import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import { Feed } from "../components/Feed";
import { Lightbox } from "../components/Lightbox";
import { openPostSource } from "../components/PostCard";
import { PublishModal } from "../publish/PublishModal";
import type PhotoFeedPlugin from "../main";
import type { FeedPost, FeedLayout, GridTileSize, GridUnit } from "../types";
import type { FrameRatioConfig } from "../utils/ratio";

export const PHOTO_FEED_VIEW_TYPE = "photo-feed";

/**
 * 筛选状态。
 *  - src："all" 或某个来源的显示名（= Post.src，就是设置页里配的显示名称）
 *  - year："all" 或 "YYYY"
 *  - from/to：起始/结束日期 "YYYY-MM-DD"，空串表示不限
 */
interface FilterState {
  src: string;
  year: string;
  from: string;
  to: string;
}

const NO_FILTER: FilterState = { src: "all", year: "all", from: "", to: "" };

/**
 * 视界视图：
 *  单列 Instagram 风格 Feed ⇄ 多列网格瀑布流（左下角按钮随手切换）
 *  筛选收进左下角浮动按钮（点开才展开面板），发布按钮在右下角
 *  打开即读索引（秒开），索引变化时按滚动位置决定原地刷新还是提示
 */
export class PhotoFeedView extends ItemView {
  plugin: PhotoFeedPlugin;

  private rootEl!: HTMLElement;
  private scrollEl!: HTMLElement;
  private feedEl!: HTMLElement;
  private chipsEl!: HTMLElement;
  private yearSel!: HTMLSelectElement;
  private fromInput!: HTMLInputElement;
  private toInput!: HTMLInputElement;
  private resetBtn!: HTMLElement;
  private statEl!: HTMLElement;
  private pillEl!: HTMLElement;
  private panelEl!: HTMLElement;
  private filterFab!: HTMLElement;
  private layoutFab!: HTMLElement;

  private feed!: Feed;
  private built = false;
  private currentPosts: FeedPost[] = [];
  private filter: FilterState = { ...NO_FILTER };
  private indexListener = (source: "settings" | "index"): void => this.onIndexChanged(source);

  constructor(leaf: WorkspaceLeaf, plugin: PhotoFeedPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return PHOTO_FEED_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "视界";
  }

  getIcon(): string {
    return "image";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("pf-view-content");
    this.buildSkeleton();

    this.feed = new Feed(
      this.feedEl,
      this.app,
      {
        onOpenPhoto: (post, index) => this.openLightbox(post, index),
        onOpenFile: (post) => void openPostSource(this.app, post),
      },
      this.feedConfig()
    );
    this.feed.setEmptyText(
      "还没有照片。点右下角 ＋ 发布照片或视频，或去设置里配置「来源文件夹」。"
    );

    // 点面板/按钮以外的地方、按 Esc → 收起筛选面板
    this.registerDomEvent(document, "click", (e) => {
      if (!this.panelOpen()) return;
      const t = e.target as Node | null;
      if (t && (this.panelEl.contains(t) || this.filterFab.contains(t))) return;
      this.closePanel();
    });
    this.registerDomEvent(document, "keydown", (e) => {
      if (e.key === "Escape") this.closePanel();
    });

    this.built = true;
    this.plugin.onIndexChanged(this.indexListener);
    this.render();
  }

  async onClose(): Promise<void> {
    this.plugin.offIndexChanged(this.indexListener);
    this.built = false;
    this.contentEl.empty();
  }

  // ─────────────── 骨架 ───────────────

