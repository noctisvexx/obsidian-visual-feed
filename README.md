# 视界 · Visual Feed

> 把你散落在 Obsidian 里的照片重新组织起来，变成一个能一直往下滑的照片流。

一个 Obsidian 插件：扫描你指定的一个或多个文件夹（日记、社交平台归档、随手记、剪藏……），把里面出现过的**图片和视频**抽出来，重新排成 Instagram 风格的时间流 —— 单列大图，或者多列网格瀑布流，左下角一点就切。

**纯本地运行。不复制原文件、不生成缩略图、不改动你的任何一条笔记。**

---

## 它解决什么问题

用久了 Obsidian 之后，照片是**散落**的：今天的记录在 `日记/2026/0901.md`，一条动态在 `社交归档/2026-09-01.md`，随手记又在另一个文件夹里。想回看「我以前拍过什么」，只能在文件树里翻。

视界不改你的目录结构，也不要求你把照片搬到统一的地方。它只是**按你给的范围建一份索引**，然后把照片按时间倒序铺出来 —— 于是你的笔记结构完全不用动，但你多了一个专门用来看照片的地方。

---

## 特性

### 两种布局，随手切换

左下角按钮一点就切，选择会被记住：

- **单列 Feed** —— Instagram 风格。照片大、带正文与来源，一条一条往下看。
- **网格瀑布流** —— 多列自动铺满，瓦片**固定正方形**、裁切填满，一屏能扫很多张。瓦片模式下正文和来源整块都不渲染（不是藏起来），照片再多也不卡。默认**每张照片一格**：一条记录里的照片全部摊开，各占一格；不想打散就切成**每条记录一格**（多图在格子里左右滑）。格子上不叠任何东西 —— 没有张数角标、没有图标，只有照片本身。

两种布局共用同一套**分批渲染**：首屏只渲染一批，滚动到哨兵才追加下一批，提前 1200px 预载。上千张照片也不会一次性塞进 DOM。

### 照片框比例可调

照片的原始比例差异极大（实测 45% 是 1:1，但也有 1:10 的手机长截图和 15:1 的全景），直接铺出来会参差不齐。三档策略：

| 模式 | 行为 |
| --- | --- |
| **限制范围**（默认 4:5 ~ 16:9） | 区间内的照片**完全不动**，只有越界的极端比例裁到边界值。实测只有约 22% 的记录会受影响 |
| 统一比例 | 全部裁成同一个比例（9:16 / 3:4 / 4:5 / 1:1 / 4:3 / 16:9），整列最齐 |
| 原始比例 | 完全不裁，完全按原图 |

另外「图片最大高度」限制照片区域占屏幕的高度；超过时照片框会**整体缩窄**而不是左右留白。

### 多图轮播 + 原图浏览

- 一条记录里有多张图 → 轮播（滑动 / 拖拽 / 箭头 / `1/N` 角标），滑动带 scroll-snap
- 点任意照片 → 全屏 Lightbox，**可以跨记录连续滑动**，键盘 `←` `→` `Esc` 操作，触屏原生手势
- Lightbox 里可以一键「回到原记录」，直接跳到那条记录所在的**行**

### 发布照片与视频

右下角 `＋`（或命令「发布照片或视频」）：

1. 多选图片和视频（在 Obsidian 内直接拖入）
2. 每个媒体可以单独写说明
3. 选一个日期时间
4. 选目标文件夹（原生文件夹选择器）

然后插件会写进 `{目标文件夹}/YYYY/MM/MMDD.md`，媒体用 `![[纯文件名]]` 嵌入，附件落在你指定的附件文件夹（留空则跟随 Obsidian 的附件设置）。

几个刻意做对的地方：

