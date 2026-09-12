import {
  AbstractInputSuggest,
  App,
  FuzzySuggestModal,
  Notice,
  PluginSettingTab,
  Setting,
  TFolder,
} from "obsidian";
import type PhotoFeedPlugin from "./main";
import type {
  FeedLayout,
  GridTileSize,
  GridUnit,
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

export class PhotoFeedSettingTab extends PluginSettingTab {
  plugin: PhotoFeedPlugin;

  constructor(app: App, plugin: PhotoFeedPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createDiv({ cls: "pf-settings-title", text: PLUGIN_NAME });

    const intro = containerEl.createDiv({ cls: "pf-settings-intro" });
    intro.setText(
      "只扫描下面配置的来源文件夹里的 Markdown，把其中出现过的照片与视频聚合成 Instagram 风格的信息流。" +
        "媒体仍然是 Vault 里的原文件：不复制、不改名、不生成缩略图，也不会修改任何原笔记。" +
        "（右下角的 ＋ 可以把手机 / 电脑上的照片直接发布进来。）"
    );

    // ─────────── 来源文件夹 ───────────
    new Setting(containerEl).setName("来源文件夹").setHeading();

    const listEl = containerEl.createDiv({ cls: "pf-src-list" });

    const renderSources = (): void => {
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
          void this.applySources(() => renderSources(), true);
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
          void this.applySources(() => renderSources(), true);
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
          void this.applySources(() => renderSources(), true);
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
          void this.applySources(() => renderSources(), false);
        });
      }
    };
    renderSources();

    const addRow = containerEl.createDiv({ cls: "pf-src-addrow" });
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
        void this.applySources(() => renderSources(), true);
      }).open();
    });

    // ─────────── 发布 ───────────
    new Setting(containerEl).setName("发布").setHeading();

    containerEl.createDiv({ cls: "pf-pub-hint", text:
      "视界视图右下角的 ＋ 会把选中的照片 / 视频写进 Vault，并在下面的目标文件夹里按「一个时间戳 = 一条记录」追加；" +
      "同一天再发多条，会自动按时间顺序插进同一个 md。" });

    const makeFolderRow = (
      current: string,
      placeholder: string,
      onPick: (path: string) => Promise<void>
    ): void => {
      const row = containerEl.createDiv({ cls: "pf-pub-row" });
      const input = row.createEl("input", {
        cls: "pf-pub-path",
        attr: { type: "text", placeholder, spellcheck: "false" },
      });
      input.value = current;
      new FolderSuggest(this.app, input, (p) => {
        input.value = p;
        void onPick(p);
      });
      input.addEventListener("change", () => {
        void onPick(input.value.trim().replace(/\/+$/, ""));
      });
      const pickBtn = row.createEl("button", {
        cls: "pf-pub-pick",
        text: "📁 选择",
        attr: { title: "从 Vault 中选择文件夹" },
      });
      pickBtn.addEventListener("click", () => {
        new FolderPickerModal(this.app, (p) => {
          input.value = p;
          void onPick(p);
        }).open();
      });
    };

    new Setting(containerEl)
      .setName("发布文件夹")
      .setDesc("发布照片 / 视频时写入的目标文件夹，不跟随 Obsidian 原生日记。");
    makeFolderRow(
      this.plugin.settings.publishFolder,
      "Vault 内的文件夹路径，或点右侧 📁 选择",
      async (p) => {
        if (p === this.plugin.settings.publishFolder) return;
        this.plugin.settings.publishFolder = p;
        await this.plugin.saveSettings();
      }
    );

    new Setting(containerEl)
      .setName("附件存放文件夹")
      .setDesc(
        "留空 = 跟随 Obsidian 的「附件文件夹」设置；填 ./ 表示与发布出来的笔记放在同一目录。"
      );
    makeFolderRow(
      this.plugin.settings.attachmentFolder,
      "留空 = 跟随 Obsidian 附件设置",
      async (p) => {
        if (p === this.plugin.settings.attachmentFolder) return;
        this.plugin.settings.attachmentFolder = p;
        await this.plugin.saveSettings();
      }
    );

    new Setting(containerEl)
      .setName("发布文件夹自动加为来源")
      .setDesc(
        "开启后，发布到不在来源列表里的文件夹时自动把它加进来源，刚发布的照片立刻能在视界里看到。"
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoAddSource).onChange(async (v) => {
          this.plugin.settings.autoAddSource = v;
          await this.plugin.saveSettings();
        })
      );

    // ─────────── Feed 显示 ───────────
    new Setting(containerEl).setName("Feed 显示").setHeading();

    new Setting(containerEl)
      .setName("默认布局")
      .setDesc(
        "单列 Feed：照片大、带正文与来源，一条一条往下看；" +
          "网格瀑布流：多列铺满、瓦片尺寸固定，适合一次扫很多张。" +
          "首页左下角的按钮可以随手切换，这里设的是打开时的默认值。"
      )
      .addDropdown((dd) =>
        dd
          .addOption("feed", "单列 Feed")
          .addOption("grid", "网格瀑布流")
          .setValue(this.plugin.settings.layoutMode)
          .onChange(async (v) => {
            this.plugin.settings.layoutMode = (v === "grid" ? "grid" : "feed") as FeedLayout;
            await this.plugin.saveSettings();
            this.plugin.notifyIndexChanged("settings");
          })
      );

    new Setting(containerEl)
      .setName("瀑布流瓦片尺寸")
      .setDesc("网格布局下每张瓦片的固定尺寸档位（窄屏会自动缩小一档，保证能排下多列）")
      .addDropdown((dd) =>
        dd
          .addOption("small", "小")
          .addOption("medium", "中（推荐）")
          .addOption("large", "大")
          .setValue(this.plugin.settings.gridTileSize)
          .onChange(async (v) => {
            const size = (v === "small" || v === "large" ? v : "medium") as GridTileSize;
            this.plugin.settings.gridTileSize = size;
            await this.plugin.saveSettings();
            this.plugin.notifyIndexChanged("settings");
          })
      );

    new Setting(containerEl)
      .setName("瀑布流一格")
      .setDesc(
        "每张照片一格：一条记录里的照片全部摊开，各占一格（照片墙的感觉，滚动时看得更多）；" +
          "每条记录一格：一条记录只占一格，多图在格子里左右滑。"
      )
      .addDropdown((dd) =>
        dd
          .addOption("photo", "每张照片一格（摊开）")
          .addOption("post", "每条记录一格")
          .setValue(this.plugin.settings.gridUnit)
          .onChange(async (v) => {
            this.plugin.settings.gridUnit = (v === "post" ? "post" : "photo") as GridUnit;
            await this.plugin.saveSettings();
            this.plugin.notifyIndexChanged("settings");
          })
      );

    new Setting(containerEl)
      .setName("分组方式")
      .setDesc(
        "每条记录一个 Post：笔记里每一段带时间戳的记录各自独立成帖（更像 Instagram）；" +
          "每个文件一个 Post：同一篇 Markdown 里的照片合并成一帖。"
      )
      .addDropdown((dd) =>
        dd
          .addOption("record", "每条记录一个 Post（推荐）")
          .addOption("file", "每个文件一个 Post")
          .setValue(this.plugin.settings.groupBy)
          .onChange(async (v) => {
            this.plugin.settings.groupBy = v === "file" ? "file" : "record";
            await this.plugin.saveSettings();
            new Notice("📷 照片流：分组方式已变更，正在重建索引…");
            await this.plugin.rebuildIndex();
          })
      );

    new Setting(containerEl)
      .setName("每批渲染条数")
      .setDesc("滚动时每批追加的 Post 数量（5–40），越小越省内存")
      .addSlider((s) =>
        s
          .setLimits(5, 40, 1)
          .setValue(this.plugin.settings.pageSize)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.pageSize = v;
            await this.plugin.saveSettings();
            this.plugin.notifyIndexChanged("settings");
          })
      );

    new Setting(containerEl)
      .setName("图片最大高度")
      .setDesc("照片区域占屏幕高度的上限（40–90vh）。超过时照片框会整体缩窄，不会出现左右留白")
      .addSlider((s) =>
        s
          .setLimits(40, 90, 2)
          .setValue(this.plugin.settings.imageMaxHeight)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.imageMaxHeight = v;
            await this.plugin.saveSettings();
            this.plugin.notifyIndexChanged("settings");
          })
      );

    // ── 照片框比例（照片框大小参差的根治手段，需要按模式显示不同选项）──
    const ratioBox = containerEl.createDiv({ cls: "pf-ratio-section" });
    /**
     * 比例设置提交：先同步重绘设置页（切换模式后要立刻看到对应的下拉框），
     * 再落盘并通知 Feed 重排。顺序反过来的话，用户会等一次磁盘写入才看到选项变化。
     */
    const commitRatio = (): void => {
      renderRatio();
      void this.plugin.saveSettings().then(() => this.plugin.notifyIndexChanged("settings"));
    };
    const renderRatio = (): void => {
      ratioBox.empty();
      const s = this.plugin.settings;

      new Setting(ratioBox)
        .setName("照片框比例")
        .setDesc(
          "限制范围：比例落在区间内的照片原样显示、完全不裁，只有超出区间的极端图（手机长截图、全景横幅）才裁到边界值；" +
            "统一比例：全部裁成同一个形状，整列最齐但都会裁。"
        )
        .addDropdown((dd) =>
          dd
            .addOption("original", "原始比例（不裁剪）")
            .addOption("range", "限制范围（推荐）")
            .addOption("fixed", "统一比例（最整齐）")
            .setValue(s.mediaRatioMode)
            .onChange((v) => {
              s.mediaRatioMode =
                v === "range" ? "range" : v === "fixed" ? "fixed" : "original";
              commitRatio();
            })
        );

      if (s.mediaRatioMode === "range") {
        new Setting(ratioBox)
          .setName("最窄")
          .setDesc(
            `比 ${ratioLabel(s.mediaRatioMin, RATIO_MIN_OPTIONS)} 更瘦的图会被裁到这个比例`
          )
          .addDropdown((dd) => {
            for (const o of RATIO_MIN_OPTIONS) dd.addOption(String(o.value), o.label);
            return dd.setValue(String(s.mediaRatioMin)).onChange((v) => {
              s.mediaRatioMin = Number(v);
              if (s.mediaRatioMin > s.mediaRatioMax) s.mediaRatioMax = s.mediaRatioMin;
              commitRatio();
            });
          });

        new Setting(ratioBox)
          .setName("最宽")
          .setDesc(
            `比 ${ratioLabel(s.mediaRatioMax, RATIO_MAX_OPTIONS)} 更宽的图会被裁到这个比例`
          )
          .addDropdown((dd) => {
            for (const o of RATIO_MAX_OPTIONS) dd.addOption(String(o.value), o.label);
            return dd.setValue(String(s.mediaRatioMax)).onChange((v) => {
              s.mediaRatioMax = Number(v);
              if (s.mediaRatioMax < s.mediaRatioMin) s.mediaRatioMin = s.mediaRatioMax;
              commitRatio();
            });
          });
      } else if (s.mediaRatioMode === "fixed") {
        new Setting(ratioBox)
          .setName("统一比例")
          .setDesc("所有 Post 的照片框都是这个形状")
          .addDropdown((dd) => {
            for (const o of RATIO_FIXED_OPTIONS) dd.addOption(String(o.value), o.label);
            return dd.setValue(String(s.mediaRatioFixed)).onChange((v) => {
              s.mediaRatioFixed = Number(v);
              commitRatio();
            });
          });
      }
    };
    renderRatio();

    new Setting(containerEl)
      .setName("显示记录文字")
      .setDesc("照片下方是否显示该记录的正文（关闭后 Feed 只剩照片和日期）")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showCaption).onChange(async (v) => {
          this.plugin.settings.showCaption = v;
          await this.plugin.saveSettings();
          this.plugin.notifyIndexChanged("settings");
        })
      );

    new Setting(containerEl)
      .setName("正文显示字数上限")
      .setDesc("超过部分折叠为「查看原记录」（40–600 字）")
      .addSlider((s) =>
        s
          .setLimits(40, 600, 20)
          .setValue(this.plugin.settings.captionChars)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.captionChars = v;
            await this.plugin.saveSettings();
            new Notice("📷 照片流：字数上限已变更，正在重建索引…");
            await this.plugin.rebuildIndex();
          })
      );

    new Setting(containerEl)
      .setName("显示来源")
      .setDesc("在照片下方显示来源名与来源说明；关掉后首页与大图里都不再出现来源")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showSourceDesc).onChange(async (v) => {
          this.plugin.settings.showSourceDesc = v;
          await this.plugin.saveSettings();
          this.plugin.notifyIndexChanged("settings");
        })
      );

    new Setting(containerEl)
      .setName("卡片样式")
      .setDesc("显示卡片圆角与阴影；关闭后是贴边无缝的沉浸式照片流")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.cardStyle).onChange(async (v) => {
          this.plugin.settings.cardStyle = v;
          await this.plugin.saveSettings();
          this.plugin.notifyIndexChanged("settings");
        })
      );

    // ─────────── 启动 ───────────
    new Setting(containerEl).setName("启动").setHeading();

    new Setting(containerEl)
      .setName("启动时打开照片流")
      .setDesc("Obsidian 启动后自动打开照片流（直接读索引，秒开）")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.openOnStartup).onChange(async (v) => {
          this.plugin.settings.openOnStartup = v;
          await this.plugin.saveSettings();
        })
      );

    // ─────────── 数据 ───────────
    new Setting(containerEl).setName("数据").setHeading();

    const stats = this.plugin.indexer.stats();
    const statEl = containerEl.createDiv({ cls: "pf-settings-stats" });
    statEl.setText(
      stats.photos || stats.posts
        ? `当前索引：${stats.posts} 条记录 · ${stats.photos} 个媒体 · 来自 ${stats.withPhotos} 个文件（已扫描 ${stats.scanned} 个）`
        : "当前索引为空：先配置来源文件夹，或点下面的「重建索引」。"
    );
    if (Object.keys(stats.bySource).length) {
      const lines = Object.entries(stats.bySource)
        .map(([k, v]) => `${k} ${v} 条`)
        .join(" · ");
      containerEl.createDiv({ cls: "pf-settings-stats-detail", text: lines });
    }

    new Setting(containerEl)
      .setName("重建索引")
      .setDesc("清空现有索引并重新扫描全部来源文件夹。来源目录变更后会自动重建，一般无需手动操作。")
      .addButton((b) =>
        b
          .setButtonText("重建索引")
          .setWarning()
          .onClick(async () => {
            b.setDisabled(true);
            try {
              await this.plugin.rebuildIndex();
              this.display();
            } catch (e) {
              console.error(e);
            } finally {
              b.setDisabled(false);
            }
          })
      );
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
  }
}
