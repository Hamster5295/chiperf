/**
 * 图表工具集 —— 所有视图共用（纯 SVG，无第三方依赖）
 *
 * 设计约定：
 *  - `svgEl` / `el` 生成节点，属性用对象给出，`text` 用 textContent（不用 innerHTML，避免转义问题）
 *  - `tooltip()` 是全局单例；`hoverTarget` 绑定鼠标事件
 *  - `linearScale` 同时给出正向映射与 `invert`
 */
import { fmtCompact, fmtInt } from './view.ts';

export const SVG_NS = 'http://www.w3.org/2000/svg';

type Attrs = Record<string, string | number | undefined>;
type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  applyAttrs(node, attrs);
  append(node, children);
  return node;
}

export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: Child[] = [],
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    if (key === 'text') node.textContent = String(value);
    else node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}

function applyAttrs(node: HTMLElement, attrs: Attrs): void {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    if (key === 'text') node.textContent = String(value);
    else if (key === 'class') node.className = String(value);
    else if (key === 'style') node.setAttribute('style', String(value));
    else if (key === 'html') node.innerHTML = String(value);
    else node.setAttribute(key, String(value));
  }
}

function append(node: Element, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function svgRoot(width: number, height: number, extra: Attrs = {}): SVGSVGElement {
  return svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, ...extra });
}

// ------------------------------------------------------------------ 比例尺

export interface Scale {
  (value: number): number;
  domain: [number, number];
  range: [number, number];
  invert(px: number): number;
}

export function linearScale(d0: number, d1: number, r0: number, r1: number): Scale {
  const span = d1 - d0 || 1;
  const fn = ((value: number) => r0 + ((value - d0) / span) * (r1 - r0)) as Scale;
  fn.domain = [d0, d1];
  fn.range = [r0, r1];
  fn.invert = (px: number) => d0 + ((px - r0) / (r1 - r0 || 1)) * span;
  return fn;
}

/** 生成"好看"的刻度值 */
export function axisTicks(from: number, to: number, target = 8): number[] {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [from];
  const raw = (to - from) / Math.max(1, target);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const candidates = [1, 2, 2.5, 5, 10].map((m) => m * magnitude);
  const step = candidates.find((c) => c >= raw) ?? 10 * magnitude;
  const ticks: number[] = [];
  for (let v = Math.ceil(from / step) * step; v <= to + step * 1e-9; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

// ------------------------------------------------------------------ 路径

const point = (p: [number, number]) => `${round(p[0])},${round(p[1])}`;
const round = (n: number) => Math.round(n * 100) / 100;

export function linePath(points: [number, number][]): string {
  if (points.length === 0) return '';
  return `M${points.map(point).join('L')}`;
}

/** 阶梯路径（保持型信号的显示方式：采样后保持到下一点） */
export function stepPath(points: [number, number][]): string {
  if (points.length === 0) return '';
  let d = `M${point(points[0]!)}`;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!;
    const cur = points[i]!;
    d += `L${round(cur[0])},${round(prev[1])}L${point(cur)}`;
  }
  return d;
}

export function areaPath(points: [number, number][], baseline: number): string {
  if (points.length === 0) return '';
  return `${linePath(points)}L${round(points[points.length - 1]![0])},${round(baseline)}L${round(points[0]![0])},${round(baseline)}Z`;
}

export function barRect(x: number, y: number, width: number, height: number): { x: number; y: number; width: number; height: number } {
  return { x, y, width: Math.max(0, width), height: Math.max(0, height) };
}

// ------------------------------------------------------------------ 配色

export const PALETTE = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4',
  '#ec4899', '#84cc16', '#f97316', '#14b8a6', '#6366f1', '#a855f7',
  '#0ea5e9', '#22c55e', '#eab308', '#f43f5e', '#64748b', '#0891b2',
];

const colorCache = new Map<string, string>();

/** 同一个 key 永远得到同一种颜色 */
export function colorFor(key: string): string {
  const cached = colorCache.get(key);
  if (cached) return cached;
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  const color = PALETTE[hash % PALETTE.length]!;
  colorCache.set(key, color);
  return color;
}

/** 顺序色阶（0..1 → 冷 → 热），用于热力图 */
export function heatColor(t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  const stops: [number, [number, number, number]][] = [
    [0, [239, 246, 255]],
    [0.25, [191, 219, 254]],
    [0.5, [96, 165, 250]],
    [0.75, [37, 99, 235]],
    [1, [30, 58, 138]],
  ];
  for (let i = 1; i < stops.length; i++) {
    const [t1, c1] = stops[i]!;
    const [t0, c0] = stops[i - 1]!;
    if (clamped <= t1) {
      const k = (clamped - t0) / (t1 - t0 || 1);
      const mix = c0.map((c, idx) => Math.round(c + (c1[idx]! - c) * k));
      return `rgb(${mix[0]} ${mix[1]} ${mix[2]})`;
    }
  }
  return 'rgb(30 58 138)';
}

export function textColorOn(background: string): string {
  const match = /rgb\((\d+) (\d+) (\d+)\)/.exec(background);
  if (!match) return '#0f172a';
  const [r, g, b] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#0f172a' : '#f8fafc';
}

// ------------------------------------------------------------------ 交互

let tooltipNode: HTMLElement | null = null;

