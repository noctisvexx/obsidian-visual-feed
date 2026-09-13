/**
 * 视频「封面帧」的时间点（秒）。
 *
 * 桌面 Chromium 会把 preload="metadata" 的 <video> 解出首帧直接画在元素上，所以桌面上
 * 视频卡片看起来是有缩略图的；移动端 WebView（iOS WebKit / Android）不画 —— 卡位上就是
 * 一块纯黑（.pf-video 的 background 是 #000）。
 *
 * 给地址挂上 #t=0.1 就能让浏览器 seek 到该时间点、把那一帧当封面渲染出来，两端一致。
 * 0.1s 而不是 0：首帧经常是黑场 / 转场帧，往后挪一丁点更保险，播放时也察觉不到。
 */
const VIDEO_THUMB_TIME = 0.1;

/**
 * 给视频地址挂上封面时间片段。
 * 已经带片段（例如远程地址自带 query/hash）或空地址时原样返回，避免二次拼接。
 */
export const videoThumbSrc = (src: string): string => {
  if (!src || src.includes("#")) return src;
  return `${src}#t=${VIDEO_THUMB_TIME}`;
};
