import { App, TFile, setIcon } from "obsidian";
import type { FeedPost, Photo } from "../types";
import type { FrameRatioConfig } from "../utils/ratio";
import { Carousel } from "./Carousel";

export interface PostCardConfig {
  imageMaxHeight: number;
  showCaption: boolean;
  showSourceDesc: boolean;
  cardStyle: boolean;
  /** 照片框比例策略 */
  ratio: FrameRatioConfig;
  /**
   * 网格 / 瀑布流瓦片：只留照片本身（不建正文与底部信息条）。
   * 瓦片尺寸固定且数量多，正文和来源挤在里面既看不清也拖慢渲染。
   */
  tile?: boolean;
}

export interface PostCardCallbacks {
  /** 点击照片 → 打开 Lightbox（index 为该照片在 post.photos 里的下标） */
  onOpenPhoto: (post: FeedPost, index: number) => void;
  /** 打开原始 Markdown（line 为记录所在行，用于定位） */
  onOpenFile: (post: FeedPost) => void;
}

export interface PostCardNode {
  el: HTMLElement;
  carousel: Carousel;
}

/**
 * 构建一个 Instagram 风格的 Post 卡片。
 * 照片是主角：卡片刻意不做顶部信息条，媒体直接打头；
 * 来源 / 日期统一收进底部一行弱化文字（小型、灰阶），最右是「打开原记录」图标。
 *
 *   照片（多图轮播 / 视频）
 *   正文（可选）
 *   来源 · 2026-09-12 09:30            ⧉
 */
export function buildPostCard(
  app: App,
  post: FeedPost,
  config: PostCardConfig,
  cb: PostCardCallbacks
): PostCardNode {
  const card = createEl("article", { cls: "pf-post" });
  if (!config.cardStyle) card.addClass("pf-post-flat");
  if (config.tile) card.addClass("pf-post-tile");

  // ── 媒体区 ──
  const mediaWrap = card.createDiv({ cls: "pf-media-wrap" });
  mediaWrap.style.setProperty("--pf-max-h", String(config.imageMaxHeight));
  const carousel = new Carousel(mediaWrap, {
    app,
    photos: post.photos,
    ratio: config.ratio,
    onOpen: (i) => cb.onOpenPhoto(post, i),
  });

  // 瓦片模式只留照片，正文和底部信息条都不建
  if (!config.tile) {
    // ── 正文（可选）──
    if (config.showCaption && (post.caption || post.photos.some((p) => p.caption))) {
      const caption = post.caption || firstPhotoCaption(post.photos);
      if (caption) {
        const body = card.createDiv({ cls: "pf-post-body" });
        const capEl = body.createDiv({ cls: "pf-caption", text: caption });
        capEl.setAttribute("title", caption);
      }
    }

    // ── 底部：来源 · 日期 · 打开原记录（全部弱化，照片才是主角）──
    const foot = card.createDiv({ cls: "pf-post-foot" });

    // 来源只留一行小字：没有底色、没有边框、没有装饰色点，别跟照片抢注意力。
    // ⚠️ 类名必须与设置页的 .pf-src-name / .pf-src-desc 区分开（加 post- 前缀），
    // 否则设置页那套「输入框样式」会按 CSS 顺序覆盖这里的文字样式（同优先级、后者胜）。
    const srcEl = foot.createDiv({ cls: "pf-post-src" });
    const nameEl = srcEl.createSpan({ cls: "pf-post-src-name", text: post.src });
    nameEl.addEventListener("click", () => cb.onOpenFile(post));
    nameEl.setAttribute("title", `打开 ${post.file}`);
    if (config.showSourceDesc && post.srcDesc) {
      srcEl.createSpan({ cls: "pf-post-src-desc", text: post.srcDesc });
    }

    foot.createSpan({
      cls: "pf-post-date-full",
      text: `${post.date}${post.time ? " " + post.time : ""}`,
    });

    const openBtn = foot.createEl("button", {
      cls: "pf-open",
      attr: { type: "button", "aria-label": "打开原记录", title: "打开原记录" },
    });
    setIcon(openBtn, "external-link");
    openBtn.addEventListener("click", () => cb.onOpenFile(post));
  }

  return { el: card, carousel };
}

const firstPhotoCaption = (photos: Photo[]): string =>
  photos.find((p) => p.caption)?.caption ?? "";

/** 打开原记录：优先跳到记录所在行 */
export async function openPostSource(app: App, post: FeedPost): Promise<void> {
  const file = app.vault.getAbstractFileByPath(post.file);
  if (!(file instanceof TFile)) return;
  const leaf = app.workspace.getLeaf("tab");
  try {
    await leaf.openFile(file, { eState: { line: post.line } });
  } catch {
    await leaf.openFile(file);
  }
}
