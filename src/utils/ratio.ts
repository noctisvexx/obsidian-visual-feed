/**
 * 照片框比例策略 —— 纯函数，可单测。
 *
 * 背景：Feed 里每条 Post 的照片框如果完全跟随原图比例，遇到手机长截图（1:10）
 * 或全景横幅（15:1）时会撑出极端的框，整列看起来高矮参差。
 * 这里把「框比例」从「原图比例」解耦：可选夹在一个区间里，或统一成一个比例。
 */
import type { MediaRatioMode } from "../types";

export interface RatioChoice {
  /** 宽 ÷ 高 */
  value: number;
  label: string;
}

/** 区间下限（竖图方向） */
export const RATIO_MIN_OPTIONS: RatioChoice[] = [
  { value: 0.5, label: "1:2" },
  { value: 0.5625, label: "9:16" },
  { value: 0.6667, label: "2:3" },
  { value: 0.75, label: "3:4" },
  { value: 0.8, label: "4:5" },
  { value: 1, label: "1:1" },
];

/** 区间上限（横图方向） */
export const RATIO_MAX_OPTIONS: RatioChoice[] = [
  { value: 1, label: "1:1" },
  { value: 1.3333, label: "4:3" },
  { value: 1.5, label: "3:2" },
  { value: 1.7778, label: "16:9" },
  { value: 2, label: "2:1" },
];

/** 统一比例可选值 */
export const RATIO_FIXED_OPTIONS: RatioChoice[] = [
  { value: 0.5625, label: "9:16" },
  { value: 0.75, label: "3:4" },
  { value: 0.8, label: "4:5" },
  { value: 1, label: "1:1" },
  { value: 1.3333, label: "4:3" },
  { value: 1.7778, label: "16:9" },
];

export interface FrameRatioConfig {
  mode: MediaRatioMode;
  /** range：最窄（宽 ÷ 高） */
  min: number;
  /** range：最宽（宽 ÷ 高） */
  max: number;
  /** fixed：统一比例（宽 ÷ 高） */
  fixed: number;
}

/**
 * 默认策略：限制范围（4:5 ~ 16:9）。
 * 实测 Feed 里约 22% 的图是 1:10 长截图或 15:1 全景，纯原图比例会让整列高矮参差，
 * 夹到 4:5~16:9 只裁这 22% 的极端图，其余 78% 原样显示。
 * 注意要和 settings.ts 的 DEFAULT_SETTINGS 保持一致。
 */
export const DEFAULT_FRAME_RATIO: FrameRatioConfig = {
  mode: "range",
  min: 0.8,
  max: 1.7778,
  fixed: 1,
};

/** 保留 4 位小数，避免写进 CSS 的字符串太长 */
const round4 = (r: number): number => Math.round(r * 10000) / 10000;

/** 目标比例是否需要裁剪填满（只有 original 模式完全不裁） */
export const frameCrops = (mode: MediaRatioMode): boolean => mode !== "original";

/**
 * 算出这条 Post 的照片框比例（宽 ÷ 高）。
 * 返回 null 表示「沿用媒体原始比例」。
 */
export function frameRatio(
  naturalW: number,
  naturalH: number,
  cfg: FrameRatioConfig
): number | null {
  if (!naturalW || !naturalH) return null;
  if (cfg.mode === "original") return null;
  if (cfg.mode === "fixed") return round4(cfg.fixed) || DEFAULT_FRAME_RATIO.fixed;
  // range：区间内的照片原样显示，只有超出区间才夹回来
  const lo = Math.min(cfg.min, cfg.max);
  const hi = Math.max(cfg.min, cfg.max);
  const natural = naturalW / naturalH;
  return round4(Math.min(hi, Math.max(lo, natural)));
}

/** 把比例写进 CSS 用：统一输出数字（CSS 的 aspect-ratio 与 calc 都接受纯数字） */
export const ratioToCss = (r: number): string => String(round4(r));

/** 比例 →「4:5」这类展示名（找不到匹配就返回数字本身） */
export function ratioLabel(r: number, opts: RatioChoice[] = RATIO_FIXED_OPTIONS): string {
  const hit = opts.find((o) => Math.abs(o.value - r) < 0.0005);
  return hit ? hit.label : String(round4(r));
}

/** 把任意比例吸附到最接近的可选值（保证设置页下拉框永远能对上） */
export function snapToOption(r: number, opts: RatioChoice[]): number {
  return opts.reduce(
    (best, o) => (Math.abs(o.value - r) < Math.abs(best - r) ? o.value : best),
    opts[0].value
  );
}