- **一个时间戳 = 一条 Post**。同一天发多条，会自动按 `HH:MM` 升序插进同一个文件，而不是各写一个文件。
- 分段**只看时间戳，不认固定标题**：`### HH:MM` 小标题或 `- HH:MM` 列表项都是 Post 的开头，一直管到下一条时间戳为止。`## Memos` / `## 随记` / `## 日记` / `## Journal` 这类标题只是普通标题，叫什么、有没有都不影响解析。
- 沿用你文件里**已经有的格式**：本来是 `### HH:MM` 小标题就插小标题，本来是 `- HH:MM` 列表就插列表项；两种混在同一份文件里也会按出现顺序正常解析。
- **完全没有时间戳也照样能用**：正文里一个 `HH:MM` 都没有时，**整篇算一条记录**（文件级回退），不会因为缺时间戳就把含图的笔记跳过。适合「一天一篇、每篇几张图」的写法 —— 那些图会合并成**一张卡片的多图轮播**。
- **日期和时分都是兜底着来的**，不要求任何特定写法：日期取 `date` → 路径里的年月日 → 文件修改时间；时分取 `date` 里的时间 → 文件名里的 `HH-MM`。两者都取不到就只显示日期，**不硬造一个时间**出来。
- 文件名里的 Windows 非法字符会被清洗（冒号特别危险 —— 它会被 NTFS 当成 ADS 静默截断成 0 字节），重名自动加 `-1`，换行符保持原样。
- 视频用 `<video controls preload="metadata" playsinline>`，**绝不自动播放**；点视频本体不会误触发 Lightbox。
- 发布后只重新索引**刚写的那一个文件**，不会重建全库。

### 筛选

左下角筛选按钮：按**来源** + **年份** + **起止日期**。来源列表不是写死的，而是**按索引里实际存在的来源动态生成**，标签就是你在设置里填的**显示名**（`全部` 永远排第一）；只有一个来源时整排自动隐藏 —— 「全部 / 唯一来源」两个选项没有意义。面板默认收起，点外面或 `Esc` 自动关；有筛选生效时按钮上会有个小圆点。面板底部一行是「当前条数 + ⚙ 设置」，来源文件夹、显示项想改就点这儿一步跳过去。

---

## 安装

### 手动安装

