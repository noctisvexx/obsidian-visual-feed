/**
 * 发布：把本地选中的照片 / 视频写进 Vault，并在 Markdown 里追加一条带时间戳的记录。
 *
 * 约定：
 *  - 一个时间戳 = 一个 Post。同一天发多条 → 追加进同一个 md（按时间升序插入）
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

/** 新建 md 的初始内容 */
export function freshNote(date: string): string {
  return ["---", `date: ${date}`, "---", "", "## Memos", ""].join("\n");
}

const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, " ").trim();

export interface MemoItem {
  time: string;
  caption: string;
  embeds: string[];
}

/** 一条记录在 md 里的样子（`- HH:MM` 列表式） */
export function memoItemLines(item: MemoItem): string[] {
  const cap = oneLine(item.caption);
  const out = [`- ${item.time}${cap ? " " + cap : ""}`];
  if (item.embeds.length) out.push(`  ${item.embeds.join(" ")}`);
  return out;
}

const MEMO_HEAD_RE = /^##\s*(Memos|随记|日记|Journal)\s*$/i;
const SEG_LINE_RE = /^###\s+(\d{1,2}):(\d{2})\s*$/;
const ITEM_LINE_RE = /^[-*]\s+(\d{1,2}):(\d{2})/;

const normTime = (h: string, m: string): string => `${pad(Number(h))}:${m}`;

/**
 * 往 md 正文里插入一条带时间戳的记录。
 * 按时间升序插入；已存在相同时间戳时追加在它之后（保持先发的在上面）。
 * 自动识别两种文件风格：
 *  - `## Memos` 段 + `- HH:MM` 列表项（日记类插件的常见写法）
 *  - `### HH:MM` 分段（社交平台同步脚本的常见写法）
 */
export function insertMemoItem(body: string, item: MemoItem): string {
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const hasMemoSection = lines.some((l) => MEMO_HEAD_RE.test(l));
  const hasSegments = lines.some((l) => SEG_LINE_RE.test(l));

  if (hasSegments && !hasMemoSection) return insertSegment(lines, eol, item);
  return insertMemoListItem(lines, eol, item);
}

/** `## Memos` + `- HH:MM` 风格 */
function insertMemoListItem(lines: string[], eol: string, item: MemoItem): string {
  const block = memoItemLines(item);
  const secHead = lines.findIndex((l) => MEMO_HEAD_RE.test(l));

  // 没有记录段 → 文末补一个
  if (secHead < 0) {
    if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push("", "## Memos", "");
    lines.splice(lines.length, 0, ...block);
    return lines.join(eol);
  }

  // 段范围：到下一个 `## ` 标题为止
  let end = lines.length;
  for (let i = secHead + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }

  // 段内的 `- HH:MM` 项
  const items: { idx: number; time: string }[] = [];
  for (let i = secHead + 1; i < end; i++) {
    const m = lines[i].match(ITEM_LINE_RE);
    if (m) items.push({ idx: i, time: normTime(m[1], m[2]) });
  }

  let insertAt: number;
  const later = items.find((it) => it.time > item.time);
  if (later) {
    insertAt = later.idx;
  } else if (items.length) {
    // 追加到最后一项之后（连同它的缩进续行）
    let i = items[items.length - 1].idx + 1;
    while (i < end && /^[ \t]/.test(lines[i])) i++;
    insertAt = i;
  } else {
    // 段内还没有条目：跳过标题后的空行
    let i = secHead + 1;
    while (i < end && lines[i].trim() === "") i++;
    insertAt = i;
  }

  lines.splice(insertAt, 0, ...block);
  return lines.join(eol);
}

/** `### HH:MM` 分段风格（社交平台同步脚本常用） */
function insertSegment(lines: string[], eol: string, item: MemoItem): string {
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
  const item: MemoItem = { time: req.time, caption: req.caption, embeds };
  const existing = app.vault.getAbstractFileByPath(notePath);
  if (existing instanceof TFile) {
    await app.vault.process(existing, (data) => insertMemoItem(data, item));
  } else {
    await app.vault.create(notePath, insertMemoItem(freshNote(req.date), item));
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
    name: dir.split("/").pop() || dir,
    type: "personal",
    desc: "视界发布",
    enabled: true,
  });
  return dir;
}
