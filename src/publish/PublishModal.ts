import { App, Modal, Notice, setIcon } from "obsidian";
import type PhotoFeedPlugin from "../main";
import { FolderPickerModal } from "../settings";
import { kindOfExt, type MediaKind } from "../types";
import { videoThumbSrc } from "../utils/video";
import {
  ensureSourceFor,
  nowDate,
  nowTime,
  publishMedia,
  type PublishFileLike,
} from "./publisher";

interface PickedFile {
  file: PublishFileLike;
  kind: MediaKind;
  /** 本地预览地址（jsdom / 老内核没有 createObjectURL 时为空） */
  url: string;
}

const objectUrl = (file: PublishFileLike): string => {
  try {
    const u = (URL as unknown as { createObjectURL?: (b: unknown) => string })
      .createObjectURL;
    return u ? u(file) : "";
  } catch {
    return "";
  }
};

const revokeUrl = (url: string): void => {
  if (!url) return;
  try {
    (URL as unknown as { revokeObjectURL?: (u: string) => void }).revokeObjectURL?.(url);
  } catch {
    /* 忽略 */
  }
};

/**
 * 发布弹窗：多选照片 / 视频 → 写一段说明 → 选时间 → 发布。
 * 一个时间戳 = 一条记录；同一天再发会自动追加进同一个 md。
 */
export class PublishModal extends Modal {
  private plugin: PhotoFeedPlugin;
  private onDone: () => void;

  private picked: PickedFile[] = [];
  private caption = "";
  private date: string;
  private time: string;
  private folder: string;

  private gridEl!: HTMLElement;
  private inputEl!: HTMLInputElement;
  private publishBtn!: HTMLButtonElement;

  constructor(app: App, plugin: PhotoFeedPlugin, onDone: () => void) {
    super(app);
    this.plugin = plugin;
    this.onDone = onDone;
    this.date = nowDate();
    this.time = nowTime();
    this.folder = plugin.settings.publishFolder || "";
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    contentEl.empty();
    contentEl.addClass("pf-publish-modal");
    titleEl.setText("发布到视界");

    const body = contentEl.createDiv({ cls: "pf-pub-body" });

    // 隐藏的文件选择器（多选图片 + 视频）
    this.inputEl = body.createEl("input", {
      cls: "pf-pub-input",
      attr: {
        type: "file",
        multiple: "true",
        accept: "image/*,video/*",
        style: "display:none",
      },
    });
    this.inputEl.addEventListener("change", () => this.takeFiles());

    this.gridEl = body.createDiv({ cls: "pf-pub-files" });

    const picker = body.createEl("button", {
      cls: "pf-pub-picker",
      attr: { type: "button" },
    });
    setIcon(picker, "image-plus");
    picker.createSpan({ text: "选择照片或视频（可多选）" });
    picker.addEventListener("click", () => this.inputEl.click());

    // 说明
    const capWrap = body.createDiv({ cls: "pf-pub-line" });
    const ta = capWrap.createEl("textarea", {
      cls: "pf-pub-caption",
      attr: { placeholder: "写点什么…（可留空）", rows: "3" },
    });
    ta.addEventListener("input", () => {
      this.caption = ta.value;
    });

    // 时间
    const timeLine = body.createDiv({ cls: "pf-pub-line" });
    timeLine.createSpan({ cls: "pf-pub-label", text: "记录时间" });
    const dateInput = timeLine.createEl("input", {
      cls: "pf-pub-date",
      attr: { type: "date" },
    });
    dateInput.value = this.date;
    dateInput.addEventListener("change", () => {
      if (dateInput.value) this.date = dateInput.value;
    });
    const timeInput = timeLine.createEl("input", {
      cls: "pf-pub-time",
      attr: { type: "time" },
    });
    timeInput.value = this.time;
    timeInput.addEventListener("change", () => {
      if (timeInput.value) this.time = timeInput.value;
    });

    // 目标文件夹
    const target = body.createDiv({ cls: "pf-pub-target" });
    setIcon(target.createSpan({ cls: "pf-pub-target-icon" }), "folder");
    const folderText = target.createSpan({ text: "" });
    const changeBtn = target.createEl("button", { text: "更改" });
    const syncTarget = (): void => {
      folderText.setText(this.folder || "（Vault 根目录）");
    };
    syncTarget();
    changeBtn.addEventListener("click", () => {
      new FolderPickerModal(this.app, (p) => {
        this.folder = p;
        syncTarget();
      }).open();
    });

    // 操作
    const actions = body.createDiv({ cls: "pf-pub-actions" });
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());

