import { App, TFile, normalizePath } from "obsidian";
import type { FeedPost, Photo, SourceFolder } from "../types";
import { isVideoExt, kindOfExt } from "../types";
import {
  dateFromPath,
  epochOf,
  fmtDate,
  timeFromPath,
  toDateStr,
  toTimeStr,
} from "../utils/date";
import {
  cleanRecordText,
  extractImageRefs,
  normalizeBody,
  parseFrontmatterLite,
  stripFrontmatter,
  stripTemplateCode,
  truncate,
  type RawImageRef,
} from "../utils/text";

/**
 * 带时间戳的分段标题：`### HH:MM`
 * 社交平台同步脚本落盘时普遍用这个格式，所以按时戳识别、不认平台名。
 */
const TIME_SEG_RE = /^###\s+(\d{1,2}:\d{2})\s*$/m;
const TIME_SEG_SPLIT = /^###\s+(\d{1,2}:\d{2})\s*$/m;
/**
 * 带时间戳的列表段标题：`## Journal` / `## Memos` / `## 随记` / `## 日记`。
 * ⚠️ 这些字面量是**用户笔记正文里的段标题**（Journal / Memos 是几个常见日记类插件的写法），
 *    属于文件格式约定而非平台信息 —— 改动它们会让插件读不到既有笔记，别乱动。
 */
const SEG_HEAD_RE = /^##\s*(Journal|Memos|随记|日记)\s*$/i;
/** Knomo 月度归档日期标题：## [[2026-08-13]] */
const KNOMO_DAY_RE = /^##\s*\[\[(\d{4}-\d{2}-\d{2})\]\]\s*$/;
/** Memoria 日期标题：## 2026-08-14 周五 */
const MEMORIA_DAY_RE = /^##\s*(\d{4}-\d{2}-\d{2})\s*(?:周.|星期.)?\s*$/;
/** 带时间戳的列表项：- 08:11 内容 / - 08:29:05 内容 */
const MEMO_ITEM_RE = /^[-*]\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*(.*)$/;

/** 解析出的一条记录（Post 候选，无图片的会被丢弃） */
export interface ParsedRecord {
  date: string;
  time: string;
  /** 记录起始行（0 基，相对正文；用于「跳转到原记录位置」） */
  line: number;
  /** 记录原始文本（含图片引用），用于生成 caption */
  text: string;
  images: RawImageRef[];
}

/**
 * 把一篇 Markdown 解析成若干条「记录」。
 *
 * 一条记录 = 一个 Post。规则（**按正文结构识别，不看来源类型**）：
 *  - 有 `### HH:MM` 分段（社交平台同步落盘的常见格式）→ 每段一条
 *  - 有 `## Journal` / `## Memos` / `## [[YYYY-MM-DD]]` / `## YYYY-MM-DD 周X` 分段
 *    → 段内每行 `- HH:MM 内容` 一条
 *  - 其余情况 → 整篇算一条（正文）
 */
export function parseRecords(app: App, file: TFile, bodyRaw: string): ParsedRecord[] {
  const body = normalizeBody(bodyRaw);

  const fmRaw = app.metadataCache.getFileCache(file)?.frontmatter;
  const fm: Record<string, unknown> =
    fmRaw && Object.keys(fmRaw).length ? fmRaw : parseFrontmatterLite(body);
  const fmStr = (k: string): string => {
    const v = fm[k];
    if (v instanceof Date) return fmtDate(v);
    if (v === undefined || v === null) return "";
    return stripTemplateCode(String(v)).trim();
  };

  const baseDate =
    toDateStr(fmStr("创建时间")) ||
    toDateStr(fmStr("date")) ||
    toDateStr(fmStr("completed_date")) ||
    dateFromPath(file.path) ||
    fmtDate(new Date(file.stat.mtime));
  const baseTime =
    toTimeStr(fmStr("创建时间")) || toTimeStr(fmStr("date")) || timeFromPath(file.path);

  const bodyText = stripFrontmatter(body);
  return splitRecords(bodyText, baseDate, baseTime);
}

