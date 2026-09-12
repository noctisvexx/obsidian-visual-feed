/** 日期工具 */

const pad = (n: number): string => String(n).padStart(2, "0");

/**
 * 时间戳核心规则：`H:MM` / `HH:MM` / `HH:MM:SS`，**只接受合法 24 小时制**。
 * 写成这样（而不是 `\d{1,2}:\d{2}`）是为了让 `24:00` / `25:80` / `99:99` 天然不匹配。
 *
 * 解析器（`indexer/parse`）与发布器（`publish/publisher`）共用这一条规则 —— 两边对
 * 「什么算合法时间」的判断必须一致，否则发布时可能把解析器根本不认的非法时间当成插入锚点。
 */
export const TS_CORE = "([01]?\\d|2[0-3]):([0-5]\\d)(?::[0-5]\\d)?";

/** Date → YYYY-MM-DD（本地时区） */
export const fmtDate = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const isDateStr = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** 从任意值解析出 YYYY-MM-DD（兼容 Date / "2026-08-13T10:19:53" / "2026/08/13"） */
export const toDateStr = (v: unknown): string => {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return fmtDate(v);
  const s = String(v ?? "").trim();
  if (!s) return "";
  const m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`;
  return "";
};

/** 从任意值解析出 HH:MM（无时间返回 ''） */
export const toTimeStr = (v: unknown): string => {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return `${pad(v.getHours())}:${pad(v.getMinutes())}`;
  }
  const s = String(v ?? "").trim();
  const m = s.match(/(\d{1,2}):(\d{2})/);
  if (!m) return "";
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return "";
  return `${pad(h)}:${pad(mi)}`;
};

/**
 * 从 Vault 路径推断日期：目录里的 4 位数年份（2026 / 2026年）+ 文件名的 MMDD 或 MM-DD。
 * 例：日记/2026/0812.md → 2026-08-12
 *     社交归档/2026年/09月/09-11.md → 2026-09-11
 * 无法推断返回 ''。
 */
export const dateFromPath = (path: string): string => {
  const segs = path.split("/");
  const name = segs[segs.length - 1] || "";
  let year = "";
  for (let i = segs.length - 2; i >= 0; i--) {
    const m = segs[i].match(/^(\d{4})年?$/);
    if (m) {
      year = m[1];
      break;
    }
  }
  if (!year) return "";
  const base = name.replace(/\.md$/i, "");
  const mmdd = base.match(/^(\d{2})(\d{2})/);
  if (mmdd && Number(mmdd[1]) >= 1 && Number(mmdd[1]) <= 12 && Number(mmdd[2]) <= 31) {
    return `${year}-${mmdd[1]}-${mmdd[2]}`;
  }
  const dashed = base.match(/^(\d{2})-(\d{2})/);
  if (dashed) return `${year}-${dashed[1]}-${dashed[2]}`;
  return "";
};

/** 文件名里的时间：`07-13 10-31 标题.md` / `01-21 18-05.md` → 10:31 / 18:05 */
export const timeFromPath = (path: string): string => {
  const base = (path.split("/").pop() || "").replace(/\.md$/i, "");
  const m = base.match(/^\d{2}-\d{2}\s+(\d{2})-(\d{2})/);
  if (!m) return "";
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return "";
  return `${m[1]}:${m[2]}`;
};

/** 日期 + 时间 → 排序时间戳（无时间按 00:00 计） */
export const epochOf = (date: string, time: string): number => {
  if (!isDateStr(date)) return 0;
  const t = /^\d{2}:\d{2}$/.test(time) ? time : "00:00";
  const ms = Date.parse(`${date}T${t}:00`);
  return Number.isNaN(ms) ? 0 : ms;
};

/** 中文可读日期：2026-09-12 → 2026年9月12日 */
export const humanDate = (date: string): string => {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return date;
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;
};

/** 相对时间：刚刚 / 3 小时前 / 昨天 / 5 天前 / 2026年9月12日 */
export const relativeTime = (ms: number, now = Date.now()): string => {
  if (!ms) return "";
  const diff = now - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day === 1) return "昨天";
  if (day < 30) return `${day} 天前`;
  const d = new Date(ms);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
};
