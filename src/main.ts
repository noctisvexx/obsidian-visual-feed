import { Notice, Plugin, TFile } from "obsidian";
import { Indexer } from "./indexer/indexer";
import {
  DEFAULT_SETTINGS,
  PhotoFeedSettingTab,
  normalizeLayoutSettings,
  normalizeRatioSettings,
  normalizeSources,
} from "./settings";
import { PublishModal } from "./publish/PublishModal";
import type { FeedIndex, PhotoFeedSettings } from "./types";
import { PLUGIN_NAME } from "./types";
import { PHOTO_FEED_VIEW_TYPE, PhotoFeedView } from "./views/PhotoFeedView";

/**
 * 视界 · Visual Feed
 *
 * 定位：只做一件事 —— 把你指定的来源文件夹（手写笔记、社交平台同步归档……都行）里
 * 出现过的照片与视频，重新组织成一个 Instagram 风格的 Feed，顺便支持直接发布新的照片 / 视频。
 *
 * 架构：
 *  Markdown → 本地索引（Post 聚合）→ Feed UI
 *   - 索引在建立阶段算好媒体路径、来源、日期、caption，打开视图只读索引 → 秒开
 *   - vault create/modify/delete/rename 事件驱动增量更新，只处理变化的文件
 *   - 媒体文件变化时只重解析引用了它的 Markdown
 *   - 索引持久化到插件 data 目录，重启时用 mtime+size 增量对比
 *   - 发布：写附件 + 按时间戳追加记录，只重解析那一篇 md（不重建全库索引）
 *   - 纯本地：不复制原文件、不生成缩略图、不上传；发布之外不改动任何 Markdown
 */
export default class PhotoFeedPlugin extends Plugin {
  settings!: PhotoFeedSettings;
  indexer!: Indexer;
  private indexListeners = new Set<(source: "settings" | "index") => void>();

  async onload(): Promise<void> {
    const data = await this.loadData();
    const raw = (data?.settings ?? {}) as Partial<PhotoFeedSettings>;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);
    this.settings.sources = normalizeSources(this.settings.sources);
    normalizeRatioSettings(this.settings);
    normalizeLayoutSettings(this.settings);

    this.indexer = new Indexer(this, (data?.index as FeedIndex) ?? null);

    this.registerView(PHOTO_FEED_VIEW_TYPE, (leaf) => new PhotoFeedView(leaf, this));

    // 左侧 Ribbon
    this.addRibbonIcon("image", PLUGIN_NAME, () => {
      void this.activateView();
    });
    this.addCommand({
      id: "open-photo-feed",
      name: "打开视界",
      callback: () => void this.activateView(),
    });
    this.addCommand({
      id: "publish-media",
      name: "发布照片或视频",
      callback: () => this.openPublish(),
    });
    this.addCommand({
      id: "rebuild-photo-index",
      name: "重建视界索引",
      callback: () => void this.rebuildIndex(),
    });
    this.addCommand({
      id: "open-photo-feed-settings",
      name: "打开视界设置",
      callback: () => this.openSettings(),
    });

    this.addSettingTab(new PhotoFeedSettingTab(this.app, this));