1. 去 [Releases](https://github.com/noctisvexx/obsidian-visual-feed/releases) 下载最新版的 `main.js`、`manifest.json`、`styles.css`
2. 放进 `<你的库>/.obsidian/plugins/visual-feed/`
3. Obsidian 里：设置 → 第三方插件 → 关闭「安全模式」→ 启用「Visual Feed」

### 用 BRAT

装了 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 的话，直接把本仓库地址加进去即可。

---

## 快速开始

1. **设置 → Visual Feed → 来源文件夹**
2. 添加一个来源：
   - **路径** —— 要扫描的文件夹（用文件夹选择器挑，支持子文件夹递归）
   - **显示名** —— 只读，自动等于路径的末级文件夹名（选什么文件夹就显示什么名，不用手填）
   - **说明** —— 可选，显示在来源旁边
3. 用命令「重建视界索引」建一次索引
4. 点左侧边栏的图片图标（或命令「打开视界」）

之后 Obsidian 里**新建 / 修改 / 删除 / 重命名**文件都会自动增量更新索引，不用手动重建。

---

## 设置项

| 设置 | 说明 |
| --- | --- |
| **来源文件夹** | 可增删改的扫描范围列表。改路径或启用状态会重建索引；只改说明则原地打补丁，不重建 |
| **分组方式** | 每条记录一个 Post（一段带时间戳的记录各自成帖）／每个文件一个 Post |
| **默认布局** | 单列 Feed / 网格瀑布流。首页左下角按钮可随手切换，这里设的是打开时的默认值 |
| **瀑布流瓦片尺寸** | 小 / 中 / 大（窄屏会自动缩一档，保证能排下多列） |
| **瀑布流一格** | 每张照片一格（记录摊开，更像照片墙）／每条记录一格（多图在格子里左右滑；网格里不显示张数角标） |
| **每批渲染条数** | 滚动时每批追加多少条（5–40），越小越省内存 |
| **图片最大高度** | 照片区域占屏幕高度上限（40–90vh） |
| **照片框比例** | 限制范围 / 统一比例 / 原始比例，见上文 |
| **显示记录文字** | 是否在照片下方显示记录正文（限 10 行） |
| **正文显示字数上限** | 索引时截断正文字数 |
| **显示来源** | 关掉后首页与大图里都不出现来源（来源名与来源说明一起隐藏）；打开则两者都显示 |
| **卡片样式** | 关掉后是无边框圆角的贴边无缝效果，更像相册 |
| **发布文件夹** | 发布功能的默认目标文件夹 |
| **附件存放文件夹** | 留空 = 跟随 Obsidian 附件设置；`./` = 笔记同目录；`/` = 库根目录 |
| **发布文件夹自动加为来源** | 否则刚发布的照片不会出现在 Feed 里 |
| **启动时打开照片流** | Obsidian 启动后自动打开视界 |

---

## 工作原理

- **索引**：扫描来源文件夹里的 Markdown，解析出每处媒体引用（`![[...]]`、`![](...)`、HTML 标签），按 `record` 或 `file` 分组记录成 Post。索引持久化在插件的 `data.json` 里。
- **增量**：启动时对比每个文件的 `mtime` + `size`，只有变过的才重新解析；没变化时零读文件。索引结构演进用可选字段 + 兜底函数，**不需要为了升级插件而重建全库**。
- **不碰原笔记**：除了「发布」这一个显式动作会写你自己指定的目标文件，其余全部只读。不复制媒体、不生成缩略图、不移动文件。
- **媒体引用**：使用 Obsidian 原生的 `app://local/` 资源地址直接引用库内文件，远程图片（`https://`）也能显示。
- **主题**：所有颜色走 Obsidian 主题变量，深色 / 浅色自动适配；移动端会避开原生底部导航栏和键盘工具栏，并遵守 `prefers-reduced-motion`。

---

## 开发

```bash
npm install
npm run dev     # 监听模式（带 sourcemap）
npm run build   # 生产构建，产出 main.js
npm run check   # tsc --noEmit
npm test        # 打包测试 + 跑端到端测试
```

### 测试

两套测试，加起来 **364** 项断言：

- **`test/run-test.ts`** —— 真实 Vault 端到端。对着一个真实的 Obsidian 库跑全量索引，断言 Post/媒体数量、日期合法性、**增量读取次数**（没变化时应该是 0 次读文件）、增删改后的正确性、发布写入端到端，以及一批纯 CSS 回归断言（jsdom 量不了布局，所以直接对 `styles.css` 源码做文本断言）。
- **`test/run-dom-test.ts`** —— jsdom UI 冒烟。轮播、懒加载、分批渲染、Lightbox、筛选面板、发布弹窗、布局切换、设置页动态重绘。

两套测试里的**写操作全部走内存 overlay**，任何情况下都不会改到你磁盘上的真实笔记。

> 端到端测试需要指向一个真实的 Obsidian 库，路径**不写进代码**：
>
> ```bash
> # 方式一：环境变量
> VISUAL_FEED_VAULT="/path/to/your/vault" npm test
>
> # 方式二：把库路径写进 test/vault.local（该文件已 gitignore）
> ```
>
> **来源文件夹也不用配**：测试会在运行时从那个库里就地挑几个 md 最多的目录当来源
> （并顺带探测文件里用的时间戳格式），所以仓库里不含任何真实目录名。

---

## 已知限制

- 只索引 Markdown 里**被引用到**的媒体。没在任何笔记里出现过的孤立图片不会被收录。
- 远程图片（`https://`）依赖网络，离线时不显示。
- 视频只支持 Obsidian 能原生内嵌播放的格式（mp4 / webm / mov / m4v / mkv / ogv / avi / 3gp）。
- 索引是按需建立的，第一次打开大库会慢一点（之后就秒开）。

---

## English

> Regroup the photos scattered across your Obsidian notes into a feed you can keep scrolling.

An Obsidian plugin: point it at one or more folders (journals, social-media archives, quick notes, web clippings…), and it pulls out every **image and video** referenced there and lays them out as an Instagram-style timeline — single-column large photos, or a multi-column masonry grid you flip between from the bottom-left corner.

**Runs entirely locally. It does not copy your files, does not generate thumbnails, and does not modify a single one of your notes.**

---

### What it solves

After a while with Obsidian, your photos end up **scattered**: today's entry is in `Journal/2026/0901.md`, a post is in `Social/2026-09-01.md`, a quick note is in yet another folder. To look back at "what did I shoot before?", you have to dig through the file tree.

Visual Feed does not change your folder structure, and it does not ask you to move photos into one place. It simply **builds an index over the scope you give it**, then lays the photos out newest-first — so your note structure stays exactly as it is, and you gain a dedicated place to look at your photos.

---

### Features

#### Two layouts, one click apart

The bottom-left button flips between them, and the choice is remembered:

- **Single-column feed** — Instagram style. Big photos, with the note text and source underneath, one record after another.
- **Masonry grid** — multiple columns that fill the width, tiles **locked to squares** and cropped to fill, so a whole screenful is scannable at once. In grid mode captions and sources are not rendered at all (not merely hidden), so it stays smooth no matter how many photos you have. The default is **one tile per photo** — every photo in a record gets its own tile; switch to **one tile per record** to keep them together (swipe between images inside the tile). Nothing is overlaid on the tiles — no count badge, no icon, just the photo itself.

Both layouts share the same **batched rendering**: only one batch on first paint, the next appended once a sentinel scrolls into view, prefetched 1200px ahead. Thousands of photos never all land in the DOM at once.

#### Adjustable frame aspect ratio

Source ratios vary wildly (measured: 45% are 1:1, but there are also 1:10 phone screenshots and 15:1 panoramas), so a raw layout looks ragged. Three strategies:

| Mode | Behaviour |
| --- | --- |
| **Clamp range** (default 4:5 – 16:9) | Photos inside the range are **left untouched**; only extreme ratios outside it are cropped to the bound. Measured: only around 22% of records are affected |
| Fixed ratio | Everything cropped to a single ratio (9:16 / 3:4 / 4:5 / 1:1 / 4:3 / 16:9) — the tidiest column |
| Original | No cropping at all, exactly as shot |

"Max media height" additionally caps how much screen height the photo area may take; when a photo would exceed it, the frame **narrows as a whole** instead of leaving side gaps.

#### Multi-image carousel + full-screen viewer

- Multiple images in one record → a carousel (swipe / drag / arrows / `1/N` badge), with scroll-snap
- Tap any photo → full-screen lightbox, **swipeable straight across records**, `←` `→` `Esc` on the keyboard, native gestures on touch
- From the lightbox, one tap on "back to the record" jumps to the exact **line** in that note

#### Publishing photos and videos

The `＋` in the bottom-right corner (or the "Publish media" command):

1. Pick multiple images and videos (dragged in directly inside Obsidian)
2. Write a caption for each media item individually
3. Choose a date and time
4. Choose a target folder (native folder picker)

The plugin then writes to `{target folder}/YYYY/MM/MMDD.md`, embeds media as `![[bare-filename]]`, and puts attachments in the attachment folder you configured (leave it empty to follow Obsidian's own attachment setting).

A few things done deliberately right:

- **One timestamp = one post.** Several posts on the same day are inserted into the same file in ascending `HH:MM` order, instead of each getting its own file.
- Segmentation **only looks at timestamps, never at fixed headings**: a `### HH:MM` heading or a `- HH:MM` list item starts a post, and it runs until the next timestamp. Headings like `## Memos` / `## Journal` are just ordinary headings — name them whatever you like, or leave them out entirely.
- It **follows the format your file already has**: a `### HH:MM` file gets a heading, a `- HH:MM` list file gets a list item; mixing the two in the same file still parses in file order.
- **No timestamps at all works too**: when the body contains no `HH:MM` whatsoever, **the whole note counts as one record** (a file-level fallback), so a note with media is never skipped just because it lacks timestamps. Ideal for "one note a day, a few photos each" — those photos become **one card with a carousel**.
- **Both the date and the time fall back gracefully**, so no particular writing style is required: the date comes from `date` → date components in the path → file mtime; the time comes from `date` → `HH-MM` in the filename. When neither yields one, only the date is shown — **no time is invented**.
- Windows-illegal characters in filenames are sanitised (colons are especially dangerous — NTFS treats them as ADS and silently truncates the file to 0 bytes), duplicates get a `-1` suffix, and line breaks are preserved as-is.
- Videos use `<video controls preload="metadata" playsinline>` and **never autoplay**; tapping the video itself will not accidentally trigger the lightbox.
- After publishing, only **the one file just written** is re-indexed, never the whole vault.

#### Filtering

The bottom-left filter button: by **source** + **year** + **date range**. The source list is not hard-coded — it is **generated dynamically from the sources actually present in the index**, labelled with the **display name** you set in settings (`全部` is always first); when there is only one source the whole row hides itself, since "all / the only source" means nothing. The panel is collapsed by default and closes when you click outside or press `Esc`; a small dot appears on the button whenever a filter is active. The bottom row of the panel shows the current counts plus a **⚙ Settings** button that jumps straight to the plugin's settings page.

---

### Installation

#### Manual

1. Download `main.js`, `manifest.json` and `styles.css` from the latest [Releases](https://github.com/noctisvexx/obsidian-visual-feed/releases)
2. Put them in `<your vault>/.obsidian/plugins/visual-feed/`
3. In Obsidian: Settings → Community plugins → turn off "Restricted mode" → enable "Visual Feed"

#### With BRAT

If you have [BRAT](https://github.com/TfTHacker/obsidian42-brat) installed, simply add this repository's URL.

---

### Quick start

1. **Settings → Visual Feed → Source folders**
2. Add a source:
   - **Path** — the folder to scan (chosen with the folder picker; subfolders are included recursively)
   - **Display name** — read-only, always the last segment of the path (whatever folder you pick is what shows up; nothing to type)
   - **Description** — optional, shown next to the source
3. Run the "Rebuild Visual Feed index" command once
4. Click the image icon in the left ribbon (or run the "Open Visual Feed" command)

After that, **creating / modifying / deleting / renaming** files inside Obsidian updates the index incrementally — no manual rebuild needed.

---

### Settings

| Setting | Description |
| --- | --- |
| **Source folders** | The list of scanned folders; addable, editable, removable. Changing a path or the enabled state rebuilds the index; changing only the description patches it in place |
| **Grouping** | One post per record (a new post at every `- HH:MM` or `### HH:MM` timestamp) / one post per file |
| **Default layout** | Single-column feed / masonry grid. The home-view button flips it live; this is what it opens with |
| **Grid tile size** | Small / medium / large (narrow screens step down one size so several columns still fit) |
| **Grid unit** | One tile per photo (records spread out, more like a photo wall) / one tile per record (swipe between images inside the tile; no count badge in grid) |
| **Posts per batch** | How many posts each scroll batch appends (5–40); smaller uses less memory |
| **Max media height** | Upper bound on the photo area's share of the screen (40–90vh) |
| **Frame aspect ratio** | Clamp range / fixed ratio / original — see above |
| **Show note text** | Whether to show the note body under the photo (up to 10 lines) |
| **Caption character limit** | Truncate the body at index time |
| **Show source** | Whether to show the source name (and its description) in the feed and in the lightbox |
| **Card style** | Turn it off for a borderless, flush, rounded look — more like a photo album |
| **Publish folder** | Default target folder for the publish flow |
| **Attachment folder** | Empty = follow Obsidian's attachment setting; `./` = next to the note; `/` = vault root |
| **Auto-add publish folder as a source** | Otherwise photos you just published will not show up in the feed |
| **Open feed on startup** | Automatically open Visual Feed when Obsidian starts |

---

### How it works

- **Index**: scans the Markdown inside the source folders, parses every media reference (`![[...]]`, `![](...)`, HTML tags), and groups them into posts by `record` or `file`. The index is persisted in the plugin's `data.json`.
- **Segmentation (two independent layers)**: the **media reference** decides *which media exists*; the **timestamp** decides *which post a media item belongs to*; fixed heading names take no part in the core parsing. Only a valid 24-hour `- HH:MM` / `### HH:MM` timestamp counts (`25:80` does not), and a stray "12:56" mentioned mid-sentence does not either — it has to be a timestamp structure at the start of a line. The whole file is cut into blocks in order of appearance, so list items and headings mixed together are handled in file order; a file with no timestamp at all becomes a single file-level post (so a file that is only Frontmatter, with no fixed headings, is never dropped).
- **Incremental**: on startup each file's `mtime` + `size` is compared and only changed files are re-parsed; when nothing changed, zero files are read. Index schema changes are handled with optional fields plus fallbacks, so **upgrading the plugin never requires a full rebuild**.
- **Never touches your notes**: apart from the explicit "publish" action writing the target file you chose, everything is read-only. Media is not copied, thumbnails are not generated, files are not moved.
- **Media references**: uses Obsidian's native `app://local/` resource URLs to reference vault files directly; remote images (`https://`) work too.
- **Theming**: every colour goes through Obsidian theme variables and adapts to dark / light automatically; on mobile the layout avoids the native bottom navbar and keyboard toolbar, and it respects `prefers-reduced-motion`.

---

### Development

```bash
npm install
npm run dev     # watch mode (with sourcemaps)
npm run build   # production build → main.js
npm run check   # tsc --noEmit
npm test        # bundle the tests + run the end-to-end suite
```

#### Tests

Two suites, **364** assertions in total:

- **`test/run-test.ts`** — real-vault end to end. Runs a full index pass against a real Obsidian vault and asserts post/media counts, date validity, **incremental read counts** (0 file reads when nothing changed), correctness after create/modify/delete, the publish write path end to end, plus a set of pure CSS regression assertions (jsdom cannot measure layout, so `styles.css` is asserted as source text).
- **`test/run-dom-test.ts`** — jsdom UI smoke tests. Carousel, lazy loading, batched rendering, lightbox, filter panel, publish modal, layout switching, settings-page re-rendering.

Every **write in both suites goes through an in-memory overlay** — your real notes on disk are never touched.

> The end-to-end suite needs a real Obsidian vault, and the path is **never hard-coded**:
>
> ```bash
> # option 1: environment variable
> VISUAL_FEED_VAULT="/path/to/your/vault" npm test
>
> # option 2: put the vault path in test/vault.local (gitignored)
> ```
>
> **No source folders to configure either**: the suite picks a few of the vault's
> markdown-heaviest directories at runtime (detecting their record style on the way),
> so the repository contains no real folder names.

---

### Known limitations

- Only media **referenced** from Markdown is indexed. Orphan images that never appear in a note are not included.
- Remote images (`https://`) need a network connection and will not render offline.
- Videos are limited to formats Obsidian can play natively (mp4 / webm / mov / m4v / mkv / ogv / avi / 3gp).
- The index is built on demand, so the first open on a large vault is a little slow (instant after that).

## License

[MIT](LICENSE) © 2026 noctis
