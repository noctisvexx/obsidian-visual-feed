/**
 * Obsidian API 的最小 mock（仅覆盖视界用到的能力）。
 * 用于在 Node 中对真实 Vault 数据端到端测试索引器 / 发布流程。仅供测试，不参与插件构建。
 *
 * ⚠️ 安全约定：create / createBinary / createFolder / process 一律只写内存 overlay，
 * 绝不落真实磁盘 —— 否则测试会把文件写进用户的 Obsidian Vault。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export class TFile {
  path: string;
  name: string;
  extension: string;
  stat: { mtime: number; size: number; ctime: number };
  constructor(path: string, stat: { mtime: number; size: number }) {
    this.path = path;
    this.name = path.split("/").pop() || "";
    this.extension = this.name.split(".").pop() || "";
    this.stat = { ...stat, ctime: stat.mtime };
  }
}

export class TFolder {
  path: string;
  name: string;
  children: (TFile | TFolder)[] = [];
  constructor(path: string) {
    this.path = path;
    this.name = path.split("/").pop() || "";
  }
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/");
}

const VIRTUAL_MTIME = 1_700_000_000_000;

/** 所有文件（含图片 / 视频），用于链接解析 */
export class Vault {
  root: string;
  files: TFile[] = [];
  extra = new Map<string, string>();
  readCount = 0;
  /** 内存 overlay：测试期间「新建」的文件 / 文件夹，绝不落磁盘 */
  virtual = new Map<string, string | ArrayBuffer>();
  virtualFolders = new Set<string>();
  /** 模拟 Obsidian 的配置（附件文件夹等） */
  config: Record<string, unknown> = {};
  /** 记录 createFolder 调用，用来断言目录被逐级创建 */
  createdFolders: string[] = [];
  /** 路径索引（贴近真实 Obsidian 的 O(1) 查找） */
  private byPath = new Map<string, TFile>();
  private byName = new Map<string, TFile[]>();

  constructor(root: string) {
    this.root = root;
    this.scan();
  }

  private scan(): void {
    this.files = [];
    const walk = (dir: string, vaultRel: string): void => {
      for (const name of readdirSync(dir)) {
        if (name.startsWith(".")) continue;
        const abs = join(dir, name);
        const rel = vaultRel ? `${vaultRel}/${name}` : name;
        const st = statSync(abs);
        if (st.isDirectory()) walk(abs, rel);
        else this.files.push(new TFile(rel, { mtime: st.mtimeMs, size: st.size }));
      }
    };
    walk(this.root, "");
    const merge = (p: string): void => {
      const st = this.statOf(p);
      const idx = this.files.findIndex((f) => f.path === p);
      if (idx >= 0) this.files[idx] = new TFile(p, st);
      else this.files.push(new TFile(p, st));
    };
    for (const p of this.extra.keys()) merge(p);
    for (const p of this.virtual.keys()) merge(p);
    this.byPath = new Map(this.files.map((f) => [f.path, f]));
    this.byName = new Map();
    for (const f of this.files) {
      const list = this.byName.get(f.name);
      if (list) list.push(f);
      else this.byName.set(f.name, [f]);
    }
  }

  private statOf(p: string): { mtime: number; size: number } {
    const v = this.virtual.get(p);
    const size =
      typeof v === "string" ? v.length : v instanceof ArrayBuffer ? v.byteLength : 0;
    if (v !== undefined) return { mtime: VIRTUAL_MTIME + size, size };
    const extra = this.extra.get(p)?.length ?? 0;
    return { mtime: VIRTUAL_MTIME + extra, size: extra };
  }

  /** 测试辅助：注入一篇「真实存在」的 md（内容也在内存） */
  upsertExtra(p: string, content: string): void {
    this.extra.set(p, content);
    this.scan();
  }

  removeExtra(p: string): void {
    this.extra.delete(p);
    this.scan();
  }

  getFiles(): TFile[] {
    return this.files;
  }

  /** 按文件名查（路径短的优先） */
  findByName(name: string): TFile[] {
    return (this.byName.get(name) ?? []).slice().sort((a, b) => a.path.length - b.path.length);
  }