const countLines = (s: string): number => (s.match(/\n/g) || []).length;

/** 记录切分（纯函数，便于测试） */
export function splitRecords(bodyText: string, baseDate: string, baseTime: string): ParsedRecord[] {
  // ── 1. 带时间戳的分段（### HH:MM）：每段一条 ──
  if (TIME_SEG_RE.test(bodyText)) {
    const out: ParsedRecord[] = [];
    const re = new RegExp(TIME_SEG_SPLIT.source, "gm");
    const marks: { time: string; start: number; bodyStart: number; line: number }[] = [];
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(bodyText)) !== null) {
      const nl = bodyText.indexOf("\n", mm.index);
      marks.push({
        time: normTime(mm[1] || ""),
        start: mm.index,
        bodyStart: nl < 0 ? bodyText.length : nl + 1,
        line: countLines(bodyText.slice(0, mm.index)),
      });
    }
    const head = bodyText.slice(0, marks.length ? marks[0].start : bodyText.length);
    const headImages = extractImageRefs(head);
    if (headImages.length) {
      out.push({ date: baseDate, time: baseTime, line: 0, text: head, images: headImages });
    }
    marks.forEach((mark, i) => {
      const end = i + 1 < marks.length ? marks[i + 1].start : bodyText.length;
      const content = bodyText
        .slice(mark.bodyStart, end)
        .replace(/^-{3,}\s*$/gm, "")
        .trim();
      out.push({
        date: baseDate,
        time: mark.time,
        line: mark.line,
        text: content,
        images: extractImageRefs(content),
      });
    });
    return out;
  }

  // ── 2. 正文 + 带时间戳的列表段 ──
  const out: ParsedRecord[] = [];
  const headLines: string[] = [];
  let curDate = baseDate;
  let sawSegment = false;
  let itemTime = "";
  let itemLine = 0;
  let itemLines: string[] = [];
  let lineNo = 0;

  const flushItem = (): void => {
    if (!itemTime) return;
    const text = itemLines.join("\n");
    out.push({
      date: curDate,
      time: itemTime,
      line: itemLine,
      text,
      images: extractImageRefs(text),
    });
    itemTime = "";
    itemLines = [];
  };

  for (const rawLine of bodyText.split("\n")) {
    const thisLine = lineNo++;
    const line = rawLine.replace(/\s+$/, "");
    const dayHit = line.match(KNOMO_DAY_RE) || line.match(MEMORIA_DAY_RE);
    if (dayHit) {
      flushItem();
      curDate = dayHit[1];
      sawSegment = true;
      continue;
    }
    if (SEG_HEAD_RE.test(line)) {
      flushItem();
      sawSegment = true;
      continue;
    }
    const itemHit = line.match(MEMO_ITEM_RE);
    if (itemHit) {
      flushItem();
      itemTime = normTime(itemHit[1] || "");
      itemLine = thisLine;
      const inline = (itemHit[2] || "").trim();
      if (inline) itemLines.push(inline);
      sawSegment = true;
      continue;
    }
    if (itemTime) {
      if (/^[ \t]/.test(rawLine)) {
        itemLines.push(line.trim());
        continue;
      }
      if (!line.trim()) continue;
      flushItem();
    }
    if (!sawSegment) headLines.push(line);
  }
  flushItem();

  const head = headLines.join("\n");
  const headImages = extractImageRefs(head);
  if (headImages.length) {
    out.unshift({ date: baseDate, time: baseTime, line: 0, text: head, images: headImages });
  }
  return out;
}

const normTime = (t: string): string => {
  const m = (t || "").match(/^(\d{1,2}):(\d{2})/);
  if (!m) return "";
  return `${String(Number(m[1])).padStart(2, "0")}:${m[2]}`;
};