    this.publishBtn = actions.createEl("button", { cls: "mod-cta", text: "发布" });
    this.publishBtn.addEventListener("click", () => void this.publish());

    this.renderGrid();
  }

  onClose(): void {
    for (const p of this.picked) revokeUrl(p.url);
    this.picked = [];
    this.contentEl.empty();
  }

  private takeFiles(): void {
    const list = Array.from(this.inputEl.files ?? []);
    let rejected = 0;
    for (const f of list) {
      const kind = kindOfExt(f.name.split(".").pop() ?? "");
      if (!kind) {
        rejected++;
        continue;
      }
      if (this.picked.some((p) => p.file.name === f.name && p.kind === kind)) continue;
      this.picked.push({ file: f, kind, url: objectUrl(f) });
    }
    if (rejected) new Notice(`视界：已忽略 ${rejected} 个不支持的文件类型`);
    this.inputEl.value = "";
    this.renderGrid();
  }

  private renderGrid(): void {
    this.gridEl.empty();
    this.gridEl.toggleClass("pf-pub-files-empty", this.picked.length === 0);
    if (!this.picked.length) {
      this.gridEl.createDiv({
        cls: "pf-pub-empty",
        text: "还没有选择文件。支持 jpg / png / webp / gif / heic 等图片与 mp4 / mov / webm 等视频。",
      });
      return;
    }
    this.picked.forEach((p, i) => {
      const cell = this.gridEl.createDiv({ cls: "pf-pub-file" });
      if (p.kind === "video") {
        if (p.url) {
          // #t=0.1 见 utils/video：移动端不给 <video> 画首帧，预览会是一片黑
          cell.createEl("video", {
            attr: { src: videoThumbSrc(p.url), muted: "true", preload: "metadata" },
          });
        } else {
          const icon = cell.createDiv({ cls: "pf-pub-file-icon" });
          setIcon(icon, "film");
        }
      } else if (p.url) {
        cell.createEl("img", { attr: { src: p.url, alt: p.file.name } });
      } else {
        const icon = cell.createDiv({ cls: "pf-pub-file-icon" });
        setIcon(icon, "image");
      }
      cell.setAttribute("title", p.file.name);

      const del = cell.createEl("button", {
        cls: "pf-pub-file-del",
        attr: { type: "button", "aria-label": `移除 ${p.file.name}` },
      });
      setIcon(del, "x");
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        revokeUrl(p.url);
        this.picked.splice(i, 1);
        this.renderGrid();
      });
    });
  }

  private async publish(): Promise<void> {
    if (!this.picked.length) {
      new Notice("视界：先选择要发布的照片或视频");
      return;
    }
    if (this.plugin.settings.autoAddSource && this.folder) {
      const added = ensureSourceFor(this.plugin.settings, this.folder);
      if (added) await this.plugin.saveSettings();
    }
    this.publishBtn.disabled = true;
    this.publishBtn.setText("发布中…");
    try {
      const res = await publishMedia(this.app, this.plugin.settings, {
        files: this.picked.map((p) => p.file),
        caption: this.caption,
        date: this.date,
        time: this.time,
        folder: this.folder,
      });
      // 只重解析刚写的那篇，不动其它上千条
      await this.plugin.indexer.reindexFile(res.notePath);
      const name = res.notePath.split("/").pop();
      new Notice(
        res.noteCreated
          ? `✅ 视界：已发布到新文件 ${name}`
          : `✅ 视界：已追加到 ${name}（${this.time}）`
      );
      this.close();
      this.onDone();
    } catch (e) {
      console.error("视界：发布失败", e);
      const msg = e instanceof Error ? e.message : String(e);
      new Notice(`❌ 视界：发布失败 —— ${msg}`);
      this.publishBtn.disabled = false;
      this.publishBtn.setText("发布");
    }
  }
}
