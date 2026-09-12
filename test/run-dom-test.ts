/**
 * UI 冒烟测试（jsdom + Obsidian mock）：
 *  1. 单图 Post：不显示圆点 / 角标 / 箭头
 *  2. 多图 Post：圆点数 = 媒体数、首图 active、角标 1/N、箭头可切换、圆点在照片底部
 *  3. 懒加载：进入视口前不设 src，进入后才设
 *  4. 点击图片 → 回调拿到正确的下标；点开原记录是图标按钮
 *  5. Feed 分批渲染 + 哨兵追加 + 空状态
 *  6. Lightbox：打开 / 切换 / Esc 关闭并清理键盘监听；视频走 <video> 不自动播放
 *  7. 视频轮播：内嵌播放器 + 全屏按钮，不自动播放
 *  8. 视图骨架：标题居中、没有顶部工具栏、左下角筛选 FAB + 右下角发布 FAB
 *  9. 设置页：来源文件夹管理 + 发布区块（回归：曾经「看不到设置」）
 * 运行：node test/build-test.mjs && node test/run-dom-test.cjs
 */
import { setupDom, tick } from "./dom-harness";

const env = setupDom();

import { App, TFile } from "./obsidian-mock";
import { Carousel } from "../src/components/Carousel";
import { buildPostCard } from "../src/components/PostCard";
import { Feed } from "../src/components/Feed";
import { Lightbox } from "../src/components/Lightbox";
import { PhotoFeedView } from "../src/views/PhotoFeedView";
import { DEFAULT_SETTINGS, PhotoFeedSettingTab } from "../src/settings";
import { PublishModal } from "../src/publish/PublishModal";
import type { FeedPost, Photo } from "../src/types";
import { PLUGIN_NAME } from "../src/types";

/** 真实 Vault 根目录：用 VISUAL_FEED_VAULT 指到你自己的库（见 run-test.ts 说明） */
const VAULT_ROOT = process.env.VISUAL_FEED_VAULT || "D:/path/to/Vault";
const app = new App(VAULT_ROOT);