  private buildVirtualFolder(path: string): TFolder {
    const folder = new TFolder(path);
    const prefix = path ? path + "/" : "";
    for (const p of this.virtual.keys()) {
      if (!p.startsWith(prefix)) continue;
      const rel = p.slice(prefix.length);
      if (!rel || rel.includes("/")) continue;
      folder.children.push(new TFile(p, this.statOf(p)));
    }
    for (const f of this.virtualFolders) {
      if (!f.startsWith(prefix)) continue;
      const rel = f.slice(prefix.length);
      if (!rel || rel.includes("/")) continue;
      folder.children.push(this.buildVirtualFolder(f));
    }
    return folder;
  }

  getAbstractFileByPath(p: string): TFile | TFolder | null {
    const norm = normalizePath(p);
    // 内存 overlay 优先（virtual 会遮蔽同名真实文件）
    if (this.virtual.has(norm)) return new TFile(norm, this.statOf(norm));
    if (this.extra.has(norm)) return new TFile(norm, this.statOf(norm));
    if (this.virtualFolders.has(norm)) return this.buildVirtualFolder(norm);
    const hit = this.byPath.get(norm);
    if (hit) return hit;
    try {
      const abs = join(this.root, norm);
      const st = statSync(abs);
      if (st.isDirectory()) {
        const folder = new TFolder(norm);
        const walk = (dir: string, rel: string, parent: TFolder): void => {
          for (const name of readdirSync(dir)) {
            if (name.startsWith(".")) continue;
            const abs2 = join(dir, name);
            const rel2 = rel ? `${rel}/${name}` : name;
            const st2 = statSync(abs2);
            if (st2.isDirectory()) {
              const sub = new TFolder(rel2);
              parent.children.push(sub);
              walk(abs2, rel2, sub);
            } else {
              parent.children.push(new TFile(rel2, { mtime: st2.mtimeMs, size: st2.size }));
            }
          }
        };
        walk(abs, norm, folder);
        return folder;
      }
      if (st.isFile()) return new TFile(norm, { mtime: st.mtimeMs, size: st.size });
    } catch {
      /* 不存在 */
    }
    return null;
  }

  getResourcePath(file: TFile): string {
    return `app://local/${join(this.root, file.path)}`;
  }

  getConfig(key: string): unknown {
    return this.config[key];
  }

  async cachedRead(file: TFile): Promise<string> {
    this.readCount++;
    const v = this.virtual.get(file.path);
    if (typeof v === "string") return v;
    const extra = this.extra.get(file.path);
    if (extra !== undefined) return extra;
    return readFileSync(join(this.root, file.path), "utf8");
  }

  async read(file: TFile): Promise<string> {
    return this.cachedRead(file);
  }

  // ───────── 写入（全部只进内存 overlay）─────────

  async create(path: string, data: string): Promise<TFile> {
    const norm = normalizePath(path);
    this.assertFree(norm);
    this.virtual.set(norm, data);
    this.scan();
    return this.getAbstractFileByPath(norm) as TFile;
  }

  async createBinary(path: string, data: ArrayBuffer): Promise<TFile> {
    const norm = normalizePath(path);
    this.assertFree(norm);
    this.virtual.set(norm, data);
    this.scan();
    return this.getAbstractFileByPath(norm) as TFile;
  }

  async createFolder(path: string): Promise<TFolder> {
    const norm = normalizePath(path).replace(/\/+$/, "");
    if (norm.includes("/")) {
      const parent = norm.split("/").slice(0, -1).join("/");
      if (!this.virtualFolders.has(parent) && !this.isRealFolder(parent)) {
        throw new Error(`Parent folder doesn't exist: ${parent}`);
      }
    }
    this.createdFolders.push(norm);
    this.virtualFolders.add(norm);
    return new TFolder(norm);
  }

  private isRealFolder(p: string): boolean {
    try {
      return statSync(join(this.root, p)).isDirectory();
    } catch {
      return false;
    }
  }

  private assertFree(norm: string): void {
    if (this.virtual.has(norm) || this.extra.has(norm) || this.byPath.has(norm)) {
      throw new Error(`File already exists: ${norm}`);
    }
  }

