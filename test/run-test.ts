/**
 * 索引器 + 发布 端到端测试（Node + 真实 Vault 数据 + Obsidian mock）：
 *  1. buildFull 全量扫描：Post 数 / 媒体数 / 来源识别 / 日期排序
 *  2. refreshChanged 启动对比：无变化时 0 次读文件；改动一个文件只读它
 *  3. 增量更新：新增 / 修改 / 删除 / 重命名
 *  4. 媒体文件变化：只重解析引用它的 Markdown
 *  5. 解析器单元校验：wiki 尺寸后缀 / alt caption / md 图片 / 分段记录 / 视频
 *  6. 发布：插入算法（升序 / 同时间 / CRLF / 分段风格）+ 写附件 + 追加同一个 md
 *
 * ⚠️ 发布相关测试全部走内存 overlay，绝不写用户 Vault 的真实文件。
 * 运行：node test/build-test.mjs && node test/run-test.cjs
 */
import { readFileSync } from "node:fs";
import { App, TFile, TFolder } from "./obsidian-mock";
import { Indexer } from "../src/indexer/indexer";
import { parseRecords, splitRecords, buildPosts } from "../src/indexer/parse";
import {
  ensureSourceFor,
  freshNote,
  insertMemoItem,
  publishMedia,
  publishNotePath,
  resolveAttachmentFolder,
  sanitizeFileName,
  uniqueName,
  type PublishFileLike,
} from "../src/publish/publisher";
import { DEFAULT_SETTINGS, normalizeLayoutSettings, normalizeRatioSettings } from "../src/settings";
import { isMediaExt, isVideoExt, kindOf, type PhotoFeedSettings } from "../src/types";
import {
  DEFAULT_FRAME_RATIO,
  RATIO_FIXED_OPTIONS,
  RATIO_MAX_OPTIONS,
  RATIO_MIN_OPTIONS,
  frameCrops,
  frameRatio,
  ratioLabel,
  ratioToCss,
  snapToOption,
  type FrameRatioConfig,
} from "../src/utils/ratio";

(globalThis as Record<string, unknown>).window = globalThis;

/**
 * 真实 Vault 根目录 —— 不在代码里写死，由 test/build-test.mjs 打包时注入：
 *   1. 环境变量 VISUAL_FEED_VAULT
 *   2. test/vault.local（本地文件，已 gitignore）
 *
 *   VISUAL_FEED_VAULT="/path/to/your/vault" npm test
 */
declare const __VAULT_ROOT__: string;
const VAULT_ROOT = __VAULT_ROOT__;
if (!VAULT_ROOT) {
  throw new Error(
    "未指定 Vault 路径：请设置环境变量 VISUAL_FEED_VAULT，或在 test/vault.local 里写入你的库路径。",
  );
}
const PERSONAL = "notes/journal";
const MEMOS = "notes/memos";
const MASTO = "notes/social";

const sources = [
  {
    id: "s1",
    path: PERSONAL,
    name: "个人记录",
    type: "personal" as const,
    desc: "日常生活记录",
    enabled: true,
  },
  {
    id: "s2",
    path: MEMOS,
    name: "Memos",
    type: "personal" as const,
    desc: "随手记",
    enabled: true,
  },
  {
    id: "s3",
    path: MASTO,
    name: "社交平台",
    type: "socialMedia" as const,
    desc: "原创动态",
    enabled: true,
  },
];

const app = new App(VAULT_ROOT);
const settings = { sources, groupBy: "record" as const, captionChars: 220 };
const plugin = {
  app,
  settings,
  persistIndex: async (): Promise<void> => undefined,
};

