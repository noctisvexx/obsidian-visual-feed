import { App, TFile, setIcon } from "obsidian";
import type { FeedPost, Photo } from "../types";
import { kindOf } from "../types";
import { humanDate } from "../utils/date";

/** Lightbox 里的一条媒体 + 它所属的 Post（用于显示来源/日期/原记录） */
export interface LightboxItem {
  post: FeedPost;
  photo: Photo;
  /** 该媒体在其 Post 内的序号 */
  indexInPost: number;
}

/** 拖动超过该位移视为切换而不是点击（px） */
const SWIPE_THRESHOLD = 50;

/**
 * 全屏大图 / 视频查看器：
 *  - 左右切换（按钮 / 键盘 ← → / 触摸滑动 / 鼠标拖拽）
 *  - 显示来源 · 日期 · 当前序号 · 正文（来源那一段受「显示来源」开关控制）
 *  - 一键跳到原记录（图标按钮）
 *  - Esc / 点击背景 / 关闭按钮 退出
 * 只看原件：object-fit contain，不裁剪、不压缩；视频带原生播放器，绝不自动播放。
 */
export class Lightbox {
  private app: App;
  private items: LightboxItem[];
  private index: number;
  private onOpenFile: (post: FeedPost) => void;
  /** 是否在元信息行显示来源名（与 Feed 卡片的「显示来源」开关同一个值） */
  private showSource: boolean;

  private overlay: HTMLElement;
  private stageEl: HTMLElement;
  private imgEl: HTMLImageElement;
  private videoEl: HTMLVideoElement;
  private counterEl: HTMLElement;
  private metaEl: HTMLElement;
  private captionEl: HTMLElement;
  private prevBtn: HTMLElement;
  private nextBtn: HTMLElement;
  private swipeStartX = 0;
  private swiping = false;
  /** 当前展示的是不是视频（滚轮切换时避让播放器） */
  private videoMode = false;

