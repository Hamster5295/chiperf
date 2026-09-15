/**
 * 时间轴视图 —— 时钟 · 状态机 · 流水线 · 占用度 · 计数器 · 事件 · 异步事件的**共用横轴**
 *
 * 设计要点：
 *  - 横轴是周期：周期 c 占据 `[scale(c), scale(c+1))`；`useTimeAxis` 且域声明了 period 时，
 *    刻度改标时间（ns），换算用「主域」（优先 `default`）的 period。
 *  - 所有泳道共用同一个周期映射；宽 SVG 由 `.chart-scroll` 横向滚动，左侧标签列用 `position:sticky`
 *    钉在滚动窗口左边，横滚时轨道名不会跑掉。
 *  - `async=1` 的记录（`record.async`，spec §6.7）不吸附到时钟沿：一律画在**周期区间中点**
 *    （两个时钟沿之间），空心标记 + 虚线连回所在区间；另有一条「异步事件」泳道汇总。
 *  - 半开区间：流水线条目、占用度、状态带都按 `[enter, close)` 画；
 *    未闭合条目（`closed === null`）只画到 `track.lastCycle`，**不伪造**退出周期。
 *  - 大文件：`records` 只扫一遍聚合成每域的沿集合；每个泳道最多画 MAX_ITEMS 个条目，
 *    文字标签有全局预算，占用度在低缩放下退化成阶梯折线。
 */
import type {
  CounterTrack,
  DomainInfo,
  EventRecord,
  FsmTrack,
  Phase,
  PipelineItem,
  Position,
  ScalarValue,
  TrackInfo,
  Trace,
} from '../../../parser/src/index.ts';
import {
  counterDeltaBetween,
  counterTotalAt,
  formatPosition,
  stateSegments,
  timeNs,
} from '../../../parser/src/index.ts';
import {
  axisTicks,
  card,
  clear,
  colorFor,
  countLabel,
  el,
  emptyState,
  heatColor,
  hoverTarget,
  legend,
  linearScale,
  statTile,
  stepPath,
  svgEl,
  svgRoot,
  type Scale,
} from '../charts.ts';
import {
  cycleTime,
  fmtCompact,
  fmtInt,
  fmtNs,
  fmtValue,
  type Selection,
  type View,
  type ViewContext,
} from '../view.ts';

// ------------------------------------------------------------------ 常量

/** 左侧标签列宽（px） */
const GUTTER = 178;
/** 顶部周期轴高度（px） */
const AXIS_H = 30;
/** 绘图区左右内边距（px） */
const SIDE = 8;
/** 泳道高度（px） */
const H = { header: 22, clk: 26, fsm: 28, pip: 22, occ: 28, cnt: 30, evt: 22 } as const;
/** 每周期像素范围 */
const PX_MIN = 0.35;
const PX_MAX = 64;
const PX_DEFAULT = 8;
/** 单个 SVG 的最大宽度（px）：更大的轨迹自动降级缩放，避免把浏览器撑爆 */
const MAX_PLOT_WIDTH = 40000;
/** 每个泳道的条目 / 标记 / 文本上限 */
const MAX_ITEMS = 4000;
const MAX_MARKS = 2000;
const TAG_BUDGET = 1200;
/** 低于这个像素密度就不画每周期柱（改用聚合折线） */
const BAR_MIN_PX = 2;

const COLOR = {
  abort: '#dc2626',
  bubble: '#f97316',
  orphan: '#64748b',
  async: '#7c3aed',
  msg: '#0891b2',
  neutral: '#94a3b8',
} as const;

/** 记录类型 → 中文名（静态表，用于提示文本） */
const KIND_LABEL: Record<string, string> = {
  clk: '时钟沿',
  cnt: '计数器',
  val: '数值',
  pip: '流水线',
  fsm: '状态机',
  evt: '事件',
  msg: '消息',
};

// ------------------------------------------------------------------ 类型

/** 每个时钟域的沿集合（升序数组 + 集合，后者用于 O(1) 成员判断） */
interface DomainEdges {
  p: number[];
  n: number[];
  pSet: Set<number>;
  nSet: Set<number>;
  lo: number;
  hi: number;
  hasClk: boolean;
}

interface Scan {
  edges: Map<string, DomainEdges>;
  asyncRecords: EventRecord[];
  from: number;
  to: number;
}

/** 绘图区几何：`scale` 把周期映射到 x（周期 c 占 [scale(c), scale(c+1))） */
interface Plot {
  scale: Scale;
  from: number;
  to: number;
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  pxPerCycle: number;
  width: number;
  height: number;
}