    // Vault 事件 → 增量索引
    this.registerEvent(
      this.app.vault.on("create", (f) => {
        if (f instanceof TFile) this.indexer.handleChange(f);
      })
    );
    this.registerEvent(
      this.app.vault.on("modify", (f) => {
        if (f instanceof TFile) this.indexer.handleChange(f);
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (f) => {
        if (f instanceof TFile) this.indexer.handleDelete(f);
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (f, oldPath) => {
        if (f instanceof TFile) this.indexer.handleRename(f, oldPath);
      })
    );

    this.app.workspace.onLayoutReady(() => {
      void this.initAfterLayout();
    });
  }

  onunload(): void {
    // registerView / registerEvent 由 Obsidian 自动清理；索引已持久化
  }

  /** 启动：有索引就只做增量对比（秒开），没有才全量扫描 */
  private async initAfterLayout(): Promise<void> {
    if (this.settings.openOnStartup) {
      await this.activateView();
    }
    // 来源显示名 = 文件夹末级名（派生值，不存盘）→ 启动时把索引里可能过期的旧名字纠正过来，
    // 纯内存重算、不读任何文件。否则改了文件夹名 / 换了路径之后，首页与筛选里会一直挂着旧名字。
    if (this.indexer.resyncSourceMeta()) {
      void this.indexer.save();
      this.notifyIndexChanged("settings");
    }
    if (this.indexer.isEmpty && this.settings.sources.some((s) => s.enabled)) {
      new Notice(`${PLUGIN_NAME}：正在建立索引（首次会稍慢）`);
      await this.indexer.buildFull();
      new Notice(`${PLUGIN_NAME}：索引完成，共 ${this.indexer.stats().photos} 个媒体`);
    } else {
      await this.indexer.refreshChanged();
    }
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(PHOTO_FEED_VIEW_TYPE);
    if (existing.length) {
      await workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = workspace.getLeaf(true);
    await leaf.setViewState({ type: PHOTO_FEED_VIEW_TYPE, active: true });
    await workspace.revealLeaf(leaf);
  }

  /** 打开发布弹窗（Ribbon / 命令 / 视图右下角按钮都走这里） */
  openPublish(): void {
    new PublishModal(this.app, this, () => {
      // 发布完成后把视界拉到前台；索引变更会自行通知视图刷新
      void this.activateView();
    }).open();
  }

  /**
   * 打开插件设置页。
   * Obsidian 不暴露「直接跳到某个插件的设置」，这里在设置窗口已经打开时
   * 复用它的内部 API；否则退化为提示。
   */
  openSettings(): void {
    const setting = (
      this.app as unknown as {
        setting?: {
          open: () => void;
          openTabById: (id: string) => void;
          activeTab?: { id?: string };
        };
      }
    ).setting;
    try {
      setting?.open();
      setting?.openTabById(this.manifest.id);
      if (!setting) new Notice(`${PLUGIN_NAME}：请在「设置 → 第三方插件」里打开本插件设置`);
    } catch {
      new Notice(`${PLUGIN_NAME}：请在「设置 → 第三方插件」里打开本插件设置`);
    }
  }

  /** 重建索引（设置页 / 命令面板） */
  async rebuildIndex(): Promise<void> {
    new Notice(`${PLUGIN_NAME}：正在重建索引…`);
    try {
      await this.indexer.buildFull();
      const s = this.indexer.stats();
      new Notice(`${PLUGIN_NAME}：重建完成，${s.posts} 条记录 / ${s.photos} 个媒体`);
      // 手动重建是用户主动发起的：无视「正在往下看就先不打断」的礼貌策略，
      // 直接按 settings 语义整体刷新（否则来源换了、筛选项和首屏却还是旧的，看着像没生效）。
      this.notifyIndexChanged("settings");
    } catch (e) {
      console.error(e);
      new Notice(`${PLUGIN_NAME}：索引重建失败，详见控制台`);
    }
  }

  // ─────────────── 持久化 + 通知 ───────────────

  async saveSettings(): Promise<void> {
    await this.saveData({ settings: this.settings, index: this.indexer.index });
  }

  /** 索引落盘；notify 仅在内容真正变化时为 true */
  async persistIndex(index: FeedIndex, notify = true): Promise<void> {
    await this.saveData({ settings: this.settings, index });
    if (notify) this.notifyIndexChanged("index");
  }

  onIndexChanged(fn: (source: "settings" | "index") => void): void {
    this.indexListeners.add(fn);
  }

  offIndexChanged(fn: (source: "settings" | "index") => void): void {
    this.indexListeners.delete(fn);
  }

  /**
   * 通知视图刷新。
   *  - "settings"：显示项/筛选相关设置变化 → 视图立即全量重渲染
   *  - "index"：索引内容真实变化 → 视图按滚动位置决定刷新或提示
   */
  notifyIndexChanged(source: "settings" | "index" = "index"): void {
    for (const fn of this.indexListeners) {
      try {
        fn(source);
      } catch (e) {
        console.error("照片流：索引变更通知失败", e);
      }
    }
  }
}