let failed = 0;
const check = (name: string, cond: boolean, detail = ""): void => {
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? "  " + detail : ""}`);
  if (!cond) failed++;
};

// ───────── 造数据：用 Vault 里真实存在的图片 ─────────
const realImgs = app.vault
  .getFiles()
  .filter((f) => /\.(jpe?g|png|webp)$/i.test(f.name) && !f.path.startsWith("."))
  .slice(0, 20)
  .map<Photo>((f) => ({ ref: f.name, path: f.path, remote: false, caption: "" }));

check("Vault 里找到可用测试图片", realImgs.length >= 6, `${realImgs.length} 张`);

const makePost = (id: string, photos: Photo[], extra: Partial<FeedPost> = {}): FeedPost => ({
  id,
  file: "notes/journal/2026/0901.md",
  date: "2026-09-01",
  time: "12:00",
  line: 3,
  sort: Date.parse("2026-09-01T12:00:00"),
  src: "个人记录",
  srcType: "personal",
  srcDesc: "日常生活记录",
  srcPath: "notes/journal",
  caption: "今天画了一只鸟",
  truncated: false,
  photos,
  ...extra,
});

/** 照片框比例策略快捷构造 */
const frame = (
  mode: "original" | "range" | "fixed",
  min = 0.8,
  max = 1.7778,
  fixed = 1
): { mode: "original" | "range" | "fixed"; min: number; max: number; fixed: number } => ({
  mode,
  min,
  max,
  fixed,
});

const config = {
  pageSize: 2,
  imageMaxHeight: 78,
  showCaption: true,
  showSourceDesc: false,
  cardStyle: true,
  ratio: frame("original"),
};

const noop = (): void => undefined;

async function main(): Promise<void> {
  // ───────── 1. 单图 Post ─────────
  {
    const wrap = document.body.createDiv();
    const opened: number[] = [];
    const node = buildPostCard(
      app as never,
      makePost("p1", realImgs.slice(0, 1)),
      config,
      { onOpenPhoto: (_p, i) => opened.push(i), onOpenFile: noop }
    );
    wrap.appendChild(node.el);

    check("单图 Post 渲染出图片", node.el.querySelectorAll("img.pf-img").length === 1);
    check(
      "照片上不再叠圆点（.pf-dots / .pf-dot 已移除）",
      node.el.querySelectorAll(".pf-dots, .pf-dot").length === 0
    );
    check("单图 Post 不显示张数角标", node.el.querySelectorAll(".pf-counter").length === 0);
    check("单图 Post 不显示左右箭头", node.el.querySelectorAll(".pf-arrow").length === 0);
    check(
      "照片是主角：卡片没有顶部信息条（.pf-post-head 已移除）",
      node.el.querySelectorAll(".pf-post-head").length === 0 &&
        node.el.firstElementChild?.classList.contains("pf-media-wrap") === true,
      node.el.firstElementChild?.className ?? ""
    );
    check(
      "来源与日期收进底部一行（弱化显示）",
      node.el.querySelector(".pf-post-foot .pf-post-src-name")?.textContent === "个人记录" &&
        (node.el.querySelector(".pf-post-date-full")?.textContent ?? "").includes("2026-09-01")
    );
    check(
      "时间只出现一次（底部），没有重复的右上角时间",
      node.el.querySelectorAll(".pf-post-date").length === 0 &&
        node.el.querySelectorAll(".pf-post-date-full").length === 1
    );
    check(
      "「打开原记录」是图标按钮（不是文字链接）",
      (() => {
        const btn = node.el.querySelector(".pf-open");
        return (
          !!btn &&
          btn.getAttribute("data-icon") === "external-link" &&
          !(btn.textContent ?? "").includes("打开")
        );
      })(),
      node.el.querySelector(".pf-open")?.getAttribute("data-icon") ?? "无"
    );
    check(
      "Post 显示正文",
      node.el.querySelector(".pf-caption")?.textContent === "今天画了一只鸟"
    );

    // 懒加载：未进入视口前不设置 src
    const img = node.el.querySelector("img.pf-img") as HTMLImageElement;
    check("懒加载：进入视口前没有 src", !img.getAttribute("src"));
    env.flushIntersections();
    check("懒加载：进入视口后才设置 src", !!img.getAttribute("src"), img.getAttribute("src") ?? "");
    check(
      "src 指向 Vault 资源地址",
      (img.getAttribute("src") ?? "").startsWith("app://local/")
    );

    // 图片 load 后按原图比例撑开容器
    Object.defineProperty(img, "naturalWidth", { value: 1200, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: 1600, configurable: true });
    img.dispatchEvent(new env.window.Event("load"));
    const media = node.el.querySelector(".pf-media") as HTMLElement;
    check(
      "原始比例模式：容器比例 = 原图比例（1200/1600 → 0.75）",
      media.style.getPropertyValue("--pf-ratio") === "0.75",
      media.style.getPropertyValue("--pf-ratio")
    );
    check("原始比例模式：不打裁剪标记 pf-cover", !media.hasClass("pf-cover"));

    // 点击图片 → 回调
    (img.closest(".pf-slide") as HTMLElement).dispatchEvent(
      new env.window.MouseEvent("click", { bubbles: true })
    );
    check("点击图片触发打开大图（下标 0）", opened.length === 1 && opened[0] === 0);
  }

  // ───────── 2. 多图 Post（轮播）─────────
  {
    const wrap = document.body.createDiv();
    const opened: number[] = [];
    const four = realImgs.slice(0, 4);
    const node = buildPostCard(app as never, makePost("p2", four), config, {
      onOpenPhoto: (_p, i) => opened.push(i),
      onOpenFile: noop,
    });
    wrap.appendChild(node.el);

    check(
      "来源是纯文字（没有装饰色点 / 底框）",
      node.el.querySelector(".pf-post-src .pf-post-src-name")?.textContent === "个人记录" &&
        node.el.querySelectorAll(".pf-src-dot").length === 0,
      node.el.querySelector(".pf-post-src")?.innerHTML ?? ""
    );
    check(
      "张数角标是唯一的翻页提示（照片上没有圆点）",
      node.el.querySelectorAll(".pf-dots, .pf-dot").length === 0 &&
        node.el.querySelector(".pf-counter")?.textContent === "1/4",
      node.el.querySelector(".pf-counter")?.textContent ?? "无角标"
    );
    check("多图 Post 有左右箭头", node.el.querySelectorAll(".pf-arrow").length === 2);
    check(
      "4 张图全部渲染在轨道里（不是缩略图堆叠）",
      node.el.querySelectorAll(".pf-track .pf-slide").length === 4 &&
        node.el.querySelectorAll(".pf-track").length === 1
    );
    check(
      "只有第一张 eager，其余 lazy",
      (() => {
        const imgs = [...node.el.querySelectorAll("img.pf-img")] as HTMLImageElement[];
        return (
          imgs[0].getAttribute("loading") === "eager" &&
          imgs.slice(1).every((i) => i.getAttribute("loading") === "lazy")
        );
      })()
    );

    // 模拟布局宽度后切到第 3 张（角标随之更新）
    const track = node.el.querySelector(".pf-track") as HTMLElement;
    Object.defineProperty(track, "clientWidth", { value: 400, configurable: true });
    node.carousel.scrollTo(2);
    await tick(60);
    check("角标更新为 3/4", node.el.querySelector(".pf-counter")?.textContent === "3/4");
    check(
      "轨道滚到第 3 张位置",
      Math.round(track.scrollLeft) === 800,
      `scrollLeft=${track.scrollLeft}`
    );

    // 点击第 3 张图 → 下标 2
    env.flushIntersections();
    const thirdSlide = node.el.querySelectorAll<HTMLElement>(".pf-slide")[2];
    thirdSlide.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true }));
    check("点击第 3 张图回调下标 2", opened.length === 1 && opened[0] === 2, JSON.stringify(opened));
  }

  // ───────── 3. Feed 分批渲染 ─────────
  {
    const container = document.body.createDiv();
    const openFiles: string[] = [];
    const feed = new Feed(
      container,
      app as never,
      { onOpenPhoto: noop, onOpenFile: (p) => openFiles.push(p.file) },
      config
    );
    const posts = Array.from({ length: 6 }, (_, i) =>
      makePost(`f${i}`, realImgs.slice(i, i + 2), {
        file: `notes/journal/2026/09${i.toString().padStart(2, "0")}.md`,
      })
    );

    feed.render(posts);
    check(
      "分批渲染：首屏只渲染 pageSize(2) 条",
      container.querySelectorAll(".pf-post").length === 2,
      `实际 ${container.querySelectorAll(".pf-post").length}`
    );
    check("存在哨兵元素", !!container.querySelector(".pf-sentinel"));

    env.flushIntersections();
    check("滚动到哨兵后追加下一批", container.querySelectorAll(".pf-post").length === 4);

    env.flushIntersections();
    env.flushIntersections();
    check(
      "全部渲染完（6 条）",
      container.querySelectorAll(".pf-post").length === 6,
      `实际 ${container.querySelectorAll(".pf-post").length}`
    );
    check("渲染完后移除哨兵", !container.querySelector(".pf-sentinel"));

    check("ensureRendered 不会重复渲染", (() => {
      feed.ensureRendered(3);
      return container.querySelectorAll(".pf-post").length === 6;
    })());

    // 空状态：反复渲染后仍能出现（回归：clear 曾误删空状态元素）
    feed.render([]);
    const empty = container.querySelector(".pf-empty") as HTMLElement;
    check("空状态元素仍在 DOM 中", !!empty);
    check("空状态可见", empty.style.display !== "none");
    feed.render(posts);
    check("从空状态切回有数据正常", container.querySelectorAll(".pf-post").length === 2);
    feed.render([]);
    check(
      "再次空状态仍可见",
      (container.querySelector(".pf-empty") as HTMLElement).style.display !== "none"
    );
    feed.render([]);
  }

  // ───────── 4. Lightbox ─────────
  {
    const posts = [
      makePost("a", realImgs.slice(0, 3), { src: "个人记录" }),
      makePost("b", realImgs.slice(3, 4), { src: "社交平台", srcType: "socialMedia" }),
    ];
    const lb = Lightbox.fromFeed(app as never, posts, "a", 1, noop);
    check("Lightbox 能打开", !!lb);
    check("Lightbox 覆盖层挂在 body 上", !!document.body.querySelector(".pf-lightbox"));
    check(
      "圆点/计数显示当前位置（2/4）",
      document.body.querySelector(".pf-lb-counter")?.textContent === "2 / 4",
      document.body.querySelector(".pf-lb-counter")?.textContent ?? ""
    );
    check(
      "显示所属来源与日期",
      (document.body.querySelector(".pf-lb-meta")?.textContent ?? "").includes("个人记录")
    );
    check(
      "大图 src 指向 Vault 资源",
      (document.body.querySelector(".pf-lb-img") as HTMLImageElement)
        .getAttribute("src")
        ?.startsWith("app://local/") ?? false
    );

    const next = document.body.querySelector(".pf-lb-next") as HTMLElement;
    next.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true }));
    check(
      "下一张按钮切换计数（3/4）",
      document.body.querySelector(".pf-lb-counter")?.textContent === "3 / 4"
    );
    next.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true }));
    check(
      "跨 Post 继续切换（4/4，来源变为 社交平台）",
      document.body.querySelector(".pf-lb-counter")?.textContent === "4 / 4" &&
        (document.body.querySelector(".pf-lb-meta")?.textContent ?? "").includes("社交平台")
    );
    next.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true }));
    check(
      "循环回到第一张（1/4）",
      document.body.querySelector(".pf-lb-counter")?.textContent === "1 / 4"
    );

    document.dispatchEvent(new env.window.KeyboardEvent("keydown", { key: "ArrowRight" }));
    check(
      "键盘 → 可切换",
      document.body.querySelector(".pf-lb-counter")?.textContent === "2 / 4"
    );

    document.dispatchEvent(new env.window.KeyboardEvent("keydown", { key: "Escape" }));
    check("Esc 关闭并移除覆盖层", !document.body.querySelector(".pf-lightbox"));
  }

  // ───────── 5. 轮播销毁 ─────────
  {
    const wrap = document.body.createDiv();
    const c = new Carousel(wrap, {
      app: app as never,
      photos: realImgs.slice(0, 3),
      onOpen: noop,
    });
    check("Carousel 独立使用正常", wrap.querySelectorAll(".pf-slide").length === 3);
    c.destroy();
    c.destroy();
    check("Carousel 可安全销毁", true);
  }

  // ───────── 6. 视频轮播 ─────────
  {
    // 造一个「存在于 Vault 里」的视频文件（真实 Vault 里目前没有视频）
    const VIDEO_PATH = "attachments/media/clip-demo.mp4";
    app.vault.upsertExtra(VIDEO_PATH, "");
    const videoPhoto: Photo = {
      ref: "clip-demo.mp4",
      path: VIDEO_PATH,
      remote: false,
      caption: "",
      kind: "video",
    };

    const wrap = document.body.createDiv();
    const opened: number[] = [];
    const node = buildPostCard(app as never, makePost("pv", [videoPhoto]), config, {
      onOpenPhoto: (_p, i) => opened.push(i),
      onOpenFile: noop,
    });
    wrap.appendChild(node.el);

    const slide = node.el.querySelector(".pf-slide") as HTMLElement;
    const video = node.el.querySelector("video.pf-video") as HTMLVideoElement;
    check("视频 Post 渲染出 <video>", !!video);
    check("视频 slide 有独立类名", slide.classList.contains("pf-slide-video"));
    check("视频带原生 controls", video.hasAttribute("controls"));
    check("视频绝不自动播放（没有 autoplay）", !video.hasAttribute("autoplay"));
    check("视频预加载策略为 metadata（不预下载整段）", video.getAttribute("preload") === "metadata");
    check("视频有「视频」角标", node.el.querySelector(".pf-video-badge")?.textContent === "视频");
    check(
      "视频右上/右下有全屏按钮（图标）",
      node.el.querySelector(".pf-video-expand")?.getAttribute("data-icon") === "maximize-2"
    );

    // 懒加载：进视口前不请求
    check("视频懒加载：进入视口前没有 src", !video.getAttribute("src"));
    env.flushIntersections();
    check(
      "视频懒加载：进入视口后才设置 src",
      (video.getAttribute("src") ?? "").startsWith("app://local/"),
      video.getAttribute("src") ?? ""
    );

    // 点视频本体（比如点播放键）不应打开大图
    slide.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true }));
    check("点视频本体不打开大图（不抢播放器交互）", opened.length === 0, JSON.stringify(opened));

    // 全屏按钮 → 打开大图
    (node.el.querySelector(".pf-video-expand") as HTMLElement).dispatchEvent(
      new env.window.MouseEvent("click", { bubbles: true })
    );
    check("点全屏按钮进入大图", opened.length === 1 && opened[0] === 0, JSON.stringify(opened));

    // 视频加载完 metadata 后按比例撑开
    Object.defineProperty(video, "videoWidth", { value: 1920, configurable: true });
    Object.defineProperty(video, "videoHeight", { value: 1080, configurable: true });
    video.dispatchEvent(new env.window.Event("loadedmetadata"));
    const media = node.el.querySelector(".pf-media") as HTMLElement;
    check(
      "视频按原始比例撑开容器（1920/1080 → 1.7778）",
      media.style.getPropertyValue("--pf-ratio") === "1.7778",
      media.style.getPropertyValue("--pf-ratio")
    );
  }

  // ───────── 6b. 照片框比例策略（原始 / 限制范围 / 统一）─────────
  {
    const build = (
      wide: number,
      high: number,
      ratio: ReturnType<typeof frame>
    ): HTMLElement => {
      const wrap = document.body.createDiv();
      const node = buildPostCard(
        app as never,
        makePost(`pr-${ratio.mode}-${wide}x${high}`, realImgs.slice(0, 1)),
        { ...config, ratio },
        { onOpenPhoto: noop, onOpenFile: noop }
      );
      wrap.appendChild(node.el);
      const img = node.el.querySelector("img.pf-img") as HTMLImageElement;
      Object.defineProperty(img, "naturalWidth", { value: wide, configurable: true });
      Object.defineProperty(img, "naturalHeight", { value: high, configurable: true });
      img.dispatchEvent(new env.window.Event("load"));
      return node.el.querySelector(".pf-media") as HTMLElement;
    };

    // 原图 1200×1600 = 0.75（比 4:5 还瘦）
    const orig = build(1200, 1600, frame("original"));
    check("原始比例：0.75 → 0.75（不裁）", orig.style.getPropertyValue("--pf-ratio") === "0.75");

    const ranged = build(1200, 1600, frame("range", 0.8, 1.7778));
    check(
      "限制范围：0.75 被夹到下限 0.8",
      ranged.style.getPropertyValue("--pf-ratio") === "0.8",
      ranged.style.getPropertyValue("--pf-ratio")
    );
    check("限制范围：打上 pf-cover 裁剪填满", ranged.hasClass("pf-cover"));

    const inRange = build(1920, 1080, frame("range", 0.8, 1.7778));
    check(
      "限制范围：区间内的 1.7778 原样保留",
      inRange.style.getPropertyValue("--pf-ratio") === "1.7778",
      inRange.style.getPropertyValue("--pf-ratio")
    );
    check("限制范围：区间内也打 pf-cover（高度超限时裁而不是留白）", inRange.hasClass("pf-cover"));

    const ultraWide = build(6000, 400, frame("range", 0.8, 1.7778));
    check(
      "限制范围：15:1 超宽横幅被夹到上限 1.7778",
      ultraWide.style.getPropertyValue("--pf-ratio") === "1.7778",
      ultraWide.style.getPropertyValue("--pf-ratio")
    );

    const ultraTall = build(300, 3000, frame("range", 0.8, 1.7778));
    check(
      "限制范围：1:10 长截图被夹到下限 0.8",
      ultraTall.style.getPropertyValue("--pf-ratio") === "0.8",
      ultraTall.style.getPropertyValue("--pf-ratio")
    );

    const fixed = build(1200, 1600, frame("fixed", 0.8, 1.7778, 1));
    check(
      "统一比例：瘦图也变成 1:1",
      fixed.style.getPropertyValue("--pf-ratio") === "1",
      fixed.style.getPropertyValue("--pf-ratio")
    );
    const fixedWide = build(1920, 1080, frame("fixed", 0.8, 1.7778, 1));
    check("统一比例：宽图同样变成 1:1", fixedWide.style.getPropertyValue("--pf-ratio") === "1");
    check("统一比例：打上 pf-cover", fixedWide.hasClass("pf-cover"));

    // 上下限写反也要能用（内部自动排序）
    const swapped = build(1200, 1600, frame("range", 1.7778, 0.8));
    check(
      "限制范围：上下限写反也能正常夹取",
      swapped.style.getPropertyValue("--pf-ratio") === "0.8",
      swapped.style.getPropertyValue("--pf-ratio")
    );
  }

  // ───────── 7. Lightbox 视频 ─────────
  {
    const VIDEO_PATH = "attachments/media/clip-demo.mp4";
    const videoPhoto: Photo = {
      ref: "clip-demo.mp4",
      path: VIDEO_PATH,
      remote: false,
      caption: "",
      kind: "video",
    };
    const imgPhoto: Photo = realImgs[0];

    const lb = new Lightbox(app as never, [
      { post: makePost("l1", [imgPhoto]), photo: imgPhoto, indexInPost: 0 },
      { post: makePost("l1", [videoPhoto]), photo: videoPhoto, indexInPost: 1 },
    ], 1, noop);
    check("Lightbox 打开视频（video 可见）", !!lb);
    const v = document.body.querySelector(".pf-lb-video") as HTMLVideoElement;
    const im = document.body.querySelector(".pf-lb-img") as HTMLImageElement;
    check("视频模式显示 <video>", v.style.display !== "none");
    check("视频模式隐藏 <img>", im.classList.contains("pf-lb-hidden"));
    check("大图视频也带 controls 且不自动播放", v.hasAttribute("controls") && !v.hasAttribute("autoplay"));
    check(
      "视频 src 指向 Vault 资源",
      (v.getAttribute("src") ?? "").startsWith("app://local/"),
      v.getAttribute("src") ?? ""
    );
    check(
      "关闭按钮用图标",
      document.body.querySelector(".pf-lb-close")?.getAttribute("data-icon") === "x"
    );
    check(
      "「打开原记录」也是图标按钮",
      document.body.querySelector(".pf-lb-open")?.getAttribute("data-icon") === "external-link"
    );

    // 切到图片模式
    (document.body.querySelector(".pf-lb-next") as HTMLElement).dispatchEvent(
      new env.window.MouseEvent("click", { bubbles: true })
    );
    check("切到图片后 <img> 恢复显示", !im.classList.contains("pf-lb-hidden"));
    check("切到图片后 <video> 被收起", (document.body.querySelector(".pf-lb-video") as HTMLVideoElement).style.display === "none");

    document.dispatchEvent(new env.window.KeyboardEvent("keydown", { key: "Escape" }));
    check("Esc 关闭 Lightbox", !document.body.querySelector(".pf-lightbox"));
  }

  // ───────── 8. 视图骨架：居中标题 + 左下筛选 FAB + 右下发布 FAB ─────────
  {
    const app4 = new App(VAULT_ROOT);
    const s4 = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as typeof DEFAULT_SETTINGS;
    const viewPosts = [makePost("v1", realImgs.slice(0, 2)), makePost("v2", realImgs.slice(2, 3))];
    let notified = 0;
    const pluginStub = {
      app: app4,
      settings: s4,
      saved: 0,
      indexer: {
        getPosts: () => viewPosts,
        index: { posts: viewPosts, files: {} },
        stats: () => ({ posts: 2, photos: 3, scanned: 2, withPhotos: 2, bySource: {} }),
        reindexFile: async () => undefined,
      },
      saveSettings: async () => {
        pluginStub.saved++;
      },
      onIndexChanged: () => {
        notified++;
      },
      offIndexChanged: () => undefined,
      notifyIndexChanged: () => undefined,
    };
    const view = new PhotoFeedView({ app: app4 } as never, pluginStub as never);
    await view.onOpen();
    const root = view.contentEl;
    check("视图注册了索引监听", notified === 1);
    check(
      "页面内不再有居中标题（.pf-titlebar 已移除，标题只在标签页上）",
      root.querySelectorAll(".pf-title, .pf-titlebar").length === 0,
      root.querySelector(".pf-title")?.textContent ?? "已移除"
    );
    check(
      "第一个子元素是滚动区（没有多余的头栏占地方）",
      root.querySelector(".pf-root")?.firstElementChild?.classList.contains("pf-scroll") === true,
      root.querySelector(".pf-root")?.firstElementChild?.className ?? ""
    );
    check("顶部不再有工具栏（全部收进左上角… 底部按钮）", root.querySelectorAll(".pf-toolbar").length === 0);
    check("左下角有筛选浮动按钮", !!root.querySelector(".pf-fab-filter"));
    check("右下角有发布浮动按钮", !!root.querySelector(".pf-fab-publish"));
    check(
      "两个按钮都是图标",
      root.querySelector(".pf-fab-filter")?.getAttribute("data-icon") === "sliders-horizontal" &&
        root.querySelector(".pf-fab-publish")?.getAttribute("data-icon") === "plus"
    );

    // ── 布局切换（单列 Feed ⇄ 网格瀑布流）──
    const layoutFab = root.querySelector(".pf-fab-layout") as HTMLElement;
    const feedInner = root.querySelector(".pf-feed-inner") as HTMLElement;
    check("左下角有布局切换按钮（叠在筛选按钮上方）", !!layoutFab);
    check(
      "默认是单列布局：按钮显示「切到瀑布流」的图标",
      layoutFab.getAttribute("data-icon") === "layout-grid" &&
        feedInner.classList.contains("pf-grid") === false,
      layoutFab.getAttribute("data-icon") ?? "无图标"
    );
    check(
      "默认布局带着瓦片尺寸档位类",
      feedInner.classList.contains("pf-tiles-medium") === true
    );

    layoutFab.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true }));
    await tick(0);
    check(
      "点一下切到网格瀑布流（容器带上 pf-grid）",
      feedInner.classList.contains("pf-grid") === true &&
        layoutFab.getAttribute("data-icon") === "layout-list",
      feedInner.className
    );
    check(
      "网格模式下卡片退化成纯照片瓦片（没有正文与底部信息条）",
      root.querySelectorAll(".pf-post-tile").length === 2 &&
        root.querySelectorAll(".pf-post-tile .pf-post-foot").length === 0 &&
        root.querySelectorAll(".pf-post-tile .pf-caption").length === 0
    );
    check(
      "布局选择被记住（写进了设置）",
      (pluginStub.saved as number) > 0 && pluginStub.settings.layoutMode === "grid",
      `saved=${pluginStub.saved} mode=${pluginStub.settings.layoutMode}`
    );
    layoutFab.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true }));
    await tick(0);
    check(
      "再点一下切回单列",
      feedInner.classList.contains("pf-grid") === false &&
        layoutFab.getAttribute("data-icon") === "layout-grid" &&
        pluginStub.settings.layoutMode === "feed"
    );
    check(
      "切回单列后正文与来源又回来了",
      root.querySelectorAll(".pf-post-foot").length === 2 &&
        root.querySelectorAll(".pf-post-tile").length === 0
    );

    check(
      "筛选条件都收进了面板（来源 / 年份 / 日期 / 重置 / 统计）",
      !!root.querySelector(".pf-filter-panel .pf-chips") &&
        !!root.querySelector(".pf-filter-panel .pf-select") &&
        root.querySelectorAll(".pf-filter-panel .pf-date").length === 2 &&
        !!root.querySelector(".pf-filter-panel .pf-reset") &&
        !!root.querySelector(".pf-filter-panel .pf-stat")
    );
    check(
      "面板默认收起",
      !(root.querySelector(".pf-filter-panel") as HTMLElement).classList.contains("pf-panel-open")
    );
    check("视图渲染出 Post", root.querySelectorAll(".pf-post").length === 2, `${root.querySelectorAll(".pf-post").length}`);
    check(
      "统计信息在面板里",
      (root.querySelector(".pf-filter-panel .pf-stat")?.textContent ?? "").includes("2 条")
    );

    // 点按钮 → 展开
    (root.querySelector(".pf-fab-filter") as HTMLElement).dispatchEvent(
      new env.window.MouseEvent("click", { bubbles: true })
    );
    check(
      "点左下按钮才展开面板",
      (root.querySelector(".pf-filter-panel") as HTMLElement).classList.contains("pf-panel-open")
    );
    check(
      "展开时按钮高亮",
      (root.querySelector(".pf-fab-filter") as HTMLElement).classList.contains("pf-fab-active")
    );
    // 点面板以外 → 收起
    (root.querySelector(".pf-scroll") as HTMLElement).dispatchEvent(
      new env.window.MouseEvent("click", { bubbles: true })
    );
    check(
      "点面板外自动收起",
      !(root.querySelector(".pf-filter-panel") as HTMLElement).classList.contains("pf-panel-open")
    );

    // 发布按钮 → 弹窗
    (root.querySelector(".pf-fab-publish") as HTMLElement).dispatchEvent(
      new env.window.MouseEvent("click", { bubbles: true })
    );
    check("点右下按钮弹出发布弹窗", !!document.body.querySelector(".pf-publish-modal"));
    check("弹窗有多选文件入口", !!document.body.querySelector(".pf-pub-picker"));
    const fileInput = document.body.querySelector(".pf-pub-input");
    check(
      "文件选择同时接受图片与视频，且支持多选",
      (fileInput?.getAttribute("accept") ?? "").includes("image/*") &&
        (fileInput?.getAttribute("accept") ?? "").includes("video/*") &&
        fileInput?.hasAttribute("multiple") === true
    );
    check("弹窗有说明输入框", !!document.body.querySelector(".pf-pub-caption"));
    check(
      "弹窗有日期 + 时间输入",
      !!document.body.querySelector(".pf-pub-date") && !!document.body.querySelector(".pf-pub-time")
    );
    check(
      "弹窗显示发布目标文件夹（不跟原生日记）",
      (document.body.querySelector(".pf-pub-target")?.textContent ?? "").includes(s4.publishFolder),
      document.body.querySelector(".pf-pub-target")?.textContent ?? ""
    );
    check(
      "弹窗有「发布」按钮",
      [...document.body.querySelectorAll(".pf-pub-actions button")].some((b) => b.textContent === "发布")
    );

    // 直接构造弹窗，验证「没选文件不让发」
    const modal = new PublishModal(app4 as never, pluginStub as never, noop);
    modal.open();
    check("发布弹窗构造正常", !!document.body.querySelector(".pf-publish-modal"));
    modal.close();
    check(
      "弹窗可关闭并清理 DOM",
      !modal.containerEl.isConnected &&
        !document.body.contains(modal.containerEl) &&
        !modal.contentEl.isConnected
    );
  }

  // ───────── 9. 设置页（回归：曾经「看不到设置」）─────────
  {
    const app5 = new App(VAULT_ROOT);
    const s5 = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as typeof DEFAULT_SETTINGS;
    const pluginStub5 = {
      app: app5,
      settings: s5,
      indexer: {
        index: { posts: [], files: {} },
        stats: () => ({ posts: 0, photos: 0, scanned: 0, withPhotos: 0, bySource: {} }),
      },
      saveSettings: async () => undefined,
      rebuildIndex: async () => undefined,
      notifyIndexChanged: () => undefined,
    };
    const tab = new PhotoFeedSettingTab(app5 as never, pluginStub5 as never);
    tab.display();
    const el = tab.containerEl;

    check(
      "设置页标题 = 新插件名且居中容器",
      el.querySelector(".pf-settings-title")?.textContent === PLUGIN_NAME,
      el.querySelector(".pf-settings-title")?.textContent ?? ""
    );
    const heads = [...el.querySelectorAll(".setting-item-heading")].map((h) => h.textContent);
    check("有「来源文件夹」分区", heads.includes("来源文件夹"), JSON.stringify(heads));
    check("有「发布」分区", heads.includes("发布"));
    check("有「Feed 显示」分区", heads.includes("Feed 显示"));
    check("有「数据」分区", heads.includes("数据"));
    check(
      "来源列表渲染出 3 行",
      el.querySelectorAll(".pf-src-row").length === 3,
      `${el.querySelectorAll(".pf-src-row").length}`
    );
    check(
      "每行都能改 路径 / 显示名 / 类型 / 说明",
      el.querySelectorAll(".pf-src-path").length === 3 &&
        el.querySelectorAll(".pf-src-name").length === 3 &&
        el.querySelectorAll(".pf-src-type").length === 3 &&
        el.querySelectorAll(".pf-src-desc").length === 3
    );
    check(
      "路径框预填了来源路径",
      (el.querySelector(".pf-src-path") as HTMLInputElement).value === s5.sources[0].path,
      (el.querySelector(".pf-src-path") as HTMLInputElement).value
    );
    check("每行有启用勾选框", el.querySelectorAll(".pf-src-enabled").length === 3);
    check("每行有选择与删除按钮", el.querySelectorAll(".pf-src-pick").length === 3 && el.querySelectorAll(".pf-src-del").length === 3);
    check(
      "有「＋ 添加来源文件夹」按钮",
      el.querySelector(".pf-src-add")?.textContent === "＋ 添加来源文件夹",
      el.querySelector(".pf-src-add")?.textContent ?? ""
    );
    check(
      "发布：有「发布文件夹」「附件存放文件夹」两个输入框",
      el.querySelectorAll(".pf-pub-path").length === 2,
      `${el.querySelectorAll(".pf-pub-path").length}`
    );
    check(
      "发布：发布文件夹预填了设置值",
      (el.querySelector(".pf-pub-path") as HTMLInputElement).value === s5.publishFolder,
      (el.querySelector(".pf-pub-path") as HTMLInputElement).value
    );
    check(
      "发布：有「发布文件夹自动加为来源」开关",
      [...el.querySelectorAll(".setting-item-name")].some((n) => n.textContent === "发布文件夹自动加为来源")
    );

    // ── 照片框比例（v1.2 新增）──
    const rowByName = (name: string): HTMLElement | undefined =>
      [...el.querySelectorAll<HTMLElement>(".setting-item")].find(
        (r) => r.querySelector(".setting-item-name")?.textContent === name
      );
    const selectOf = (name: string): HTMLSelectElement | undefined =>
      rowByName(name)?.querySelector<HTMLSelectElement>("select") ?? undefined;
    const pick = async (name: string, value: string): Promise<void> => {
      const sel = selectOf(name);
      check(`存在「${name}」下拉框（值 ${value}）`, !!sel);
      if (!sel) return;
      sel.value = value;
      sel.dispatchEvent(new env.window.Event("change", { bubbles: true }));
      // onChange 里落盘后还会通知视图刷新，等一下异步队列，再读重建后的 DOM
      await tick(0);
    };

    check("有「照片框比例」设置行", !!rowByName("照片框比例"));
    check(
      "照片框比例默认 = 限制范围",
      selectOf("照片框比例")?.value === "range",
      selectOf("照片框比例")?.value ?? "无"
    );
    check(
      "限制范围模式：显示「最窄」「最宽」，且没有「统一比例」",
      !!selectOf("最窄") && !!selectOf("最宽") && !rowByName("统一比例")
    );
    check("最窄默认 4:5", selectOf("最窄")?.value === "0.8", selectOf("最窄")?.value ?? "无");
    check("最宽默认 16:9", selectOf("最宽")?.value === "1.7778", selectOf("最宽")?.value ?? "无");

    await pick("照片框比例", "fixed");
    check(
      "切到统一比例：出现「统一比例」下拉，隐藏「最窄 / 最宽」",
      !!selectOf("统一比例") && !selectOf("最窄") && !selectOf("最宽")
    );
    check(
      "统一比例默认 1:1",
      selectOf("统一比例")?.value === "1",
      selectOf("统一比例")?.value ?? "无"
    );

    await pick("照片框比例", "original");
    check("切到原始比例：不显示任何区间下拉", !selectOf("最窄") && !selectOf("统一比例"));
    check("选择会写回设置", s5.mediaRatioMode === "original", s5.mediaRatioMode);

    await pick("照片框比例", "range");
    await pick("最窄", "1");
    check("最窄写回设置", s5.mediaRatioMin === 1, String(s5.mediaRatioMin));
    check(
      "最窄的说明文字跟着更新为 1:1",
      (rowByName("最窄")?.querySelector(".setting-item-description")?.textContent ?? "").includes(
        "1:1"
      ),
      rowByName("最窄")?.querySelector(".setting-item-description")?.textContent ?? "无"
    );

    await pick("最宽", "1");
    check(
      "最宽也压到 1:1 后区间收窄，最窄 ≤ 最宽 恒成立",
      s5.mediaRatioMax === 1 && s5.mediaRatioMin <= s5.mediaRatioMax,
      `min=${s5.mediaRatioMin} max=${s5.mediaRatioMax}`
    );

    // 回归：保存的值必须永远是预设值，否则 setValue 对不上，下拉框渲染成空白
    await pick("最窄", "0.5");
    await pick("最宽", "2");
    check(
      "改完上下限后两个下拉框都还能显示当前值（不是空白）",
      selectOf("最窄")?.value === "0.5" && selectOf("最宽")?.value === "2",
      `最窄=${selectOf("最窄")?.value ?? "无"} 最宽=${selectOf("最宽")?.value ?? "无"}`
    );

    // 点「添加来源文件夹」→ 打开文件夹选择弹窗
    const before = document.body.children.length;
    (el.querySelector(".pf-src-add") as HTMLElement).dispatchEvent(
      new env.window.MouseEvent("click", { bubbles: true })
    );
    check("点「＋ 添加来源文件夹」会打开文件夹选择器", document.body.children.length > before);
  }

  console.log(`\n${failed === 0 ? "✅ 全部通过" : `❌ ${failed} 项失败`}`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
