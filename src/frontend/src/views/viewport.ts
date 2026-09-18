/**
 * 小图表的可见窗口（窗口式缩放/平移）—— 计数器 / 数值视图共用。
 *
 * 画布宽度固定为卡片列宽，缩放改变的是"窗口覆盖多少周期"：最小 = 整条铺满，
 * 最大不设限（可以一直放大到看清单个周期）；平移用横向滚轮 / Shift+滚轮，
 * 缩放用 Ctrl/⌘ + 滚轮（以指针处为锚点）。和时间轴同一套手势。
 */

export interface CycleWindow {
  /** 起始周期（含） */
  from: number;
  /** 结束周期（不含） */
  to: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 把窗口夹进完整范围：跨度不超过整条，两端不越界 */
export function clampWindow(w: CycleWindow, full: CycleWindow): CycleWindow {
  const fullSpan = Math.max(1e-9, full.to - full.from);
  let span = w.to - w.from;
  if (!(span > 0)) span = fullSpan;
  if (span > fullSpan) span = fullSpan;
  span = Math.max(span, 1e-12);
  let from = w.from;
  if (from < full.from) from = full.from;
  if (from + span > full.to) from = full.to - span;
  if (from < full.from) from = full.from;
  return { from, to: from + span };
}

/** 以内容比例 `anchorFrac`（0~1）为锚点缩放（factor > 1 放大） */
export function zoomWindow(view: CycleWindow, full: CycleWindow, anchorFrac: number, factor: number): CycleWindow {
  const frac = clamp01(anchorFrac);
  const span = Math.max(1e-9, view.to - view.from);
  const fullSpan = Math.max(1e-9, full.to - full.from);
  const anchor = view.from + frac * span;
  const newSpan = Math.min(span / factor, fullSpan);
  const from = anchor - frac * newSpan;
  return clampWindow({ from, to: from + newSpan }, full);
}

/** 平移 `dCycles` 个周期（正数向右） */
export function panWindow(view: CycleWindow, full: CycleWindow, dCycles: number): CycleWindow {
  return clampWindow({ from: view.from + dCycles, to: view.to + dCycles }, full);
}

/**
 * 给一张图绑定滚轮：Ctrl/⌘ 缩放（指针锚点）、横向滚轮或 Shift+滚轮平移。
 * 一帧最多重画一次；普通竖向滚轮留给页面滚动。
 */
export function installChartViewport(
  surface: HTMLElement,
  opts: {
    full: () => CycleWindow;
    get: () => CycleWindow;
    set: (w: CycleWindow) => void;
    redraw: () => void;
  },
): void {
  let scheduled = false;
  const flush = (): void => {
    scheduled = false;
    opts.redraw();
  };
  surface.addEventListener(
    'wheel',
    (event) => {
      const wt = event as WheelEvent;
      const full = opts.full();
      const view = opts.get();
      if (wt.ctrlKey || wt.metaKey) {
        const box = surface.getBoundingClientRect();
        const frac = box.width > 0 ? (wt.clientX - box.left) / box.width : 0.5;
        opts.set(zoomWindow(view, full, frac, wt.deltaY < 0 ? 1.2 : 1 / 1.2));
      } else {
        const dx = wt.deltaX !== 0 ? wt.deltaX : wt.shiftKey ? wt.deltaY : 0;
        if (dx === 0) return;
        const box = surface.getBoundingClientRect();
        const perPx = (view.to - view.from) / Math.max(1, box.width);
        opts.set(panWindow(view, full, dx * perPx));
      }
      wt.preventDefault();
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(flush);
      }
    },
    { passive: false },
  );
}