  private buildSkeleton(): void {
    this.rootEl = this.contentEl.createDiv({ cls: "pf-root" });

    // 页面内不再放居中标题：标签页标题栏已经写着「视界」，重复且占地方
    this.scrollEl = this.rootEl.createDiv({ cls: "pf-scroll" });
    this.feedEl = this.scrollEl.createDiv({ cls: "pf-feed-inner" });

    // 左下角：布局切换（叠在筛选按钮上方）
    this.layoutFab = this.rootEl.createEl("button", {
      cls: "pf-fab pf-fab-layout",
      attr: { type: "button" },
    });
    this.syncLayoutFab();
    this.layoutFab.addEventListener("click", () => this.toggleLayout());

    // 左下角：筛选面板 + 浮动按钮
    this.buildFilterPanel();
    this.filterFab = this.rootEl.createEl("button", {
      cls: "pf-fab pf-fab-filter",
      attr: { type: "button", "aria-label": "筛选", title: "筛选" },
    });
    setIcon(this.filterFab, "sliders-horizontal");
    this.filterFab.addEventListener("click", () => this.togglePanel());

    // 右下角：发布照片 / 视频
    const publishFab = this.rootEl.createEl("button", {
      cls: "pf-fab pf-fab-publish",
      attr: { type: "button", "aria-label": "发布照片或视频", title: "发布照片或视频" },
    });
    setIcon(publishFab, "plus");
    publishFab.addEventListener("click", () => this.openPublish());

    // 有新照片提示（滚动靠下时不打断浏览）
    this.pillEl = this.rootEl.createDiv({ cls: "pf-pill" });
    this.pillEl.hide();
    const pillBtn = this.pillEl.createEl("button", {
      cls: "pf-pill-btn",
      attr: { type: "button" },
    });
    pillBtn.createSpan({ cls: "pf-pill-dot" });
    pillBtn.createSpan({ text: "有新照片 · 点击刷新" });
    pillBtn.addEventListener("click", () => {
      this.pillEl.hide();
      this.render();
      this.scrollEl.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  private buildFilterPanel(): void {
    const panel = this.rootEl.createDiv({ cls: "pf-filter-panel" });
    this.panelEl = panel;
    panel.createDiv({ cls: "pf-panel-title", text: "筛选" });

    this.chipsEl = panel.createDiv({ cls: "pf-chips" });
    this.renderSourceChips();

    const filters = panel.createDiv({ cls: "pf-filters" });

    this.yearSel = filters.createEl("select", {
      cls: "pf-select",
      attr: { "aria-label": "按年份筛选" },
    });
    this.yearSel.addEventListener("change", () => {
      this.filter.year = this.yearSel.value;
      this.render();
    });

    this.fromInput = filters.createEl("input", {
      cls: "pf-date",
      attr: { type: "date", "aria-label": "起始日期" },
    });
    filters.createSpan({ cls: "pf-date-sep", text: "–" });
    this.toInput = filters.createEl("input", {
      cls: "pf-date",
      attr: { type: "date", "aria-label": "结束日期" },
    });
    for (const input of [this.fromInput, this.toInput]) {
      input.addEventListener("change", () => {
        this.filter.from = this.fromInput.value;
        this.filter.to = this.toInput.value;
        this.render();
      });
    }

    this.resetBtn = panel.createEl("button", {
      cls: "pf-reset",
      text: "重置筛选",
      attr: { type: "button" },
    });
    this.resetBtn.addEventListener("click", () => {
      this.filter = { ...NO_FILTER };
      this.fromInput.value = "";
      this.toInput.value = "";
      this.syncChips();
      this.render();
      this.scrollEl.scrollTop = 0;
    });

    // 底部一行：左边统计当前筛出多少条，右边直接跳插件设置。
    // 来源文件夹、显示项全在设置页里配，用户在这个面板里发现「没有我要的来源」时，
    // 最顺手的动作就是从这儿过去 —— 而不是跑去「设置 → 第三方插件 → Visual Feed」翻。
    const foot = panel.createDiv({ cls: "pf-panel-foot" });
    this.statEl = foot.createDiv({ cls: "pf-stat" });
    const settingsBtn = foot.createEl("button", {
      cls: "pf-settings-btn",
      attr: { type: "button", "aria-label": "打开插件设置", title: "打开插件设置" },
    });
    setIcon(settingsBtn, "settings");
    settingsBtn.createSpan({ text: "设置" });
    settingsBtn.addEventListener("click", () => {
      this.closePanel();
      this.plugin.openSettings();
    });

    panel.hide();
  }

  // ─────────────── 面板开关 ───────────────

  private panelOpen(): boolean {
    return this.panelEl.hasClass("pf-panel-open");
  }

  private togglePanel(): void {
    if (this.panelOpen()) this.closePanel();
    else this.openPanel();
  }

  private openPanel(): void {
    this.panelEl.show();
    this.panelEl.addClass("pf-panel-open");
    this.filterFab.addClass("pf-fab-active");
  }

  private closePanel(): void {
    this.panelEl.removeClass("pf-panel-open");
    this.panelEl.hide();
    this.filterFab.removeClass("pf-fab-active");
  }

  /**
   * 来源 chips：**按索引里实际存在的来源动态生成**，标签直接用设置页里配的显示名称。
   * 这里不写死任何来源名——改了来源文件夹/换了名字，chips 跟着变。
   * 只有一个来源（或没有）时整排隐藏：「全部 / 唯一来源」两个选项没有任何意义。
   */
  private renderSourceChips(): void {
    const counts = new Map<string, number>();
    for (const p of this.plugin.indexer.getPosts()) {
      const name = (p.src || "").trim();
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    // 多的排前面（顺手把最常用的来源放在最顺手的位置）
    const names = [...counts.keys()].sort(
      (a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b, "zh")
    );

    const multi = names.length > 1;
    // 来源被改名/删掉了 → 退回「全部」；
    // 只剩一个来源时也要退回：chips 已经隐藏，用户没法再改回来，
    // 留着一个看不见的激活筛选（按钮亮着小圆点却找不到出处）最让人困惑。
    if (!multi || !names.includes(this.filter.src)) {
      this.filter.src = "all";
    }

    this.chipsEl.toggleClass("pf-chips-hidden", !multi);
    const wanted = multi ? names.join("|") : "";
    if (this.chipsEl.dataset.built === wanted) {
      this.syncChips();
      return;
    }

    this.chipsEl.empty();
    if (multi) {
      const items: [string, string][] = [["all", "全部"], ...names.map((n): [string, string] => [n, n])];
      for (const [value, label] of items) {
        const chip = this.chipsEl.createEl("button", {
          cls: "pf-chip",
          text: label,
          attr: { type: "button" },
        });
        chip.dataset.value = value;
        chip.addEventListener("click", () => {
          if (this.filter.src === value) return;
          this.filter.src = value;
          this.syncChips();
          this.render();
        });
      }
    }
    this.chipsEl.dataset.built = wanted;
    this.syncChips();
  }

  private syncChips(): void {
    for (const chip of Array.from(this.chipsEl.children) as HTMLElement[]) {
      chip.toggleClass("pf-chip-active", chip.dataset.value === this.filter.src);
    }
  }

  /** 有筛选条件生效时，在按钮上点一个小圆点提示 */
  private syncFilterBadge(): void {
    const on =
      this.filter.src !== "all" ||
      this.filter.year !== "all" ||
      !!this.filter.from ||
      !!this.filter.to;
    const dot = this.filterFab.querySelector(".pf-fab-dot");
    if (on && !dot) this.filterFab.createSpan({ cls: "pf-fab-dot" });
    else if (!on && dot) dot.remove();
  }

  /** 布局按钮的图标/提示反映「点下去会切到什么」，而不是当前状态 */
  private syncLayoutFab(): void {
    const grid = this.plugin.settings.layoutMode === "grid";
    const label = grid ? "切换到单列" : "切换到瀑布流";
    this.layoutFab.empty();
    setIcon(this.layoutFab, grid ? "layout-list" : "layout-grid");
    this.layoutFab.setAttribute("aria-label", label);
    this.layoutFab.setAttribute("title", label);
    this.layoutFab.toggleClass("pf-fab-active", grid);
  }

  /** 单列 Feed ⇄ 多列网格瀑布流：记住选择，下次打开还是这个布局 */
  private toggleLayout(): void {
    const grid = this.plugin.settings.layoutMode === "grid";
    this.plugin.settings.layoutMode = grid ? "feed" : "grid";
    this.syncLayoutFab();
    this.closePanel();
    this.render();
    this.scrollEl.scrollTop = 0;
    void this.plugin.saveSettings();
  }

  private feedConfig(): {
    pageSize: number;
    imageMaxHeight: number;
    showCaption: boolean;
    showSourceDesc: boolean;
    cardStyle: boolean;
    ratio: FrameRatioConfig;
    layout: FeedLayout;
    tileSize: GridTileSize;
    gridUnit: GridUnit;
  } {
    const s = this.plugin.settings;
    return {
      pageSize: s.pageSize,
      imageMaxHeight: s.imageMaxHeight,
      showCaption: s.showCaption,
      showSourceDesc: s.showSourceDesc,
      cardStyle: s.cardStyle,
      layout: s.layoutMode,
      tileSize: s.gridTileSize,
      gridUnit: s.gridUnit,
      ratio: {
        mode: s.mediaRatioMode,
        min: s.mediaRatioMin,
        max: s.mediaRatioMax,
        fixed: s.mediaRatioFixed,
      },
    };
  }

  // ─────────────── 渲染 ───────────────

  /** 筛选 + 排序（最新 → 最旧） */
  private selectPosts(): FeedPost[] {
    const { src, year, from, to } = this.filter;
    const list = this.plugin.indexer.getPosts().filter((p) => {
      if (src !== "all" && p.src !== src) return false;
      if (year !== "all" && !p.date.startsWith(year)) return false;
      if (from && p.date < from) return false;
      if (to && p.date > to) return false;
      return true;
    });
    list.sort((a, b) => {
      if (b.sort !== a.sort) return b.sort - a.sort;
      if (b.time !== a.time) return b.time < a.time ? -1 : 1;
      return a.file.localeCompare(b.file, "zh");
    });
    return list;
  }

  /** 年份下拉：只出现索引里真实存在的年份 */
  private syncYearOptions(): void {
    const years = new Set<string>();
    for (const p of this.plugin.indexer.getPosts()) years.add(p.date.slice(0, 4));
    const sorted = [...years].filter((y) => /^\d{4}$/.test(y)).sort().reverse();
    const wanted = ["all", ...sorted].join("|");
    if (this.yearSel.dataset.built !== wanted) {
      this.yearSel.empty();
      this.yearSel.add(new Option("全部年份", "all"));
      for (const y of sorted) this.yearSel.add(new Option(y, y));
      this.yearSel.dataset.built = wanted;
    }
    if ([...this.yearSel.options].some((o) => o.value === this.filter.year)) {
      this.yearSel.value = this.filter.year;
    } else {
      this.filter.year = "all";
      this.yearSel.value = "all";
    }
  }

  render(): void {
    if (!this.built) return;
    this.renderSourceChips();
    const posts = this.selectPosts();
    this.currentPosts = posts;
    this.syncYearOptions();
    this.syncFilterBadge();

    const prevRendered = this.feed.renderedCount;
    const prevScroll = this.scrollEl.scrollTop;
    this.feed.setConfig(this.feedConfig());
    this.feed.render(posts);
    if (prevRendered > 0 && prevScroll > 0) {
      this.feed.ensureRendered(prevRendered);
      this.scrollEl.scrollTop = prevScroll;
    }

    const photos = posts.reduce((n, p) => n + p.photos.length, 0);
    this.statEl.setText(
      posts.length ? `${posts.length} 条 · ${photos} 张媒体` : "没有符合条件的记录"
    );
  }

  /** 索引变化：滚动靠上直接刷新，正在往下看则提示 */
  private onIndexChanged(source: "settings" | "index"): void {
    if (!this.built) return;
    if (source === "settings") {
      this.render();
      return;
    }
    if (this.scrollEl.scrollTop > 400) {
      this.pillEl.show();
      return;
    }
    this.render();
  }

  private openLightbox(post: FeedPost, index: number): void {
    Lightbox.fromFeed(
      this.app,
      this.currentPosts,
      post.id,
      index,
      (p) => void openPostSource(this.app, p),
      // 大图里的来源名跟卡片共用「显示来源」开关：关掉后视图内哪个角落都不出现来源
      this.plugin.settings.showSourceDesc
    );
  }

  /** 发布照片 / 视频 */
  private openPublish(): void {
    this.closePanel();
    new PublishModal(this.app, this.plugin, () => {
      // 发布完成：回到顶部重渲染，让刚发的 Post 立刻可见
      this.scrollEl.scrollTo({ top: 0, behavior: "smooth" });
      this.render();
    }).open();
  }
}
