import { App, TFile, setIcon } from "obsidian";
import type { Photo } from "../types";
import { kindOf } from "../types";
import {
  frameCrops,
  frameRatio,
  ratioToCss,
  type FrameRatioConfig,
} from "../utils/ratio";

export interface CarouselOptions {
  app: App;
  photos: Photo[];
  /** 照片框比例策略（原始 / 限制范围 / 统一比例） */
  ratio: FrameRatioConfig;
  /** 点击图片 / 视频右上角全屏按钮（进入 Lightbox） */
  onOpen: (index: number) => void;
}

/** 视口外多远开始加载媒体（px） */
const LAZY_MARGIN = "900px";
/** 判定为拖拽而非点击的位移阈值（px） */
const DRAG_THRESHOLD = 6;

/** 取当前运行环境的 IntersectionObserver（老内核 / 极旧移动端 WebView 可能没有） */
function getIO(): typeof IntersectionObserver | undefined {
  return (window as unknown as { IntersectionObserver?: typeof IntersectionObserver })
    .IntersectionObserver;
}

/**
 * Instagram 风格多图轮播：
 *  - CSS scroll-snap 横向滚动，手机原生惯性滑动
 *  - 桌面：鼠标拖拽 + 左右按钮 + 滚轮横向
 *  - 张数角标（右上角 1/N）是唯一的翻页提示，照片上不再叠圆点
 *  - 媒体按需加载（IntersectionObserver），不一次性拉全部原图
 *  - 首图加载完成后撑开容器（按设置的比例策略），避免布局跳动
 *  - 视频：内嵌播放器（默认不自动播放，点播放键才播），右上角有全屏按钮
 */
export class Carousel {
  private app: App;
  private photos: Photo[];
  private onOpen: (index: number) => void;
  private ratioCfg: FrameRatioConfig;

  private mediaEl: HTMLElement;
  private trackEl: HTMLElement;
  private counterEl: HTMLElement | null = null;
  private prevBtn: HTMLElement | null = null;
  private nextBtn: HTMLElement | null = null;

  private imgObserver: IntersectionObserver | null = null;
  private onScroll = (): void => this.queueActiveUpdate();
  private onResize = (): void => this.queueActiveUpdate();
  private rafId = 0;
  private active = 0;
  private dragMoved = 0;
  private ratioApplied = false;

  constructor(mediaEl: HTMLElement, opts: CarouselOptions) {
    this.app = opts.app;
    this.photos = opts.photos;
    this.onOpen = opts.onOpen;
    this.ratioCfg = opts.ratio;
    this.mediaEl = mediaEl;
    this.mediaEl.addClass("pf-media");

    this.trackEl = this.mediaEl.createDiv({ cls: "pf-track" });

    if (this.photos.length > 1) {
      this.counterEl = this.mediaEl.createDiv({ cls: "pf-counter" });
      this.prevBtn = this.createArrow("‹", "上一张", -1);
      this.nextBtn = this.createArrow("›", "下一张", 1);
    }

    this.buildSlides();
    this.setupLazyLoad();
    this.bindScroll();
    this.bindDrag();
    this.updateActive(0);
  }

  destroy(): void {
    this.imgObserver?.disconnect();
    this.imgObserver = null;
    this.trackEl.removeEventListener("scroll", this.onScroll);
    window.removeEventListener("resize", this.onResize);
    if (this.rafId) window.cancelAnimationFrame(this.rafId);
  }

