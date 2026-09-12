/**
 * 发布：把本地选中的照片 / 视频写进 Vault，并在 Markdown 里追加一条带时间戳的记录。
 *
 * 约定：
 *  - 一个时间戳 = 一个 Post。同一天发多条 → 追加进同一个 md（按时间升序插入）
 *  - **只按时间戳定位，不创建也不依赖任何固定标题**：文件里已有 `### HH:MM` 分段就沿用分段，
 *    否则用 `- HH:MM` 列表项；没有锚点标题照样能写
 *  - 目标 md：`{发布文件夹}/YYYY/MM/MMDD.md`，不跟随 Obsidian 原生日记
 *  - 附件写入「附件文件夹」（默认跟随 Obsidian 的设置），文件名全库唯一
 *  - 媒体一律用纯文件名 wiki 嵌入 `![[文件名.ext]]`
 *  - **不重建整个索引**：只重解析刚写的那篇 md
 */
import { App, TFile, normalizePath } from "obsidian";
import type { MediaKind, PhotoFeedSettings } from "../types";
import { kindOfExt } from "../types";

/** 待写入的本地文件（浏览器 File 的可用子集，便于测试注入） */
export interface PublishFileLike {
  name: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface PublishRequest {
  files: PublishFileLike[];
  caption: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM */
  time: string;
  /** 目标文件夹（Vault 内相对路径，'' = 根） */
  folder: string;
}

export interface PublishResult {
  notePath: string;
  noteCreated: boolean;
  /** 实际写入的附件路径 */
  attachments: string[];
}

const pad = (n: number): string => String(n).padStart(2, "0");

export const nowDate = (d = new Date()): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const nowTime = (d = new Date()): string =>
  `${pad(d.getHours())}:${pad(d.getMinutes())}`;

// ───────────────────────── 纯函数（可单测） ─────────────────────────

/**
 * 清洗文件名：去掉 Windows 非法字符（`:*?"<>|`）与控制字符。
 * 冒号必须清掉 —— 在 NTFS 上会被当成数据流（ADS）静默截断成 0 字节。
 */
export function sanitizeFileName(name: string): string {
  const clean = name
    .replace(/[:*?"<>|]/g, "-")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .trim();
  return clean || "未命名";
}

/** 在已有名字集合里取一个不冲突的文件名（冲突就加 -1 / -2 …） */
export function uniqueName(existing: Set<string>, name: string): string {
  const lower = name.toLowerCase();
  if (!existing.has(lower)) return name;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 1; i < 1000; i++) {
    const candidate = `${base}-${i}${ext}`;
    if (!existing.has(candidate.toLowerCase())) return candidate;
  }
  return `${base}-${Date.now()}${ext}`;
}

/** 目标 md 路径：`{folder}/YYYY/MM/MMDD.md` */
export function publishNotePath(folder: string, date: string): string {
  const dir = normalizePath(folder || "").replace(/^\/+|\/+$/g, "");
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return dir ? `${dir}/${date}.md` : `${date}.md`;
  const rel = `${m[1]}/${m[2]}/${m[2]}${m[3]}.md`;
  return dir ? `${dir}/${rel}` : rel;
}

export const folderOf = (path: string): string =>
  path.split("/").slice(0, -1).join("/");

/**
 * 新建 md 的初始内容：只有 frontmatter 和日期，正文留空。
 * **不预置任何标题** —— 记录靠时间戳定位，不需要一个固定的二级标题当锚点。
 */
export function freshNote(date: string): string {
  return ["---", `date: ${date}`, "---", ""].join("\n");
}

const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, " ").trim();

/** 一条待写入的记录 */
export interface RecordItem {
  time: string;
  caption: string;
  embeds: string[];
}

/** 一条记录在 md 里的样子（`- HH:MM` 列表式） */
export function recordItemLines(item: RecordItem): string[] {
  const cap = oneLine(item.caption);
  const out = [`- ${item.time}${cap ? " " + cap : ""}`];
  if (item.embeds.length) out.push(`  ${item.embeds.join(" ")}`);
  return out;
}

/** 三级标题时间戳 `### HH:MM` */
const SEG_LINE_RE = /^###\s+(\d{1,2}):(\d{2})\s*$/;
/** 列表项时间戳 `- HH:MM`（与解析器的列表时间戳同一套写法） */
const ITEM_LINE_RE = /^[-*]\s+(\d{1,2}):(\d{2})/;

const normTime = (h: string, m: string): string => `${pad(Number(h))}:${m}`;

/**
 * 往 md 正文里插入一条带时间戳的记录。
 *
 * **只按时间戳定位，不认任何固定标题**：文件里已经有 `### HH:MM` 分段就沿用分段格式，
 * 否则按 `- HH:MM` 列表项插入。两种情况都按时间升序，同一时间戳追加在已有记录之后。
 */
export function insertTimestampItem(body: string, item: RecordItem): string {
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  return lines.some((l) => SEG_LINE_RE.test(l))
    ? insertAsSegment(lines, eol, item)
    : insertAsListItem(lines, eol, item);
}

/** `- HH:MM` 列表项风格 */
function insertAsListItem(lines: string[], eol: string, item: RecordItem): string {
  const block = recordItemLines(item);

  // 文件里已有的 `- HH:MM` 项（它们的位置就是插入锚点）
  const items: { idx: number; time: string }[] = [];
  lines.forEach((l, idx) => {
    const m = l.match(ITEM_LINE_RE);
    if (m) items.push({ idx, time: normTime(m[1], m[2]) });
  });

  // 一条时间戳记录都还没有 → 追加到正文末尾，不新建任何标题
  if (!items.length) {
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    if (lines.length) lines.push("");
    lines.push(...block);
    return lines.join(eol);
  }

  let insertAt: number;
  const later = items.find((it) => it.time > item.time);
  if (later) {
    insertAt = later.idx;
  } else {
    // 追加到最后一项之后（连同它的缩进续行）
    let i = items[items.length - 1].idx + 1;
    while (i < lines.length && /^[ \t]/.test(lines[i])) i++;
    insertAt = i;
  }
  lines.splice(insertAt, 0, ...block);
  return lines.join(eol);
}

/** `### HH:MM` 分段风格 */
function insertAsSegment(lines: string[], eol: string, item: RecordItem): string {
  const marks: { idx: number; time: string }[] = [];
  lines.forEach((l, idx) => {
    const m = l.match(SEG_LINE_RE);
    if (m) marks.push({ idx, time: normTime(m[1], m[2]) });
  });

  const cap = oneLine(item.caption);
  const block = [`### ${item.time}`];
  if (cap) block.push(cap);
  if (item.embeds.length) block.push(item.embeds.join(" "));
  block.push("");

  const later = marks.find((mk) => mk.time > item.time);
  if (later) {
    lines.splice(later.idx, 0, ...block);
  } else {
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push("", ...block);
  }
  return lines.join(eol);
}

/**
 * 附件应当落在哪个文件夹。
 *  - 配置为空 → 跟随 Obsidian 的「附件文件夹」设置
 *  - `/` → Vault 根；`./` → 与笔记同目录；`./sub` → 笔记目录下的 sub
 */
export function resolveAttachmentFolder(
  app: App,
  notePath: string,
  configured: string
): string {
  let raw = (configured || "").trim();
  if (!raw) {
    try {
      const cfg = (
        app.vault as unknown as { getConfig?: (k: string) => unknown }
      ).getConfig?.("attachmentFolderPath");
      raw = String(cfg ?? "").trim();
    } catch {
      raw = "";
    }
  }
  if (!raw || raw === "/") return "";
  if (raw === "./" || raw === ".") return folderOf(notePath);
  if (raw.startsWith("./")) {
    const sub = raw.slice(2).replace(/^\/+|\/+$/g, "");
    const base = folderOf(notePath);
    return base ? `${base}/${sub}` : sub;
  }
  return raw.replace(/^\/+|\/+$/g, "");
}

// ───────────────────────── 主流程 ─────────────────────────

/** 逐级创建文件夹（已存在则跳过，不抛错） */
export async function ensureFolder(app: App, path: string): Promise<void> {
  const clean = normalizePath(path || "").replace(/^\/+|\/+$/g, "");
  if (!clean) return;
  let cur = "";
  for (const part of clean.split("/")) {
    cur = cur ? `${cur}/${part}` : part;
    if (app.vault.getAbstractFileByPath(cur)) continue;
    try {
      await app.vault.createFolder(cur);
    } catch {
      /* 并发创建 / 已存在 */
    }
  }
}

const existingNames = (app: App): Set<string> => {
  const set = new Set<string>();
  for (const f of app.vault.getFiles()) set.add(f.name.toLowerCase());
  return set;
};

/** 发布：写附件 → 写 / 追加 md */
export async function publishMedia(
  app: App,
  settings: PhotoFeedSettings,
  req: PublishRequest
): Promise<PublishResult> {
  const folder = normalizePath(req.folder || "").replace(/^\/+|\/+$/g, "");
  const notePath = publishNotePath(folder, req.date);
  const noteDir = folderOf(notePath);
  const noteExists = app.vault.getAbstractFileByPath(notePath) instanceof TFile;
  const attachDir = resolveAttachmentFolder(app, notePath, settings.attachmentFolder);

  await ensureFolder(app, noteDir);
  if (attachDir) await ensureFolder(app, attachDir);

  // ── 写附件 ──
  const names = existingNames(app);
  const embeds: string[] = [];
  const written: string[] = [];
  for (const f of req.files) {
    const kind: MediaKind | null = kindOfExt(f.name.split(".").pop() ?? "");
    if (!kind) continue; // 不支持的类型直接跳过
    const safe = uniqueName(names, sanitizeFileName(f.name));
    const target = attachDir ? `${attachDir}/${safe}` : safe;
    await app.vault.createBinary(target, await f.arrayBuffer());
    names.add(safe.toLowerCase());
    written.push(target);
    embeds.push(`![[${safe}]]`);
  }

  if (!embeds.length) {
    throw new Error("没有可写入的图片或视频");
  }

  // ── 写 / 追加 md ──
  const item: RecordItem = { time: req.time, caption: req.caption, embeds };
  const existing = app.vault.getAbstractFileByPath(notePath);
  if (existing instanceof TFile) {
    await app.vault.process(existing, (data) => insertTimestampItem(data, item));
  } else {
    await app.vault.create(notePath, insertTimestampItem(freshNote(req.date), item));
  }

  return {
    notePath,
    noteCreated: !noteExists,
    attachments: written,
  };
}

/** 发布文件夹不在来源列表时补上，保证刚发的照片立刻能被索引到 */
export function ensureSourceFor(
  settings: PhotoFeedSettings,
  folder: string
): string | null {
  const dir = normalizePath(folder || "").replace(/^\/+|\/+$/g, "");
  if (!dir) return null;
  const hit = settings.sources.some(
    (s) => normalizePath(s.path).replace(/\/+$/, "") === dir
  );
  if (hit) return null;
  settings.sources.push({
    id: `src-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    path: dir,
    // 显示名从文件夹末级名推导，说明留空（不替用户写死任何描述）
    name: dir.split("/").pop() || dir,
    type: "personal",
    desc: "",
    enabled: true,
  });
  return dir;
}