export function tooltip(): {
  show(html: string, x: number, y: number): void;
  hide(): void;
} {
  if (tooltipNode === null) {
    tooltipNode = el('div', { class: 'tooltip', role: 'tooltip' });
    document.body.append(tooltipNode);
  }
  const node = tooltipNode;
  return {
    show(html, x, y) {
      node.innerHTML = html;
      node.classList.add('is-visible');
      const rect = node.getBoundingClientRect();
      const left = Math.min(window.innerWidth - rect.width - 8, Math.max(8, x + 12));
      const top = Math.max(8, y - rect.height - 12);
      node.style.transform = `translate(${left}px, ${top}px)`;
    },
    hide() {
      node.classList.remove('is-visible');
    },
  };
}

/** 把 hover 提示绑定到任意元素上 */
export function hoverTarget<T extends Element>(
  node: T,
  render: () => string,
  onClick?: (event: MouseEvent) => void,
): T {
  const tip = tooltip();
  node.addEventListener('mousemove', (event) => {
    const me = event as MouseEvent;
    tip.show(render(), me.clientX, me.clientY);
  });
  node.addEventListener('mouseleave', () => tip.hide());
  if (onClick) node.addEventListener('click', onClick as EventListener);
  return node;
}

// ------------------------------------------------------------------ 版式组件

/** 卡片：返回 body 容器 */
export function card(title: string, subtitle?: string, actions?: Node[]): { root: HTMLElement; body: HTMLElement } {
  const body = el('div', { class: 'card-body' });
  const head = el('div', { class: 'card-head' }, [
    el('div', {}, [
      el('h3', { class: 'card-title', text: title }),
      subtitle ? el('p', { class: 'card-sub', text: subtitle }) : null,
    ]),
    actions ? el('div', { class: 'card-actions' }, actions) : null,
  ]);
  const root = el('section', { class: 'card' }, [head, body]);
  return { root, body };
}

export function statTile(label: string, value: string, hint?: string): HTMLElement {
  return el('div', { class: 'stat' }, [
    el('span', { class: 'stat-label', text: label }),
    el('span', { class: 'stat-value', text: value }),
    hint ? el('span', { class: 'stat-hint', text: hint }) : null,
  ]);
}

export function legend(items: { label: string; color: string; value?: string }[]): HTMLElement {
  return el(
    'div',
    { class: 'legend' },
    items.map((item) =>
      el('span', { class: 'legend-item' }, [
        el('i', { class: 'swatch', style: `background:${item.color}` }),
        el('span', { text: item.label }),
        item.value ? el('b', { text: item.value }) : null,
      ]),
    ),
  );
}

export function emptyState(message: string): HTMLElement {
  return el('div', { class: 'empty', text: message });
}

/** 迷你表格（视图内部用；大数据量用 views/table.ts 的智能表格） */
export function dataTable(headers: string[], rows: (Node | string)[][]): HTMLElement {
  return el('div', { class: 'table-wrap' }, [
    el('table', { class: 'table' }, [
      el('thead', {}, [el('tr', {}, headers.map((h) => el('th', { text: h })))]),
      el('tbody', {}, rows.map((cells) => el('tr', {}, cells.map((c) => (typeof c === 'string' ? el('td', { text: c }) : el('td', {}, [c])))))),
    ]),
  ]);
}

/** 数值轴：左侧刻度 + 网格线（返回绘图区几何） */
export function numericAxis(
  svg: SVGSVGElement,
  opts: { x: number; y: number; width: number; height: number; min: number; max: number; label?: string; ticks?: number[] },
): { scale: Scale; ticks: { value: number; y: number }[] } {
  const ticks = opts.ticks ?? axisTicks(opts.min, opts.max, 5);
  const scale = linearScale(opts.min, opts.max, opts.y + opts.height, opts.y);
  const out: { value: number; y: number }[] = [];
  for (const value of ticks) {
    const y = scale(value);
    out.push({ value, y });
    svg.append(
      svgEl('line', { x1: opts.x, x2: opts.x + opts.width, y1: y, y2: y, class: 'grid-line' }),
      svgEl('text', { x: opts.x - 6, y: y + 3.5, class: 'axis-label', 'text-anchor': 'end', text: fmtCompact(value) }),
    );
  }
  if (opts.label) {
    svg.append(svgEl('text', { x: opts.x - 6, y: opts.y - 6, class: 'axis-label axis-title', 'text-anchor': 'end', text: opts.label }));
  }
  return { scale, ticks: out };
}

/** 周期轴（底部刻度 + 网格）：返回周期 → x 的映射 */
export function cycleAxis(
  svg: SVGSVGElement,
  opts: { x: number; y: number; width: number; height: number; from: number; to: number; labelEvery?: number },
): Scale {
  const scale = linearScale(opts.from, opts.to + 1, opts.x, opts.x + opts.width);
  const span = opts.to - opts.from + 1;
  const every = opts.labelEvery ?? Math.max(1, Math.ceil(span / Math.max(2, Math.floor(opts.width / 70))));
  for (const value of axisTicks(opts.from, opts.to, Math.max(2, Math.floor(opts.width / 70)))) {
    const x = scale(value);
    svg.append(
      svgEl('line', { x1: x, x2: x, y1: opts.y, y2: opts.y + opts.height, class: 'grid-line' }),
      svgEl('text', { x, y: opts.y + opts.height + 14, class: 'axis-label', 'text-anchor': 'middle', text: String(value) }),
    );
  }
  void every;
  return scale;
}

export function countLabel(n: number): string {
  return n >= 10000 ? fmtCompact(n) : fmtInt(n);
}