  private createArrow(glyph: string, label: string, dir: number): HTMLElement {
    const btn = this.mediaEl.createEl("button", {
      cls: `pf-arrow pf-arrow-${dir < 0 ? "prev" : "next"}`,
      text: glyph,
      attr: { type: "button", "aria-label": label, title: label },
    });
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.scrollTo(this.active + dir);
    });
    return btn;
  }

  private buildSlides(): void {
    const frag = document.createDocumentFragment();
    this.photos.forEach((photo, i) => {
      const slide = createDiv({ cls: "pf-slide" });
      const kind = kindOf(photo);
      if (kind === "video") slide.addClass("pf-slide-video");
      const src = this.resolveSrc(photo);
      if (!src) {
        slide.addClass("pf-slide-broken");
        slide.createDiv({ cls: "pf-broken", text: "媒体已不在 Vault 中" });
      } else if (kind === "video") {
        this.buildVideoSlide(slide, photo, src, i);
      } else {
        this.buildImageSlide(slide, photo, src, i);
      }
      // 视频上点击交给播放器，不在整块 slide 上挂「打开大图」
      if (kind !== "video") {
        slide.addEventListener("click", () => {
          if (this.dragMoved > DRAG_THRESHOLD) return;
          this.onOpen(i);
        });
      }
      frag.appendChild(slide);
    });
    this.trackEl.appendChild(frag);
  }

  private buildImageSlide(slide: HTMLElement, photo: Photo, src: string, i: number): void {
    const img = slide.createEl("img", {
      cls: "pf-img",
      attr: {
        alt: photo.caption || "",
        decoding: "async",
        draggable: "false",
        "data-pf-src": src,
        loading: i === 0 ? "eager" : "lazy",
      },
    });
    img.addEventListener("load", () => {
      slide.addClass("pf-loaded");
      if (i === 0) this.applyRatio(img.naturalWidth, img.naturalHeight);
    });
    img.addEventListener("error", () => {
      slide.addClass("pf-slide-broken");
    });
    // 首图若已缓存（complete），load 事件不会再触发
    if (img.complete && img.naturalWidth > 0) {
      slide.addClass("pf-loaded");
      this.applyRatio(img.naturalWidth, img.naturalHeight);
    }
  }

  /** 视频：内嵌播放器 + 右上角全屏按钮；绝不自动播放 */
  private buildVideoSlide(slide: HTMLElement, photo: Photo, src: string, i: number): void {
    const video = slide.createEl("video", {
      cls: "pf-video",
      attr: {
        controls: "true",
        preload: "metadata",
        playsinline: "true",
        "data-pf-src": src,
        "aria-label": photo.caption || "视频",
      },
    });
    video.addEventListener("loadedmetadata", () => {
      slide.addClass("pf-loaded");
      if (i === 0) this.applyRatio(video.videoWidth, video.videoHeight);
    });
    video.addEventListener("error", () => {
      slide.addClass("pf-slide-broken");
    });

    const expand = slide.createEl("button", {
      cls: "pf-video-expand",
      attr: { type: "button", "aria-label": "全屏查看", title: "全屏查看" },
    });
    setIcon(expand, "maximize-2");
    expand.addEventListener("click", (e) => {
      e.stopPropagation();
      this.onOpen(i);
    });

    const badge = slide.createDiv({ cls: "pf-video-badge" });
    setIcon(badge, "play");
    badge.createSpan({ text: "视频" });
  }

  /** 本地媒体 → Obsidian 资源地址；远程媒体直用 URL；文件不存在返回 null */
  private resolveSrc(photo: Photo): string | null {
    if (photo.remote) return photo.path;
    const f = this.app.vault.getAbstractFileByPath(photo.path);
    if (!(f instanceof TFile)) return null;
    return this.app.vault.getResourcePath(f);
  }

  /**
   * 设置照片框比例（只做一次，避免布局跳动）。
   *  - original：写入原图比例 → 不裁剪
   *  - range / fixed：写入目标比例并打上 pf-cover → 超出部分裁掉填满
   */
  private applyRatio(w: number, h: number): void {
    if (this.ratioApplied) return;
    if (!w || !h) return;
    this.ratioApplied = true;
    const target = frameRatio(w, h, this.ratioCfg);
    if (target === null) {
      this.mediaEl.style.setProperty("--pf-ratio", ratioToCss(w / h));
      return;
    }
    if (frameCrops(this.ratioCfg.mode)) this.mediaEl.addClass("pf-cover");
    this.mediaEl.style.setProperty("--pf-ratio", ratioToCss(target));
  }

  /** 懒加载：进入视口前 LAZY_MARGIN 才开始请求原文件 */
  private setupLazyLoad(): void {
    const els = Array.from(this.trackEl.querySelectorAll<HTMLElement>("[data-pf-src]"));
    const IO = getIO();
    if (!IO) {
      for (const el of els) this.loadMedia(el);
      return;
    }
    this.imgObserver = new IO(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target as HTMLElement;
          this.imgObserver?.unobserve(el);
          this.loadMedia(el);
        }
      },
      { root: null, rootMargin: LAZY_MARGIN, threshold: 0.01 }
    );
    for (const el of els) this.imgObserver.observe(el);
  }

  private loadMedia(el: HTMLElement): void {
    const src = el.getAttribute("data-pf-src");
    if (!src || el.getAttribute("src")) return;
    el.setAttribute("src", src);
  }

  // ─────────────── 滚动 / 拖拽 ───────────────

  private bindScroll(): void {
    this.trackEl.addEventListener("scroll", this.onScroll, { passive: true });
    window.addEventListener("resize", this.onResize);
  }

  private queueActiveUpdate(): void {
    if (this.rafId) return;
    this.rafId = window.requestAnimationFrame(() => {
      this.rafId = 0;
      const w = this.trackEl.clientWidth;
      if (!w) return;
      const idx = Math.round(this.trackEl.scrollLeft / w);
      this.updateActive(Math.max(0, Math.min(this.photos.length - 1, idx)));
    });
  }

  private updateActive(index: number): void {
    this.active = index;
    if (this.counterEl) this.counterEl.setText(`${index + 1}/${this.photos.length}`);
    if (this.prevBtn) this.prevBtn.toggleClass("pf-arrow-off", index === 0);
    if (this.nextBtn) {
      this.nextBtn.toggleClass("pf-arrow-off", index === this.photos.length - 1);
    }
  }

  scrollTo(index: number): void {
    const clamped = Math.max(0, Math.min(this.photos.length - 1, index));
    this.trackEl.scrollTo({
      left: clamped * this.trackEl.clientWidth,
      behavior: "smooth",
    });
  }

  /** 桌面鼠标拖拽（触摸交给原生滚动） */
  private bindDrag(): void {
    let startX = 0;
    let startScroll = 0;
    let active = false;

    this.trackEl.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch") return;
      if (this.photos.length < 2) return;
      active = true;
      startX = e.clientX;
      startScroll = this.trackEl.scrollLeft;
      this.dragMoved = 0;
      this.trackEl.addClass("pf-dragging");
    });

    this.trackEl.addEventListener("pointermove", (e) => {
      if (!active) return;
      const dx = e.clientX - startX;
      this.dragMoved = Math.abs(dx);
      if (this.dragMoved > DRAG_THRESHOLD) {
        this.trackEl.scrollLeft = startScroll - dx;
      }
    });

    const end = (): void => {
      if (!active) return;
      active = false;
      this.trackEl.removeClass("pf-dragging");
      // 吸附到最近一张
      const w = this.trackEl.clientWidth || 1;
      this.scrollTo(Math.round(this.trackEl.scrollLeft / w));
      // 稍后复位拖拽标记，避免误吞下一次点击
      window.setTimeout(() => {
        this.dragMoved = 0;
      }, 60);
    };
    this.trackEl.addEventListener("pointerup", end);
    this.trackEl.addEventListener("pointercancel", end);
    this.trackEl.addEventListener("pointerleave", end);

    // 横向滚轮（触控板 / 鼠标横滑轮）
    this.trackEl.addEventListener(
      "wheel",
      (e) => {
        if (this.photos.length < 2) return;
        if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
        e.preventDefault();
        this.trackEl.scrollLeft += e.deltaX;
      },
      { passive: false }
    );

    // 拖拽结束时抑制 click
    this.trackEl.addEventListener(
      "click",
      (e) => {
        if (this.dragMoved > DRAG_THRESHOLD) {
          e.stopPropagation();
          e.preventDefault();
        }
      },
      true
    );
  }
}