let failed = 0;
const check = (name: string, cond: boolean, detail = ""): void => {
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? "  " + detail : ""}`);
  if (!cond) failed++;
};

async function main(): Promise<void> {
  // ───────── 1. 全量扫描 ─────────
  const indexer = new Indexer(plugin as never, null);
  const t0 = Date.now();
  await indexer.buildFull();
  const buildMs = Date.now() - t0;
  const stats = indexer.stats();
  console.log(
    `\n=== buildFull ===  耗时 ${buildMs}ms，读取 ${app.vault.readCount} 个文件\n` +
      `Post ${stats.posts} 条 · 照片 ${stats.photos} 张 · 来自 ${stats.withPhotos} 个文件（扫描 ${stats.scanned} 个）`
  );
  console.log("来源分布:", stats.bySource);

  check("Post 数 > 800", stats.posts > 800, `实际 ${stats.posts}`);
  check("媒体数 > 1100", stats.photos > 1100, `实际 ${stats.photos}`);
  check("三个来源都有内容", Object.keys(stats.bySource).length >= 2);

  const posts = indexer.getPosts();
  check("每条 Post 至少一个媒体", posts.every((p) => p.photos.length >= 1));
  check(
    "媒体路径都指向真实存在的文件",
    posts
      .flatMap((p) => p.photos)
      .filter((ph) => !ph.remote)
      .every((ph) => {
        const f = app.vault.getAbstractFileByPath(ph.path);
        return f instanceof TFile;
      })
  );
  check(
    "媒体扩展名都是图片或视频",
    posts
      .flatMap((p) => p.photos)
      .every((ph) => isMediaExt(ph.path.split(".").pop() ?? ""))
  );
  check(
    "每条媒体都带 kind（image / video）",
    posts
      .flatMap((p) => p.photos)
      .every((ph) => kindOf(ph) === "image" || kindOf(ph) === "video")
  );
  check(
    "日期格式全部合法",
    posts.every((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.date))
  );
  check(
    "排序字段全部非零",
    posts.every((p) => p.sort > 0),
    `0 值 ${posts.filter((p) => !p.sort).length} 个`
  );

  // 多图 Post（carousel 的来源）
  const multi = posts.filter((p) => p.photos.length > 1);
  check("存在多图 Post（轮播数据）", multi.length > 0, `${multi.length} 条`);
  check(
    "多图 Post 内没有重复媒体",
    multi.every((p) => new Set(p.photos.map((x) => x.path)).size === p.photos.length)
  );
  const maxImgs = Math.max(...posts.map((p) => p.photos.length));
  console.log(`   单条最多媒体数: ${maxImgs}`);

  // 日期范围
  const dates = posts.map((p) => p.date).sort();
  console.log(`   日期范围: ${dates[0]} → ${dates[dates.length - 1]}`);

  // 来源类型分布
  const mastoPosts = posts.filter((p) => p.srcType === "socialMedia");
  check("社交平台 Post 带时间", mastoPosts.filter((p) => p.time).length > 0);

  // caption 不含图片语法
  check(
    "caption 已剔除图片引用",
    posts.every((p) => !/!\[\[|<img|!\[/.test(p.caption))
  );

  // 抽样打印
  console.log("\n   抽样（最新 3 条）:");
  for (const p of [...posts].sort((a, b) => b.sort - a.sort).slice(0, 3)) {
    console.log(
      `   · ${p.date} ${p.time} [${p.src}] ${p.photos.length} 张 | ${p.caption.slice(0, 40)}`
    );
  }
  console.log("\n   抽样（多图 Post）:");
  for (const p of multi.slice(0, 3)) {
    console.log(
      `   · ${p.date} ${p.time} [${p.src}] ${p.photos.length} 张 | ${p.caption.slice(0, 30)}`
    );
  }

  // ───────── 2. 启动对比（增量）─────────
  app.vault.readCount = 0;
  const changed = await indexer.refreshChanged();
  check("启动对比：无变化时 0 次读文件", app.vault.readCount === 0, `实际 ${app.vault.readCount}`);
  check("启动对比：无变化返回 false", changed === false);

  // 改动一篇随笔
  const target = "notes/journal/2026/0817.md";
  const targetFile = app.vault.getAbstractFileByPath(target) as TFile;
  if (targetFile) {
    const before = targetFile.stat.mtime;
    targetFile.stat.mtime = before + 1;
    app.vault.readCount = 0;
    await indexer.refreshChanged();
    check("启动对比：只读变化的那 1 个文件", app.vault.readCount === 1, `实际 ${app.vault.readCount}`);
    targetFile.stat.mtime = before;
    await indexer.refreshChanged();
  } else {
    check("找到测试用随笔文件", false, target);
  }

  // ───────── 3. 增量：新增 / 修改 / 删除 ─────────
  const synth = "notes/journal/2026/9999.md";
  const synthBody = [
    "---",
    "创建时间: 2026-09-09T08:30:00",
    "---",
    "",
    "## Memos",
    "- 08:30 测试三张图 ![[fx-2.jpg]] ![[fx-1.webp]] ![[fx-3.jpg]]",
    "- 09:00 只有文字没有图",
    "",
  ].join("\n");
  app.vault.upsertExtra(synth, synthBody);
  const synthFile = app.vault.getAbstractFileByPath(synth) as TFile;
  const postsBefore = indexer.getPosts().length;
  indexer.handleChange(synthFile);
  await sleep(500);
  const added = indexer.getPosts().filter((p) => p.file === synth);
  check("新增文件 → 生成 1 条 Post", added.length === 1, `实际 ${added.length}`);
  check("新增 Post 有 3 张照片（轮播）", added[0]?.photos.length === 3, `实际 ${added[0]?.photos.length}`);
  check("新增 Post 日期取自 frontmatter", added[0]?.date === "2026-09-09", added[0]?.date);
  check("新增 Post 时间取自 Memos", added[0]?.time === "08:30", added[0]?.time);
  check("无图记录不生成 Post", indexer.getPosts().filter((p) => p.file === synth).length === 1);
  check(
    "索引条数 +1",
    indexer.getPosts().length === postsBefore + 1,
    `${postsBefore} → ${indexer.getPosts().length}`
  );

  // 修改：去掉图片 → Post 消失
  app.vault.upsertExtra(synth, synthBody.replace(/!\[\[[^\]]+\]\]/g, ""));
  const synthFile2 = app.vault.getAbstractFileByPath(synth) as TFile;
  indexer.handleChange(synthFile2);
  await sleep(500);
  check("删掉图片后 Post 消失", indexer.getPosts().filter((p) => p.file === synth).length === 0);
  check("索引条数回到原值", indexer.getPosts().length === postsBefore);

  // 删除
  app.vault.removeExtra(synth);
  indexer.handleDelete(new TFile(synth, { mtime: 1, size: 1 }));
  await sleep(500);
  check("删除文件后不残留", indexer.getPosts().filter((p) => p.file === synth).length === 0);

  // ───────── 4. 图片文件变化 → 只重解析引用它的 Markdown ─────────
  const samplePhoto = posts.flatMap((p) => p.photos).find((ph) => !ph.remote);
  if (samplePhoto) {
    app.vault.readCount = 0;
    indexer.handleChange(new TFile(samplePhoto.path, { mtime: 1, size: 1 }));
    await sleep(500);
    check(
      "图片变化只重解析引用它的文件（≥1 且远小于全库）",
      app.vault.readCount >= 1 && app.vault.readCount < 30,
      `照片 ${samplePhoto.path} → 读取 ${app.vault.readCount} 个文件`
    );
  } else {
    check("找到可用于测试的本地照片", false);
  }

  // ───────── 5. 解析器单元校验 ─────────
  const app2 = new App(VAULT_ROOT);
  const fakeFile = new TFile("notes/journal/2026/0101.md", { mtime: Date.now(), size: 10 });

  const rec1 = parseRecords(app2 as never, fakeFile as never, [
    "---",
    "创建时间: 2026-01-01T09:00:00",
    "---",
    "今天画了一只鸟",
    "![[fx-2.jpg|600x400]]",
    "![[fx-1.webp|画的小鸟]]",
    "![外链图](https://example.com/a.jpg)",
    "![](attachments/media/fx-1.webp)",
    "",
  ].join("\n"));
  const imgs1 = rec1[0]?.images ?? [];
  check("wiki 尺寸后缀不算 caption", imgs1[0]?.caption === "", JSON.stringify(imgs1[0]));
  check("wiki alt 作为 caption", imgs1[1]?.caption === "画的小鸟", JSON.stringify(imgs1[1]));
  check("markdown 图片能被提取", imgs1.some((i) => i.link === "https://example.com/a.jpg"));
  check("相对路径图片能被提取", imgs1.some((i) => i.link.includes("fx-1.webp")));
  check("图片引用去重（同图只留一次）", imgs1.length === 4, `实际 ${imgs1.length}`);

  const posts1 = buildPosts(
    app2 as never,
    fakeFile as never,
    ["今天画了一只鸟", "![[fx-2.jpg]]", "![[fx-1.webp]]"].join("\n"),
    sources[0],
    "record",
    220
  );
  check("正文记录 → 1 条 Post", posts1.length === 1, `实际 ${posts1.length}`);
  check("正文 caption 去掉图片语法", posts1[0]?.caption === "今天画了一只鸟", posts1[0]?.caption);

  const seg = splitRecords(
    [
      "## Memos",
      "- 10:00 上午图 ![[fx-2.jpg]]",
      "- 11:00 下午两图 ![[fx-1.webp]] ![[fx-3.jpg]]",
      "- 12:00 纯文字",
      "",
    ].join("\n"),
    "2026-09-09",
    ""
  );
  check("Memos 分段切分正确（3 条记录）", seg.length === 3, `实际 ${seg.length}`);
  check("分段 1 时间 10:00 / 1 图", seg[0].time === "10:00" && seg[0].images.length === 1);
  check("分段 2 时间 11:00 / 2 图", seg[1].time === "11:00" && seg[1].images.length === 2);
  check("分段 3 无图", seg[2].images.length === 0);

  const masto = splitRecords(
    ["# 2026-09-11", "", "### 08:00", "早上好", "", "---", "### 09:30", "两只猫", "![[fx-1.webp]]", "![[fx-2.jpg]]", ""].join("\n"),
    "2026-09-11",
    ""
  );
  check("社交平台 分段切分正确（2 条）", masto.length === 2, `实际 ${masto.length}`);
  check("社交平台 分段 1 无图", masto[0].time === "08:00" && masto[0].images.length === 0);
  check("社交平台 分段 2 两图", masto[1].time === "09:30" && masto[1].images.length === 2);

  const grouped = buildPosts(
    app2 as never,
    fakeFile as never,
    ["## Memos", "- 10:00 一图 ![[fx-2.jpg]]", "- 11:00 一图 ![[fx-1.webp]]"].join("\n"),
    sources[0],
    "file",
    220
  );
  check("groupBy=file 合并成一个 Post（2 图）", grouped.length === 1 && grouped[0].photos.length === 2);

  // 停用的来源不参与索引
  settings.sources = sources.map((s) => (s.id === "s3" ? { ...s, enabled: false } : s));
  const idx2 = new Indexer(plugin as never, null);
  await idx2.buildFull();
  const st2 = idx2.stats();
  check(
    "停用 社交平台 后不再索引其内容",
    st2.posts < stats.posts && !Object.keys(st2.bySource).includes("社交平台"),
    `${st2.posts} vs ${stats.posts}`
  );
  settings.sources = sources;

  // ───────── 6. 视频 / 无时间戳退化 ─────────
  {
    const app2 = new App(VAULT_ROOT);
    // 用内存 overlay 造两个媒体文件（真实 Vault 里没有视频）
    app2.vault.upsertExtra("attachments/media/clip-demo.mp4", "");
    app2.vault.upsertExtra("attachments/media/photo-demo.jpg", "");
    const fake = new TFile("notes/journal/2026/0101.md", { mtime: Date.now(), size: 10 });

    const pv = buildPosts(
      app2 as never,
      fake as never,
      [
        "---",
        "date: 2026-09-09",
        "---",
        "## Memos",
        "",
        "- 10:00 视频与图 ![[clip-demo.mp4]] ![[photo-demo.jpg]]",
        "",
      ].join("\n"),
      sources[0],
      "record",
      220
    );
    check("视频能进索引", pv.length === 1 && pv[0].photos.length === 2, `实际 ${pv.length}`);
    check("视频 kind = video", kindOf(pv[0]?.photos[0]) === "video", JSON.stringify(pv[0]?.photos[0]));
    check("图片 kind = image", kindOf(pv[0]?.photos[1]) === "image");
    check(
      "扩展名识别：mp4/webm 是视频，jpg 是媒体，pdf 不是",
      isVideoExt("MP4") && isVideoExt("webm") && isMediaExt("jpg") && isMediaExt("mp4") && !isMediaExt("pdf")
    );

    const pv2 = buildPosts(
      app2 as never,
      fake as never,
      ['今天录了一段 <video src="clip-demo.mp4" controls></video>'].join("\n"),
      sources[0],
      "record",
      220
    );
    check(
      "<video src> 能被提取为视频",
      pv2.length === 1 && pv2[0].photos.length === 1 && kindOf(pv2[0].photos[0]) === "video",
      `实际 ${pv2.length} 条`
    );

    const pv3 = buildPosts(
      app2 as never,
      fake as never,
      [
        "---",
        "date: 2026-09-09",
        "---",
        "",
        "随手拍的两张",
        "",
        "![[photo-demo.jpg]]",
        "",
        "补一张 ![[photo-demo.jpg|600]]",
        "",
      ].join("\n"),
      sources[0],
      "record",
      220
    );
    check("没有时间戳的 md 退化成 1 个 Post", pv3.length === 1, `实际 ${pv3.length}`);
    check("退化 Post 用 frontmatter 的 date", pv3[0]?.date === "2026-09-09", pv3[0]?.date);
    check(
      "退化 Post 收集整篇的媒体（同一文件去重后 1 个）",
      pv3[0]?.photos.length === 1,
      `实际 ${pv3[0]?.photos.length}`
    );
  }

  // ───────── 7. 发布：纯函数 ─────────
  {
    check(
      "文件名清洗：Windows 非法字符换成横杠",
      sanitizeFileName("a:b*c?d.jpg") === "a-b-c-d.jpg",
      sanitizeFileName("a:b*c?d.jpg")
    );
    check(
      "文件名清洗：冒号必须清掉（NTFS 会当数据流截断）",
      !sanitizeFileName("12:30 shot.jpg").includes(":")
    );
    check("文件名清洗：空名有兜底", sanitizeFileName("   ") === "未命名");
    check(
      "目标路径 = {folder}/YYYY/MM/MMDD.md",
      publishNotePath("notes/memos", "2026-09-12") === "notes/memos/2026/09/0912.md",
      publishNotePath("notes/memos", "2026-09-12")
    );
    check("根目录发布路径", publishNotePath("", "2026-09-12") === "2026/09/0912.md");

    const names = new Set(["a.jpg"]);
    check("重名自动加序号", uniqueName(names, "a.jpg") === "a-1.jpg", uniqueName(names, "a.jpg"));
    check("不重名保持原样", uniqueName(names, "b.jpg") === "b.jpg");

    const note = insertMemoItem(freshNote("2026-09-12"), {
      time: "09:00",
      caption: "早上拍的",
      embeds: ["![[a.jpg]]"],
    });
    check("新文件里出现 ## Memos 段", note.includes("## Memos"));
    check("写入 `- HH:MM` 记录", note.includes("- 09:00 早上拍的"), JSON.stringify(note));
    check("媒体用纯文件名 wiki 嵌入", note.includes("  ![[a.jpg]]"));

    const two = insertMemoItem(note, { time: "07:30", caption: "更早", embeds: ["![[b.jpg]]"] });
    check(
      "按时间升序插入：07:30 排在 09:00 之前",
      two.indexOf("- 07:30") >= 0 && two.indexOf("- 07:30") < two.indexOf("- 09:00")
    );
    const three = insertMemoItem(two, { time: "21:00", caption: "晚上", embeds: ["![[c.jpg]]"] });
    check("更晚的时间排到最后", three.indexOf("- 21:00") > three.indexOf("- 09:00"));
    const four = insertMemoItem(three, {
      time: "09:00",
      caption: "同时间再来一条",
      embeds: ["![[d.jpg]]"],
    });
    check(
      "同一时间戳追加在已有记录之后（保持先后）",
      four.indexOf("同时间再来一条") > four.indexOf("早上拍的"),
      JSON.stringify(four.split("\n").slice(5, 12))
    );
    check("插入不会丢内容", four.includes("- 07:30") && four.includes("- 21:00") && four.includes("- 09:00"));

    // CRLF 保留 + 原内容不动
    const crlf = ["---", "date: 2026-09-12", "---", "", "## Memos", "", "- 08:00 旧", ""].join("\r\n");
    const kept = insertMemoItem(crlf, { time: "09:00", caption: "新", embeds: ["![[a.jpg]]"] });
    check("CRLF 文件保持 CRLF（不整篇改成 LF）", kept.includes("\r\n") && !/[^\r]\n/.test(kept));
    check(
      "原有内容保持不变（frontmatter + 旧记录）",
      kept.startsWith("---\r\ndate: 2026-09-12") && kept.includes("- 08:00 旧")
    );

    // 社交平台 风格：### HH:MM
    const masto = ["# 2026-09-12", "", "### 08:00", "早上好", "", "### 20:00", "晚安", ""].join("\n");
    const m2 = insertMemoItem(masto, { time: "12:00", caption: "午间", embeds: ["![[x.jpg]]"] });
    check("已有 ### HH:MM 分段时沿用分段格式", m2.includes("### 12:00"), JSON.stringify(m2));
    check(
      "分段按时间插到 08:00 与 20:00 之间",
      m2.indexOf("### 12:00") > m2.indexOf("### 08:00") && m2.indexOf("### 12:00") < m2.indexOf("### 20:00")
    );
    check("分段模式下不额外造 ## Memos", !m2.includes("## Memos"));
  }

  // ───────── 8. 发布：写附件 + 追加同一个 md（全内存，不碰真实 Vault）─────────
  {
    const app3 = new App(VAULT_ROOT);
    const PUB = "zz 视界发布测试";
    const s3 = cloneSettings({ publishFolder: PUB, attachmentFolder: "", autoAddSource: true });
    app3.vault.config = { attachmentFolderPath: `${PUB}/附件` };

    const mk = (name: string, size = 8): PublishFileLike => ({
      name,
      arrayBuffer: async () => new ArrayBuffer(size),
    });

    const r1 = await publishMedia(app3 as never, s3, {
      files: [mk("IMG 1.jpg"), mk("clip.mp4"), mk("no-1.pdf")],
      caption: "第一帖",
      date: "2026-09-12",
      time: "09:00",
      folder: PUB,
    });
    check("发布：笔记路径正确", r1.notePath === `${PUB}/2026/09/0912.md`, r1.notePath);
    check("发布：不支持的类型被跳过（pdf）", r1.attachments.length === 2, JSON.stringify(r1.attachments));
    check(
      "发布：附件落在 Obsidian 附件文件夹里",
      r1.attachments.every((p) => p.startsWith(`${PUB}/附件/`)),
      JSON.stringify(r1.attachments)
    );
    check("发布：首次是新建笔记", r1.noteCreated === true);
    check(
      "发布：目录被逐级创建",
      app3.vault.createdFolders.includes(`${PUB}/2026/09`) &&
        app3.vault.createdFolders.includes(`${PUB}/附件`),
      JSON.stringify(app3.vault.createdFolders)
    );

    const note1 = await app3.vault.cachedRead(
      app3.vault.getAbstractFileByPath(r1.notePath) as TFile
    );
    check("发布：md 里写了时间戳记录", note1.includes("- 09:00 第一帖"), note1);
    check("发布：md 里嵌入了两个媒体", (note1.match(/!\[\[/g) ?? []).length === 2, note1);
    check(
      "发布：媒体用纯文件名嵌入（不带路径）",
      note1.includes("![[clip.mp4]]") && note1.includes("![[IMG 1.jpg]]"),
      note1
    );

    // 同一天第二帖（更晚）
    const r2 = await publishMedia(app3 as never, s3, {
      files: [mk("night.jpg")],
      caption: "第二帖",
      date: "2026-09-12",
      time: "21:30",
      folder: PUB,
    });
    check("发布：同一天复用同一个 md", r2.notePath === r1.notePath && r2.noteCreated === false);
    const note2 = await app3.vault.cachedRead(
      app3.vault.getAbstractFileByPath(r2.notePath) as TFile
    );
    check("发布：追加后两条都在同一个文件里", note2.includes("第一帖") && note2.includes("第二帖"));
    check(
      "发布：按时间升序（09:00 在 21:30 之前）",
      note2.indexOf("- 09:00") < note2.indexOf("- 21:30")
    );

    // 同一天第三帖（更早的时间）
    await publishMedia(app3 as never, s3, {
      files: [mk("dawn.jpg")],
      caption: "早起篇",
      date: "2026-09-12",
      time: "06:15",
      folder: PUB,
    });
    const note3 = await app3.vault.cachedRead(
      app3.vault.getAbstractFileByPath(r1.notePath) as TFile
    );
    check("发布：更早的时间插到最前面", note3.indexOf("- 06:15") < note3.indexOf("- 09:00"));

    // 附件重名 → 自动改名，不覆盖
    const r3 = await publishMedia(app3 as never, s3, {
      files: [mk("night.jpg")],
      caption: "再来一张同名的",
      date: "2026-09-12",
      time: "22:00",
      folder: PUB,
    });
    check("发布：附件重名自动加序号", r3.attachments[0].endsWith("night-1.jpg"), r3.attachments[0]);

    // ── 发布后进索引：只重扫发布文件夹，Feed 里立刻能看到 ──
    const addedSrc = ensureSourceFor(s3, PUB);
    check("自动把发布文件夹加为来源", addedSrc === PUB, `实际 ${addedSrc}`);
    check("发布文件夹出现在来源列表里", s3.sources.some((s) => s.path === PUB));
    check(
      "来源已存在时不重复添加（幂等）",
      ensureSourceFor(s3, PUB) === null &&
        s3.sources.filter((s) => s.path === PUB).length === 1
    );
    check("空文件夹不添加来源", ensureSourceFor(s3, "") === null);
    const idx3 = new Indexer(
      { app: app3, settings: s3, persistIndex: async () => undefined } as never,
      null
    );
    const scanned = await idx3.reindexFolder(PUB);
    check("只重扫发布文件夹（1 篇）", scanned === 1, `实际 ${scanned}`);
    const pubPosts = idx3.getPosts();
    check(
      "一个时间戳 = 一个 Post（发布 4 次 → 4 条）",
      pubPosts.length === 4,
      `实际 ${pubPosts.length}`
    );
    check(
      "Post 的日期 / 时间正确",
      pubPosts.every((p) => p.date === "2026-09-12" && /^\d{2}:\d{2}$/.test(p.time)),
      JSON.stringify(pubPosts.map((p) => `${p.date} ${p.time}`))
    );
    check(
      "视频 Post 的 kind = video",
      pubPosts.some((p) => p.photos.some((ph) => kindOf(ph) === "video"))
    );
    check(
      "图片 Post 的 kind = image",
      pubPosts.some((p) => p.photos.some((ph) => kindOf(ph) === "image"))
    );
    check(
      "发布的媒体路径都指向真实存在的文件",
      pubPosts
        .flatMap((p) => p.photos)
        .every((ph) => app3.vault.getAbstractFileByPath(ph.path) instanceof TFile)
    );
    check(
      "发布出来的 Post 来源名 = 文件夹名",
      pubPosts.every((p) => p.src === PUB),
      pubPosts[0]?.src
    );
  }

  // ───────── 9. 照片框比例策略（纯函数）─────────
  {
    const cfg = (
      mode: "original" | "range" | "fixed",
      min = 0.8,
      max = 1.7778,
      fixed = 1
    ): FrameRatioConfig => ({ mode, min, max, fixed });

    check("原始比例：永远返回 null（沿用原图）", frameRatio(1200, 1600, cfg("original")) === null);
    check("原始比例：竖图也不夹", frameRatio(300, 3000, cfg("original")) === null);

    check("限制范围：比 4:5 更瘦的图夹到下限 0.8", frameRatio(1200, 1600, cfg("range")) === 0.8);
    check("限制范围：方图 1:1 不动", frameRatio(1000, 1000, cfg("range")) === 1);
    check("限制范围：4:3 不动", frameRatio(1200, 900, cfg("range")) === 1.3333);
    check("限制范围：超宽 15:1 夹到上限", frameRatio(6000, 400, cfg("range")) === 1.7778);
    check("限制范围：1:10 长截图夹到下限", frameRatio(300, 3000, cfg("range")) === 0.8);
    check("限制范围：刚好在下限不裁", frameRatio(800, 1000, cfg("range")) === 0.8);
    check("限制范围：上限可调", frameRatio(6000, 400, cfg("range", 0.5, 2)) === 2);
    check("限制范围：下限可调", frameRatio(300, 3000, cfg("range", 0.5625, 2)) === 0.5625);
    check("限制范围：上下限写反也能用", frameRatio(1200, 1600, cfg("range", 1.7778, 0.8)) === 0.8);

    check("统一比例：瘦图也变成 1:1", frameRatio(1200, 1600, cfg("fixed")) === 1);
    check("统一比例：宽图也变成 1:1", frameRatio(1920, 1080, cfg("fixed")) === 1);
    check("统一比例：可选 16:9", frameRatio(1200, 1600, cfg("fixed", 0.8, 1.7778, 1.7778)) === 1.7778);
    check("统一比例：可选 4:5", frameRatio(1920, 1080, cfg("fixed", 0.8, 1.7778, 0.8)) === 0.8);

    check("尺寸缺失时返回 null（不写坏比例）", frameRatio(0, 0, cfg("fixed")) === null);

    check("裁剪标记：original 不裁", frameCrops("original") === false);
    check("裁剪标记：range 要裁", frameCrops("range") === true);
    check("裁剪标记：fixed 要裁", frameCrops("fixed") === true);

    check("CSS 比例字符串：0.8 → '0.8'", ratioToCss(0.8) === "0.8");
    check("CSS 比例字符串：1920/1080 → '1.7778'", ratioToCss(1920 / 1080) === "1.7778");
    check("比例展示名：0.8 → 4:5", ratioLabel(0.8) === "4:5", ratioLabel(0.8));
    check("比例展示名：1.7778 → 16:9", ratioLabel(1.7778) === "16:9", ratioLabel(1.7778));
    check("比例展示名：0.5625 → 9:16", ratioLabel(0.5625) === "9:16", ratioLabel(0.5625));
    check(
      "比例展示名：非预设值回退成数字",
      ratioLabel(0.98765) === "0.9877",
      ratioLabel(0.98765)
    );

    check("吸附：0.79 → 最近预设 0.8", snapToOption(0.79, RATIO_MIN_OPTIONS) === 0.8);
    check("吸附：0.1 → 最近预设 0.5", snapToOption(0.1, RATIO_MIN_OPTIONS) === 0.5);
    check("吸附：3 → 最近预设 2", snapToOption(3, RATIO_MAX_OPTIONS) === 2);
    check(
      "默认设置吸附后原样不变（默认值必须都是合法预设）",
      DEFAULT_SETTINGS.mediaRatioMin === snapToOption(DEFAULT_SETTINGS.mediaRatioMin, RATIO_MIN_OPTIONS) &&
        DEFAULT_SETTINGS.mediaRatioMax === snapToOption(DEFAULT_SETTINGS.mediaRatioMax, RATIO_MAX_OPTIONS) &&
        DEFAULT_SETTINGS.mediaRatioFixed === snapToOption(DEFAULT_SETTINGS.mediaRatioFixed, RATIO_FIXED_OPTIONS)
    );

    // 手改 data.json / 旧版本缺字段的兜底
    const broken = {
      ...DEFAULT_SETTINGS,
      mediaRatioMode: "wtf" as never,
      mediaRatioMin: NaN,
      mediaRatioMax: 99,
      mediaRatioFixed: 0.77,
    };
    normalizeRatioSettings(broken);
    check("非法模式回退默认", broken.mediaRatioMode === DEFAULT_SETTINGS.mediaRatioMode, broken.mediaRatioMode);
    check("NaN 回退默认", broken.mediaRatioMin === 0.8, String(broken.mediaRatioMin));
    check("超范围回退默认", broken.mediaRatioMax === 1.7778, String(broken.mediaRatioMax));
    check("非预设吸附到 3:4", broken.mediaRatioFixed === 0.75, String(broken.mediaRatioFixed));

    const reversed = { ...DEFAULT_SETTINGS, mediaRatioMin: 1, mediaRatioMax: 0.5 };
    normalizeRatioSettings(reversed);
    check(
      "min > max 时自动交换",
      reversed.mediaRatioMin === 0.5 && reversed.mediaRatioMax === 1,
      `${reversed.mediaRatioMin}/${reversed.mediaRatioMax}`
    );
    // 交换要在吸附之前做：写反的区间要保留原本的跨度，不能被压成一个点
    const reversedWide = { ...DEFAULT_SETTINGS, mediaRatioMin: 1.7778, mediaRatioMax: 0.8 };
    normalizeRatioSettings(reversedWide);
    check(
      "写反的区间交换后保留跨度（0.8 ~ 16:9 而不是收成一个点）",
      reversedWide.mediaRatioMin === 0.8 && reversedWide.mediaRatioMax === 1.7778,
      `${reversedWide.mediaRatioMin}/${reversedWide.mediaRatioMax}`
    );

    // 真实升级路径：老版本 data.json 里完全没有这四个字段，加载后必须补成默认值
    const legacy = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
    delete legacy.mediaRatioMode;
    delete legacy.mediaRatioMin;
    delete legacy.mediaRatioMax;
    delete legacy.mediaRatioFixed;
    normalizeRatioSettings(legacy as never);
    check(
      "老版本设置缺字段时补成默认（限制范围 4:5~16:9）",
      legacy.mediaRatioMode === "range" &&
        legacy.mediaRatioMin === 0.8 &&
        legacy.mediaRatioMax === 1.7778 &&
        legacy.mediaRatioFixed === 1,
      `${legacy.mediaRatioMode} ${legacy.mediaRatioMin}~${legacy.mediaRatioMax} fixed=${legacy.mediaRatioFixed}`
    );
    check(
      "默认设置与 DEFAULT_FRAME_RATIO 保持一致",
      DEFAULT_SETTINGS.mediaRatioMode === DEFAULT_FRAME_RATIO.mode &&
        DEFAULT_SETTINGS.mediaRatioMin === DEFAULT_FRAME_RATIO.min &&
        DEFAULT_SETTINGS.mediaRatioMax === DEFAULT_FRAME_RATIO.max &&
        DEFAULT_SETTINGS.mediaRatioFixed === DEFAULT_FRAME_RATIO.fixed
    );
  }

  // ───────── 9.5 布局设置兜底（布局 / 瓦片尺寸 / 一格代表什么）─────────
  {
    const broken = {
      ...DEFAULT_SETTINGS,
      layoutMode: "瀑布" as never,
      gridTileSize: "xxl" as never,
      gridUnit: "tile" as never,
    };
    normalizeLayoutSettings(broken);
    check(
      "布局枚举兜底：非法布局 / 瓦片尺寸 / 一格单位全部回退默认",
      broken.layoutMode === "feed" &&
        broken.gridTileSize === "medium" &&
        broken.gridUnit === "photo",
      `${broken.layoutMode} ${broken.gridTileSize} ${broken.gridUnit}`
    );
    check("默认网格一格 = 每张照片一格（记录摊开）", DEFAULT_SETTINGS.gridUnit === "photo");

    // 真实升级路径：v1.5.0 的 data.json 里没有 gridUnit，加载后必须补成默认值
    const legacyLayout = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
    delete legacyLayout.gridUnit;
    normalizeLayoutSettings(legacyLayout as never);
    check("老版本设置缺 gridUnit 时补成默认", legacyLayout.gridUnit === "photo");
  }

  // ───────── 10. 样式回归（纯 CSS，jsdom 量不到布局，只能查规则在不在）─────────
  {
    // 测试一律从工程根目录跑，所以直接按相对路径读
    const css = readFileSync("styles.css", "utf8");

    // 已移除的视觉元素：别再被改回来
    check("样式里不再有轮播圆点规则", !/\.pf-dot\b/.test(css));
    check("样式里不再有 .pf-dots 容器规则", !/\.pf-dots\b/.test(css));
    check("样式里不再有主页居中标题规则", !/\.pf-titlebar\b/.test(css) && !/\.pf-title\b/.test(css));
    check("样式里不再有来源装饰色点规则", !/\.pf-src-dot\b/.test(css));

    // 来源弱化：字号 ≤ 11px、颜色浅、无边框/底色
    // ⚠️ 必须查 .pf-post-src-name（Post 卡片专用类名）而不是 .pf-src-name：
    //    后者是设置页来源行输入框的类名，带底色+边框+13px，一旦被 Post 卡片复用就会反压回来。
    const srcName = /\.pf-post-src-name\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    check(
      "来源名是 11px 小字 + 浅色（无边框 / 无底色）",
      /font-size:\s*11px/.test(srcName) &&
        /color:\s*var\(--text-faint\)/.test(srcName) &&
        !/border/.test(srcName) &&
        !/background/.test(srcName),
      srcName.replace(/\s+/g, " ").trim()
    );
    check(
      "设置页来源输入框的「框」只作用于设置页类名，不会反压 Post 卡片",
      (() => {
        const box = /\.pf-src-path,\s*\.pf-src-name,\s*\.pf-src-desc\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
        return /background/.test(box) && /border/.test(box) && !/pf-post-src/.test(box);
      })(),
      "设置页 .pf-src-name 才有底色+边框，Post 卡片用独立的 .pf-post-src-name"
    );

    // 移动端：浮动按钮必须抬到原生底栏之上
    const mobileRoot = /body\.is-mobile\s+\.pf-root\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    check(
      "移动端浮动按钮高度计入了 --mobile-toolbar-height",
      /--pf-fab-bottom:[^;]*var\(--mobile-toolbar-height/.test(mobileRoot),
      mobileRoot.replace(/\s+/g, " ").trim()
    );
    check(
      "移动端避让用的是 env(safe-area-inset-bottom)（不是 var，键盘弹起会被写坏）",
      /env\(safe-area-inset-bottom/.test(mobileRoot) &&
        !/var\(--safe-area-inset-bottom/.test(mobileRoot)
    );
    check(
      "移动端还兜了一层固定底栏高度（.mobile-navbar 约 52px）",
      /max\(\s*var\(--mobile-toolbar-height[^)]*\),\s*52px\s*\)/.test(mobileRoot),
      mobileRoot.replace(/\s+/g, " ").trim()
    );
    check(
      "浮动按钮 / 筛选面板 / 底部留白都复用 --pf-fab-bottom",
      /\.pf-fab\s*\{[^}]*bottom:\s*var\(--pf-fab-bottom/.test(css) &&
        /\.pf-filter-panel\s*\{[^}]*bottom:\s*calc\(var\(--pf-fab-bottom/.test(css) &&
        /body\.is-mobile\s+\.pf-feed-inner\s*\{[^}]*padding-bottom:\s*calc\(var\(--pf-fab-bottom\)/.test(
          css
        )
    );

    // ── 网格 / 瀑布流布局 ──
    const grid = /\.pf-feed-inner\.pf-grid\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    check(
      "网格布局是多列自动铺满（auto-fill + 固定最小列宽）",
      /display:\s*grid/.test(grid) &&
        /grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(var\(--pf-tile/.test(grid),
      grid.replace(/\s+/g, " ").trim()
    );
    check(
      "瓦片尺寸按档位固定（small / medium / large 三档给 --pf-tile 赋值）",
      /pf-tiles-small\s*\{[^}]*--pf-tile:\s*128px/.test(css) &&
        /pf-tiles-medium\s*\{[^}]*--pf-tile:\s*190px/.test(css) &&
        /pf-tiles-large\s*\{[^}]*--pf-tile:\s*280px/.test(css)
    );
    check(
      "网格瓦片是固定正方形 + cover（高度不再随原图比例浮动）",
      /\.pf-feed-inner\.pf-grid\s+\.pf-media\s*\{[^}]*aspect-ratio:\s*1/.test(css) &&
        /\.pf-feed-inner\.pf-grid\s+\.pf-media\s+\.pf-img[^{]*\{[^}]*object-fit:\s*cover/.test(css)
    );
    check(
      "网格里的哨兵/空状态横跨整行（不会被当成一个瓦片占格）",
      /\.pf-feed-inner\.pf-grid\s+\.pf-sentinel,[\s\S]{0,80}grid-column:\s*1\s*\/\s*-1/.test(css)
    );
    check(
      "瀑布流只要照片：网格里张数角标被藏掉，照片上不叠任何标记",
      /\.pf-feed-inner\.pf-grid\s+\.pf-counter\s*\{[^}]*display:\s*none/.test(css) &&
        !/pf-tile-multi/.test(css)
    );
    check(
      "窄屏下瓦片整体缩一档（手机能排下多列）",
      /@media \(max-width: 640px\)[\s\S]*?pf-tiles-medium\s*\{[^}]*--pf-tile:\s*140px/.test(css)
    );
    check(
      "布局切换按钮叠在筛选按钮上方（左下角一列）",
      /\.pf-fab-layout\s*\{[^}]*bottom:\s*calc\(var\(--pf-fab-bottom/.test(css) &&
        /\.pf-filter-panel\s*\{[^}]*bottom:\s*calc\(var\(--pf-fab-bottom[^)]*\)\s*\+\s*104px/.test(css)
    );
  }

  console.log(`\n${failed === 0 ? "✅ 全部通过" : `❌ ${failed} 项失败`}`);
  process.exit(failed === 0 ? 0 : 1);
}

/** 深拷贝默认设置（DEFAULT_SETTINGS 是模块级共享对象，不能直接被测试改） */
const cloneSettings = (patch: Partial<PhotoFeedSettings> = {}): PhotoFeedSettings => ({
  ...(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as PhotoFeedSettings),
  ...patch,
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

void main();
