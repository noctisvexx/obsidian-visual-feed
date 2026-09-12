import { App, TFile, TFolder, normalizePath } from "obsidian";
import type { FeedIndex, FeedPost, SourceFolder } from "../types";
import { INDEX_VERSION, isMediaExt } from "../types";
import { buildPosts } from "./parse";
import type PhotoFeedPlugin from "../main";

/** 全量扫描时并发读取正文的批次（移动端内存友好） */
const CHUNK = 12;
/** 索引落盘防抖 ms */
const SAVE_DEBOUNCE = 400;
/** 文件变更批量防抖 ms（一次导入多个文件时合并处理） */
const FLUSH_DEBOUNCE = 250;

/**
 * 照片索引器：
 *  - buildFull：首次 / 重建时全量扫描已配置的来源目录，建立 Post 索引
 *  - refreshChanged：启动时用 mtime + size 与持久化索引对比，只重处理变化的文件（保证秒开）
 *  - 事件驱动增量：create / modify / delete / rename 只处理对应文件
 *  - 图片文件变化：只重解析引用了它的 Markdown
 *  - 索引持久化在插件 data 目录，重启不丢
 */
export class Indexer {
  private plugin: PhotoFeedPlugin;
  private app: App;
  index: FeedIndex;

  private saveTimer: number | null = null;
  private flushTimer: number | null = null;
  private pendingPaths = new Set<string>();
  private itemDirty = false;
  private building = false;

