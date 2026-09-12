/** 正文 / 媒体引用解析工具 */

/** 剔除 Templater 模板代码（<% ... %>），防止未渲染的模板污染正文 */
export const stripTemplateCode = (s: string): string => s.replace(/<%[\s\S]*?%>/g, "");

/**
 * 统一换行符（CRLF → LF）并移除 BOM。
 * 不同来源的 Markdown 换行格式不一致，不归一化会导致按行首匹配的正则失配。
 */
export const normalizeBody = (body: string): string =>
  body.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");

/** 剥离 frontmatter 块 */
export const stripFrontmatter = (body: string): string =>
  body.replace(/^---[\s\S]*?\n---\n?/, "");

/** 简易 frontmatter 解析（仅取标量字段）；metadataCache 未就绪时的回退 */
export function parseFrontmatterLite(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const m = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^([^:#][^:]*?):\s*(.*)$/);
    if (!mm) continue;
    const key = mm[1].trim();
    let val = mm[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!val || val.startsWith("-") || /^(true|false|null|\[\])$/.test(val)) continue;
    out[key] = val;
  }
  return out;
}

/** 一条媒体（图片 / 视频）在正文里的原始引用 */
export interface RawImageRef {
  /** 引用目标：wiki 名（不含 | 后缀）/ md 路径 / URL */
  link: string;
  /** 媒体的 caption（alt），可靠时才非空 */
  caption: string;
}

/**
 * wiki 嵌入：`![[文件]]` / `![[文件|说明]]` / `![[文件|300x200]]`。
 * ⚠️ 用非贪婪 + 允许方括号：文件名本身可能带 `[` `]`（如 `封面[2024]版.jpg`），
 *    写成 `[^\]\n]+` 会让这类引用整条匹配不上，既不提取也不清洗。
 */
const IMG_WIKI_RE = /!\[\[([^\n]+?)\]\]/g;
const IMG_MD_RE = /!\[([^\]\n]*)\]\(\s*([^)\n]+?)\s*\)/g;
const IMG_HTML_RE = /<img\b[^>]*>/gi;
const VIDEO_HTML_RE = /<video\b[^>]*>/gi;
const HTML_SRC_RE = /\bsrc\s*=\s*["']([^"']+)["']/i;
const HTML_ALT_RE = /\balt\s*=\s*["']([^"']*)["']/i;

/**
 * 判断 wiki 嵌入的 `|` 后缀是尺寸还是 alt。
 * Obsidian 支持 ![[a.png|300]]、![[a.png|300x200]]（尺寸）和 ![[a.png|说明]]（alt）。
 */
const isSizeSuffix = (s: string): boolean => /^\d+(\s*x\s*\d+)?$/.test(s.trim());

/**
 * 提取正文里的全部媒体引用（图片 + 视频）：
 *  - `![[xxx.jpg]]` / `![[xxx.jpg|alt]]` / `![[xxx.jpg|300x200]]` / `![[xxx.mp4]]`
 *  - `![alt](path)` / `![alt](url "title")`
 *  - `<img src="..." alt="...">` / `<video src="..."></video>`
 * 按 link 去重（保留首次出现的 caption）。
 */
