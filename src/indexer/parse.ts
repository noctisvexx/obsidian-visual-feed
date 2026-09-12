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
  TS_CORE,
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

/** 列表时间戳 `- HH:MM`；时间戳后面的文字算进该 Post 正文（时间合法性由 TS_CORE 统一保证） */
const LIST_TS_RE = new RegExp(`^\\s*[-*]\\s+${TS_CORE}(?:\\s+(.*))?$`);
/** 三级标题时间戳 `### HH:MM`；要求整行只有时间戳 */
const HEAD_TS_RE = new RegExp(`^\\s*###\\s+${TS_CORE}\\s*$`);
/** 日期标题 `## [[2026-08-13]]` —— 只改「归属日期」，不切 Post */
const DAY_LINK_RE = /^##\s*\[\[(\d{4}-\d{2}-\d{2})\]\]\s*$/;
/** 日期标题 `## 2026-08-14 周五` */
const DAY_PLAIN_RE = /^##\s*(\d{4}-\d{2}-\d{2})\s*(?:周.|星期.)?\s*$/;

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

/** 解析一篇 Markdown → 记录列表（日期基准：frontmatter 的 `date` → 路径 → mtime） */
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

  // 日期基准：frontmatter 的 `date`（通用字段）→ 路径里的日期 → 文件修改时间
  const baseDate =
    toDateStr(fmStr("date")) || dateFromPath(file.path) || fmtDate(new Date(file.stat.mtime));
  // 时间基准：frontmatter 的 `date` → 文件名里的 HH-MM
  const baseTime = toTimeStr(fmStr("date")) || timeFromPath(file.path);

  const bodyText = stripFrontmatter(body);
  return splitRecords(bodyText, baseDate, baseTime);
}

/**
 * 记录切分（纯函数，便于测试）。一条记录 = 一个 Post，**只看行首时间戳，跟标题写什么无关**：
 *  - `- HH:MM`（列表项）或 `### HH:MM`（三级标题）→ 新起点，直到下一个时间戳为止；
 *    两种格式混用时按文件里的实际顺序切
 *  - 时间必须是合法 24 小时制（由 TS_CORE 保证），所以 `- 25:80`、
 *    正文里的「我在 12:56 拍了一张照片」都不算起点
 *  - 第一个时间戳之前的正文 → 含媒体时才单独成一条
 *  - 整篇没有任何时间戳 → 整篇算一条（文件级回退，不因为缺标题就丢掉含媒体的文件）
 *
 * 职责边界：媒体发现只管「这篇里有哪些图片/视频」，时间戳只管「这些媒体属于哪条 Post」。
 */
export function splitRecords(bodyText: string, baseDate: string, baseTime: string): ParsedRecord[] {
  const lines = bodyText.split("\n");

  /** 一个时间戳起点 */
  interface Mark {
    time: string;
    /** 起点所在行（0 基，用于「跳转到原记录位置」） */
    line: number;
    /** 该 Post 正文从哪一行开始（标题式就是下一行） */
    bodyFrom: number;
    /** 列表式里时间戳后面的文字，也算进正文（`- 12:56 出门了`） */
    inline: string;
  }
  const marks: Mark[] = [];
  /** 日期标题：只决定「归属日期」，不切 Post */
  const days: { line: number; date: string }[] = [];
  /** 第一个时间戳之前的正文 */
  const headLines: string[] = [];

  lines.forEach((rawLine, idx) => {
    const line = rawLine.replace(/\s+$/, "");

    const dayHit = line.match(DAY_LINK_RE) || line.match(DAY_PLAIN_RE);
    if (dayHit) {
      days.push({ line: idx, date: dayHit[1] ?? "" });
      return;
    }

    const headHit = line.match(HEAD_TS_RE);
    if (headHit) {
      marks.push({
        time: normTime(headHit[1] ?? "", headHit[2] ?? ""),
        line: idx,
        bodyFrom: idx + 1,
        inline: "",
      });
      return;
    }

    const listHit = line.match(LIST_TS_RE);
    if (listHit) {
      marks.push({
        time: normTime(listHit[1] ?? "", listHit[2] ?? ""),
        line: idx,
        bodyFrom: idx + 1,
        inline: (listHit[3] ?? "").trim(),
      });
      return;
    }

    // 还没遇到任何时间戳 → 归入开头正文（时间戳之后的行由下面的切片处理）
    if (!marks.length) headLines.push(line);
  });

  /** 某一行归属的日期：取它前面最后一个日期标题，没有就用文件级日期 */
  const dateAt = (at: number): string => {
    let d = baseDate;
    for (const day of days) {
      if (day.line > at) break;
      if (day.date) d = day.date;
    }
    return d;
  };

  /** 去掉分隔线并裁掉首尾空白 */
  const tidy = (s: string): string => s.replace(/^-{3,}\s*$/gm, "").trim();

  const out: ParsedRecord[] = marks.map((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].line : lines.length;
    const body = tidy(lines.slice(mark.bodyFrom, end).join("\n"));
    const text = [mark.inline, body].filter(Boolean).join("\n");
    return {
      date: dateAt(mark.line),
      time: mark.time,
      line: mark.line,
      text,
      images: extractImageRefs(text),
    };
  });

  // 第一个时间戳之前的正文：含媒体时单独算一条，用文件级日期/时间兜底
  const head = tidy(headLines.join("\n"));
  const headImages = extractImageRefs(head);
  if (headImages.length) {
    out.unshift({ date: baseDate, time: baseTime, line: 0, text: head, images: headImages });
  }
  return out;
}

/** `9:05` → `09:05`（时分已是合法 24 小时制，由正则保证） */
const normTime = (h: string, m: string): string => `${String(Number(h)).padStart(2, "0")}:${m}`;

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