  constructor(plugin: PhotoFeedPlugin, existing: FeedIndex | null) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.index =
      existing && existing.version === INDEX_VERSION
        ? existing
        : { version: INDEX_VERSION, files: {}, posts: [] };
  }

  /** 索引是否为空（用于决定首次全量还是增量） */
  get isEmpty(): boolean {
    return this.index.posts.length === 0 && Object.keys(this.index.files).length === 0;
  }

  get isBuilding(): boolean {
    return this.building;
  }

  /**
   * 判断路径属于哪个来源目录；不属于任何已启用目录返回 null。
   * 多个目录嵌套时取最长路径匹配（更具体的目录优先）→ 同一文件夹不会重复索引。
   */
  sourceOf(path: string): SourceFolder | null {
    const p = normalizePath(path);
    let best: SourceFolder | null = null;
    let bestLen = -1;
    for (const s of this.plugin.settings.sources) {
      if (!s.enabled) continue;
      const dir = normalizePath(s.path || "").replace(/\/+$/, "");
      if (!dir) continue;
      if (p === dir || p.startsWith(dir + "/")) {
        if (dir.length > bestLen) {
          best = s;
          bestLen = dir.length;
        }
      }
    }
    return best;
  }

  isRelevant(path: string): boolean {
    return this.sourceOf(path) !== null;
  }

  /**
   * 是否是需要索引的 Markdown：
   *  - 属于某个已启用来源目录
   *  - 不在 `.` / `_` 开头的系统目录或文件里（如某些插件的 `_trash.md`、
   *    同步器的 `.sync_state.json` 所在目录）
   * 全量扫描与增量事件必须用同一套判断，否则启动对比会反复读取被跳过的文件。
   */
  private shouldIndex(file: { path: string; extension: string; name?: string }): boolean {
    if (file.extension !== "md") return false;
    const parts = file.path.split("/");
    const name = file.name ?? parts[parts.length - 1] ?? "";
    if (name.startsWith("_") || name.startsWith(".")) return false;
    for (let i = 0; i < parts.length - 1; i++) {
      if (parts[i].startsWith("_") || parts[i].startsWith(".")) return false;
    }
    return this.isRelevant(file.path);
  }

  getPosts(): FeedPost[] {
    return this.index.posts;
  }

  /**
   * 按当前来源配置重算每条 Post 的 src / srcType / srcDesc（显示名是文件夹末级名的派生值，
   * 不存盘），不做任何文件读取 —— 换文件夹、改说明、以及**启动时纠正旧名字**都走这里。
   * 返回是否有内容真的变了（变了才需要落盘 / 通知视图）。
   */
  resyncSourceMeta(): boolean {
    const sources = this.plugin.settings.sources;
    let changed = false;
    for (const post of this.index.posts) {
      const src = sources.find((s) => s.path === post.srcPath);
      if (!src) continue;
      const name = src.name || src.type;
      const desc = src.desc || "";
      if (post.src !== name || post.srcDesc !== desc || post.srcType !== src.type) changed = true;
      post.src = name;
      post.srcType = src.type;
      post.srcDesc = desc;
    }
    return changed;
  }

  /** 统计信息（设置页 / 空状态展示） */
  stats(): {
    posts: number;
    photos: number;
    scanned: number;
    withPhotos: number;
    bySource: Record<string, number>;
  } {
    const bySource: Record<string, number> = {};
    let photos = 0;
    for (const p of this.index.posts) {
      photos += p.photos.length;
      bySource[p.src] = (bySource[p.src] ?? 0) + 1;
    }
    return {
      posts: this.index.posts.length,
      photos,
      scanned: Object.keys(this.index.files).length,
      withPhotos: new Set(this.index.posts.map((p) => p.file)).size,
      bySource,
    };
  }

  // ───────────────────────── 全量扫描 ─────────────────────────

  /** 清空并重建整个索引（首次安装 / 来源目录变更 / 手动重建） */
  async buildFull(): Promise<void> {
    if (this.building) return;
    this.building = true;
    try {
      this.index = { version: INDEX_VERSION, files: {}, posts: [] };
      const files = await this.listAllMdFiles();
      for (let i = 0; i < files.length; i += CHUNK) {
        const chunk = files.slice(i, i + CHUNK);
        await Promise.all(
          chunk.map(async ({ f, source }) => {
            const body = await this.safeRead(f);
            if (body === null) return;
            this.applyParsed(f, source, body);
          })
        );
      }
      await this.save(true);
    } finally {
      this.building = false;
    }
  }

  /** 遍历所有已启用来源目录收集 md 文件（按路径去重，嵌套目录不重复索引） */
  private async listAllMdFiles(): Promise<{ f: TFile; source: SourceFolder }[]> {
    const seen = new Set<string>();
    const out: { f: TFile; source: SourceFolder }[] = [];
    for (const src of this.plugin.settings.sources) {
      if (!src.enabled) continue;
      const dir = normalizePath(src.path || "").replace(/\/+$/, "");
      if (!dir) continue;
      for (const f of this.listMdFiles(dir)) {
        if (seen.has(f.path)) continue;
        seen.add(f.path);
        const owner = this.sourceOf(f.path);
        if (owner) out.push({ f, source: owner });
      }
    }
    return out;
  }

  /** 递归列出目录下的 md（跳过 . / _ 开头的系统目录与文件） */
  private listMdFiles(folderPath: string): TFile[] {
    const out: TFile[] = [];
    const root = this.app.vault.getAbstractFileByPath(normalizePath(folderPath));
    if (!(root instanceof TFolder)) return out;
    const walk = (folder: TFolder): void => {
      for (const ch of folder.children) {
        if (ch instanceof TFile) {
          if (ch.extension === "md" && !ch.name.startsWith("_") && !ch.name.startsWith(".")) {
            out.push(ch);
          }
        } else if (
          ch instanceof TFolder &&
          !ch.name.startsWith(".") &&
          !ch.name.startsWith("_")
        ) {
          walk(ch);
        }
      }
    };
    walk(root);
    return out;
  }

  // ───────────────────────── 启动对比 ─────────────────────────

  /**
   * 对比文件系统与持久化索引，只重处理变化的文件（含新增 / 删除）。
   * 返回是否有内容变化。
   */
  async refreshChanged(): Promise<boolean> {
    const seen = new Set<string>();
    const changed: TFile[] = [];
    for (const f of this.app.vault.getFiles()) {
      if (!this.shouldIndex(f)) continue;
      seen.add(f.path);
      const st = this.index.files[f.path];
      if (!st || st.mtime !== f.stat.mtime || st.size !== f.stat.size) {
        changed.push(f);
      }
    }
    let removedAny = false;
    for (const p of Object.keys(this.index.files)) {
      if (!seen.has(p)) {
        this.removeFile(p);
        removedAny = true;
      }
    }
    for (const f of changed) {
      const source = this.sourceOf(f.path);
      if (!source) continue;
      const body = await this.safeRead(f);
      if (body === null) continue;
      this.applyParsed(f, source, body);
    }
    if (changed.length || removedAny) {
      await this.save(true);
      return changed.length > 0 || removedAny;
    }
    return false;
  }

  // ───────────────────────── 增量更新 ─────────────────────────

  /** create / modify：进入待处理队列，批量防抖后重建对应文件的索引 */
  handleChange(file: TFile): void {
    if (file.extension !== "md") {
      this.handleMediaChange(file);
      return;
    }
    if (!this.shouldIndex(file)) return;
    this.pendingPaths.add(file.path);
    this.scheduleFlush();
  }

  handleDelete(file: TFile): void {
    if (file.extension !== "md") {
      this.handleMediaChange(file);
      return;
    }
    if (!this.shouldIndex(file)) return;
    this.pendingPaths.delete(file.path);
    this.removeFile(file.path);
    this.scheduleFlush();
  }

  handleRename(file: TFile, oldPath: string): void {
    if (file.extension !== "md") {
      this.handleMediaChange({ path: file.path, extension: file.extension });
      this.handleMediaChange({
        path: oldPath,
        extension: oldPath.split(".").pop() ?? "",
      });
      return;
    }
    this.removeFile(oldPath);
    if (this.shouldIndex(file)) {
      this.pendingPaths.add(file.path);
      this.scheduleFlush();
    }
  }

  /**
   * 图片 / 视频文件变化（新增 / 删除 / 改名）：
   * 只重解析引用了该媒体的 Markdown，而不是全量重建。
   */
  private handleMediaChange(file: { path: string; extension: string }): void {
    if (!isMediaExt(file.extension || "")) return;
    const target = normalizePath(file.path);
    let hit = false;
    for (const post of this.index.posts) {
      if (post.photos.some((p) => !p.remote && normalizePath(p.path) === target)) {
        this.pendingPaths.add(post.file);
        hit = true;
      }
    }
    if (hit) this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_DEBOUNCE);
  }

  private async flush(): Promise<void> {
    const paths = [...this.pendingPaths];
    this.pendingPaths.clear();
    for (const p of paths) {
      const f = this.app.vault.getAbstractFileByPath(p);
      if (!(f instanceof TFile)) continue;
      const source = this.sourceOf(f.path);
      if (!source) continue;
      const body = await this.safeRead(f);
      if (body === null) continue;
      this.applyParsed(f, source, body);
    }
    if (paths.length) await this.save();
  }

  // ───────────────────────── 索引维护 ─────────────────────────

  private applyParsed(file: TFile, source: SourceFolder, body: string): void {
    let posts: FeedPost[] = [];
    try {
      posts = buildPosts(
        this.app,
        file,
        body,
        source,
        this.plugin.settings.groupBy,
        this.plugin.settings.captionChars
      );
    } catch (e) {
      console.error(`照片流：解析失败 ${file.path}`, e);
      posts = [];
    }
    this.replaceFile(file.path, file.stat.mtime, file.stat.size, posts);
  }

  /**
   * 写入索引。先比较新旧 Post 是否真正变化：
   * 内容相同（例如同步导致 mtime 变了但正文没变）时只更新 stat，
   * 避免无意义地通知视图「有新照片」。
   *
   * 注意：无论有没有照片都要记录 stat —— 否则无图文件每次启动都会被
   * 当成「新文件」重新读取（首次全量后启动仍要读几百个文件）。
   */
  private replaceFile(path: string, mtime: number, size: number, posts: FeedPost[]): void {
    const old = this.index.posts.filter((p) => p.file === path);
    const same =
      old.length === posts.length &&
      old.every((p, i) => JSON.stringify(p) === JSON.stringify(posts[i]));
    if (!same) {
      this.index.posts = this.index.posts.filter((p) => p.file !== path);
      if (posts.length) this.index.posts.push(...posts);
      this.itemDirty = true;
    }
    this.index.files[path] = { mtime, size };
  }

  removeFile(path: string): void {
    const had = this.index.posts.some((p) => p.file === path);
    if (had) {
      this.index.posts = this.index.posts.filter((p) => p.file !== path);
      this.itemDirty = true;
    }
    delete this.index.files[path];
  }

  /**
   * 立即重解析一个文件（发布后调用，不等防抖）。
   * 不属于任何来源目录时按「已移除」处理。
   */
  async reindexFile(path: string): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(f instanceof TFile)) {
      this.removeFile(path);
      await this.save(true);
      return;
    }
    const source = this.sourceOf(f.path);
    if (!source) {
      this.removeFile(f.path);
      await this.save(true);
      return;
    }
    const body = await this.safeRead(f);
    if (body === null) return;
    this.applyParsed(f, source, body);
    await this.save(true);
  }

  /**
   * 只重扫指定目录（发布到某个文件夹后调用）。
   * 相比 buildFull 全库重扫，避免为了几条新记录重建上千条索引。
   */
  async reindexFolder(folderPath: string): Promise<number> {
    const dir = normalizePath(folderPath || "").replace(/\/+$/, "");
    if (!dir) return 0;
    let n = 0;
    for (const f of this.listMdFiles(dir)) {
      const source = this.sourceOf(f.path);
      if (!source) continue;
      const body = await this.safeRead(f);
      if (body === null) continue;
      this.applyParsed(f, source, body);
      n++;
    }
    await this.save(true);
    return n;
  }

  private async safeRead(file: TFile): Promise<string | null> {
    try {
      return await this.app.vault.cachedRead(file);
    } catch (e) {
      console.error(`照片流：读取失败 ${file.path}`, e);
      return null;
    }
  }

  // ───────────────────────── 持久化 ─────────────────────────

  save(immediate = false): Promise<void> {
    if (immediate) {
      if (this.saveTimer !== null) {
        window.clearTimeout(this.saveTimer);
        this.saveTimer = null;
      }
      return this.persistNow();
    }
    return new Promise((resolve) => {
      if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
      this.saveTimer = window.setTimeout(() => {
        this.saveTimer = null;
        void this.persistNow().then(() => resolve());
      }, SAVE_DEBOUNCE);
    });
  }

  private async persistNow(): Promise<void> {
    const notify = this.itemDirty;
    this.itemDirty = false;
    await this.plugin.persistIndex(this.index, notify);
  }
}
