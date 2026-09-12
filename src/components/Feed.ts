import { App } from "obsidian";
import type { FeedLayout, FeedPost, GridTileSize } from "../types";
import { buildPostCard, type PostCardConfig } from "./PostCard";
import type { Carousel } from "./Carousel";

/** 取当前运行环境的 IntersectionObserver */
function getIO(): typeof IntersectionObserver | undefined {
  return (window as unknown as { IntersectionObserver?: typeof IntersectionObserver })
    .IntersectionObserver;
}

export interface FeedCallbacks {
  onOpenPhoto: (post: FeedPost, index: number) => void;
  onOpenFile: (post: FeedPost) => void;
}

export interface FeedConfig extends PostCardConfig {
  pageSize: number;
  /** 布局：feed 单列 / grid 多列网格。缺省按 feed 处理（旧调用方不用改） */
  layout?: FeedLayout;
  /** grid 模式的瓦片尺寸档位 */
  tileSize?: GridTileSize;
}

const TILE_SIZES: GridTileSize[] = ["small", "medium", "large"];

/**
 * Feed 渲染器（两种布局共用同一套分批渲染）：
 *  - 单列 Instagram 风格 / 多列网格瀑布流，由容器类切换，CSS 负责排版
 *  - 分批渲染：每批 pageSize 条，滚动到哨兵时再追加，首屏不注入几百个 DOM
 *  - 每批渲染后释放 DOM 引用，滚动时由浏览器回收
 *  - 正在浏览时索引变化不打断，由视图层决定是否提示刷新
 */
export class Feed {
  private container: HTMLElement;
  private app: App;
  private cb: FeedCallbacks;
  private config: FeedConfig;

  private posts: FeedPost[] = [];
  private rendered = 0;
  private sentinel: HTMLElement | null = null;
  private emptyEl: HTMLElement;
  private observer: IntersectionObserver | null = null;
  private carousels: Carousel[] = [];
  /** 环境不支持 IntersectionObserver 时退化为一次性渲染（不分批） */
  private batchEnabled: boolean;

  constructor(container: HTMLElement, app: App, cb: FeedCallbacks, config: FeedConfig) {
    this.container = container;
    this.app = app;
    this.cb = cb;
    this.config = config;
    this.batchEnabled = !!getIO();
    this.container.addClass("pf-feed");
    this.syncLayoutClass();
    this.emptyEl = this.container.createDiv({ cls: "pf-empty" });
    this.emptyEl.hide();
  }

  /** 空状态文案 */
  setEmptyText(text: string): void {
    this.emptyEl.setText(text);
  }

  setConfig(config: FeedConfig): void {
    this.config = config;
    this.syncLayoutClass();
  }

  /**
   * 把布局落到容器类上，CSS 负责真正的排版：
   *  - pf-grid          → 多列网格（瀑布流式铺满）
   *  - pf-tiles-<档位>  → 瓦片固定尺寸（由 --pf-tile 决定列宽）
   * 抽成类而不是内联样式，切换布局时不用重建 DOM 之外的任何东西。
   */
  private syncLayoutClass(): void {
    const isGrid = (this.config.layout ?? "feed") === "grid";
    this.container.toggleClass("pf-grid", isGrid);
    // 尺寸档位始终挂在容器上（切回单列也不用摘），实际生效与否由 CSS 决定
    const size = this.config.tileSize ?? "medium";
    for (const s of TILE_SIZES) {
      this.container.toggleClass(`pf-tiles-${s}`, s === size);
    }
  }

  hasContent(): boolean {
    return this.rendered > 0;
  }

  /** 已渲染条数（用于刷新时保持滚动位置） */
  get renderedCount(): number {
    return this.rendered;
  }

  /** 至少渲染 count 条（同步补齐，用于刷新后恢复滚动位置） */
  ensureRendered(count: number): void {
    const target = Math.min(count, this.posts.length);
    let guard = 0;
    while (this.rendered < target && guard++ < 500) this.appendBatch();
  }

  /** 数据变更 → 重新分批渲染 */
  render(posts: FeedPost[]): void {
    this.posts = posts;
    this.clear();
    if (!posts.length) {
      this.emptyEl.show();
      return;
    }
    this.emptyEl.hide();
    this.appendBatch();
  }

  private clear(): void {
    this.observer?.disconnect();
    this.observer = null;
    for (const c of this.carousels) c.destroy();
    this.carousels = [];
    for (const el of Array.from(this.container.children)) {
      if (el === this.emptyEl) continue;
      el.remove();
    }
    this.rendered = 0;
    this.sentinel = null;
  }

  private appendBatch(): void {
    const { pageSize } = this.config;
    // 无 IO 的环境一次性渲染完，避免逐批递归
    const step = this.batchEnabled ? pageSize : Math.max(1, this.posts.length);
    const end = Math.min(this.rendered + step, this.posts.length);
    const frag = document.createDocumentFragment();
    // 网格布局下卡片退化成纯照片瓦片（不建正文 / 底部信息条）
    const cardConfig: FeedConfig = {
      ...this.config,
      tile: (this.config.layout ?? "feed") === "grid",
    };
    for (let i = this.rendered; i < end; i++) {
      const node = buildPostCard(this.app, this.posts[i], cardConfig, {
        onOpenPhoto: this.cb.onOpenPhoto,
        onOpenFile: this.cb.onOpenFile,
      });
      frag.appendChild(node.el);
      this.carousels.push(node.carousel);
    }
    const anchor = this.sentinel;
    if (anchor && anchor.parentElement === this.container) {
      this.container.insertBefore(frag, anchor);
    } else {
      this.container.appendChild(frag);
    }
    this.rendered = end;

    if (this.rendered < this.posts.length) {
      this.ensureSentinel();
      this.observeSentinel();
    } else if (anchor) {
      anchor.remove();
      this.sentinel = null;
    }
  }

  private ensureSentinel(): void {
    if (this.sentinel && this.sentinel.parentElement === this.container) return;
    this.sentinel = this.container.createDiv({ cls: "pf-sentinel" });
  }

  private observeSentinel(): void {
    if (!this.sentinel) return;
    const IO = getIO();
    if (!IO) return; // 无 IO 时已在 appendBatch 中一次性渲染完，不会有哨兵
    if (!this.observer) {
      this.observer = new IO(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) this.appendBatch();
        },
        { root: null, rootMargin: "1200px", threshold: 0 }
      );
    }
    this.observer.disconnect();
    this.observer.observe(this.sentinel);
  }
}