/**
 * 把一条媒体引用解析成 Photo。
 * 本地媒体必须能在 Vault 里找到（metadataCache 链接解析 → 直接路径兜底），
 * 否则丢弃（避免 Feed 里出现永远加载不出来的破图）。
 * 图片与视频都会保留，用 kind 区分。
 */
const resolvePhoto = (
  app: App,
  ref: RawImageRef,
  fromPath: string
): Photo | null => {
  const link = ref.link.trim();
  if (!link) return null;
  if (/^(https?|data):/i.test(link)) {
    // 远程：按 URL 里的扩展名判断是不是视频，其余都当图片
    const ext = extOfLink(link);
    return {
      ref: link,
      path: link,
      remote: true,
      caption: ref.caption,
      kind: isVideoExt(ext) ? "video" : "image",
    };
  }
  let clean = link.split("#")[0].split("?")[0].replace(/\\/g, "/").trim();
  if (clean.startsWith("/")) clean = clean.slice(1);
  if (!clean) return null;

  const dest = app.metadataCache.getFirstLinkpathDest(clean, fromPath);
  const found: TFile | null =
    dest instanceof TFile
      ? dest
      : (() => {
          const f = app.vault.getAbstractFileByPath(normalizePath(clean));
          return f instanceof TFile ? f : null;
        })();
  if (!found) return null;
  const kind = kindOfExt(found.extension);
  if (!kind) return null;
  return { ref: clean, path: found.path, remote: false, caption: ref.caption, kind };
};

/** 从链接里取出扩展名（忽略查询串 / 锚点） */
const extOfLink = (link: string): string => {
  const clean = link.split("#")[0].split("?")[0];
  const base = clean.split("/").pop() ?? "";
  const idx = base.lastIndexOf(".");
  return idx < 0 ? "" : base.slice(idx + 1).toLowerCase();
};

const photoKey = (p: Photo): string => (p.remote ? p.path : p.path.toLowerCase());

/**
 * 解析一篇 Markdown → Post 列表（只保留含图片的记录）。
 * groupBy = "record"：每条记录一个 Post（推荐）；
 * groupBy = "file"：整篇文件的图片合成一个 Post。
 */
export function buildPosts(
  app: App,
  file: TFile,
  bodyRaw: string,
  source: SourceFolder,
  groupBy: "record" | "file",
  captionChars: number
): FeedPost[] {
  let records: ParsedRecord[];
  try {
    records = parseRecords(app, file, bodyRaw);
  } catch (e) {
    console.error(`照片流：解析失败 ${file.path}`, e);
    return [];
  }

  if (groupBy === "file") {
    const merged = mergeFileRecords(records);
    records = merged ? [merged] : [];
  }

  const out: FeedPost[] = [];
  records.forEach((rec, idx) => {
    const photos: Photo[] = [];
    const seen = new Set<string>();
    for (const ref of rec.images) {
      const p = resolvePhoto(app, ref, file.path);
      if (!p) continue;
      const k = photoKey(p);
      if (seen.has(k)) continue;
      seen.add(k);
      photos.push(p);
    }
    if (!photos.length) return;

    const [caption, truncated] = truncate(cleanRecordText(rec.text), captionChars);
    out.push({
      id: `${file.path}#${idx}`,
      file: file.path,
      date: rec.date,
      time: rec.time,
      line: rec.line,
      sort: epochOf(rec.date, rec.time),
      src: source.name || source.type,
      srcType: source.type,
      srcDesc: source.desc || "",
      srcPath: source.path,
      caption,
      truncated,
      photos,
    });
  });
  return out;
}

/** 把同一篇文件的多条记录合并成一条（保留第一条有文字的描述） */
function mergeFileRecords(records: ParsedRecord[]): ParsedRecord | null {
  const withImg = records.filter((r) => r.images.length);
  if (!withImg.length) return null;
  const first = withImg[0];
  const text = withImg.map((r) => r.text).find((t) => cleanRecordText(t).length) ?? first.text;
  return {
    date: first.date,
    time: first.time,
    line: first.line,
    text,
    images: withImg.flatMap((r) => r.images),
  };
}