interface LaneRegistration {
  key: string;
  domain: string;
  node: SVGGElement;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 绘图区 + 画布：泳道绘制与轴交互都只需要这两样 */
interface Surface {
  svg: SVGSVGElement;
  plot: Plot;
}

/** 渲染期共享的注册表：`applyState()` 用它做选中/悬停高亮，不必重建 DOM */
interface Registry extends Surface {
  lanes: LaneRegistration[];
  itemBoxes: Map<string, Box>;
  selLine: SVGLineElement;
  hoverLine: SVGLineElement;
  selBox: SVGRectElement;
  hoverBox: SVGRectElement;
  selLabel: SVGTextElement;
}

interface HeaderRow {
  kind: 'header';
  text: string;
  right: string;
  height: number;
}

interface LaneRow {
  kind: 'lane';
  /** 高亮用的泳道键：`clk:域` / `fsm:key` / `pip:轨道` / `occ:轨道` / `cnt:key` / `evt:key` … */
  key: string;
  domain: string;
  label: string;
  note: string;
  color: string;
  height: number;
  /** 标签列点击 / 悬停时广播的选中态 */
  select?: Selection;
  hover?: Selection;
  draw(g: SVGGElement, reg: Registry, y: number, h: number, stripe: boolean): void;
}

type Row = HeaderRow | LaneRow;

/** 指针探针：泳道背景用「指针位置 → 周期」而不是逐周期建节点 */
interface Probe {
  cycle: number;
  half: 0 | 1;
}

// ------------------------------------------------------------------ 模块状态

let hostEl: HTMLElement | null = null;
let scrollEl: HTMLElement | null = null;
let ctxRef: ViewContext | null = null;
let unsub: (() => void) | null = null;
let registry: Registry | null = null;
let hoverSel: Selection = null;
let lastHoverKey = '';
let tagBudget = 0;
/** 上一次量到的滚动容器宽度（px）：重建时旧容器已摘除，用它保持「适应宽度」稳定 */
let chartAvail = 0;
/** 上一次量到的视图容器宽度（px）：ResizeObserver 用它判断是否真的变宽/变窄 */
let lastHostW = 0;
/** 监听容器尺寸变化（比 window.resize 可靠：侧栏/筛选变化也会触发） */
let resizeObs: ResizeObserver | null = null;
/** 「适应宽度」模式：重画时按容器宽度重算 px/周期 */
let fitWidth = false;

// ------------------------------------------------------------------ 小工具

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

const round2 = (n: number): number => Math.round(n * 100) / 100;

const rowHeight = (row: Row): number => row.height;

/** 二分：最后一个 ≤ v 的元素（无则 null） */
function lastLE(sorted: number[], v: number): number | null {
  let lo = 0;
  let hi = sorted.length - 1;
  let found: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= v) {
      found = sorted[mid]!;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** 二分：第一个 ≥ v 的下标 */
function lowerBound(sorted: number[], v: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 记录在周期内的横向偏移：p 沿在起点、n 沿在中点；`async` 一律在区间中点（spec §6.7） */
function phaseOffset(pos: Position, async: boolean): number {
  if (async) return 0.5;
  const phase: Phase = pos.phase;
  return phase === 'n' ? 0.5 : phase === 'p' ? 0 : 0.25;
}

/** 某时刻的时钟电平（p 沿 = 周期起点，n 沿 = 周期中点） */
function levelAt(edges: DomainEdges, cycle: number, half: 0 | 1): boolean {
  const t = cycle + half * 0.5;
  const pAt = lastLE(edges.p, Math.floor(t));
  const nAt = lastLE(edges.n, Math.floor(t - 0.5));
  const pPos = pAt === null ? Number.NEGATIVE_INFINITY : pAt;
  const nPos = nAt === null ? Number.NEGATIVE_INFINITY : nAt + 0.5;
  return pPos > nPos;
}

function recordName(rec: EventRecord): string {
  switch (rec.kind) {
    case 'cnt':
    case 'val':
    case 'fsm':
    case 'evt':
      return rec.name;
    case 'pip':
      return rec.track;
    case 'msg':
      return rec.text;
    case 'clk':
      return `${rec.edge} 沿`;
  }
}

function clip(text: string, widthPx: number): string {
  const max = Math.max(1, Math.floor(widthPx / 6.2));
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

/** 单遍扫描：每域的 p/n 沿、异步记录、周期范围 */
function scanRecords(trace: Trace, visible: Set<string>): Scan {
  const edges = new Map<string, DomainEdges>();
  const asyncRecords: EventRecord[] = [];
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  const bucket = (name: string): DomainEdges => {
    let e = edges.get(name);
    if (!e) {
      e = {
        p: [],
        n: [],
        pSet: new Set(),
        nSet: new Set(),
        lo: Number.POSITIVE_INFINITY,
        hi: Number.NEGATIVE_INFINITY,
        hasClk: false,
      };
      edges.set(name, e);
    }
    return e;
  };
  for (const rec of trace.records) {
    const name = rec.pos.domain;
    if (!visible.has(name)) continue;
    const e = bucket(name);
    const c = rec.pos.cycle;
    if (c < e.lo) e.lo = c;
    if (c > e.hi) e.hi = c;
    if (c < from) from = c;
    if (c > to) to = c;
    if (rec.kind === 'clk') {
      e.hasClk = true;
      const list = rec.edge === 'p' ? e.p : e.n;
      const set = rec.edge === 'p' ? e.pSet : e.nSet;
      if (!set.has(c)) {
        set.add(c);
        list.push(c);
      }
    }
    if (rec.async) asyncRecords.push(rec);
  }
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    from = 1;
    to = 1;
  }
  for (const e of edges.values()) {
    e.p.sort((a, b) => a - b);
    e.n.sort((a, b) => a - b);
  }
  asyncRecords.sort((a, b) => a.seq - b.seq);
  return { edges, asyncRecords, from, to };
}

// ------------------------------------------------------------------ 交互基元

function broadcastHover(ctx: ViewContext, sel: Selection): void {
  const key = sel === null ? '' : JSON.stringify(sel);
  if (key === lastHoverKey) return;
  lastHoverKey = key;
  ctx.selection.hover(sel);
}

/**
 * 泳道背景的通用交互：指针位置 → 周期/半格 → 广播周期悬停 + 提示 + 点击选中周期。
 * 自己的 mousemove 必须先登记（`hoverTarget` 的监听器按注册顺序后触发）。
 */
function cycleSurface(
  node: SVGRectElement,
  surface: Surface,
  domain: string,
  ctx: ViewContext,
  render: (probe: Probe) => string,
): SVGRectElement {
  const { plot, svg } = surface;
  const probe: Probe = { cycle: plot.from, half: 0 };
  node.addEventListener('mousemove', (event) => {
    const me = event as MouseEvent;
    const box = svg.getBoundingClientRect();
    const userX = box.width > 0 ? (me.clientX - box.left) * (plot.width / box.width) : plot.x0;
    const raw = plot.scale.invert(clamp(userX, plot.x0, plot.x1));
    probe.cycle = clamp(Math.floor(raw), plot.from, plot.to);
    probe.half = raw - probe.cycle < 0.5 ? 0 : 1;
    broadcastHover(ctx, { kind: 'cycle', domain, cycle: probe.cycle });
  });
  node.addEventListener('click', () => ctx.selection.set({ kind: 'cycle', domain, cycle: probe.cycle }));
  return hoverTarget(node, () => render(probe));
}

/** 泳道底：透明命中矩形 + 底部分隔线 */
function laneCanvas(g: SVGGElement, reg: Registry, y: number, h: number, stripe: boolean): SVGRectElement {
  const plot = reg.plot;
  if (stripe) {
    g.append(svgEl('rect', { x: plot.x0, y, width: plot.x1 - plot.x0, height: h, fill: 'var(--surface-2)', 'fill-opacity': 0.5 }));
  }
  g.append(svgEl('line', { x1: plot.x0, x2: plot.x1, y1: y + h - 0.5, y2: y + h - 0.5, stroke: 'var(--border)' }));
  const hit = svgEl('rect', {
    x: plot.x0,
    y: y + 0.5,
    width: plot.x1 - plot.x0,
    height: h - 1,
    fill: 'transparent',
    style: 'cursor:crosshair;pointer-events:all',
  });
  g.append(hit);
  return hit;
}

// ------------------------------------------------------------------ 视图主体

function build(host: HTMLElement, ctx: ViewContext): void {
  const trace = ctx.trace;
  const visible = (name: string): boolean => ctx.options.domains.length === 0 || ctx.options.domains.includes(name);
  const domains = [...trace.domains.values()].filter((d) => visible(d.name));
  if (domains.length === 0) {
    host.append(emptyState('没有可显示的时钟域'));
    return;
  }
  const scan = scanRecords(trace, new Set(domains.map((d) => d.name)));

  // 时间轴换算的主域：优先 default，其次任意声明了 period 的可见域
  const timeDomain =
    domains.find((d) => d.name === 'default' && d.periodNs !== undefined) ?? domains.find((d) => d.periodNs !== undefined);
  const useTime = ctx.options.useTimeAxis && timeDomain?.periodNs !== undefined;
  const primary = timeDomain ?? domains[0]!;

  const rows = buildRows(trace, ctx, domains, scan, visible);

  const span = Math.max(1, scan.to - scan.from + 1);
  const px = pixelScale(ctx, host, span);
  const plotW = Math.max(1, span * px);
  const height = AXIS_H + rows.reduce((sum, row) => sum + rowHeight(row), 0);
  const plot: Plot = {
    scale: linearScale(scan.from, scan.to + 1, SIDE, SIDE + plotW),
    from: scan.from,
    to: scan.to,
    x0: SIDE,
    x1: SIDE + plotW,
    top: AXIS_H,
    bottom: height,
    pxPerCycle: px,
    width: plotW + SIDE * 2,
    height,
  };

  const svg = svgRoot(plot.width, plot.height, { style: 'flex:0 0 auto' });
  svg.append(buildDefs());
  axisLayer(svg, plot, primary, useTime, ctx);

  const reg: Registry = {
    svg,
    plot,
    lanes: [],
    itemBoxes: new Map(),
    selLine: svgEl('line', {}),
    hoverLine: svgEl('line', {}),
    selBox: svgEl('rect', {}),
    hoverBox: svgEl('rect', {}),
    selLabel: svgEl('text', {}),
  };

  const gutter = el('div', {
    style: `flex:0 0 ${GUTTER}px;min-width:0;overflow:hidden;position:sticky;left:0;z-index:2;background:var(--surface);border-right:1px solid var(--border)`,
  });
  gutter.append(axisGutterCell(plot, useTime ? primary : undefined));

  let y = AXIS_H;
  let stripe = false;
  for (const row of rows) {
    const h = rowHeight(row);
    if (row.kind === 'header') {
      svg.append(svgEl('rect', { x: plot.x0, y, width: plot.x1 - plot.x0, height: h, fill: 'var(--surface-2)', 'fill-opacity': 0.8 }));
      gutter.append(
        el(
          'div',
          {
            style:
              'height:' +
              h +
              'px;display:flex;align-items:center;justify-content:space-between;gap:6px;padding:0 8px;min-width:0;overflow:hidden;background:var(--surface-2);font-size:10.5px;letter-spacing:0.05em;text-transform:uppercase;color:var(--text-muted);border-bottom:1px solid var(--border)',
          },
          [el('span', { text: row.text }), el('span', { text: row.right })],
        ),
      );
      stripe = false;
      // 分节表头同样占一行高度：漏掉这一句会让右侧泳道整体上移（左侧标签列却照常堆叠）
      y += h;
      continue;
    }
    const g = svgEl('g', {});
    svg.append(g);
    row.draw(g, reg, y, h, stripe);
    reg.lanes.push({ key: row.key, domain: row.domain, node: g });
    gutter.append(gutterCell(row, h, ctx));
    stripe = !stripe;
    y += h;
  }

  // 网格线画在泳道之上，避免被泳道底色冲淡
  const grid = svgEl('g', { 'pointer-events': 'none' });
  drawGrid(grid, plot);
  svg.append(grid);

  // 选中 / 悬停标记（覆盖层）
  const overlay = svgEl('g', { 'pointer-events': 'none' });
  reg.selLine = svgEl('line', { y1: plot.top, y2: plot.bottom, stroke: 'var(--accent)', 'stroke-width': 1, 'stroke-dasharray': '4 3', display: 'none' });
  reg.hoverLine = svgEl('line', { y1: plot.top, y2: plot.bottom, stroke: COLOR.async, 'stroke-width': 1, 'stroke-dasharray': '2 3', display: 'none' });
  reg.selBox = svgEl('rect', { fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2, rx: 3, display: 'none' });
  reg.hoverBox = svgEl('rect', { fill: 'none', stroke: COLOR.async, 'stroke-width': 1.5, 'stroke-dasharray': '3 2', rx: 3, display: 'none' });
  reg.selLabel = svgEl('text', { class: 'axis-label', 'text-anchor': 'middle', y: AXIS_H - 9, display: 'none' });
  overlay.append(reg.hoverBox, reg.selBox, reg.hoverLine, reg.selLine, reg.selLabel);
  svg.append(overlay);

  // 卡片
  const cardNode = card(
    '时间轴',
    useTime && timeDomain
      ? `共用横轴：周期（时间换算按 ${timeDomain.name} 域，1 周期 = ${fmtNs(timeDomain.periodNs!)}）`
      : '共用横轴：周期（没有可见域声明 period/freq，无法改标时间）',
  );
  cardNode.body.append(buildStats(domains, scan, trace));
  cardNode.body.append(buildControls(ctx, plot, span));
  cardNode.body.append(
    legend([
      { label: '完成（O）', color: colorFor('pip') },
      { label: '冲刷（X，斜纹）', color: COLOR.abort },
      { label: '未闭合（虚线）', color: colorFor('pip') },
      { label: '孤立条目（空心 ×）', color: COLOR.orphan },
      { label: '气泡周期', color: COLOR.bubble },
      { label: '异步记录（区间中点・空心）', color: COLOR.async },
    ]),
  );
  const scroll = el('div', { class: 'chart-scroll', style: 'max-width:100%' });
  scroll.append(el('div', { style: 'display:flex;align-items:flex-start;min-width:max-content' }, [gutter, svg]));
  cardNode.body.append(scroll);
  host.append(cardNode.root);

  scrollEl = scroll;
  registry = reg;
  chartAvail = scroll.clientWidth;
  lastHostW = host.clientWidth;
}

// ------------------------------------------------------------------ 卡片附属

function buildStats(domains: DomainInfo[], scan: Scan, trace: Trace): HTMLElement {
  const names = new Set(domains.map((d) => d.name));
  let items = 0;
  let open = 0;
  let aborted = 0;
  let bubbles = 0;
  let lanes = 0;
  for (const track of trace.tracks.values()) {
    if (!names.has(track.domain)) continue;
    lanes++;
    items += track.items.length;
    open += track.open;
    aborted += track.aborted;
    bubbles += track.bubbles.length;
  }
  const clkEdges = [...scan.edges.values()].reduce((sum, e) => sum + e.p.length + e.n.length, 0);
  return el('div', { class: 'stat-row' }, [
    statTile('周期范围', `${countLabel(scan.from)} – ${countLabel(scan.to)}`, `${countLabel(scan.to - scan.from + 1)} 个周期槽`),
    statTile('时钟域', countLabel(domains.length), `${countLabel(clkEdges)} 条 [clk] 记录`),
    statTile('流水线', countLabel(items), `${lanes} 轨道 · ${aborted} 冲刷 · ${open} 未闭合`),
    statTile('气泡周期', countLabel(bubbles), '占用度为 0 的活跃周期'),
    statTile('异步记录', countLabel(scan.asyncRecords.length), '画在周期区间中点（spec §6.7）'),
  ]);
}

function buildControls(ctx: ViewContext, plot: Plot, span: number): HTMLElement {
  const row = el('div', { class: 'row' });
  const button = (text: string, title: string, active: boolean, handler: () => void): HTMLButtonElement => {
    const node = el('button', { class: `chip chip-toggle${active ? ' is-on' : ''}`, text, title, style: 'font:inherit;cursor:pointer' });
    node.addEventListener('click', handler);
    return node;
  };
  row.append(
    el('span', { class: 'toolbar-label', text: '横向缩放' }),
    button('−', '缩小（每周期像素 ÷1.5）', false, () => stepZoom(1 / 1.5)),
    button('+', '放大（每周期像素 ×1.5）', false, () => stepZoom(1.5)),
    button('适应宽度', '让全部周期正好铺满可视宽度', fitWidth, () => {
      fitWidth = true;
      rebuildAnchored(null);
    }),
    el('span', { class: 'toolbar-spacer' }),
  );
  for (const n of [4, 8, 16, 32]) {
    row.append(
      button(`1 周期 = ${n}px`, `每周期 ${n} 像素`, !fitWidth && Math.abs(plot.pxPerCycle - n) < 0.01, () => {
        const center = currentCenterCycle();
        fitWidth = false;
        ctx.options.zoom = n;
        rebuildAnchored(center);
      }),
    );
  }
  row.append(
    el('span', {
      class: 'muted nowrap',
      text: `当前 1 周期 ≈ ${plot.pxPerCycle.toFixed(2)} px · ${countLabel(span)} 周期 · 画布 ${countLabel(Math.round(plot.width))} px`,
    }),
  );
  return row;
}

function axisGutterCell(plot: Plot, timeDomain: DomainInfo | undefined): HTMLElement {
  return el(
    'div',
    {
      style:
        'height:' +
        AXIS_H +
        'px;display:flex;flex-direction:column;justify-content:center;gap:1px;padding:0 8px;border-bottom:1px solid var(--border-strong)',
    },
    [
      el('span', { style: 'font-size:11px;font-weight:600', text: timeDomain ? `周期 / 时间（${timeDomain.name}）` : '周期' }),
      el('span', { class: 'muted', style: 'font-size:10px', text: `${countLabel(plot.from)} – ${countLabel(plot.to)} · ${plot.pxPerCycle.toFixed(2)} px/周期` }),
    ],
  );
}

function gutterCell(row: LaneRow, h: number, ctx: ViewContext): HTMLElement {
  const node = el(
    'div',
    {
      style: `height:${h}px;display:flex;align-items:center;gap:6px;padding:0 8px;border-bottom:1px solid var(--border);overflow:hidden;min-width:0;${row.select ? 'cursor:pointer' : ''}`,
    },
    [
      el('i', { style: `flex:0 0 auto;width:8px;height:8px;border-radius:2px;background:${row.color}` }),
      el('span', {
        class: 'mono',
        style: 'flex:0 1 auto;min-width:0;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
        text: row.label,
      }),
      el('span', {
        class: 'muted nowrap',
        style: 'margin-left:auto;font-size:10px;flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis',
        text: row.note,
      }),
    ],
  );
  if (row.select) node.addEventListener('click', () => ctx.selection.set(row.select ?? null));
  if (row.hover) {
    const sel = row.hover;
    node.addEventListener('mouseenter', () => ctx.selection.hover(sel));
    node.addEventListener('mouseleave', () => ctx.selection.hover(null));
  }
  return node;
}

// ------------------------------------------------------------------ 轴 / 网格 / defs

function axisLayer(svg: SVGSVGElement, plot: Plot, primary: DomainInfo, useTime: boolean, ctx: ViewContext): void {
  const g = svgEl('g', {});
  g.append(svgEl('rect', { x: plot.x0, y: 0, width: plot.x1 - plot.x0, height: AXIS_H, fill: 'var(--surface-2)', 'fill-opacity': 0.55 }));
  const period = primary.periodNs;
  for (const t of axisTicks(plot.from, plot.to, tickCount(plot))) {
    const x = plot.scale(t);
    g.append(svgEl('line', { x1: x, x2: x, y1: AXIS_H - 5, y2: AXIS_H, stroke: 'var(--border-strong)' }));
    const label = useTime && period !== undefined ? (t < 1 ? '时钟前' : fmtNs(timeNs(primary, t) ?? 0)) : String(t);
    g.append(svgEl('text', { x, y: 15, class: 'axis-label', 'text-anchor': 'middle', text: label }));
  }
  g.append(svgEl('line', { x1: plot.x0, x2: plot.x1, y1: AXIS_H - 0.5, y2: AXIS_H - 0.5, stroke: 'var(--border-strong)' }));
  g.append(
    svgEl('text', {
      x: plot.x0 + 4,
      y: 15,
      class: 'axis-label axis-title',
      'text-anchor': 'start',
      text: useTime ? '时间（按主域 period 换算）' : '周期',
    }),
  );
  svg.append(g);

  // 轴背景：点击 / 悬停广播周期
  const hit = svgEl('rect', {
    x: plot.x0,
    y: 0,
    width: plot.x1 - plot.x0,
    height: AXIS_H,
    fill: 'transparent',
    style: 'cursor:crosshair;pointer-events:all',
  });
  svg.append(hit);
  cycleSurface(hit, { svg, plot }, primary.name, ctx, (probe) =>
    [
      cycleTime(primary, probe.cycle, true),
      useTime ? `时间轴：按域 ${primary.name} 的 1 周期 = ${fmtNs(period ?? 0)} 换算` : '没有可见域声明 period，刻度只能标周期号',
      `横轴范围 ${countLabel(plot.from)} – ${countLabel(plot.to)} · 当前 ${plot.pxPerCycle.toFixed(2)} px/周期`,
      '点击：广播该周期（其它视图会跟着定位）',
    ].join('\n'),
  );
}

/** 刻度密度：约每 76 px 一个主刻度（对应 10px 刻度文字宽度 + 呼吸空间），至少 2 个、至多 40 个 */
function tickCount(plot: Plot): number {
  return clamp(Math.floor((plot.x1 - plot.x0) / 76), 2, 40);
}

function drawGrid(g: SVGGElement, plot: Plot): void {
  for (const t of axisTicks(plot.from, plot.to, tickCount(plot))) {
    const x = plot.scale(t);
    g.append(svgEl('line', { x1: x, x2: x, y1: plot.top, y2: plot.bottom, class: 'grid-line' }));
  }
  // 放大后补每周期淡网格，方便逐周期读数
  if (plot.pxPerCycle >= 22 && plot.to - plot.from <= 2000) {
    for (let c = plot.from; c <= plot.to + 1; c++) {
      const x = plot.scale(c);
      g.append(svgEl('line', { x1: x, x2: x, y1: plot.top, y2: plot.bottom, stroke: 'var(--border)', 'stroke-width': 1, 'stroke-opacity': 0.45 }));
    }
  }
}

/** 斜纹填充：用于「冲刷（X）」条目 */
function buildDefs(): SVGDefsElement {
  const defs = svgEl('defs', {});
  defs.append(
    svgEl('pattern', { id: 'tl-stripe', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, [
      svgEl('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: '#ffffff', 'stroke-width': 2, 'stroke-opacity': 0.6 }),
    ]),
  );
  return defs;
}

// ------------------------------------------------------------------ 泳道

function buildRows(
  trace: Trace,
  ctx: ViewContext,
  domains: DomainInfo[],
  scan: Scan,
  visible: (name: string) => boolean,
): Row[] {
  const rows: Row[] = [];
  const group = (header: string, right: string, lanes: LaneRow[]): void => {
    if (lanes.length === 0) return;
    rows.push({ kind: 'header', text: header, right, height: H.header }, ...lanes);
  };

  const clkLanes = domains.map((d) => clockLane(d, ctx, scan));
  group('时钟', `${domains.length} 域`, clkLanes);

  const fsmLanes: LaneRow[] = [];
  for (const fsm of trace.fsms.values()) {
    if (visible(fsm.domain)) fsmLanes.push(fsmLane(fsm, ctx));
  }
  group('状态机', `${fsmLanes.length} 台`, fsmLanes);

  const pipLanes: LaneRow[] = [];
  for (const track of trace.tracks.values()) {
    if (visible(track.domain)) pipLanes.push(pipLane(track, ctx));
  }
  group('流水线', `${pipLanes.length} 轨道`, pipLanes);

  const occLanes: LaneRow[] = [];
  for (const track of trace.tracks.values()) {
    if (visible(track.domain)) occLanes.push(occupancyLane(track, ctx));
  }
  group('占用度', '半开区间 [enter, close)', occLanes);

  const cntLanes: LaneRow[] = [];
  for (const counter of trace.counters.values()) {
    if (visible(counter.domain)) cntLanes.push(counterLane(counter, ctx));
  }
  group('计数器', `${cntLanes.length} 个`, cntLanes);

  const evtLanes: LaneRow[] = [];
  for (const track of trace.events.values()) {
    if (visible(track.domain)) evtLanes.push(eventLane(track.name, track.domain, track.key, track.samples, ctx));
  }
  const messages = trace.messages.filter((m) => visible(m.pos.domain));
  if (messages.length > 0) evtLanes.push(messageLane(messages, ctx));
  group('事件', `${evtLanes.length} 条`, evtLanes);

  if (scan.asyncRecords.length > 0) group('异步事件', `${scan.asyncRecords.length} 条`, [asyncLane(scan.asyncRecords, ctx)]);

  return rows;
}

// ------------------------------ 时钟

function clockLane(d: DomainInfo, ctx: ViewContext, scan: Scan): LaneRow {
  const edges: DomainEdges =
    scan.edges.get(d.name) ?? { p: [], n: [], pSet: new Set(), nSet: new Set(), lo: d.firstCycle, hi: d.lastCycle, hasClk: false };
  const period = d.periodNs !== undefined ? `${d.periodNs} ns/周期` : d.freqHz !== undefined ? `${fmtCompact(d.freqHz)}Hz` : '未声明 period/freq';
  return {
    kind: 'lane',
    key: `clk:${d.name}`,
    domain: d.name,
    label: d.name,
    note: `${countLabel(d.cycles)} 周期`,
    color: colorFor(d.name),
    height: H.clk,
    hover: { kind: 'cycle', domain: d.name, cycle: Math.max(1, d.firstCycle) },
    draw(g, reg, y, h, stripe) {
      const hit = laneCanvas(g, reg, y, h, stripe);
      const high = y + 4;
      const low = y + h - 4;
      g.append(svgEl('path', { d: clockPoints(edges, reg.plot, high, low), fill: 'none', stroke: colorFor(d.name), 'stroke-width': 1.4, 'stroke-linecap': 'square' }));
      if (!edges.hasClk) g.append(svgEl('text', { x: reg.plot.x0 + 6, y: y + h - 8, class: 'axis-label', text: `域 ${d.name} 没有 [clk] 记录` }));
      cycleSurface(hit, reg, d.name, ctx, (probe) => {
        const c = probe.cycle;
        const level = levelAt(edges, c, probe.half);
        const marks = [edges.pSet.has(c) ? 'p（上升）' : null, edges.nSet.has(c) ? 'n（下降）' : null].filter((v) => v !== null);
        return [
          `时钟域 ${d.name}（${d.declared ? '@domain 声明' : '隐式建立'}）`,
          cycleTime(d, c, true),
          `相位 ${probe.half === 0 ? 'p（上升沿之后）' : 'n（下降沿之后）'} · ${level ? '高电平' : '低电平'}`,
          `周期参数：${period}`,
          `本周期沿：${marks.length > 0 ? marks.join(' + ') : '（无）'}`,
          `该域记录周期 ${d.firstCycle} – ${d.lastCycle} · 共 ${countLabel(d.cycles)} 周期`,
        ].join('\n');
      });
    },
  };
}

/** 方波折线：p 沿占前半格、n 沿占后半格；只有 p 记录时整段都是高电平 */
function clockPoints(edges: DomainEdges, plot: Plot, high: number, low: number): string {
  const step = Math.max(1, Math.ceil((plot.to + 1 - plot.from) / 4000));
  const pts: [number, number][] = [];
  let level = false;
  let pi = lowerBound(edges.p, plot.from);
  let ni = lowerBound(edges.n, plot.from);
  for (let block = plot.from; block <= plot.to; block += step) {
    const next = Math.min(block + step, plot.to + 1);
    let hasP = false;
    while (pi < edges.p.length && edges.p[pi]! < next) {
      hasP = true;
      pi++;
    }
    let hasN = false;
    while (ni < edges.n.length && edges.n[ni]! < next) {
      hasN = true;
      ni++;
    }
    if (hasP) level = true;
    const x0 = plot.scale(block);
    const xm = plot.scale(block + step / 2);
    const x1 = plot.scale(next);
    pts.push([x0, level ? high : low], [xm, level ? high : low]);
    if (hasN) level = false;
    pts.push([xm, level ? high : low], [x1, level ? high : low]);
  }
  if (pts.length === 0) return '';
  return `M${pts.map((p) => `${round2(p[0])},${round2(p[1])}`).join('L')}`;
}

// ------------------------------ 状态机

function fsmLane(fsm: FsmTrack, ctx: ViewContext): LaneRow {
  const segments = stateSegments(fsm);
  return {
    kind: 'lane',
    key: `fsm:${fsm.key}`,
    domain: fsm.domain,
    label: fsm.name,
    note: `${fsm.stateSet.length} 状态`,
    color: COLOR.neutral,
    height: H.fsm,
    select: { kind: 'fsm', key: fsm.key },
    hover: { kind: 'fsm', key: fsm.key },
    draw(g, reg, y, h, stripe) {
      const hit = laneCanvas(g, reg, y, h, stripe);
      cycleSurface(hit, reg, fsm.domain, ctx, (probe) => {
        const at = segments.find((s) => probe.cycle >= s.start && probe.cycle <= s.end);
        return [
          `状态机 ${fsm.name}（域 ${fsm.domain}）`,
          cycleTime(ctx.trace.domains.get(fsm.domain), probe.cycle, true),
          at ? `该周期状态：${at.state}（区段 ${at.start} – ${at.end}）` : '该周期没有状态记录',
          `状态集 {${fsm.stateSet.join(', ')}} · 转换 ${fsm.transitions.length} 次 · 采样 ${fsm.samples.length} 条`,
        ].join('\n');
      });
      const last = segments[segments.length - 1];
      let drawn = 0;
      for (const seg of segments) {
        if (drawn >= MAX_ITEMS) break;
        // 区段是半开区间 [start, 下一采样)；最后一段收在自己的周期里
        const segEnd = seg === last ? seg.end + 1 : seg.end;
        const from = Math.max(seg.start, reg.plot.from);
        const to = Math.min(segEnd, reg.plot.to + 1);
        if (to <= from) continue;
        const x0 = reg.plot.scale(from);
        const x1 = reg.plot.scale(to);
        const rect = svgEl('rect', {
          x: x0 + 0.5,
          y: y + 3,
          width: Math.max(1, x1 - x0 - 1),
          height: h - 8,
          rx: 2,
          fill: colorFor(seg.state),
          'fill-opacity': seg.open === true ? 0.45 : 0.82,
          ...(seg.open === true ? { 'stroke-dasharray': '3 2', stroke: colorFor(seg.state), 'stroke-width': 1.5 } : {}),
        });
        const dwell = fsm.dwellCycles.get(seg.state) ?? 0;
        hoverTarget(
          rect,
          () =>
            [
              `状态机 ${fsm.name}（域 ${fsm.domain}）`,
              `状态 ${seg.state}`,
              `周期 ${seg.start} → ${segEnd}（跨 ${segEnd - seg.start} 周期）`,
              `结束于 ${cycleTime(ctx.trace.domains.get(fsm.domain), segEnd, true)}`,
              `该状态驻留合计 ${countLabel(dwell)} 周期`,
              `转换 ${fsm.transitions.length} 次 · 状态集 {${fsm.stateSet.join(', ')}}`,
              seg.open === true ? '最后一段：驻留周期数不可确定（spec §9.5），画成开放的浅色虚线段' : '',
            ]
              .filter((line) => line !== '')
              .join('\n'),
          () => ctx.selection.set({ kind: 'fsm', key: fsm.key }),
        );
        g.append(rect);
        const width = x1 - x0;
        if (width >= 26) {
          g.append(
            svgEl('text', {
              x: x0 + 4,
              y: y + h - 10,
              style: 'font-size:10px;fill:#0f172a;fill-opacity:0.78;pointer-events:none',
              text: clip(seg.state, width),
            }),
          );
        }
        drawn++;
      }
      if (drawn === 0) g.append(svgEl('text', { x: reg.plot.x0 + 6, y: y + h - 10, class: 'axis-label', text: '没有状态记录' }));
    },
  };
}

// ------------------------------ 流水线

function pipLane(track: TrackInfo, ctx: ViewContext): LaneRow {
  const sorted =
    track.items.length > 1 ? [...track.items].sort((a, b) => a.enter.cycle - b.enter.cycle || a.enterSeq - b.enterSeq) : track.items;
  const shown = sorted.length > MAX_ITEMS ? sorted.slice(0, MAX_ITEMS) : sorted;
  const truncated = shown.length < sorted.length;
  return {
    kind: 'lane',
    key: `pip:${track.name}`,
    domain: track.domain,
    label: track.name,
    note: truncated ? `${shown.length}/${sorted.length} 条目` : `${track.items.length} 条目`,
    color: colorFor(track.name),
    height: H.pip,
    hover: { kind: 'cycle', domain: track.domain, cycle: Math.max(1, track.firstCycle) },
    draw(g, reg, y, h, stripe) {
      const hit = laneCanvas(g, reg, y, h, stripe);
      cycleSurface(hit, reg, track.domain, ctx, (probe) =>
        [
          `轨道 ${track.name}（域 ${track.domain}）`,
          cycleTime(ctx.trace.domains.get(track.domain), probe.cycle, true),
          `本周期占用 ${track.occupancy.get(probe.cycle) ?? 0} · 到达 ${track.arrivals.get(probe.cycle) ?? 0} · 离开 ${track.departures.get(probe.cycle) ?? 0}`,
          `${track.items.length} 条目 · ${track.completed} 完成 · ${track.aborted} 冲刷 · ${track.open} 未闭合`,
        ].join('\n'),
      );

      const color = colorFor(track.name);
      const barH = h - 9;
      const barY = y + 4;
      for (const item of shown) {
        const open = item.closed === null;
        const aborted = item.closed === 'X';
        const enterX = reg.plot.scale(item.enter.cycle + phaseOffset(item.enter, item.async));
        // 同域用关闭周期作锚点；跨域锚点在 enter 域上（spec §9.4），不再叠加出记录的相位；
        // 未闭合只画到轨道末周期，**不伪造**退出周期
        const anchor = item.closeAnchorCycle;
        const endCycle = open || anchor === null ? track.lastCycle : anchor;
        const endShift = open || anchor === null || item.crossDomain ? 0 : phaseOffset(item.exit ?? item.abort ?? item.enter, item.closeAsync);
        const right = Math.max(reg.plot.x0 + 1, Math.min(reg.plot.scale(endCycle + endShift), reg.plot.x1));
        const x = clamp(enterX, reg.plot.x0, reg.plot.x1 - 1);
        const w = Math.max(1.5, right - x);
        reg.itemBoxes.set(`${track.name}\u0000${item.enterSeq}`, { x, y: barY, w, h: barH });

        const rect = svgEl('rect', {
          x,
          y: barY,
          width: w,
          height: barH,
          rx: 2,
          fill: item.orphan ? 'var(--surface)' : aborted ? COLOR.abort : color,
          'fill-opacity': item.orphan ? 1 : open ? 0.3 : 0.88,
          stroke: item.orphan ? COLOR.orphan : aborted ? COLOR.abort : color,
          'stroke-width': 1.2,
          ...(open ? { 'stroke-dasharray': '4 3' } : {}),
        });
        g.append(rect);
        // 退化宽度（孤立条目 / 同拍开闭）的条目仍然好点：套一个隐形命中矩形
        const sliver = w < 7;
        const target = sliver
          ? svgEl('rect', { x: x + w / 2 - 3.5, y: barY - 1, width: 7, height: barH + 2, fill: 'transparent', style: 'pointer-events:all' })
          : rect;
        if (sliver) {
          rect.setAttribute('pointer-events', 'none');
          g.append(target);
        }
        hoverTarget(
          target,
          () => pipTip(track, item, open),
          () => ctx.selection.set({ kind: 'item', track: track.name, enterSeq: item.enterSeq }),
        );
        target.addEventListener('mouseenter', () => broadcastHover(ctx, { kind: 'item', track: track.name, enterSeq: item.enterSeq }));
        target.addEventListener('mouseleave', () => broadcastHover(ctx, null));
        if (aborted && !item.orphan) {
          g.append(svgEl('rect', { x, y: barY, width: w, height: barH, rx: 2, fill: 'url(#tl-stripe)', 'pointer-events': 'none' }));
        }
        if (item.orphan) {
          const cx = x + w / 2;
          const cy = barY + barH / 2;
          const r = clamp(w / 3, 2, 4);
          g.append(
            svgEl('path', {
              d: `M${round2(cx - r)},${round2(cy - r)}L${round2(cx + r)},${round2(cy + r)}M${round2(cx + r)},${round2(cy - r)}L${round2(cx - r)},${round2(cy + r)}`,
              stroke: COLOR.orphan,
              'stroke-width': 1.4,
              'pointer-events': 'none',
            }),
          );
        }
        if (item.async) {
          g.append(
            svgEl('circle', { cx: x, cy: barY + barH / 2, r: 2.6, fill: 'var(--surface)', stroke: color, 'stroke-width': 1.2, 'pointer-events': 'none' }),
          );
        }
        if (w >= 30 && tagBudget > 0 && item.tag) {
          tagBudget--;
          g.append(
            svgEl('text', { x: x + 3, y: y + h - 11, style: 'font-size:10px;fill:#0f172a;fill-opacity:0.8;pointer-events:none', text: clip(fmtValue(item.tag), w - 6) }),
          );
        }
      }
      if (truncated) {
        g.append(svgEl('text', { x: reg.plot.x0 + 6, y: y + h - 6, class: 'axis-label', text: `仅绘制前 ${shown.length} 条（共 ${sorted.length} 条）` }));
      }
    },
  };
}

function pipTip(track: TrackInfo, item: PipelineItem, open: boolean): string {
  const lines = [`轨道 ${track.name}（域 ${track.domain}）`, `标记 ${item.tag ? fmtValue(item.tag) : '（无）'}`];
  lines.push(`入：${formatPosition(item.enter)}${item.async ? ' · 异步（画在区间中点）' : ''}`);
  lines.push(item.exit ? `出：${formatPosition(item.exit)}${item.closeAsync ? ' · 异步' : ''}` : '出：（没有匹配的出 / 撤记录）');
  if (item.orphan) lines.push('延迟：—（孤立条目，没有对应的入记录）');
  else if (item.latencyCycles !== null) lines.push(`延迟：${item.latencyCycles} 周期（同域）`);
  else if (item.latencyNs !== null) lines.push(`延迟：${fmtNs(item.latencyNs)}（跨域，两端域都声明了 period）`);
  else if (item.crossDomain) lines.push('延迟：跨域条目不给周期延迟（spec §6.5），按两端位置读数');
  else lines.push('延迟：—（未闭合）');
  lines.push(
    `状态：${
      item.orphan ? '孤立条目（没有可匹配的在飞条目）' : item.closed === 'O' ? '完成（O）' : item.closed === 'X' ? '冲刷 / 撤销（X）' : '未闭合'
    }`,
  );
  if (open) lines.push(`未闭合：只画到轨道末周期 ${track.lastCycle}，不伪造退出周期`);
  lines.push(`跨域 ${item.crossDomain ? '是' : '否'} · 入 seq ${item.enterSeq}${item.closeSeq !== null ? ` · 出 seq ${item.closeSeq}` : ''}`);
  return lines.join('\n');
}

// ------------------------------ 占用度

function occupancyLane(track: TrackInfo, ctx: ViewContext): LaneRow {
  const maxOcc = Math.max(1, ...track.occupancy.values());
  return {
    kind: 'lane',
    key: `occ:${track.name}`,
    domain: track.domain,
    label: `${track.name} 占用`,
    note: `峰 ${maxOcc} · 气泡 ${track.bubbles.length}`,
    color: colorFor(track.name),
    height: H.occ,
    hover: { kind: 'cycle', domain: track.domain, cycle: Math.max(1, track.firstCycle) },
    draw(g, reg, y, h, stripe) {
      const hit = laneCanvas(g, reg, y, h, stripe);
      const plot = reg.plot;
      const base = y + h - 4;
      const inner = h - 9;
      const from = Math.max(plot.from, track.firstCycle);
      const to = Math.min(plot.to, track.lastCycle);
      if (to >= from) {
        if (plot.pxPerCycle >= BAR_MIN_PX && to - from <= 3000) {
          for (let c = from; c <= to; c++) {
            const v = track.occupancy.get(c) ?? 0;
            if (v <= 0) continue;
            const x0 = plot.scale(c);
            const height = Math.max(1, (v / maxOcc) * inner);
            g.append(
              svgEl('rect', {
                x: x0 + 0.5,
                y: base - height,
                width: Math.max(1, plot.scale(c + 1) - x0 - 1),
                height,
                fill: heatColor(v / maxOcc),
                'pointer-events': 'none',
              }),
            );
          }
        } else {
          const pts: [number, number][] = [];
          for (let c = from; c <= to; c++) pts.push([plot.scale(c), base - ((track.occupancy.get(c) ?? 0) / maxOcc) * inner]);
          if (pts.length > 0) {
            g.append(svgEl('path', { d: stepPath(pts), fill: 'none', stroke: colorFor(track.name), 'stroke-width': 1.2, 'pointer-events': 'none' }));
          }
        }
      }
      // 气泡周期：占用度为 0 的活跃周期，用醒目颜色
      for (const range of track.bubbleRanges) {
        const b0 = Math.max(range.start, plot.from);
        const b1 = Math.min(range.end + 1, plot.to + 1);
        if (b1 <= b0) continue;
        const x0 = plot.scale(b0);
        g.append(
          svgEl('rect', {
            x: x0,
            y: y + 3,
            width: Math.max(1, plot.scale(b1) - x0),
            height: h - 7,
            fill: COLOR.bubble,
            'fill-opacity': 0.3,
            stroke: COLOR.bubble,
            'stroke-opacity': 0.8,
            'stroke-width': 0.8,
            'pointer-events': 'none',
          }),
        );
      }
      cycleSurface(hit, reg, track.domain, ctx, (probe) => {
        const c = probe.cycle;
        const occ = track.occupancy.get(c) ?? 0;
        const lines = [
          `轨道 ${track.name} 占用度（域 ${track.domain}）`,
          cycleTime(ctx.trace.domains.get(track.domain), c, true),
          `占用 ${occ}（峰值 ${maxOcc}）· 半开区间 [enter, close)`,
          `到达 ${track.arrivals.get(c) ?? 0} · 离开 ${track.departures.get(c) ?? 0} · 撤销 ${track.aborts.get(c) ?? 0}`,
        ];
        const range = track.bubbleRanges.find((r) => c >= r.start && c <= r.end);
        if (range) lines.push(`气泡周期（气泡区间 ${range.start} – ${range.end}）`);
        lines.push(`轨道活跃区间 ${track.firstCycle} – ${track.lastCycle} · 气泡 ${track.bubbles.length} 个周期`);
        return lines.join('\n');
      });
      if (track.occupancy.size === 0) g.append(svgEl('text', { x: plot.x0 + 6, y: y + h - 10, class: 'axis-label', text: '没有在飞条目' }));
    },
  };
}

// ------------------------------ 计数器

function counterLane(counter: CounterTrack, ctx: ViewContext): LaneRow {
  return {
    kind: 'lane',
    key: `cnt:${counter.key}`,
    domain: counter.domain,
    label: counter.name,
    note: `终值 ${fmtCompact(counter.total)}`,
    color: colorFor(counter.key),
    height: H.cnt,
    select: { kind: 'counter', key: counter.key },
    hover: { kind: 'counter', key: counter.key },
    draw(g, reg, y, h, stripe) {
      const hit = laneCanvas(g, reg, y, h, stripe);
      const plot = reg.plot;
      const inner = h - 12;
      const base = y + h - 4;
      const maxTotal = Math.max(1, counter.total);
      const maxDelta = Math.max(1, ...counter.deltaByCycle.values());
      const color = colorFor(counter.key);

      // 每周期增量柱（放得下时）
      if (plot.pxPerCycle >= 3) {
        for (const [c, delta] of counter.deltaByCycle) {
          if (c < plot.from || c > plot.to || delta <= 0) continue;
          const x0 = plot.scale(c);
          const dh = Math.max(1, (delta / maxDelta) * (inner * 0.55));
          g.append(
            svgEl('rect', { x: x0 + 0.5, y: base - dh, width: Math.max(1, plot.scale(c + 1) - x0 - 1), height: dh, fill: color, 'fill-opacity': 0.45, 'pointer-events': 'none' }),
          );
        }
      }
      // 累计总量阶梯
      const changes = counter.changeCycles.filter((c) => c >= plot.from && c <= plot.to);
      const pts: [number, number][] = [];
      let lastValue = 0;
      const lead = counterTotalAt(counter, plot.from);
      if (lead !== null) {
        lastValue = lead;
        pts.push([plot.scale(plot.from), base - clamp(lead / maxTotal, 0, 1) * inner]);
      }
      for (const c of changes) {
        const v = counter.totalByCycle.get(c) ?? 0;
        lastValue = v;
        pts.push([plot.scale(c), base - clamp(v / maxTotal, 0, 1) * inner]);
      }
      if (pts.length > 0) {
        pts.push([plot.scale(plot.to + 1), base - clamp(lastValue / maxTotal, 0, 1) * inner]);
        g.append(svgEl('path', { d: stepPath(pts), fill: 'none', stroke: color, 'stroke-width': 1.4, 'pointer-events': 'none' }));
      }
      // `abs=` 回读：只置总量、不贡献增量（spec §9.2），用空心点标出
      for (const sample of counter.samples) {
        if (sample.abs === null) continue;
        const c = sample.pos.cycle;
        if (c < plot.from || c > plot.to) continue;
        g.append(
          svgEl('circle', { cx: plot.scale(c + phaseOffset(sample.pos, sample.async)), cy: y + 5, r: 3, fill: 'var(--surface)', stroke: color, 'stroke-width': 1.2, 'pointer-events': 'none' }),
        );
      }
      cycleSurface(hit, reg, counter.domain, ctx, (probe) => {
        const c = probe.cycle;
        const total = counterTotalAt(counter, c);
        const delta = counterDeltaBetween(counter, c - 1, c);
        const lines = [
          `计数器 ${counter.name}（域 ${counter.domain}）`,
          cycleTime(ctx.trace.domains.get(counter.domain), c, true),
          `周期末总量：${total === null ? '—（尚无采样）' : fmtInt(total)}`,
          `本周期增量：${delta === null ? '—' : delta >= 0 ? `+${fmtInt(delta)}` : fmtInt(delta)}`,
          `终值 ${fmtInt(counter.total)} · 采样 ${counter.samples.length} 条 · 变化周期 ${counter.changeCycles.length} 个`,
          `本周期有 ${counter.samples.filter((s) => s.pos.cycle === c).length} 条记录`,
        ];
        const absCount = counter.samples.filter((s) => s.abs !== null).length;
        if (absCount > 0) lines.push(`其中 abs= 回读 ${absCount} 条（只置总量，不贡献增量）`);
        return lines.join('\n');
      });
    },
  };
}

// ------------------------------ 事件 / 消息

function eventLane(
  name: string,
  domain: string,
  key: string,
  samples: { value: ScalarValue | null; pos: Position; async: boolean }[],
  ctx: ViewContext,
): LaneRow {
  const shown = samples.length > MAX_MARKS ? samples.slice(0, MAX_MARKS) : samples;
  return {
    kind: 'lane',
    key: `evt:${key}`,
    domain,
    label: name,
    note: `${samples.length} 次`,
    color: colorFor(key),
    height: H.evt,
    hover: { kind: 'cycle', domain, cycle: samples.length > 0 ? samples[0]!.pos.cycle : 1 },
    draw(g, reg, y, h, stripe) {
      const hit = laneCanvas(g, reg, y, h, stripe);
      const plot = reg.plot;
      cycleSurface(hit, reg, domain, ctx, (probe) =>
        [
          `事件 ${name}（域 ${domain}）`,
          cycleTime(ctx.trace.domains.get(domain), probe.cycle, true),
          `本周期触发 ${samples.filter((s) => s.pos.cycle === probe.cycle).length} 次 · 共 ${samples.length} 次`,
        ].join('\n'),
      );
      const color = colorFor(key);
      const base = y + h - 5;
      let count = 0;
      for (const sample of shown) {
        const c = sample.pos.cycle;
        if (c < plot.from || c > plot.to) continue;
        const cx = plot.scale(c + phaseOffset(sample.pos, sample.async));
        const tri = svgEl('path', {
          d: `M${round2(cx - 3.5)},${base - 7}L${round2(cx + 3.5)},${base - 7}L${round2(cx)},${base}Z`,
          fill: sample.async ? 'var(--surface)' : color,
          stroke: color,
          'stroke-width': 1.1,
        });
        const tip = [
          `事件 ${name}（域 ${domain}）`,
          `位置：${formatPosition(sample.pos)}`,
          `取值：${fmtValue(sample.value)}`,
          sample.async ? '异步记录：不吸附时钟沿，画在周期区间中点（spec §6.7）' : '',
        ]
          .filter((line) => line !== '')
          .join('\n');
        hoverTarget(tri, () => tip, () => ctx.selection.set({ kind: 'cycle', domain, cycle: c }));
        g.append(tri);
        count++;
      }
      if (count === 0) g.append(svgEl('text', { x: plot.x0 + 6, y: y + h - 8, class: 'axis-label', text: '该周期范围内没有事件' }));
    },
  };
}

function messageLane(messages: { pos: Position; text: string; async: boolean }[], ctx: ViewContext): LaneRow {
  const shown = messages.length > MAX_MARKS ? messages.slice(0, MAX_MARKS) : messages;
  return {
    kind: 'lane',
    key: 'msg:all',
    domain: messages[0]!.pos.domain,
    label: '消息',
    note: `${messages.length} 条`,
    color: COLOR.msg,
    height: H.evt,
    draw(g, reg, y, h, stripe) {
      const hit = laneCanvas(g, reg, y, h, stripe);
      const plot = reg.plot;
      cycleSurface(hit, reg, messages[0]!.pos.domain, ctx, (probe) => {
        const here = messages.filter((m) => m.pos.cycle === probe.cycle);
        return [
          `消息（${messages.length} 条）`,
          cycleTime(ctx.trace.domains.get(messages[0]!.pos.domain), probe.cycle, true),
          here.length > 0 ? here.map((m) => `· ${m.text}`).join('\n') : '本周期没有消息',
        ].join('\n');
      });
      const base = y + h - 6;
      for (const msg of shown) {
        const c = msg.pos.cycle;
        if (c < plot.from || c > plot.to) continue;
        const dot = svgEl('circle', {
          cx: plot.scale(c + phaseOffset(msg.pos, msg.async)),
          cy: base - 4,
          r: 4,
          fill: msg.async ? 'var(--surface)' : COLOR.msg,
          stroke: COLOR.msg,
          'stroke-width': 1.2,
        });
        const tip = [
          `消息（域 ${msg.pos.domain}）`,
          `位置：${formatPosition(msg.pos)}`,
          `正文：${msg.text}`,
          msg.async ? '异步记录：画在周期区间中点（spec §6.7）' : '',
        ]
          .filter((line) => line !== '')
          .join('\n');
        hoverTarget(dot, () => tip, () => ctx.selection.set({ kind: 'cycle', domain: msg.pos.domain, cycle: c }));
        g.append(dot);
      }
    },
  };
}

// ------------------------------ 异步事件汇总（spec §6.7）

function asyncLane(records: EventRecord[], ctx: ViewContext): LaneRow {
  const shown = records.length > MAX_MARKS ? records.slice(0, MAX_MARKS) : records;
  return {
    kind: 'lane',
    key: 'async:all',
    domain: records[0]!.pos.domain,
    label: '异步事件',
    note: `${records.length} 条`,
    color: COLOR.async,
    height: H.evt,
    draw(g, reg, y, h, stripe) {
      const hit = laneCanvas(g, reg, y, h, stripe);
      const plot = reg.plot;
      cycleSurface(hit, reg, records[0]!.pos.domain, ctx, (probe) => {
        const here = records.filter((r) => r.pos.cycle === probe.cycle);
        return [
          `异步记录（${records.length} 条）`,
          cycleTime(ctx.trace.domains.get(records[0]!.pos.domain), probe.cycle, true),
          here.length > 0 ? here.map((r) => `· ${KIND_LABEL[r.kind] ?? r.kind} ${recordName(r)}`).join('\n') : '本周期没有异步记录',
          '画在周期区间中点（两个时钟沿之间），空心标记 + 虚线连回区间',
        ].join('\n');
      });
      const base = y + h - 3;
      const cy = y + h / 2 - 1;
      for (const rec of shown) {
        const c = rec.pos.cycle;
        if (c < plot.from || c > plot.to) continue;
        const color = colorFor(rec.kind);
        const cx = plot.scale(c + 0.5); // 区间中点：不吸附到任何时钟沿
        const x0 = plot.scale(c);
        const x1 = plot.scale(Math.min(c + 1, plot.to + 1));
        g.append(svgEl('line', { x1: cx, x2: cx, y1: cy + 4, y2: base, stroke: color, 'stroke-width': 1, 'stroke-dasharray': '3 2', 'stroke-opacity': 0.85 }));
        g.append(svgEl('line', { x1: x0, x2: x1, y1: base, y2: base, stroke: color, 'stroke-width': 1.4, 'stroke-dasharray': '3 2' }));
        const mark = svgEl('path', {
          d: `M${round2(cx - 4)},${round2(cy - 4)}L${round2(cx + 4)},${round2(cy - 4)}L${round2(cx)},${round2(cy + 4)}Z`,
          fill: 'var(--surface)',
          stroke: color,
          'stroke-width': 1.4,
        });
        const tip = [
          `异步${KIND_LABEL[rec.kind] ?? rec.kind}：${recordName(rec)}`,
          `位置：${formatPosition(rec.pos)}`,
          `原始行：${rec.raw.length > 160 ? `${rec.raw.slice(0, 160)}…` : rec.raw}`,
          '画在周期区间中点（两个时钟沿之间），空心标记 + 虚线连回区间（spec §6.7）',
        ].join('\n');
        hoverTarget(mark, () => tip, () => ctx.selection.set({ kind: 'cycle', domain: rec.pos.domain, cycle: c }));
        g.append(mark);
      }
    },
  };
}

// ------------------------------------------------------------------ 选中 / 悬停高亮

function laneTargets(sel: Selection): { lanes?: string[]; domain?: string } | null {
  if (sel === null) return null;
  switch (sel.kind) {
    case 'cycle':
      return { domain: sel.domain };
    case 'item':
      return { lanes: [`pip:${sel.track}`] };
    case 'fsm':
      return { lanes: [`fsm:${sel.key}`] };
    case 'counter':
      return { lanes: [`cnt:${sel.key}`] };
    default:
      return null;
  }
}

function applyState(): void {
  const ctx = ctxRef;
  const reg = registry;
  if (!ctx || !reg) return;
  const sel = ctx.selection.get();
  const opacity = new Map<string, number>();
  const focus = (target: Selection, keep: number, others: number): void => {
    const scope = laneTargets(target);
    if (!scope) return;
    for (const lane of reg.lanes) {
      const hit = scope.lanes ? scope.lanes.includes(lane.key) : lane.domain === scope.domain;
      const value = hit ? keep : others;
      const prev = opacity.get(lane.key);
      opacity.set(lane.key, prev === undefined ? value : Math.min(prev, value));
    }
  };
  focus(sel, 1, 0.4);
  focus(hoverSel, 1, 0.72);
  for (const lane of reg.lanes) lane.node.style.opacity = String(opacity.get(lane.key) ?? 1);

  placeCycleMark(reg.selLine, reg.selLabel, sel, ctx);
  placeCycleMark(reg.hoverLine, null, hoverSel, ctx);
  placeBox(reg.selBox, sel, reg, true);
  placeBox(reg.hoverBox, hoverSel, reg, false);
}

function placeCycleMark(line: SVGLineElement, label: SVGTextElement | null, sel: Selection, ctx: ViewContext): void {
  const reg = registry;
  if (!reg || sel === null || sel.kind !== 'cycle' || sel.cycle < reg.plot.from || sel.cycle > reg.plot.to) {
    line.setAttribute('display', 'none');
    label?.setAttribute('display', 'none');
    return;
  }
  const plot = reg.plot;
  // 放大后指向周期中点，缩小时指向周期起点，避免误导
  const x = plot.scale(sel.cycle) + (plot.pxPerCycle >= 6 ? plot.pxPerCycle / 2 : 0);
  line.setAttribute('x1', String(x));
  line.setAttribute('x2', String(x));
  line.setAttribute('display', '');
  if (label) {
    label.setAttribute('x', String(clamp(x, plot.x0 + 46, plot.x1 - 46)));
    label.setAttribute('display', '');
    label.textContent = cycleTime(ctx.trace.domains.get(sel.domain), sel.cycle, ctx.options.useTimeAxis);
  }
}

function placeBox(box: SVGRectElement, sel: Selection, reg: Registry, solid: boolean): void {
  if (sel === null || sel.kind !== 'item') {
    box.setAttribute('display', 'none');
    return;
  }
  const found = reg.itemBoxes.get(`${sel.track}\u0000${sel.enterSeq}`);
  if (!found) {
    box.setAttribute('display', 'none');
    return;
  }
  box.setAttribute('x', String(found.x - 1));
  box.setAttribute('y', String(found.y - 1));
  box.setAttribute('width', String(found.w + 2));
  box.setAttribute('height', String(found.h + 2));
  box.setAttribute('stroke-dasharray', solid ? '' : '3 2');
  box.setAttribute('display', '');
}

// ------------------------------------------------------------------ 缩放 / 重建

/** 每周期像素：`fitWidth` = 适应宽度；`options.zoom ≥ 2` = 用户显式选择；默认（1）= 自动铺满但至少 8px/周期 */
function pixelScale(ctx: ViewContext, host: HTMLElement, span: number): number {
  // 重建时旧滚动容器已从文档摘掉（clientWidth = 0），此时用上一次量到的宽度或容器宽度估算
  const live = scrollEl?.isConnected ? scrollEl.clientWidth : chartAvail > 0 ? chartAvail : host.clientWidth;
  const avail = Math.max(200, live - GUTTER - SIDE * 2 - 2);
  const ceiling = MAX_PLOT_WIDTH / span;
  // 「适应宽度」要正好铺满，所以不受手动缩放的像素上限约束
  if (fitWidth) return clamp(avail / span, PX_MIN, ceiling);
  const zoom = ctx.options.zoom;
  const explicit = Number.isFinite(zoom) && zoom >= 2;
  return clamp(explicit ? zoom : clamp(avail / span, PX_DEFAULT, PX_MAX), PX_MIN, Math.min(PX_MAX, ceiling));
}

/** 清空并重画；「适应宽度」下首帧量宽不准时再补一帧，保证正好铺满 */
function paint(host: HTMLElement, ctx: ViewContext): void {
  const before = chartAvail;
  clear(host);
  tagBudget = TAG_BUDGET;
  build(host, ctx);
  if (fitWidth && Math.abs(chartAvail - before) > 1) {
    clear(host);
    tagBudget = TAG_BUDGET;
    build(host, ctx);
  }
}

/** 视口中心对应的周期（重建后还原，缩放时不「跑偏」） */
function currentCenterCycle(): number | null {
  const reg = registry;
  if (!reg || !scrollEl) return null;
  const userX = scrollEl.scrollLeft + scrollEl.clientWidth / 2 - GUTTER;
  return reg.plot.scale.invert(clamp(userX, reg.plot.x0, reg.plot.x1));
}

function restoreCenter(cycle: number | null): void {
  const reg = registry;
  if (!reg || !scrollEl || cycle === null) return;
  scrollEl.scrollLeft = GUTTER + reg.plot.scale(cycle) - scrollEl.clientWidth / 2;
}

function rebuild(keepScroll: boolean, center: number | null): void {
  const host = hostEl;
  const ctx = ctxRef;
  if (!host || !ctx) return;
  const left = scrollEl?.scrollLeft ?? 0;
  paint(host, ctx);
  if (keepScroll) scrollEl!.scrollLeft = left;
  restoreCenter(center);
  applyState();
}

function rebuildAnchored(center: number | null): void {
  rebuild(false, center);
}

function stepZoom(factor: number): void {
  const ctx = ctxRef;
  if (!ctx) return;
  const current = registry?.plot.pxPerCycle ?? PX_DEFAULT;
  const next = clamp(current * factor, PX_MIN, PX_MAX);
  if (Math.abs(next - current) < 1e-6) return;
  const center = currentCenterCycle();
  fitWidth = false;
  ctx.options.zoom = Number(next.toFixed(4));
  rebuildAnchored(center);
}

/** 视图容器宽度变化：只有「适应宽度」模式需要跟着重画（ResizeObserver 回调，宽度已确定） */
function handleResize(): void {
  if (!fitWidth || !hostEl || !ctxRef || hostEl.clientWidth === lastHostW) return;
  rebuild(false, null);
}

function observeResize(host: HTMLElement): void {
  resizeObs?.disconnect();
  resizeObs = new ResizeObserver(() => handleResize());
  resizeObs.observe(host);
}

// ------------------------------------------------------------------ 视图

export const timelineView: View = {
  id: 'timeline',
  title: '时间轴',
  hint: '时钟 · 流水线 · 计数器 · 状态机的共用时间轴',

  mount(container, ctx) {
    unsub?.();
    hostEl = container;
    ctxRef = ctx;
    scrollEl = null;
    registry = null;
    hoverSel = null;
    lastHoverKey = '';
    chartAvail = 0;
    tagBudget = TAG_BUDGET;
    paint(container, ctx);
    unsub = ctx.selection.subscribe((sel, kind) => {
      if (kind === 'hover') {
        hoverSel = sel;
        lastHoverKey = sel === null ? '' : JSON.stringify(sel);
      }
      applyState();
    });
    applyState();
    observeResize(container);
  },

  refresh(ctx, reason) {
    ctxRef = ctx;
    if (!hostEl || !ctxRef) return;
    if (reason === 'hover' || reason === 'selection') {
      applyState();
      return;
    }
    rebuild(true, currentCenterCycle());
  },

  unmount() {
    unsub?.();
    unsub = null;
    resizeObs?.disconnect();
    resizeObs = null;
    hostEl = null;
    scrollEl = null;
    registry = null;
    ctxRef = null;
    hoverSel = null;
    lastHoverKey = '';
    chartAvail = 0;
    lastHostW = 0;
  },
};

export default timelineView;