  constructor(
    app: App,
    items: LightboxItem[],
    startIndex: number,
    onOpenFile: (post: FeedPost) => void,
    /** 是否显示来源名；跟 Feed 卡片共用一个设置，关掉时大图里也不出现来源 */
    showSource = true
  ) {
    this.app = app;
    this.items = items;
    this.index = Math.max(0, Math.min(items.length - 1, startIndex));
    this.onOpenFile = onOpenFile;
    this.showSource = showSource;

    this.overlay = document.body.createDiv({ cls: "pf-lightbox" });
    this.overlay.setAttribute("role", "dialog");
    this.overlay.setAttribute("aria-label", "媒体大图");

    this.stageEl = this.overlay.createDiv({ cls: "pf-lb-stage" });
    this.imgEl = this.stageEl.createEl("img", { cls: "pf-lb-img", attr: { alt: "" } });
    this.videoEl = this.stageEl.createEl("video", {
      cls: "pf-lb-video",
      attr: { controls: "true", playsinline: "true", preload: "metadata" },
    });
    this.videoEl.hide();

    const closeBtn = this.overlay.createEl("button", {
      cls: "pf-lb-close",
      attr: { type: "button", "aria-label": "关闭" },
    });
    setIcon(closeBtn, "x");
    closeBtn.addEventListener("click", () => this.close());

    this.prevBtn = this.overlay.createEl("button", {
      cls: "pf-lb-nav pf-lb-prev",
      text: "‹",
      attr: { type: "button", "aria-label": "上一张" },
    });
    this.prevBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.step(-1);
    });

    this.nextBtn = this.overlay.createEl("button", {
      cls: "pf-lb-nav pf-lb-next",
      text: "›",
      attr: { type: "button", "aria-label": "下一张" },
    });
    this.nextBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.step(1);
    });

    const bar = this.overlay.createDiv({ cls: "pf-lb-bar" });
    this.metaEl = bar.createDiv({ cls: "pf-lb-meta" });
    this.captionEl = bar.createDiv({ cls: "pf-lb-caption" });
    this.counterEl = bar.createDiv({ cls: "pf-lb-counter" });

    const openBtn = bar.createEl("button", {
      cls: "pf-lb-open",
      attr: { type: "button", "aria-label": "打开原记录", title: "打开原记录" },
    });
    setIcon(openBtn, "external-link");
    openBtn.addEventListener("click", () => {
      const item = this.items[this.index];
      if (!item) return;
      this.close();
      this.onOpenFile(item.post);
    });

    this.overlay.addEventListener("click", (e) => {
      if (e.target === this.overlay || e.target === this.stageEl) this.close();
    });
    this.overlay.addEventListener("wheel", (e) => {
      // 视频模式不抢滚轮（交给播放器 / 页面）
      if (this.videoMode) return;
      if (Math.abs(e.deltaY) < 12) return;
      this.step(e.deltaY > 0 ? 1 : -1);
    });

    this.bindSwipe(this.stageEl);
    this.bindKeys();

    this.render();
  }

  /** 从某个 Post 的某条媒体打开 */
  static fromPost(
    app: App,
    post: FeedPost,
    index: number,
    onOpenFile: (p: FeedPost) => void
  ): Lightbox {
    const items: LightboxItem[] = post.photos.map((photo, i) => ({
      post,
      photo,
      indexInPost: i,
    }));
    return new Lightbox(app, items, index, onOpenFile);
  }

  /**
   * 从整个 Feed 打开：把所有 Post 的媒体拍平成一条长列表，
   * 左右切换可以一路刷下去（个人浏览器用起来更顺）。
   */
  static fromFeed(
    app: App,
    posts: FeedPost[],
    postId: string,
    indexInPost: number,
    onOpenFile: (p: FeedPost) => void,
    showSource = true
  ): Lightbox | null {
    const items: LightboxItem[] = [];
    let start = -1;
    for (const post of posts) {
      post.photos.forEach((photo, i) => {
        if (post.id === postId && i === indexInPost) start = items.length;
        items.push({ post, photo, indexInPost: i });
      });
    }
    if (start < 0) return null;
    return new Lightbox(app, items, start, onOpenFile, showSource);
  }

  private keyHandler = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      this.step(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      this.step(1);
    }
  };

  private bindKeys(): void {
    this.overlay.tabIndex = -1;
    document.addEventListener("keydown", this.keyHandler, true);
    this.overlay.focus();
  }

  /** 触摸滑动 + 鼠标拖拽切换 */
  private bindSwipe(stage: HTMLElement): void {
    stage.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch") return;
      this.swiping = true;
      this.swipeStartX = e.clientX;
    });
    stage.addEventListener("pointerup", (e) => {
      if (!this.swiping) return;
      this.swiping = false;
      const dx = e.clientX - this.swipeStartX;
      if (Math.abs(dx) > SWIPE_THRESHOLD) this.step(dx < 0 ? 1 : -1);
    });

    let touchStartX = 0;
    this.overlay.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length !== 1) return;
        touchStartX = e.touches[0].clientX;
      },
      { passive: true }
    );
    this.overlay.addEventListener(
      "touchend",
      (e) => {
        const t = e.changedTouches[0];
        if (!t) return;
        const dx = t.clientX - touchStartX;
        if (Math.abs(dx) > SWIPE_THRESHOLD) this.step(dx < 0 ? 1 : -1);
      },
      { passive: true }
    );
  }

  private step(delta: number): void {
    if (this.items.length < 2) return;
    this.index = (this.index + delta + this.items.length) % this.items.length;
    this.render();
  }

  /** 切走时停掉上一个视频，避免后台还在放 */
  private stopVideo(): void {
    if (!this.videoEl.isConnected) return;
    try {
      if (!this.videoEl.paused) this.videoEl.pause();
    } catch {
      /* jsdom / 极旧内核没有实现 pause */
    }
    this.videoEl.removeAttribute("src");
    this.videoEl.hide();
  }

  private render(): void {
    const item = this.items[this.index];
    if (!item) return;
    const { post, photo } = item;
    const kind = kindOf(photo);
    const src = this.srcOf(photo);

    if (src && kind === "video") {
      this.videoMode = true;
      this.imgEl.removeAttribute("src");
      this.imgEl.addClass("pf-lb-hidden");
      this.videoEl.show();
      if (this.videoEl.getAttribute("src") !== src) this.videoEl.setAttribute("src", src);
    } else {
      this.videoMode = false;
      this.stopVideo();
      if (src) {
        this.imgEl.removeClass("pf-lb-hidden");
        this.imgEl.setAttribute("src", src);
        this.imgEl.setAttribute("alt", photo.caption || "");
      } else {
        this.imgEl.removeAttribute("src");
        this.imgEl.addClass("pf-lb-hidden");
      }
    }

    this.counterEl.setText(
      this.items.length > 1 ? `${this.index + 1} / ${this.items.length}` : ""
    );
    // 元信息行：来源名 + 日期时间。关掉「显示来源」后只剩日期时间（分隔符也一起收掉）。
    const when = `${humanDate(post.date)}${post.time ? " " + post.time : ""}`;
    this.metaEl.setText(this.showSource && post.src ? `${post.src} · ${when}` : when);
    const cap = photo.caption || post.caption;
    this.captionEl.setText(cap || "");
    this.captionEl.toggleClass("pf-lb-caption-empty", !cap);

    const single = this.items.length < 2;
    this.prevBtn.toggleClass("pf-lb-nav-hidden", single);
    this.nextBtn.toggleClass("pf-lb-nav-hidden", single);
  }

  private srcOf(photo: Photo): string | null {
    if (photo.remote) return photo.path;
    const f = this.app.vault.getAbstractFileByPath(photo.path);
    if (!(f instanceof TFile)) return null;
    return this.app.vault.getResourcePath(f);
  }

  close(): void {
    this.stopVideo();
    document.removeEventListener("keydown", this.keyHandler, true);
    this.overlay.remove();
  }
}
