/**
 * jsdom 测试环境：把 Obsidian 提供的 DOM 便利方法（createEl / addClass / setText …）
 * 以及 IntersectionObserver、元素 scrollTo 补上，让插件 UI 代码能在 Node 里真跑一遍。
 * 仅供测试。
 */
import { JSDOM } from "jsdom";

type AnyEl = HTMLElement & {
  createEl: (tag: string, o?: DomInfo | string) => AnyEl;
  createDiv: (o?: DomInfo | string) => AnyEl;
  createSpan: (o?: DomInfo | string) => AnyEl;
  empty: () => void;
  setText: (t: string) => void;
  addClass: (...c: string[]) => void;
  removeClass: (...c: string[]) => void;
  toggleClass: (c: string, on?: boolean) => void;
  hasClass: (c: string) => boolean;
  hide: () => void;
  show: () => void;
};

interface DomInfo {
  cls?: string;
  text?: string;
  attr?: Record<string, string>;
  title?: string;
  type?: string;
  value?: string;
  placeholder?: string;
}

function applyInfo(el: AnyEl, o?: DomInfo | string): void {
  if (!o) return;
  if (typeof o === "string") {
    el.className = o;
    return;
  }
  if (o.cls) el.className = o.cls;
  if (o.text !== undefined) el.textContent = o.text;
  if (o.title) el.setAttribute("title", o.title);
  if (o.type) el.setAttribute("type", o.type);
  if (o.placeholder) el.setAttribute("placeholder", o.placeholder);
  if (o.attr) {
    for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, String(v));
  }
  if (o.value !== undefined) (el as unknown as HTMLInputElement).value = o.value;
}

function makeEl(doc: Document, tag: string, o?: DomInfo | string): AnyEl {
  const el = doc.createElement(tag) as AnyEl;
  applyInfo(el, o);
  return el;
}

export interface DomEnv {
  window: Window & typeof globalThis;
  document: Document;
  /** 触发一次 IntersectionObserver 回调（模拟元素进入视口） */
  flushIntersections: () => number;
}

export function setupDom(): DomEnv {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
  });
  const win = dom.window as unknown as Window & typeof globalThis;
  const doc = win.document;
  const proto = win.HTMLElement.prototype as unknown as Record<string, unknown>;

  proto.createEl = function (this: AnyEl, tag: string, o?: DomInfo | string) {
    const el = makeEl(doc, tag, o);
    this.appendChild(el);
    return el;
  };
  proto.createDiv = function (this: AnyEl, o?: DomInfo | string) {
    return (this as unknown as AnyEl).createEl("div", o);
  };
  proto.createSpan = function (this: AnyEl, o?: DomInfo | string) {
    return (this as unknown as AnyEl).createEl("span", o);
  };
  proto.empty = function (this: AnyEl) {
    while (this.firstChild) this.removeChild(this.firstChild);
  };
  proto.setText = function (this: AnyEl, t: string) {
    this.textContent = t;
  };
  proto.addClass = function (this: AnyEl, ...c: string[]) {
    this.classList.add(...c);
  };
  proto.removeClass = function (this: AnyEl, ...c: string[]) {
    this.classList.remove(...c);
  };
  proto.toggleClass = function (this: AnyEl, c: string, on?: boolean) {
    if (on === undefined) this.classList.toggle(c);
    else this.classList.toggle(c, on);
  };
  proto.hasClass = function (this: AnyEl, c: string) {
    return this.classList.contains(c);
  };
  proto.hide = function (this: AnyEl) {
    this.style.display = "none";
  };
  proto.show = function (this: AnyEl) {
    this.style.display = "";
  };
  // jsdom 没有元素 scrollTo：补成「设置 scrollLeft + 派发 scroll 事件」
  proto.scrollTo = function (this: AnyEl, arg: number | { left?: number }) {
    const left = typeof arg === "number" ? arg : (arg?.left ?? 0);
    this.scrollLeft = left;
    this.dispatchEvent(new win.Event("scroll"));
  };

  const g = globalThis as unknown as Record<string, unknown>;
  g.window = win;
  g.document = doc;
  g.HTMLElement = win.HTMLElement;
  g.Node = win.Node;
  g.Event = win.Event;
  g.MouseEvent = win.MouseEvent;
  g.KeyboardEvent = win.KeyboardEvent;
  // 原生插件里可以直接 `new Option(text, value)` 造 <option>，jsdom 有实现但不会
  // 自动挂到 Node 的 globalThis 上，不补会在渲染下拉框时直接 ReferenceError。
  g.Option = win.Option;
  g.HTMLSelectElement = win.HTMLSelectElement;
  g.HTMLOptionElement = win.HTMLOptionElement;
  g.createEl = (tag: string, o?: DomInfo | string): AnyEl => makeEl(doc, tag, o);
  g.createDiv = (o?: DomInfo | string): AnyEl => makeEl(doc, "div", o);
  g.createSpan = (o?: DomInfo | string): AnyEl => makeEl(doc, "span", o);
  g.Notice = class {
    constructor(_msg?: string) {
      /* 测试环境静默 */
    }
  };

  // IntersectionObserver 桩：手动 flush 才触发
  const instances: FakeIO[] = [];
  class FakeIO {
    cb: IntersectionObserverCallback;
    targets = new Set<Element>();
    constructor(cb: IntersectionObserverCallback) {
      this.cb = cb;
      instances.push(this);
    }
    observe(el: Element): void {
      this.targets.add(el);
    }
    unobserve(el: Element): void {
      this.targets.delete(el);
    }
    disconnect(): void {
      this.targets.clear();
    }
  }
  g.IntersectionObserver = FakeIO as unknown as typeof IntersectionObserver;
  // 生产代码用 `window.IntersectionObserver` 判断能力，jsdom 的 window 是独立对象，
  // 必须一起挂上，否则会误判为「不支持 IO」而走一次性加载兜底。
  (win as unknown as Record<string, unknown>).IntersectionObserver =
    FakeIO as unknown as typeof IntersectionObserver;

  const flushIntersections = (): number => {
    let fired = 0;
    for (const io of instances) {
      for (const el of [...io.targets]) {
        io.targets.delete(el);
        io.cb(
          [{ isIntersecting: true, target: el } as unknown as IntersectionObserverEntry],
          io as unknown as IntersectionObserver
        );
        fired++;
      }
    }
    return fired;
  };

  return { window: win, document: doc, flushIntersections };
}

/** 让异步事件队列跑完 */
export const tick = (ms = 30): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));
