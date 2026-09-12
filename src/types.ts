/** 视界 Visual Feed —— 核心类型定义 */

/** 插件显示名（视图标题、设置页、Ribbon 提示统一用它） */
export const PLUGIN_NAME = "视界 · Visual Feed";

/** 来源类型：个人记录 / 社交平台 记录 */
export type SourceType = "personal" | "socialMedia";

/** 媒体类型：图片 / 视频 */
export type MediaKind = "image" | "video";

/**
 * 照片框比例策略：
 *  - original：完全按媒体原始比例（不裁剪，但极端比例会让框高矮参差）
 *  - range   ：把比例夹在一个区间内（区间内的照片原样，超出才裁剪填满）
 *  - fixed   ：全部统一成一个比例（最整齐，但一律裁剪）
 */
export type MediaRatioMode = "original" | "range" | "fixed";

/**
 * 首页布局：
 *  - feed：单列 Instagram 风格（照片大、有正文与来源，一条一条往下看）
 *  - grid：多列网格瀑布流（多列铺满、瓦片尺寸固定，适合一次扫很多张）
 * 两种布局共用同一套分批渲染，数量都按滚动自动追加。
 */
export type FeedLayout = "feed" | "grid";

/** 网格模式下的瓦片尺寸档位（固定展示尺寸，只在这三档里选） */
export type GridTileSize = "small" | "medium" | "large";

/**
 * 网格瀑布流里「一格」代表什么：
 *  - post ：一条记录一格（多图记录在格子里左右滑）
 *  - photo：把记录摊开，每张照片各占一格（更像照片墙）
 * 两种模式下格子上都不叠任何覆盖物：瀑布流只要照片本身。
 */
export type GridUnit = "post" | "photo";

/** 用户配置的来源文件夹（设置页可增删改） */
export interface SourceFolder {
  /** 稳定 id（重命名/移动路径后仍可追踪来源） */
  id: string;
  /** Vault 内相对路径（'' 表示 Vault 根） */
  path: string;
  /** 显示名称（Feed 里显示的来源名，如「个人记录」「绘画」） */
  name: string;
  /** 来源类型 */
  type: SourceType;
  /** 说明文字（可选，显示在 Feed 来源上、设置页里） */
  desc: string;
  /** 是否启用（禁用后不参与索引） */
  enabled: boolean;
}

/** 一条媒体（图片或视频，引用 Vault 里的原文件，不复制、不生成缩略图） */
export interface Photo {
  /** 原始引用文本（wiki 名 / 相对路径 / URL），调试与回退用 */
  ref: string;
  /** Vault 内完整路径；远程媒体为 URL */
  path: string;
  /** 是否为远程媒体（http/https） */
  remote: boolean;
  /** 媒体自身的 caption（![[img|alt]] 或 ![alt](url) 的 alt，可靠时才填） */
  caption: string;
  /** 媒体类型。旧索引没有该字段 → 按 image 处理（无需重建索引） */
  kind?: MediaKind;
}

/** 一条记录 = 一个 Post */
export interface FeedPost {
  /** 稳定 id：md 路径 + 段序号 */
  id: string;
  /** 所属 Markdown 路径 */
  file: string;
  /** 记录日期 YYYY-MM-DD */
  date: string;
  /** 记录时间 HH:MM，无则 '' */
  time: string;
  /** 记录在 Markdown 中的起始行（0 基，用于跳转到原文位置） */
  line: number;
  /** 排序用时间戳 */
  sort: number;
  /** 来源显示名（用户配置） */
  src: string;
  /** 来源类型 */
  srcType: SourceType;
  /** 来源说明 */
  srcDesc: string;
  /** 来源文件夹路径 */
  srcPath: string;
  /** 记录正文（已清洗，可能被截断） */
  caption: string;
  /** 正文是否被截断（用于「查看原记录」提示） */
  truncated: boolean;
  /** 该记录的全部照片（≥1） */
  photos: Photo[];
}

export interface FileStat {
  mtime: number;
  size: number;
}

/** 持久化索引 */
export interface FeedIndex {
  version: number;
  /** md 路径 -> stat，用于启动增量对比 */
  files: Record<string, FileStat>;
  /** 全部 Post */
  posts: FeedPost[];
}

export interface PhotoFeedSettings {
  /** 来源文件夹列表 */
  sources: SourceFolder[];
  /** 分组方式：每条记录一个 Post / 每个文件一个 Post */
  groupBy: "record" | "file";
  /** Feed 每批渲染条数 */
  pageSize: number;
  /** 图片区域最大高度（vh） */
  imageMaxHeight: number;
  /** 照片框比例策略 */
  mediaRatioMode: MediaRatioMode;
  /** range 模式：允许的最窄比例（宽 ÷ 高） */
  mediaRatioMin: number;
  /** range 模式：允许的最宽比例（宽 ÷ 高） */
  mediaRatioMax: number;
  /** fixed 模式：统一使用的比例（宽 ÷ 高） */
  mediaRatioFixed: number;
  /** 是否显示正文文字 */
  showCaption: boolean;
  /** 正文显示字数上限 */
  captionChars: number;
  /** 是否显示来源说明文字 */
  showSourceDesc: boolean;
  /** 启动时打开照片流 */
  openOnStartup: boolean;
  /** 相机胶卷式：卡片是否显示圆角阴影（关闭 = 无缝贴边） */
  cardStyle: boolean;
  /** 首页布局：单列 Feed / 多列网格瀑布流（首页左下角按钮可随手切换） */
  layoutMode: FeedLayout;
  /** 网格模式的瓦片尺寸档位 */
  gridTileSize: GridTileSize;
  /** 网格模式里一格代表一条记录还是一张照片 */
  gridUnit: GridUnit;
  /** 发布目标文件夹（自己选定，不跟随 Obsidian 原生日记） */
  publishFolder: string;
  /** 发布时的附件存放文件夹；留空 = 跟随 Obsidian 的附件文件夹设置 */
  attachmentFolder: string;
  /** 发布目标文件夹不在来源列表时，自动加为来源（否则刚发布的照片不会出现在 Feed） */
  autoAddSource: boolean;
}

export const INDEX_VERSION = 1;

/** 支持的图片扩展名 */
export const IMAGE_EXT = new Set([
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "avif",
  "bmp",
  "svg",
  "heic",
  "heif",
]);

/** 支持的视频扩展名（Obsidian 内嵌播放的原生格式） */
export const VIDEO_EXT = new Set(["mp4", "webm", "mov", "m4v", "mkv", "ogv", "avi", "3gp"]);

export const isImageExt = (ext: string): boolean => IMAGE_EXT.has(ext.toLowerCase());

export const isVideoExt = (ext: string): boolean => VIDEO_EXT.has(ext.toLowerCase());

/** 图片或视频都算「可展示的媒体」 */
export const isMediaExt = (ext: string): boolean =>
  isImageExt(ext) || isVideoExt(ext);

/** 扩展名 → 媒体类型；不是支持的媒体返回 null */
export const kindOfExt = (ext: string): MediaKind | null => {
  if (isImageExt(ext)) return "image";
  if (isVideoExt(ext)) return "video";
  return null;
};

/** 媒体类型兜底：旧索引没有 kind 字段时按图片处理 */
export const kindOf = (photo: { kind?: MediaKind }): MediaKind => photo.kind ?? "image";