  /**
   * 原子读改写。只允许改内存里的文件 —— 真实磁盘文件一律拒绝，
   * 防止测试误改用户的 Vault。
   */
  async process(file: TFile, fn: (data: string) => string): Promise<string> {
    const v = this.virtual.get(file.path);
    if (typeof v === "string") {
      const next = fn(v);
      this.virtual.set(file.path, next);
      this.scan();
      return next;
    }
    if (this.extra.has(file.path)) {
      const next = fn(this.extra.get(file.path) ?? "");
      this.extra.set(file.path, next);
      this.scan();
      return next;
    }
    throw new Error(
      `测试保护：拒绝改写磁盘上的真实文件 ${file.path}（请改用内存 overlay 路径）`
    );
  }
}

/** 简化的链接解析：精确路径 → 文件名唯一匹配（贴近 Obsidian 的 getFirstLinkpathDest） */
export class MetadataCache {
  vault: Vault;
  constructor(vault: Vault) {
    this.vault = vault;
  }

  getFileCache(): { frontmatter?: Record<string, unknown> } | null {
    return null;
  }

  getFirstLinkpathDest(linkpath: string, sourcePath: string): TFile | null {
    const norm = normalizePath(linkpath);
    const exact = this.vault.getAbstractFileByPath(norm);
    if (exact instanceof TFile) return exact;
    // 相对源文件目录
    const dir = sourcePath.split("/").slice(0, -1).join("/");
    if (dir) {
      const rel = this.vault.getAbstractFileByPath(normalizePath(`${dir}/${norm}`));
      if (rel instanceof TFile) return rel;
    }
    // 文件名匹配（取路径最短的，贴近 Obsidian 的「最近文件」策略）
    const byName = this.vault.findByName(norm.split("/").pop() || "");
    return byName[0] ?? null;
  }
}

/**
 * 模拟 Obsidian 的「设备本地存储」（`App.saveLocalStorage` / `loadLocalStorage`，@since 1.8.7）。
 * **跨 App 实例共享**：测试里再 `new App()` 一次就等价于「重启 Obsidian」，用来验证状态记忆。
 * 落盘走一次 JSON 往返 —— 真实环境也是序列化存的，顺便验证写进去的是可序列化的普通对象。
 */
const localStore = new Map<string, string>();

/** 清空模拟的本地存储（测试之间隔离） */
export function resetLocalStorage(): void {
  localStore.clear();
}

export class App {
  vault: Vault;
  metadataCache: MetadataCache;
  workspace: Workspace;
  setting?: unknown;
  constructor(root: string) {
    this.vault = new Vault(root);
    this.metadataCache = new MetadataCache(this.vault);
    this.workspace = new Workspace(this);
  }

  /** @since 1.8.7 */
  loadLocalStorage(key: string): unknown {
    const raw = localStore.get(key);
    return raw === undefined ? null : JSON.parse(raw);
  }

  /** @since 1.8.7 */
  saveLocalStorage(key: string, data: unknown): void {
    localStore.set(key, JSON.stringify(data ?? null));
  }
}

/** 只够让 openPostSource / 视图跑起来的 workspace */
export class Workspace {
  app: App;
  /**
   * 工作区布局是否就绪（@since 0.9.7）。
   * 默认 true = 测试环境的常态（布局早就好了）；要验证「冷启动时视图先于布局恢复」
   * 这条时序，先 `markLayoutNotReady()`，之后 `markLayoutReady()` 手动放行挂起的回调。
   */
  layoutReady = true;
  private layoutPending: (() => void)[] = [];

  constructor(app: App) {
    this.app = app;
  }
  getLeaf(): { openFile: () => Promise<void> } {
    return { openFile: async () => undefined };
  }
  getLeavesOfType(): unknown[] {
    return [];
  }
  setActiveLeaf(): void {
    /* 测试里不需要真的切换活动页 */
  }
  revealLeaf(): Promise<void> {
    return Promise.resolve();
  }
  onLayoutReady(cb: () => void): void {
    if (this.layoutReady) cb();
    else this.layoutPending.push(cb);
  }
  /** 测试用：模拟「布局还没就绪」（移动端冷启动恢复视图的时刻） */
  markLayoutNotReady(): void {
    this.layoutReady = false;
  }
  /** 测试用：布局就绪，放行之前挂起的回调 */
  markLayoutReady(): void {
    this.layoutReady = true;
    const pending = this.layoutPending;
    this.layoutPending = [];
    for (const cb of pending) cb();
  }
}

export interface WorkspaceLeaf {
  app: App;
  setViewState?: (s: unknown) => Promise<void>;
  view?: unknown;
}