export const extractImageRefs = (body: string): RawImageRef[] => {
  const out: RawImageRef[] = [];
  const seen = new Set<string>();
  const push = (linkRaw: string, captionRaw: string): void => {
    const link = stripTemplateCode(linkRaw).trim();
    if (!link) return;
    if (seen.has(link)) return;
    seen.add(link);
    out.push({ link, caption: captionRaw.trim() });
  };

  let m: RegExpExecArray | null;
  IMG_WIKI_RE.lastIndex = 0;
  while ((m = IMG_WIKI_RE.exec(body)) !== null) {
    const raw = m[1];
    const idx = raw.indexOf("|");
    if (idx < 0) {
      push(raw, "");
      continue;
    }
    const link = raw.slice(0, idx);
    const suffix = raw.slice(idx + 1);
    push(link, isSizeSuffix(suffix) ? "" : suffix);
  }

  IMG_MD_RE.lastIndex = 0;
  while ((m = IMG_MD_RE.exec(body)) !== null) {
    const alt = m[1] || "";
    let link = m[2] || "";
    // 去掉可选 title：path "title" / path 'title'
    link = link.replace(/\s+["'][^"']*["']\s*$/, "");
    push(link, alt);
  }

  IMG_HTML_RE.lastIndex = 0;
  while ((m = IMG_HTML_RE.exec(body)) !== null) {
    const tag = m[0];
    const src = HTML_SRC_RE.exec(tag);
    if (!src) continue;
    const alt = HTML_ALT_RE.exec(tag);
    push(src[1], alt ? alt[1] : "");
  }

  // <video src="..."></video>（Obsidian 里内嵌视频的写法之一）
  VIDEO_HTML_RE.lastIndex = 0;
  while ((m = VIDEO_HTML_RE.exec(body)) !== null) {
    const tag = m[0];
    const src = HTML_SRC_RE.exec(tag);
    if (src) push(src[1], "");
  }

  return out;
};

/** 完整的 <video>…</video> 元素（连带闭合标签一起清掉） */
const VIDEO_HTML_FULL_RE = /<video\b[^>]*>[\s\S]*?<\/video\s*>/gi;
const VIDEO_CLOSE_RE = /<\/?video\b[^>]*>/gi;

/** 媒体引用整体替换为空白（用于生成「记录正文」） */
const stripImageSyntax = (s: string): string =>
  s
    .replace(VIDEO_HTML_FULL_RE, " ")
    .replace(IMG_WIKI_RE, " ")
    .replace(IMG_MD_RE, " ")
    .replace(IMG_HTML_RE, " ")
    .replace(VIDEO_CLOSE_RE, " ");

/** 正文清洗中跳过的整行 */
const isNoiseLine = (l: string): boolean => {
  const t = l.trim();
  if (!t) return true;
  if (/^%%/.test(t)) return true; // Obsidian 注释
  if (/^<%/.test(t)) return true; // Templater
  if (/^<!--/.test(t)) return true; // HTML 注释（同步脚本写的幂等标记）
  if (/^#/.test(t)) return true; // 标题
  if (/^(---|\*\*\*|___)$/.test(t)) return true; // 分隔线
  if (/^> \[!/.test(t)) return true; // callout 标记
  if (/^\[!/.test(t)) return true;
  if (/^>\s*$/.test(t)) return true;
  return false;
};

/**
 * 由记录原始文本生成干净的正文：
 * 去图片引用 / 注释 / 标记行 / markdown 修饰符，压平空白。
 */
export const cleanRecordText = (raw: string): string => {
  const hadImgOnly = raw.trim().length > 0;
  const lines = raw.split(/\n+/);
  const kept: string[] = [];
  for (const line of lines) {
    const withoutImg = stripImageSyntax(line);
    if (isNoiseLine(withoutImg)) continue;
    kept.push(withoutImg);
  }
  let text = kept
    .join(" ")
    .replace(/^[-*+]\s+/, "")
    // 双链 `[[目标]]` / `[[目标|别名]]`：有别名留别名，没有就整段去掉。
    // 同样要允许目标里带方括号（笔记名带 `[草稿]` 之类）。
    .replace(/\[\[([^\n]+?)\]\]/g, (_all, inner: string) => {
      const i = inner.indexOf("|");
      return i < 0 ? "" : inner.slice(i + 1);
    })
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/^\s*>\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // 双链被替换后可能残留空括号
  text = text.replace(/\(\s*\)/g, "").trim();
  if (!text && hadImgOnly) return "";
  return text;
};

/** 按字符数截断，返回 [文本, 是否被截断] */
export const truncate = (s: string, max: number): [string, boolean] => {
  if (max <= 0) return [s, false];
  if (s.length <= max) return [s, false];
  return [s.slice(0, max).trimEnd() + "…", true];
};
