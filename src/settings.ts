import {
  AbstractInputSuggest,
  App,
  FuzzySuggestModal,
  Notice,
  PluginSettingTab,
  TFolder,
} from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import type PhotoFeedPlugin from "./main";
import type {
  MediaRatioMode,
  PhotoFeedSettings,
  SourceFolder,
  SourceType,
} from "./types";
import { PLUGIN_NAME } from "./types";
import {
  RATIO_FIXED_OPTIONS,
  RATIO_MAX_OPTIONS,
  RATIO_MIN_OPTIONS,
  ratioLabel,
  snapToOption,
  type RatioChoice,
} from "./utils/ratio";

const uid = (): string => `src-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/** 取文件夹末级名：来源显示名的唯一来源（派生值，不落盘） */
const folderName = (p: string): string => p.split("/").filter(Boolean).pop() || p || "未命名来源";

export const DEFAULT_SETTINGS: PhotoFeedSettings = {
  /**
   * 默认**不预置任何来源**：文件夹结构每个人都不一样，预置示例名既容易被误当成真实路径，
   * 又会在新装时指向不存在的目录。用户在设置页自己加，空状态有引导提示。
   * ⚠️ 若以后要改回预置，`name` 必须等于 `path` 的末级名（显示名是不落盘的派生值）。
   */
  sources: [],
  groupBy: "record",
  pageSize: 12,
  imageMaxHeight: 78,
  mediaRatioMode: "range",
  mediaRatioMin: 0.8,
  mediaRatioMax: 1.7778,
  mediaRatioFixed: 1,
  showCaption: true,
  captionChars: 220,
  showSourceDesc: false,
  openOnStartup: false,
  cardStyle: true,
  layoutMode: "feed",
  gridTileSize: "medium",
  gridUnit: "photo",
  // 空 = 由用户在发布弹窗里现选（弹窗会显示「（Vault 根目录）」）
  publishFolder: "",
  attachmentFolder: "",
  autoAddSource: true,
};

/** 补齐来源条目的缺省字段（兼容手改 data.json / 旧版本） */
export function normalizeSources(input: unknown): SourceFolder[] {
  // 没有来源配置（新装 / data.json 损坏）→ 走同一套归一化，保证默认来源的显示名也是派生的
  if (!Array.isArray(input)) return normalizeSources(DEFAULT_SETTINGS.sources);
  const out: SourceFolder[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const r = (raw ?? {}) as Partial<SourceFolder>;
    const path = String(r.path ?? "").trim().replace(/\/+$/, "");
    if (!path || seen.has(path)) continue;
    seen.add(path);
    // 兼容旧版本 data.json：早先类型名耦合了具体平台（只分「个人」与「平台」两种），
    // 现在统一收敛到通用的 socialMedia —— 任何显式的非 personal 类型都按社交平台处理。
    const rawType = (r.type as string | undefined) ?? "";
    const type: SourceType = rawType && rawType !== "personal" ? "socialMedia" : "personal";
    out.push({
      id: String(r.id ?? "") || uid(),
      path,
      // 显示名不进数据模型：永远等于文件夹末级名（用户要求「选什么文件夹就显示什么名」）。
      // 这里直接丢弃 data.json 里存的旧 name，所以换路径 / 改文件夹名之后重启就自动纠正。
      name: folderName(path),
      type,
      desc: String(r.desc ?? "").trim(),
      enabled: r.enabled !== false,
    });
  }
  return out;
}

const RATIO_MODES: MediaRatioMode[] = ["original", "range", "fixed"];

/** 只认「看起来像比例」的值（宽 ÷ 高 的合理区间），其余返回 null */
const ratioLike = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0.2 && n <= 5 ? n : null;
};

/** 比例值兜底：非法值回退默认，合法值吸附到最近的预设（保证下拉框能对上） */
const saneRatio = (v: unknown, fallback: number, opts: RatioChoice[]): number =>
  snapToOption(ratioLike(v) ?? fallback, opts);

/** 修正照片框比例相关设置（兼容手改 data.json / 旧版本缺字段） */
export function normalizeRatioSettings(s: PhotoFeedSettings): void {
  if (!RATIO_MODES.includes(s.mediaRatioMode)) {
    s.mediaRatioMode = DEFAULT_SETTINGS.mediaRatioMode;
  }
  // 手改 data.json 可能把上下限写反：先按原始值对调（保住用户想表达的范围），
  // 再各自吸附到预设值——若先吸附，0.5 会被「最宽」的预设拉到 1:1，区间就被压成一个点了。
  const rawMin = ratioLike(s.mediaRatioMin);
  const rawMax = ratioLike(s.mediaRatioMax);
  if (rawMin !== null && rawMax !== null && rawMin > rawMax) {
    s.mediaRatioMin = rawMax;
    s.mediaRatioMax = rawMin;
  }
  s.mediaRatioMin = saneRatio(s.mediaRatioMin, DEFAULT_SETTINGS.mediaRatioMin, RATIO_MIN_OPTIONS);
  s.mediaRatioMax = saneRatio(s.mediaRatioMax, DEFAULT_SETTINGS.mediaRatioMax, RATIO_MAX_OPTIONS);
  s.mediaRatioFixed = saneRatio(
    s.mediaRatioFixed,
    DEFAULT_SETTINGS.mediaRatioFixed,
    RATIO_FIXED_OPTIONS
  );
  // 吸附后兜底：无论如何保证「最窄 ≤ 最宽」
  if (s.mediaRatioMin > s.mediaRatioMax) {
    const t = s.mediaRatioMin;
    s.mediaRatioMin = s.mediaRatioMax;
    s.mediaRatioMax = t;
  }
}

/**
 * 布局设置兜底：data.json 里可能是旧版本（没有这两个字段）或手改成了非法值。
 * 下拉框一旦拿不到对应 option 就会渲染成空白，所以这里必须收敛到合法枚举。
 */
export function normalizeLayoutSettings(s: PhotoFeedSettings): void {
  if (s.layoutMode !== "feed" && s.layoutMode !== "grid") {
    s.layoutMode = DEFAULT_SETTINGS.layoutMode;
  }
  if (
    s.gridTileSize !== "small" &&
    s.gridTileSize !== "medium" &&
    s.gridTileSize !== "large"
  ) {
    s.gridTileSize = DEFAULT_SETTINGS.gridTileSize;
  }
  if (s.gridUnit !== "post" && s.gridUnit !== "photo") {
    s.gridUnit = DEFAULT_SETTINGS.gridUnit;
  }
}

/** 比例预设 → 下拉框选项。key 必须是字符串（读回来是数字，靠 RATIO_KEYS 转换） */
const ratioOptions = (opts: RatioChoice[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const o of opts) out[String(o.value)] = o.label;
  return out;
};

/** Vault 内全部文件夹（用于文件夹选择器） */
function allFolders(app: App): TFolder[] {
  const out: TFolder[] = [];
  const walk = (folder: TFolder): void => {
    for (const ch of folder.children) {
      if (ch instanceof TFolder && !ch.name.startsWith(".")) {
        out.push(ch);
        walk(ch);
      }
    }
  };
  walk(app.vault.getRoot());
  return out.sort((a, b) => a.path.localeCompare(b.path, "zh"));
}

/** 输入框里的文件夹建议（Obsidian 原生 type-ahead） */
class FolderSuggest extends AbstractInputSuggest<TFolder> {
  private onPick: (path: string) => void;

  constructor(app: App, inputEl: HTMLInputElement, onPick: (path: string) => void) {
    super(app, inputEl);
    this.onPick = onPick;
    this.limit = 40;
  }

  getSuggestions(query: string): TFolder[] {
    const q = query.trim().toLowerCase();
    const folders = allFolders(this.app);
    if (!q) return folders.slice(0, 40);
    return folders.filter((f) => f.path.toLowerCase().includes(q)).slice(0, 40);
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path);
  }

  selectSuggestion(folder: TFolder): void {
    this.setValue(folder.path);
    this.onPick(folder.path);
    this.close();
  }
}

/** 点文件夹按钮时的原生选择弹窗（发布弹窗也会复用） */
export class FolderPickerModal extends FuzzySuggestModal<TFolder> {
  private onPick: (path: string) => void;

  constructor(app: App, onPick: (path: string) => void) {
    super(app);
    this.onPick = onPick;
    this.setPlaceholder("输入文件夹名，选择要扫描 / 发布的目录…");
  }

  getItems(): TFolder[] {
    return allFolders(this.app);
  }

  getItemText(folder: TFolder): string {
    return folder.path;
  }

  onChooseItem(folder: TFolder): void {
    this.onPick(folder.path);
  }
}

/** 存在设置里是数字、在下拉框里是字符串的三个比例键 —— 读/写都要转换 */
const RATIO_KEYS = new Set<string>(["mediaRatioMin", "mediaRatioMax", "mediaRatioFixed"]);

/** 只落盘就够、不用通知 Feed 的设置（改它们不影响已经渲染出来的内容） */
const SAVE_ONLY_KEYS = new Set<string>(["autoAddSource", "openOnStartup"]);

/** 改了就要重建索引的设置：正文长度上限参与索引时的正文裁剪，分组方式决定 Post 怎么切 */
const REBUILD_KEYS = new Set<string>(["groupBy", "captionChars"]);

export class PhotoFeedSettingTab extends PluginSettingTab {
  plugin: PhotoFeedPlugin;

  constructor(app: App, plugin: PhotoFeedPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /**
   * 设置页用官方的声明式 API（Obsidian 1.13.0 起）：这里只描述「有哪些设置」，
   * 渲染、落盘、搜索索引都交给 Obsidian —— 所以这些设置项在「设置 → 搜索」里也搜得到。
   *
   * 需要自定义 DOM 的行（来源列表、文件夹选择、索引统计）走 render 逃生口：
   * 那些行 Obsidian 不管存盘，由我们自己落盘。
   *
   * ⚠️ 这个方法会被频繁调用（每次 update() + 注册时建搜索索引），只做纯计算：
   * 读文件、扫 Vault 这类重活儿必须留在 render 回调里（只在真正画那一行时才跑）。
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    const s = this.plugin.settings;
    const rangeVisible = (): boolean => this.plugin.settings.mediaRatioMode === "range";

    return [
      // ── 顶部：插件名 + 一段引导 ──
      {
        name: PLUGIN_NAME,
        searchable: false,
        render: (setting) => this.renderIntro(setting.settingEl),
      },

      // ─────────── 来源文件夹 ───────────
      {
        type: "group",
        heading: "来源文件夹",
        cls: "pf-group-sources",
        items: [
          {
            name: "来源文件夹",
            desc: "只扫描这些文件夹里的 Markdown，把其中出现过的照片与视频聚合成信息流。可以添加多个来源。",
            aliases: ["来源", "文件夹", "扫描", "source", "folder"],
            render: (setting) => this.renderSourcesBlock(setting.settingEl),
          },
        ],
      },

      // ─────────── 发布 ───────────
      {
        type: "group",
        heading: "发布",
        items: [
          {
            name: "发布说明",
            searchable: false,
            render: (setting) =>
              this.renderPlainBlock(
                setting.settingEl,
                "pf-pub-hint",
                "视界视图右下角的 ＋ 会把选中的照片 / 视频写进 Vault，并在下面的目标文件夹里按「一个时间戳 = 一条记录」追加；" +
                  "同一天再发多条，会自动按时间顺序插进同一个 md。"
              ),
          },
          {
            name: "发布文件夹",
            desc: "发布照片 / 视频时写入的目标文件夹，不跟随 Obsidian 原生日记。",
            aliases: ["发布", "目标文件夹", "publish"],
            render: (setting) =>
              this.renderFolderRow(setting.controlEl, {
                current: this.plugin.settings.publishFolder,
                placeholder: "Vault 内的文件夹路径，或点右侧 📁 选择",
                apply: async (path): Promise<void> => {
                  if (path === this.plugin.settings.publishFolder) return;
                  this.plugin.settings.publishFolder = path;
                  await this.plugin.saveSettings();
                },
              }),
          },
          {
            name: "附件存放文件夹",
            desc: "留空 = 跟随 Obsidian 的「附件文件夹」设置；填 ./ 表示与发布出来的笔记放在同一目录。",
            render: (setting) =>
              this.renderFolderRow(setting.controlEl, {
                current: this.plugin.settings.attachmentFolder,
                placeholder: "留空 = 跟随 Obsidian 附件设置",
                apply: async (path): Promise<void> => {
                  if (path === this.plugin.settings.attachmentFolder) return;
                  this.plugin.settings.attachmentFolder = path;
                  await this.plugin.saveSettings();
                },
              }),
          },
          {
            name: "发布文件夹自动加为来源",
            desc: "开启后，发布到不在来源列表里的文件夹时自动把它加进来源，刚发布的照片立刻能在视界里看到。",
            control: { type: "toggle", key: "autoAddSource" },
          },
        ],
      },

      // ─────────── Feed 显示 ───────────
      {
        type: "group",
        heading: "Feed 显示",
        items: [
          {
            name: "默认布局",
            desc:
              "单列 Feed：照片大、带正文与来源，一条一条往下看；网格瀑布流：多列铺满、瓦片尺寸固定。" +
              "首页左下角的按钮可以随手切换，这里设的是打开时的默认值。",
            aliases: ["布局", "瀑布流", "layout"],
            control: {
              type: "dropdown",
              key: "layoutMode",
              options: { feed: "单列 Feed", grid: "网格瀑布流" },
            },
          },
          {
            name: "瀑布流瓦片尺寸",
            desc: "网格布局下每张瓦片的固定尺寸档位（窄屏会自动缩小一档，保证能排下多列）",
            control: {
              type: "dropdown",
              key: "gridTileSize",
              options: { small: "小", medium: "中（推荐）", large: "大" },
            },
          },
          {
            name: "瀑布流一格",
            desc:
              "每张照片一格：一条记录里的照片全部摊开，各占一格（照片墙的感觉，滚动时看得更多）；" +
              "每条记录一格：一条记录只占一格，多图在格子里左右滑。",
            control: {
              type: "dropdown",
              key: "gridUnit",
              options: { photo: "每张照片一格（摊开）", post: "每条记录一格" },
            },
          },
          {
            name: "分组方式",
            desc:
              "每条记录一个 Post：笔记里每一段带时间戳的记录各自独立成帖（更像 Instagram）；" +
              "每个文件一个 Post：同一篇 Markdown 里的照片合并成一帖。",
            control: {
              type: "dropdown",
              key: "groupBy",
              options: { record: "每条记录一个 Post（推荐）", file: "每个文件一个 Post" },
            },
          },
          {
            name: "每批渲染条数",
            desc: "滚动时每批追加的 Post 数量（5–40），越小越省内存",
            control: { type: "slider", key: "pageSize", min: 5, max: 40, step: 1 },
          },
          {
            name: "图片最大高度",
            desc: "照片区域占屏幕高度的上限（40–90vh）。超过时照片框会整体缩窄，不会出现左右留白",
            control: { type: "slider", key: "imageMaxHeight", min: 40, max: 90, step: 2 },
          },

          // ── 照片框比例（照片框大小参差的根治手段，按模式显示不同的下拉框）──
          {
            name: "照片框比例",
            desc:
              "限制范围：比例落在区间内的照片原样显示、完全不裁，只有超出区间的极端图（手机长截图、全景横幅）才裁到边界值；" +
              "统一比例：全部裁成同一个形状，整列最齐但都会裁。",
            control: {
              type: "dropdown",
              key: "mediaRatioMode",
              options: {
                original: "原始比例（不裁剪）",
                range: "限制范围（推荐）",
                fixed: "统一比例（最整齐）",
              },
            },
          },
          {
            name: "最窄",
            desc: `比 ${ratioLabel(s.mediaRatioMin, RATIO_MIN_OPTIONS)} 更瘦的图会被裁到这个比例`,
            visible: rangeVisible,
            control: {
              type: "dropdown",
              key: "mediaRatioMin",
              options: ratioOptions(RATIO_MIN_OPTIONS),
            },
          },
          {
            name: "最宽",
            desc: `比 ${ratioLabel(s.mediaRatioMax, RATIO_MAX_OPTIONS)} 更宽的图会被裁到这个比例`,
            visible: rangeVisible,
            control: {
              type: "dropdown",
              key: "mediaRatioMax",
              options: ratioOptions(RATIO_MAX_OPTIONS),
            },
          },
          {
            name: "统一比例",
            desc: "所有 Post 的照片框都是这个形状",
            visible: (): boolean => this.plugin.settings.mediaRatioMode === "fixed",
            control: {
              type: "dropdown",
              key: "mediaRatioFixed",
              options: ratioOptions(RATIO_FIXED_OPTIONS),
            },
          },

          {
            name: "显示记录文字",
            desc: "照片下方是否显示该记录的正文（关闭后 Feed 只剩照片和日期）",
            control: { type: "toggle", key: "showCaption" },
          },
          {
            name: "正文显示字数上限",
            desc: "超过部分折叠为「查看原记录」（40–600 字）",
            control: { type: "slider", key: "captionChars", min: 40, max: 600, step: 20 },
          },
          {
            name: "显示来源",
            desc: "在照片下方显示来源名与来源说明；关掉后首页与大图里都不再出现来源",
            control: { type: "toggle", key: "showSourceDesc" },
          },
          {
            name: "卡片样式",
            desc: "显示卡片圆角与阴影；关闭后是贴边无缝的沉浸式照片流",
            control: { type: "toggle", key: "cardStyle" },
          },
        ],
      },

      // ─────────── 启动 ───────────
      {
        type: "group",
        heading: "启动",
        items: [
          {
            name: "启动时打开照片流",
            desc: "Obsidian 启动后自动打开照片流（直接读索引，秒开）",
            control: { type: "toggle", key: "openOnStartup" },
          },
        ],
      },

      // ─────────── 数据 ───────────
      {
        type: "group",
        heading: "数据",
        items: [
          {
            name: "索引统计",
            desc: "当前已索引的记录与媒体数量",
            aliases: ["索引", "统计", "index"],
            render: (setting) => this.renderStats(setting.settingEl),
          },
          {
            name: "重建索引",
            desc: "清空现有索引并重新扫描全部来源文件夹。来源目录变更后会自动重建，一般无需手动操作。",
            render: (setting) => {
              setting.addButton((b) =>
                b.setDestructive().setButtonText("重建索引").onClick(async () => {
                  b.setDisabled(true);
                  try {
                    await this.plugin.rebuildIndex();
                    // 上面的统计要跟着变：重建完重跑一遍定义
                    this.update();
                  } catch (e) {
                    console.error(e);
                  } finally {
                    b.setDisabled(false);
                  }
                })
              );
            },
          },
        ],
      },
    ];
  }

  // ─────────────── 声明式控件的读写 ───────────────

  /** 比例值存的是数字，但下拉框的选项 key 是字符串 —— 不转的话下拉框会渲染成空白 */
  getControlValue(key: string): unknown {
    const v = (this.plugin.settings as unknown as Record<string, unknown>)[key];
    return RATIO_KEYS.has(key) ? String(v) : v;
  }

  /**
   * 声明式控件改值后由 Obsidian 调用。
   * 统一做三件事：同步写进 settings（UI 立刻反映）→ 异步落盘 → 补上旧 onChange 里的副作用
   * （通知 Feed 重排；分组方式 / 字数上限还要重建索引）。
   */
  setControlValue(key: string, value: unknown): void {
    const s = this.plugin.settings as unknown as Record<string, unknown>;
    if (RATIO_KEYS.has(key)) this.applyRatio(key, Number(value));
    else s[key] = value;

    // 比例相关的行要**立刻**重绘：切模式要显隐不同的下拉框、说明里的「当前比例」也要刷新。
    // 放在落盘之前，用户不用等一次磁盘写入才看到变化。
    if (key === "mediaRatioMode" || RATIO_KEYS.has(key)) this.update();

    void this.plugin.saveSettings();

    if (REBUILD_KEYS.has(key)) {
      new Notice(
        `📷 照片流：${key === "groupBy" ? "分组方式" : "字数上限"}已变更，正在重建索引…`
      );
      void this.plugin.rebuildIndex();
    } else if (!SAVE_ONLY_KEYS.has(key)) {
      this.plugin.notifyIndexChanged("settings");
    }
  }

  /** 比例改值：顺手保证「最窄 ≤ 最宽」恒成立（否则区间会被写成一个不可能的区间） */
  private applyRatio(key: string, value: number): void {
    const s = this.plugin.settings;
    if (key === "mediaRatioMin") {
      s.mediaRatioMin = value;
      if (s.mediaRatioMin > s.mediaRatioMax) s.mediaRatioMax = s.mediaRatioMin;
    } else if (key === "mediaRatioMax") {
      s.mediaRatioMax = value;
      if (s.mediaRatioMax < s.mediaRatioMin) s.mediaRatioMin = s.mediaRatioMax;
    } else {
      s.mediaRatioFixed = value;
    }
  }

  // ─────────────── 自定义行（render 逃生口） ───────────────

  /**
   * 整行接管：清掉 Obsidian 画的那一行，换成我们自己的 DOM。
   * 设置行本身是 flex，自定义块要铺满宽度就得改回 block（样式在 styles.css 的 .pf-row-block）。
   */
  private takeOverRow(host: HTMLElement, cls?: string): HTMLElement {
    host.empty();
    host.addClass("pf-row-block");
    if (cls) host.addClass(cls);
    return host;
  }

  /** 顶部：插件名 + 引导文案 */
  private renderIntro(host: HTMLElement): void {
    const el = this.takeOverRow(host);
    el.createDiv({ cls: "pf-settings-title", text: PLUGIN_NAME });
    el.createDiv({ cls: "pf-settings-intro" }).setText(
      "只扫描下面配置的来源文件夹里的 Markdown，把其中出现过的照片与视频聚合成 Instagram 风格的信息流。" +
        "媒体仍然是 Vault 里的原文件：不复制、不改名、不生成缩略图，也不会修改任何原笔记。" +
        "（右下角的 ＋ 可以把手机 / 电脑上的照片直接发布进来。）"
    );
  }

  /** 一整行的说明文字 */
  private renderPlainBlock(host: HTMLElement, cls: string, text: string): void {
    this.takeOverRow(host).createDiv({ cls, text });
  }

  /** 索引统计：总量一行 + 分来源一行 */
  private renderStats(host: HTMLElement): void {
    const el = this.takeOverRow(host);
    const stats = this.plugin.indexer.stats();
    el.createDiv({
      cls: "pf-settings-stats",
      text:
        stats.photos || stats.posts
          ? `当前索引：${stats.posts} 条记录 · ${stats.photos} 个媒体 · 来自 ${stats.withPhotos} 个文件（已扫描 ${stats.scanned} 个）`
          : "当前索引为空：先配置来源文件夹，或点下面的「重建索引」。",
    });
    if (Object.keys(stats.bySource).length) {
      el.createDiv({
        cls: "pf-settings-stats-detail",
        text: Object.entries(stats.bySource)
          .map(([k, v]) => `${k} ${v} 条`)
          .join(" · "),
      });
    }
  }

  /**
   * 文件夹选择行：路径输入框（带文件夹建议）+ 「📁 选择」按钮，画在设置行的右侧控件区。
   * 不用自带的 folder 控件是因为这儿要允许留空（跟随 Obsidian 附件设置）和 ./（与笔记同目录）。
   */
  private renderFolderRow(
    controlEl: HTMLElement,
    opts: { current: string; placeholder: string; apply: (path: string) => Promise<void> }
  ): void {
    const row = controlEl.createDiv({ cls: "pf-pub-row" });
    // 让控件区吃满整行剩余宽度（样式见 styles.css 的 .setting-item-control.pf-folder-row）
    controlEl.addClass("pf-folder-row");
    const input = row.createEl("input", {
      cls: "pf-pub-path",
      attr: { type: "text", placeholder: opts.placeholder, spellcheck: "false" },
    });
    input.value = opts.current;

    new FolderSuggest(this.app, input, (path) => {
      input.value = path;
      void opts.apply(path);
    });
    input.addEventListener("change", () => {
      void opts.apply(input.value.trim().replace(/\/+$/, ""));
    });

    const pickBtn = row.createEl("button", {
      cls: "pf-pub-pick",
      text: "📁 选择",
      attr: { title: "从 Vault 中选择文件夹" },
    });
    pickBtn.addEventListener("click", () => {
      new FolderPickerModal(this.app, (path) => {
        input.value = path;
        void opts.apply(path);
      }).open();
    });
  }

  /**
   * 来源列表：整行接管。每行是 启用勾选 / 路径（带建议）/ 选择 / 删除 / 只读显示名 / 说明，
   * 一个声明式控件装不下这种表单，所以走 render —— 落盘也由我们自己负责（applySources）。
   */
  private renderSourcesBlock(host: HTMLElement): void {
    const el = this.takeOverRow(host);
    const listEl = el.createDiv({ cls: "pf-src-list" });

    const renderList = (): void => {
      listEl.empty();
      const sources = this.plugin.settings.sources;
      if (!sources.length) {
        listEl.createDiv({
          cls: "pf-src-empty",
          text: "还没有来源文件夹。点下面的「＋ 添加来源文件夹」开始吧。",
        });
        return;
      }
      for (const src of sources) {
        const row = listEl.createDiv({ cls: "pf-src-row" });
        if (!src.enabled) row.addClass("pf-src-disabled");

        // 第一行：启用 + 路径 + 选择 + 删除
        const line1 = row.createDiv({ cls: "pf-src-line" });

        const enable = line1.createEl("input", {
          cls: "pf-src-enabled",
          attr: { type: "checkbox", title: "启用 / 停用该来源" },
        });
        enable.checked = src.enabled;
        enable.addEventListener("change", () => {
          src.enabled = enable.checked;
          void this.applySources(() => renderList(), true);
        });

        const pathInput = line1.createEl("input", {
          cls: "pf-src-path",
          attr: {
            type: "text",
            placeholder: "Vault 内的文件夹路径，或点右侧 📁 选择",
            spellcheck: "false",
          },
        });
        pathInput.value = src.path;

        // 换文件夹 = 显示名跟着换（显示名不存盘，永远由文件夹末级名派生）。
        const applyNewPath = (raw: string): boolean => {
          const p = raw.trim().replace(/\/+$/, "");
          if (!p) return false;
          if (this.plugin.settings.sources.some((s) => s !== src && s.path === p)) {
            new Notice("该文件夹已在来源列表中");
            return false;
          }
          const nextName = folderName(p);
          // 重选「同一个」文件夹也要顺手纠正对不上的旧名字，
          // 否则这条会一直卡在错误的名字上，怎么点都改不过来。
          if (p === src.path && src.name === nextName) return false;
          src.path = p;
          src.name = nextName;
          void this.applySources(() => renderList(), true);
          return true;
        };

        new FolderSuggest(this.app, pathInput, (p) => {
          if (applyNewPath(p)) pathInput.value = src.path;
        });
        pathInput.addEventListener("change", () => {
          if (!applyNewPath(pathInput.value)) pathInput.value = src.path;
        });

        const pickBtn = line1.createEl("button", {
          cls: "pf-src-pick",
          text: "📁 选择",
          attr: { title: "从 Vault 中选择文件夹" },
        });
        pickBtn.addEventListener("click", () => {
          new FolderPickerModal(this.app, (p) => {
            applyNewPath(p);
          }).open();
        });

        const delBtn = line1.createEl("button", {
          cls: "pf-src-del",
          text: "删除",
          attr: { title: "从照片流移除该来源（源文件不动）" },
        });
        delBtn.addEventListener("click", () => {
          const i = this.plugin.settings.sources.indexOf(src);
          if (i >= 0) this.plugin.settings.sources.splice(i, 1);
          void this.applySources(() => renderList(), true);
        });

        // 第二行：显示名（只读，跟随文件夹末级名）+ 说明
        const line2 = row.createDiv({ cls: "pf-src-line" });

        line2.createSpan({
          cls: "pf-src-name",
          text: src.name,
          attr: { title: "显示名跟随文件夹末级名，换文件夹就会跟着变" },
        });

        const descInput = line2.createEl("input", {
          cls: "pf-src-desc",
          attr: { type: "text", placeholder: "说明（可选），如「我的绘画记录」", spellcheck: "false" },
        });
        descInput.value = src.desc;
        descInput.addEventListener("change", () => {
          const v = descInput.value.trim();
          if (v === src.desc) return;
          src.desc = v;
          // 同上：改完说明也要重绘，避免 DOM 行绑在旧对象上
          void this.applySources(() => renderList(), false);
        });
      }
    };
    renderList();

    const addRow = el.createDiv({ cls: "pf-src-addrow" });
    const addBtn = addRow.createEl("button", {
      cls: "pf-src-add",
      text: "＋ 添加来源文件夹",
    });
    addBtn.addEventListener("click", () => {
      new FolderPickerModal(this.app, (p) => {
        if (this.plugin.settings.sources.some((s) => s.path === p)) {
          new Notice("该文件夹已在来源列表中");
          return;
        }
        this.plugin.settings.sources.push({
          id: uid(),
          path: p,
          name: folderName(p),
          type: "personal",
          desc: "",
          enabled: true,
        });
        void this.applySources(() => renderList(), true);
      }).open();
    });
  }

  /**
   * 来源配置变更后的统一处理：
   *  - rebuild=true：路径 / 启用状态 / 增删 → 全量重建索引
   *  - rebuild=false：只改了名称 / 类型 / 说明 → 直接原地改已索引的 Post，不重建
   */
  private async applySources(after?: () => void, rebuild = true): Promise<void> {
    this.plugin.settings.sources = normalizeSources(this.plugin.settings.sources);
    await this.plugin.saveSettings();
    if (after) after();

    if (!rebuild) {
      // 元信息变了：把对应来源的 Post 就地改名，避免一次全量扫描
      this.plugin.indexer.resyncSourceMeta();
      this.plugin.notifyIndexChanged("settings");
      return;
    }

    new Notice("📷 照片流：来源已变更，正在重建索引…");
    await this.plugin.rebuildIndex();
    // 重建会改统计数字，重跑一遍定义把它们刷新出来
    this.update();
  }
}