// ───────────────── DOM 相关 mock（仅 jsdom 环境下会被实例化）─────────────────

/** Obsidian 的 setIcon：真实环境注入 SVG，这里只打标记供断言 */
export function setIcon(el: HTMLElement, icon: string): void {
  el.setAttribute("data-icon", icon);
}

export class Notice {
  constructor(_message?: string, _timeout?: number) {
    /* 测试环境静默 */
  }
  setMessage(): void {
    /* noop */
  }
  hide(): void {
    /* noop */
  }
}

class ToggleStub {  el: HTMLInputElement;
  constructor(parent: HTMLElement) {
    this.el = parent.createEl("input", { attr: { type: "checkbox" } });
  }
  setValue(v: boolean): this {
    this.el.checked = v;
    return this;
  }
  setTooltip(): this {
    return this;
  }
  onChange(cb: (v: boolean) => void): this {
    this.el.addEventListener("change", () => cb(this.el.checked));
    return this;
  }
}

class SliderStub {
  el: HTMLInputElement;
  private cb: ((v: number) => void) | null = null;
  constructor(parent: HTMLElement) {
    this.el = parent.createEl("input", { attr: { type: "range" } });
    this.el.addEventListener("change", () => this.cb?.(Number(this.el.value)));
  }
  setLimits(): this {
    return this;
  }
  setValue(v: number): this {
    this.el.value = String(v);
    return this;
  }
  setDynamicTooltip(): this {
    return this;
  }
  onChange(cb: (v: number) => void): this {
    this.cb = cb;
    return this;
  }
}

class DropdownStub {
  el: HTMLSelectElement;
  private cb: ((v: string) => void) | null = null;
  constructor(parent: HTMLElement) {
    this.el = parent.createEl("select");
    this.el.addEventListener("change", () => this.cb?.(this.el.value));
  }
  addOption(v: string, label: string): this {
    this.el.add(new Option(label, v));
    return this;
  }
  addOptions(): this {
    return this;
  }
  setValue(v: string): this {
    this.el.value = v;
    return this;
  }
  onChange(cb: (v: string) => void): this {
    this.cb = cb;
    return this;
  }
}

class ButtonStub {
  el: HTMLButtonElement;
  private cb: (() => void) | null = null;
  constructor(parent: HTMLElement) {
    this.el = parent.createEl("button");
    this.el.addEventListener("click", () => this.cb?.());
  }
  setButtonText(t: string): this {
    this.el.setText(t);
    return this;
  }
  setCta(): this {
    this.el.addClass("mod-cta");
    return this;
  }
  setWarning(): this {
    this.el.addClass("mod-warning");
    return this;
  }
  setDestructive(): this {
    this.el.addClass("mod-destructive");
    return this;
  }
  setTooltip(): this {
    return this;
  }
  setIcon(): this {
    return this;
  }
  setDisabled(v: boolean): this {
    this.el.disabled = v;
    return this;
  }
  onClick(cb: () => void): this {
    this.cb = cb;
    return this;
  }
}

class TextStub {
  el: HTMLInputElement;
  private cb: ((v: string) => void) | null = null;
  constructor(parent: HTMLElement) {
    this.el = parent.createEl("input", { attr: { type: "text" } });
    this.el.addEventListener("change", () => this.cb?.(this.el.value));
  }
  setPlaceholder(v: string): this {
    this.el.setAttribute("placeholder", v);
    return this;
  }
  setValue(v: string): this {
    this.el.value = v;
    return this;
  }
  onChange(cb: (v: string) => void): this {
    this.cb = cb;
    return this;
  }
}

export class Setting {
  settingEl: HTMLElement;
  nameEl: HTMLElement;
  descEl: HTMLElement;
  controlEl: HTMLElement;
  constructor(containerEl: HTMLElement) {
    this.settingEl = containerEl.createDiv({ cls: "setting-item" });
    this.nameEl = this.settingEl.createDiv({ cls: "setting-item-name" });
    this.descEl = this.settingEl.createDiv({ cls: "setting-item-description" });
    this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" });
  }
  setName(n: string): this {
    this.nameEl.setText(n);
    return this;
  }
  setDesc(d: string): this {
    this.descEl.setText(d);
    return this;
  }
  setHeading(): this {
    this.settingEl.addClass("setting-item-heading");
    return this;
  }
  setClass(c: string): this {
    this.settingEl.addClass(c);
    return this;
  }
  setTooltip(): this {
    return this;
  }
  addToggle(cb: (c: ToggleStub) => unknown): this {
    cb(new ToggleStub(this.controlEl));
    return this;
  }
  addSlider(cb: (c: SliderStub) => unknown): this {
    cb(new SliderStub(this.controlEl));
    return this;
  }
  addDropdown(cb: (c: DropdownStub) => unknown): this {
    cb(new DropdownStub(this.controlEl));
    return this;
  }
  addButton(cb: (c: ButtonStub) => unknown): this {
    cb(new ButtonStub(this.controlEl));
    return this;
  }
  addText(cb: (c: TextStub) => unknown): this {
    cb(new TextStub(this.controlEl));
    return this;
  }
  addExtraButton(cb: (c: ButtonStub) => unknown): this {
    cb(new ButtonStub(this.controlEl));
    return this;
  }
}

/**
 * 设置页基类桩。
 * 除了老的 display()，这里也补上了 1.13.0 声明式设置 API 的几个方法
 * （getSettingDefinitions / getControlValue / setControlValue / update / refreshDomState）：
 * 语义照官方文档（读 `plugin.settings[key]`、写回并落盘、update() 重建定义），
 * 真正的渲染由下面的 renderSettingTab() 负责。
 */
export class PluginSettingTab {
  app: App;
  plugin: unknown;
  containerEl: HTMLElement;
  /** 最近一次 getSettingDefinitions() 的结果 */
  settingItems: unknown[] = [];
  /** 上次渲染到哪个容器 —— update() / refreshDomState() 要原地重绘 */
  renderHost: HTMLElement | null = null;
  constructor(app: App, plugin: unknown) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = document.createElement("div");
  }
  getSettingDefinitions(): unknown[] {
    return [];
  }
  getControlValue(key: string): unknown {
    return (this.plugin as { settings?: Record<string, unknown> })?.settings?.[key];
  }
  setControlValue(key: string, value: unknown): void {
    const p = this.plugin as {
      settings?: Record<string, unknown>;
      saveSettings?: () => Promise<void>;
    };
    if (p?.settings) p.settings[key] = value;
    void p?.saveSettings?.();
  }
  update(): void {
    if (this.renderHost) renderInto(this, this.renderHost);
  }
  refreshDomState(): void {
    // 桩里没有「就地刷新谓词」这套，整块重绘一遍，效果等价
    this.update();
  }
  display(): void {
    /* 子类实现（1.13.0 起被声明式定义取代） */
  }
  hide(): void {
    /* noop */
  }
}

// ───────────────── 声明式设置的最小渲染器 ─────────────────

function renderInto(tab: PluginSettingTab, host: HTMLElement): void {
  tab.settingItems = tab.getSettingDefinitions();
  host.empty();
  renderSettingItems(tab, host, tab.settingItems);
}

/**
 * 测试端的声明式设置渲染器：真实 Obsidian 自己渲染 getSettingDefinitions() 的返回值，
 * 桩环境里没有这套引擎，所以照官方文档描述的语义补一份最小实现 ——
 * group/heading、visible 谓词、control 绑定、render 逃生口、action 行。
 */
export function renderSettingTab(tab: PluginSettingTab, containerEl: HTMLElement): void {
  tab.renderHost = containerEl;
  renderInto(tab, containerEl);
}

function renderSettingItems(
  tab: PluginSettingTab,
  host: HTMLElement,
  items: unknown[]
): void {
  for (const raw of items) {
    const item = raw as {
      type?: string;
      heading?: string;
      name?: string;
      desc?: string | DocumentFragment;
      items?: unknown[];
      visible?: boolean | (() => boolean);
      control?: { type: string; key: string; options?: Record<string, string>; min?: number; max?: number; step?: number; defaultValue?: unknown };
      render?: (setting: Setting, group: unknown) => void;
      action?: (el: HTMLElement, index: number) => void;
    };
    const visible =
      typeof item.visible === "function" ? item.visible() : item.visible !== false;
    if (!visible) continue;

    if (item.type === "group" || item.type === "list") {
      if (item.heading) new Setting(host).setName(item.heading).setHeading();
      renderSettingItems(tab, host, item.items ?? []);
      continue;
    }

    const setting = new Setting(host).setName(item.name ?? "");
    if (typeof item.desc === "string") setting.setDesc(item.desc);
    if (item.render) {
      item.render(setting, { listEl: host });
      continue;
    }
    if (item.control) {
      applyControl(tab, setting, item.control);
      continue;
    }
    if (item.action) {
      const el = setting.controlEl.createEl("button", { text: item.name ?? "" });
      el.addEventListener("click", () => item.action?.(el, 0));
    }
  }
}

function applyControl(
  tab: PluginSettingTab,
  setting: Setting,
  control: { type: string; key: string; options?: Record<string, string>; min?: number; max?: number; step?: number; defaultValue?: unknown }
): void {
  const key = control.key;
  if (control.type === "toggle") {
    setting.addToggle((t) =>
      t.setValue(Boolean(tab.getControlValue(key))).onChange((v) => {
        tab.setControlValue(key, v);
      })
    );
    return;
  }
  if (control.type === "dropdown") {
    setting.addDropdown((dd) => {
      for (const [value, label] of Object.entries(control.options ?? {})) dd.addOption(value, label);
      const current = tab.getControlValue(key) ?? control.defaultValue ?? "";
      dd.setValue(String(current)).onChange((v) => {
        tab.setControlValue(key, v);
      });
    });
    return;
  }
  if (control.type === "slider") {
    setting.addSlider((sl) =>
      sl
        .setLimits(control.min ?? 0, control.max ?? 100, control.step ?? 1)
        .setValue(Number(tab.getControlValue(key)))
        .onChange((v) => {
          tab.setControlValue(key, v);
        })
    );
  }
}

export class ItemView {
  app: App;
  leaf: WorkspaceLeaf;
  containerEl: HTMLElement;
  contentEl: HTMLElement;
  constructor(leaf: WorkspaceLeaf) {
    this.leaf = leaf;
    this.app = leaf.app;
    this.containerEl = document.createElement("div");
    this.contentEl = document.createElement("div");
    this.containerEl.appendChild(this.contentEl);
    document.body.appendChild(this.containerEl);
  }
  getViewType(): string {
    return "";
  }
  getDisplayText(): string {
    return "";
  }
  getIcon(): string {
    return "";
  }
  registerDomEvent(el: EventTarget, type: string, cb: EventListener): void {
    el.addEventListener(type, cb);
  }
  registerEvent(): void {
    /* noop */
  }
  addChild(): void {
    /* noop */
  }
}

export class Modal {
  app: App;
  containerEl: HTMLElement;
  modalEl: HTMLElement;
  titleEl: HTMLElement;
  contentEl: HTMLElement;
  constructor(app: App) {
    this.app = app;
    const doc = document;
    this.containerEl = doc.createElement("div");
    this.modalEl = doc.createElement("div");
    this.titleEl = doc.createElement("div");
    this.contentEl = doc.createElement("div");
    this.modalEl.appendChild(this.titleEl);
    this.modalEl.appendChild(this.contentEl);
    this.containerEl.appendChild(this.modalEl);
    doc.body.appendChild(this.containerEl);
  }
  open(): void {
    this.onOpen();
  }
  close(): void {
    this.onClose();
    this.containerEl.remove();
  }
  onOpen(): void {
    /* 子类实现 */
  }
  onClose(): void {
    /* 子类实现 */
  }
}

export class AbstractInputSuggest<T> {
  app: App;
  inputEl: HTMLInputElement;
  limit = 20;
  constructor(app: App, inputEl: HTMLInputElement) {
    this.app = app;
    this.inputEl = inputEl;
  }
  setValue(v: string): void {
    this.inputEl.value = v;
  }
  getValue(): string {
    return this.inputEl.value;
  }
  close(): void {
    /* noop */
  }
  getSuggestions(_q: string): T[] {
    return [];
  }
  renderSuggestion(_item: T, _el: HTMLElement): void {
    /* noop */
  }
  selectSuggestion(_item: T): void {
    /* noop */
  }
}

export class FuzzySuggestModal<T> extends Modal {
  constructor(app: App) {
    super(app);
  }
  setPlaceholder(_p: string): void {
    /* noop */
  }
  getItems(): T[] {
    return [];
  }
  getItemText(_item: T): string {
    return "";
  }
  onChooseItem(_item: T): void {
    /* noop */
  }
}
