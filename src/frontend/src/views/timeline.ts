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
  DomainInfo,
  EventRecord,
  Phase,
  PipelineItem,
  Position,
  ScalarValue,
  TrackInfo,
  Trace,
  ValueTrack,
} from '../../../parser/src/index.ts';
import {
  counterTotalAt,
  equalRuns,
  formatPosition,
  stateSegments,
  valueAt,
  valueKey,
  type CounterTrack,
  type FsmTrack,
} from '../../../parser/src/index.ts';
import {
  axisTicks,
  card,
  clear,
  colorFor,
  countLabel,
  el,
  emptyState,
  hoverTarget,
  linePath,
  legend,
  linearScale,
  statTile,
  stepPath,
  svgEl,
  svgRoot,
  type Scale,
} from '../charts.ts';
import {
  fmtCompact,
  fmtInt,
  fmtNs,
  fmtValue,
  type Selection,
  type View,
  type ViewContext,
} from '../view.ts';
import { VALUE_FORMATS, formatScalarBy, type ValueFormat } from '../rv.ts';
import { compositeOver, inkOn as inkOnBackdrop, parseCssColor, type Rgb } from '../contrast.ts';

// ------------------------------------------------------------------ 常量

/** 左侧标签列宽（px） */
const GUTTER = 178;
/** 顶部周期轴高度（px） */
const AXIS_H = 30;
/** 绘图区左右内边距（px） */
const SIDE = 8;
/** 泳道高度（px） */
const H = { clk: 34, fsm: 30, pip: 30, cnt: 36, value: 36, evt: 26 } as const;
/** 行间距（px）：行之间留白，靠间距而不是分隔线区分行 */
const ROW_GAP = 9;
/**
 * 泳道底下真正被涂上的颜色：从所在元素往上走，把半透明背景逐层合成掉。
 * 不能假定是白色 —— 深色主题下写死白色会把"该用黑字还是白字"整个判反。
 */
function computeBackdrop(from: Element | null): Rgb {
  const layers: { rgb: Rgb; alpha: number }[] = [];
  for (let node: Element | null = from; node !== null; node = node.parentElement) {
    const parsed = parseCssColor(getComputedStyle(node).backgroundColor);
    if (parsed !== null && parsed.alpha > 0) {
      layers.push(parsed);
      if (parsed.alpha >= 1) break;
    }
  }
  // 自下而上合成：最靠上的那层垫底
  return compositeOver(layers.reverse(), [255, 255, 255]);
}

/** 本次渲染的画布底色（`build()` 里刷新；主题切换时置空并重画） */
let backdrop: Rgb | null = null;

/** 当前画布底色上的字色（`fill` 传 null 表示该处不填充，露出画布底色） */
function inkOn(fill: string | null, alpha = 1): string {
  return inkOnBackdrop(fill, alpha, backdrop ?? [255, 255, 255]);
}

/** 自动铺满时每周期的最小像素（默认视图别太挤） */
const PX_DEFAULT = 8;
/** 画布总宽上限（不是缩放上限）：几十万像素的 SVG 浏览器渲染会明显吃力 */
const MAX_PLOT_WIDTH = 200000;
/** 画布总宽下限（px）：缩到一根线就没法看了 */
const MIN_PLOT_WIDTH = 24;
/** 每个泳道的条目 / 标记 / 文本上限 */
const MAX_ITEMS = 4000;
const MAX_MARKS = 2000;
/**
 * **每条泳道**的条目文本上限。
 * 曾经是全局一份：几千条记录的轨迹里，靠前的泳道（IF/ID/SG）把额度吃完，
 * 后面的泳道（EX/MEM/WB）就一个字都画不出来 —— 看起来像"没有数值"。
 */
const TAG_BUDGET = 1200;
/** 低于这个像素密度就不画每周期柱（改用聚合折线） */
const BAR_MIN_PX = 2;

/**
 * 内容型六边形色块的填充不透明度。
 * 只作用于"实色内容块"（流水线条目、状态机状态段、数值/计数器块）；
 * 空心与推断类标记另有更淡的值：气泡 0.08、推断段 0.15、未闭合的空心/表面色，
 * 冲刷条目干脆不填充 —— 它们靠"空心"表达"这里没有内容"，填充率一高就看不出来了。
 */
const BLOCK_FILL = 0.6;

/** 时钟泳道的颜色：默认域用绿色 —— 波形查看器里时钟基本都画成绿色，扫一眼就能找到节拍 */
const CLOCK_COLOR = '#22c55e';
const clockColor = (domain: string): string => (domain === 'default' ? CLOCK_COLOR : colorFor(domain));

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
  /** n 沿是按相位模型补出来的（文件里只有 p 记录），不是文件里写着的 */
  synthN: boolean;
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
  y: number;
  h: number;
  color: string;
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
  selBox: SVGRectElement;
  hoverBox: SVGRectElement;
  selLabel: SVGTextElement;
  /** 悬停高光：整列一层很淡的底色 + 鼠标所在那一行更明显一点 */
  hoverCol: SVGRectElement;
  hoverCell: SVGRectElement;
  hoverTag: SVGTextElement;
  /** 渲染循环在调用 row.draw 前写入，供 cycleSurface 捕获（不改各泳道的绘制签名） */
  currentRow: { key: string; y: number; h: number; color: string } | null;
}

/** 行分组：仅用于给行头背景上色（界面上不再显示小标题） */
type LaneGroup = 'clock' | 'fsm' | 'pipeline' | 'counter' | 'value' | 'event';

/** 行分组 → 中文名（"已隐藏的行"菜单里标出来源） */
const GROUP_NAME: Record<LaneGroup, string> = {
  clock: '时钟',
  fsm: '状态机',
  pipeline: '流水线',
  counter: '计数器',
  value: '数值',
  event: '事件',
};

const GROUP_TINT: Record<LaneGroup, string> = {
  clock: 'color-mix(in srgb, #22c55e 16%, transparent)',
  fsm: 'color-mix(in srgb, #0d9488 15%, transparent)',
  pipeline: 'var(--surface-2)',
  counter: 'color-mix(in srgb, #0891b2 14%, transparent)',
  value: 'color-mix(in srgb, #7c3aed 13%, transparent)',
  event: 'color-mix(in srgb, #d97706 14%, transparent)',
};

interface LaneRow {
  kind: 'lane';
  group: LaneGroup;
  /** 高亮用的泳道键：`clk:域` / `fsm:key` / `pip:轨道` / `occ:轨道` / `cnt:key` / `evt:key` … */
  key: string;
  domain: string;
  label: string;
  color: string;
  height: number;
  /** 右键菜单可配置的内容（显示格式 / 显示模式；`row` 一节里还有"隐藏此行"） */
  menu?: { formatKey?: string; formatWidth?: number; modeKey?: string; defaultMode?: ValueMode; allowRv?: boolean };
  /** 标签列点击 / 悬停时广播的选中态 */
  select?: Selection;
  hover?: Selection;
  draw(g: SVGGElement, reg: Registry, y: number, h: number): void;
}

type Row = LaneRow;

/** 指针探针：泳道背景用「指针位置 → 周期」而不是逐周期建节点 */
interface Probe {
  cycle: number;
  half: 0 | 1;
}

// ------------------------------------------------------------------ 模块状态

let hostEl: HTMLElement | null = null;
/** 用户拖拽后的行顺序（按 LaneRow.key）；空数组表示默认顺序 */
let rowOrder: string[] = [];
/** 被右键隐藏的行（按 LaneRow.key）：拖拽顺序里仍然留着，重新显示时回到原位 */
let hiddenRows = new Set<string>();
/** 最近一次构建出的全部行（含被隐藏的），供"已隐藏的行"菜单取名字 */
let allRows: LaneRow[] = [];
/** 批量选中的行键（Shift 选一整片、Ctrl 点选增减），以及 Shift 区间用的锚点 */
let selectedRows = new Set<string>();
let anchorKey: string | null = null;
/** 行键 → 行头单元格：给选中的行加类名用（重画后要重新套一遍） */
const rowCells = new Map<string, HTMLElement>();

/** 当前渲染顺序（被隐藏的行不参与区间选择） */
function renderedRowKeys(): string[] {
  const lanes = registry?.lanes.map((lane) => lane.key) ?? [];
  return lanes.length > 0 ? lanes : allRows.filter((row) => !hiddenRows.has(row.key)).map((row) => row.key);
}

function applyRowSelection(): void {
  for (const [key, cell] of rowCells) cell.classList.toggle('is-row-selected', selectedRows.has(key));
}

/** 左键（可带修饰键）改选中：普通=只选它，Ctrl/⌘=加选或去掉它，Shift=从锚点连选一整片 */
function selectRow(row: LaneRow, mode: 'only' | 'toggle' | 'range'): void {
  if (mode === 'only') {
    selectedRows = new Set([row.key]);
    anchorKey = row.key;
  } else if (mode === 'toggle') {
    if (selectedRows.has(row.key)) selectedRows.delete(row.key);
    else selectedRows.add(row.key);
    anchorKey = row.key;
  } else {
    const keys = renderedRowKeys();
    const here = keys.indexOf(row.key);
    const from = anchorKey !== null && keys.includes(anchorKey) ? keys.indexOf(anchorKey) : here;
    if (here >= 0 && from >= 0) {
      selectedRows = new Set(keys.slice(Math.min(from, here), Math.max(from, here) + 1));
      anchorKey = row.key;
    }
  }
  applyRowSelection();
}

/**
 * 右键作用于哪些行：右键的行在选中集里 → 整批；否则只有它自己。
 * 菜单项据此只作用在"适用的行"上 —— 时钟/事件这类没有显示格式与显示模式的行
 * 不会被批量操作改到（见 menuSectionsFor 的过滤）。
 */
function menuTargets(row: LaneRow): LaneRow[] {
  if (selectedRows.size <= 1 || !selectedRows.has(row.key)) return [row];
  return allRows.filter((candidate) => selectedRows.has(candidate.key));
}
let scrollEl: HTMLElement | null = null;
let ctxRef: ViewContext | null = null;
let unsub: (() => void) | null = null;
let registry: Registry | null = null;
let hoverSel: Selection = null;
let lastHoverKey = '';
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
        synthN: false,
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
    // 只插上升沿是规范允许的省事写法（§6.2 第 3 条 / W10），此时文件里没有 n 记录；
    // 但「周期 = 先 p 段（高）再 n 段（低）」的相位模型仍然成立（§6.1 第 5 条），
    // 下降沿必然落在周期中点 —— 不补出来波形会一直停在第一次上升沿后的高电平。
    // 只影响渲染与 tip 里的电平：不动 nSet，§9.1 的「下降沿数」仍是文件里的 n 记录数。
    if (e.hasClk && e.p.length > 0 && e.n.length === 0) {
      e.n = e.p.slice();
      e.synthN = true;
    }
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
  // 轴带上的调用拿不到 Registry（它在轴之后才创建），轴本来也没有"所在行"，
  // 因此这里接受 Surface，行信息按需探测
  node: SVGRectElement,
  surface: Surface | Registry,
  domain: string,
  ctx: ViewContext,
  render: (probe: Probe) => string,
): SVGRectElement {
  const { plot, svg } = surface;
  const probe: Probe = { cycle: plot.from, half: 0 };
  // 绘制期就从传进来的 reg 捕获所在行（不能读模块级 registry：它在这轮渲染结束前还是上一轮的）
  const rowAt = 'currentRow' in surface ? surface.currentRow : null;
  const currentRow = (): typeof rowAt => rowAt;
  const onMove = (event: MouseEvent): void => {
    const box = svg.getBoundingClientRect();
    const userX = box.width > 0 ? (event.clientX - box.left) * (plot.width / box.width) : plot.x0;
    const raw = plot.scale.invert(clamp(userX, plot.x0, plot.x1));
    probe.cycle = clamp(Math.floor(raw), plot.from, plot.to);
    probe.half = raw - probe.cycle < 0.5 ? 0 : 1;
    broadcastHover(ctx, { kind: 'cycle', domain, cycle: probe.cycle });
    showHoverCycle(domain, probe.cycle, currentRow(), ctx);
  };
  // 高亮挂在这一行的**分组**上：鼠标压在条目/标记上时也要能高亮当前周期
  // （提示气泡仍然各管各的：条目有条目自己的，泳道空白处才有泳道的）
  const host = node.parentElement !== null && node.parentElement.tagName !== 'svg' ? node.parentElement : node;
  // 用捕获阶段：本行内的元素（条目、标记）可能自带 mousemove 提示，
  // 捕获先于目标阶段执行，保证提示读到的是本拍刚算出的周期，而不是上一拍的残留
  host.addEventListener('mousemove', onMove as EventListener, true);
  host.addEventListener('mouseleave', () => hideHoverCycle());
  node.addEventListener('click', () => ctx.selection.set({ kind: 'cycle', domain, cycle: probe.cycle }));
  return hoverTarget(node, () => render(probe));
}

/**
 * 悬停高亮：把「鼠标所在行 + 该行所属时钟域的当前周期」框出来。
 * 行头/泳道都可以拖拽排序，所以这里刻意不画横跨全图的竖线，避免误读成"全局时刻"。
 */
function showHoverCycle(domain: string, cycle: number, rowAt: { key: string; y: number; h: number; color: string } | null, ctx: ViewContext): void {
  const reg = registry;
  if (!reg) return;
  const plot = reg.plot;
  const target = rowAt ?? reg.lanes.find((lane) => lane.key === `clk:${domain}`) ?? null;
  if (target === null || cycle < plot.from || cycle > plot.to) {
    hideHoverCycle();
    return;
  }
  const x0 = plot.scale(cycle);
  const x1 = plot.scale(cycle + 1);
  const width = Math.max(2, x1 - x0);
  // 整列高光（贯穿绘图区）
  reg.hoverCol.setAttribute('x', String(x0));
  reg.hoverCol.setAttribute('y', String(plot.top));
  reg.hoverCol.setAttribute('width', String(width));
  reg.hoverCol.setAttribute('height', String(plot.bottom - plot.top));
  reg.hoverCol.setAttribute('fill', target.color);
  reg.hoverCol.setAttribute('display', '');
  // 当前行再加深一档
  reg.hoverCell.setAttribute('x', String(x0));
  reg.hoverCell.setAttribute('y', String(target.y));
  reg.hoverCell.setAttribute('width', String(width));
  reg.hoverCell.setAttribute('height', String(Math.max(2, target.h)));
  reg.hoverCell.setAttribute('fill', target.color);
  reg.hoverCell.setAttribute('display', '');
  reg.hoverTag.setAttribute('x', String(x1 + 6));
  reg.hoverTag.setAttribute('y', String(target.y + target.h / 2 + 3.5));
  reg.hoverTag.setAttribute('fill', target.color);
  reg.hoverTag.textContent = `${domain} · ${cycleLabel(cycle)}`;
  reg.hoverTag.setAttribute('display', '');
}

function hideHoverCycle(): void {
  registry?.hoverCol.setAttribute('display', 'none');
  registry?.hoverCell.setAttribute('display', 'none');
  registry?.hoverTag.setAttribute('display', 'none');
}

/** 泳道底：透明命中矩形 + 底部分隔线 */
/**
 * 六边形：左右两端切角，中段是水平的本体。
 * 切角正好落在相邻两段的交界处，于是"这里发生了数值跳变"一眼可见（传统总线波形的画法）。
 */
function hexPath(x0: number, x1: number, top: number, bottom: number, slant: number): string {
  const mid = (top + bottom) / 2;
  const s = Math.min(slant, Math.max(0.5, (x1 - x0) / 3));
  return `M${round2(x0 + s)},${round2(top)}L${round2(x1 - s)},${round2(top)}L${round2(x1)},${round2(mid)}L${round2(x1 - s)},${round2(bottom)}L${round2(x0 + s)},${round2(bottom)}L${round2(x0)},${round2(mid)}Z`;
}

function laneCanvas(g: SVGGElement, reg: Registry, y: number, h: number): SVGRectElement {
  const plot = reg.plot;
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
  // 每次渲染重新解析一次画布底色（跟着主题走），供 inkOn 判断字色
  backdrop = computeBackdrop(host);
  const scan = scanRecords(trace, new Set(domains.map((d) => d.name)));

  // 时间轴换算的主域：优先 default，其次任意声明了 period 的可见域
  const timeDomain =
    domains.find((d) => d.name === 'default' && d.periodNs !== undefined) ?? domains.find((d) => d.periodNs !== undefined);
  const primary = timeDomain ?? domains[0]!;

  const rows = buildRows(trace, ctx, domains, scan, visible);

  const span = Math.max(1, scan.to - scan.from + 1);
  const px = pixelScale(ctx, host, span);
  const plotW = Math.max(1, span * px);
  // 行之间留白：总高 = 轴 + Σ行高 + 行间距（末尾不加）
  const height = AXIS_H + rows.reduce((sum, row) => sum + rowHeight(row) + ROW_GAP, 0) - ROW_GAP;
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
  axisLayer(svg, plot, primary, ctx);

  const reg: Registry = {
    svg,
    plot,
    lanes: [],
    itemBoxes: new Map(),
    selLine: svgEl('line', {}),
    selBox: svgEl('rect', {}),
    hoverBox: svgEl('rect', {}),
    selLabel: svgEl('text', {}),
    hoverCol: svgEl('rect', {}),
    hoverCell: svgEl('rect', {}),
    hoverTag: svgEl('text', {}),
    currentRow: null,
  };

  // 网格线先画：它在泳道之下，不会盖住波形（选中/悬停高光仍在最上层）
  const underlay = svgEl('g', { 'pointer-events': 'none' });
  drawGrid(underlay, plot);
  svg.append(underlay);

  const gutter = el('div', {
    // padding 让每行的圆角色块与左右两条边线（画布外沿 / 分隔线）留白，不贴着线
    style: `flex:0 0 ${GUTTER}px;min-width:0;overflow:hidden;position:sticky;left:0;z-index:2;background:var(--surface);border-right:1px solid var(--border);padding:0 8px;box-sizing:border-box`,
  });
  gutter.append(axisGutterCell(plot));

  rowCells.clear();
  let y = AXIS_H;
  for (const row of rows) {
    const h = rowHeight(row);
    const g = svgEl('g', {});
    svg.append(g);
    // 悬停高亮需要知道"鼠标在哪一行"，这里在绘制前登记（各泳道的绘制签名保持不变）
    reg.currentRow = { key: row.key, y, h, color: row.color };
    row.draw(g, reg, y, h);
    reg.currentRow = null;
    reg.lanes.push({ key: row.key, domain: row.domain, node: g, y, h, color: row.color });
    const cell = gutterCell(row, h, ctx);
    rowCells.set(row.key, cell);
    gutter.append(cell);
    installRowMenu(g, row);
    y += h + ROW_GAP;
  }
  // 单元格是新建的，把批量选中态重新套上
  applyRowSelection();

  // 选中 / 悬停标记（覆盖层）
  const overlay = svgEl('g', { 'pointer-events': 'none' });
  reg.selLine = svgEl('line', { y1: plot.top, y2: plot.bottom, stroke: 'var(--accent)', 'stroke-width': 1, 'stroke-dasharray': '4 3', display: 'none' });
  // 悬停：周期所在的一整列加一层浅色高光（不画边框，也不画竖向虚线），
  // 其中鼠标所在行再加深一点，兼顾"列"的定位与"行"的归属
  reg.hoverCol = svgEl('rect', { 'fill-opacity': 0.07, display: 'none', 'pointer-events': 'none' });
  reg.hoverCell = svgEl('rect', { rx: 3, 'fill-opacity': 0.18, display: 'none', 'pointer-events': 'none' });
  reg.hoverTag = svgEl('text', { class: 'axis-label', 'text-anchor': 'start', display: 'none' });
  reg.selBox = svgEl('rect', { fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2, rx: 3, display: 'none' });
  reg.hoverBox = svgEl('rect', { fill: 'none', stroke: COLOR.async, 'stroke-width': 1.5, 'stroke-dasharray': '3 2', rx: 3, display: 'none' });
  reg.selLabel = svgEl('text', { class: 'axis-label', 'text-anchor': 'middle', y: AXIS_H - 9, display: 'none' });
  overlay.append(reg.hoverCol, reg.hoverCell, reg.hoverBox, reg.selBox, reg.selLine, reg.selLabel, reg.hoverTag);
  svg.append(overlay);

  // 卡片
  const cardNode = card(
    '时间轴',
    '共用横轴：周期（各时钟域独立计数）。行头可拖拽排序；Ctrl/⌘ + 滚轮缩放',
  );
  cardNode.body.append(buildStats(domains, scan, trace));
  cardNode.body.append(buildControls(ctx, plot, span));
  cardNode.body.append(
    legend([
      { label: '完成（O）', color: colorFor('pip') },
      { label: '冲刷（X，空心斜纹）', color: COLOR.abort },
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

  installWheelZoom(scroll);
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
  row.append(
    el('span', {
      class: 'muted nowrap',
      text: `当前 1 周期 ≈ ${plot.pxPerCycle.toFixed(2)} px · ${countLabel(span)} 周期 · 画布 ${countLabel(Math.round(plot.width))} px`,
    }),
  );
  return row;
}

/** 时间轴只讲周期，不换算真实时间 */
function cycleLabel(cycle: number): string {
  return cycle <= 0 ? '时钟之前（周期 0）' : `周期 ${cycle}`;
}

function axisGutterCell(plot: Plot): HTMLElement {
  return el(
    'div',
    {
      style:
        'height:' +
        AXIS_H +
        'px;display:flex;align-items:center;justify-content:space-between;gap:6px;padding:0 8px;border-bottom:1px solid var(--border-strong)',
    },
    [el('span', { style: 'font-size:11px;font-weight:600', text: '周期' }), restoreButton()],
  );
}

/**
 * 波形图左上角的 "+"：把右键隐藏掉的行重新显示出来。
 * 有隐藏行时按钮上带数量，一眼能看出"图里少了东西"。
 */
function restoreButton(): HTMLElement {
  const count = hiddenRows.size;
  const node = el('button', {
    class: `tl-restore${count > 0 ? ' is-active' : ''}`,
    type: 'button',
    text: count > 0 ? `+ ${count}` : '+',
    title: count > 0 ? `${count} 行已隐藏，点击恢复` : '没有被隐藏的行',
  });
  node.addEventListener('click', (event) => {
    const me = event as MouseEvent;
    me.stopPropagation();
    const items: MenuItem[] =
      count === 0
        ? []
        : [...hiddenRows].map((key) => {
            const row = allRows.find((lane) => lane.key === key);
            return {
              label: row ? `${row.label} · ${GROUP_NAME[row.group]}` : key,
              checked: false,
              pick: () => {
                hiddenRows.delete(key);
                rerenderTimeline();
              },
            };
          });
    const sections: MenuSection[] = [{ title: count > 0 ? '已隐藏的行' : '没有被隐藏的行', items }];
    if (count > 1) {
      sections.push({
        title: '',
        items: [
          {
            label: '全部显示',
            checked: false,
            pick: () => {
              hiddenRows = new Set();
              rerenderTimeline();
            },
          },
        ],
      });
    }
    openRowMenu(me.clientX, me.clientY, sections);
  });
  return node;
}

function gutterCell(row: LaneRow, h: number, ctx: ViewContext): HTMLElement {
  const node = el(
    'div',
    {
      class: 'tl-gutter-cell',
      draggable: 'true',
      title: '拖动可调整行顺序',
      style: `height:${h}px;margin-bottom:${ROW_GAP}px;display:flex;align-items:center;gap:6px;padding:0 10px;border-radius:6px;overflow:hidden;min-width:0;cursor:grab;background:${GROUP_TINT[row.group]};${row.select ? 'cursor:pointer' : ''}`,
    },
    [
      el('span', { class: 'tl-drag-handle', text: '⠿' }),
      el('i', { style: `flex:0 0 auto;width:8px;height:8px;border-radius:2px;background:${row.color}` }),
      el('span', {
        class: 'mono',
        style: 'flex:0 1 auto;min-width:0;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
        text: row.label,
      }),
    ],
  );
  node.addEventListener('mousedown', (event) => {
    const me = event as MouseEvent;
    if (me.button !== 0) return; // 右键交给菜单
    if (me.shiftKey) {
      selectRow(row, 'range');
      me.preventDefault();
      return;
    }
    if (me.ctrlKey || me.metaKey) {
      selectRow(row, 'toggle');
      me.preventDefault();
    }
    // 普通左键按下时**不动选中**：按下之后可能是"点击"（见下面的 click），
    // 也可能是"拖拽"（拖拽不会触发 click）。先保留整批，才拖得动一整块。
  });
  node.addEventListener('click', (event) => {
    const me = event as MouseEvent;
    if (me.shiftKey || me.ctrlKey || me.metaKey) return; // 修饰键手势在 mousedown 里处理过了
    // 纯点击（拖拽不会走到这里）：选中收窄到点中的这一行
    selectRow(row, 'only');
    if (row.select) ctx.selection.set(row.select ?? null);
  });
  if (row.hover) {
    const sel = row.hover;
    node.addEventListener('mouseenter', () => ctx.selection.hover(sel));
    node.addEventListener('mouseleave', () => ctx.selection.hover(null));
  }
  installRowDrag(node, row);
  installRowMenu(node, row);
  return node;
}

/** 行头拖拽排序：拖到目标行的上半 → 插到它前面，下半 → 插到它后面 */
/** 正在拖的行键（整批拖动时是多个） */
let draggingKey: string[] | null = null;

function installRowDrag(node: HTMLElement, row: LaneRow): void {
  /**
   * 拖动之后浏览器**可能**补一个 click（原生拖放通常会抑制它，但合成事件、
   * 不同浏览器不一定）。补一个开关把这次 click 吃掉 —— 否则拖完一整块会立刻
   * 被"点击收窄"打回一行，批量拖拽就废了。每次按下重新放行。
   */
  let swallowNextClick = false;
  node.addEventListener('mousedown', () => {
    swallowNextClick = false;
  });
  node.addEventListener('click', (event) => {
    if (!swallowNextClick) return;
    swallowNextClick = false;
    event.stopImmediatePropagation();
  }, true);
  const clearMarks = (): void => {
    document.querySelectorAll('.tl-drop-before, .tl-drop-after').forEach((n) => n.classList.remove('tl-drop-before', 'tl-drop-after'));
  };
  node.addEventListener('dragstart', (event) => {
    swallowNextClick = true;
    // 拖的是选中行 → 整批一起搬；拖没选中的行 → 选中收窄到它，只搬它自己
    if (!selectedRows.has(row.key)) selectRow(row, 'only');
    draggingKey = selectedRows.size > 1 ? [...selectedRows] : [row.key];
    node.classList.add('tl-dragging');
    event.dataTransfer?.setData('text/plain', row.key);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  });
  node.addEventListener('dragend', () => {
    draggingKey = null;
    node.classList.remove('tl-dragging');
    clearMarks();
  });
  node.addEventListener('dragover', (event) => {
    if (draggingKey === null || draggingKey.includes(row.key)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const box = node.getBoundingClientRect();
    const after = event.clientY > box.top + box.height / 2;
    for (const other of document.querySelectorAll('.tl-drop-before, .tl-drop-after')) {
      if (other !== node) other.classList.remove('tl-drop-before', 'tl-drop-after');
    }
    node.classList.toggle('tl-drop-after', after);
    node.classList.toggle('tl-drop-before', !after);
  });
  node.addEventListener('dragleave', () => node.classList.remove('tl-drop-before', 'tl-drop-after'));
  node.addEventListener('drop', (event) => {
    event.preventDefault();
    const box = node.getBoundingClientRect();
    const after = event.clientY > box.top + box.height / 2;
    const dragged = draggingKey;
    clearMarks();
    node.classList.remove('tl-dragging');
    draggingKey = null;
    if (dragged !== null) reorderRows(dragged, row.key, after);
  });
}

// ------------------------------------------------------------------ 轴 / 网格 / defs

function axisLayer(svg: SVGSVGElement, plot: Plot, primary: DomainInfo, ctx: ViewContext): void {
  const g = svgEl('g', {});
  g.append(svgEl('rect', { x: plot.x0, y: 0, width: plot.x1 - plot.x0, height: AXIS_H, fill: 'var(--surface-2)', 'fill-opacity': 0.55 }));
  // 时间轴只标周期数：不显示真实时间（各域周期号本来就不同刻度，换成 ns 更容易误读）
  for (const t of axisTicks(plot.from, plot.to, tickCount(plot))) {
    const x = plot.scale(t);
    g.append(svgEl('line', { x1: x, x2: x, y1: AXIS_H - 5, y2: AXIS_H, stroke: 'var(--border-strong)' }));
    g.append(svgEl('text', { x, y: 15, class: 'axis-label', 'text-anchor': 'middle', text: String(t) }));
  }
  g.append(svgEl('line', { x1: plot.x0, x2: plot.x1, y1: AXIS_H - 0.5, y2: AXIS_H - 0.5, stroke: 'var(--border-strong)' }));
  g.append(
    svgEl('text', {
      x: plot.x0 + 4,
      y: 15,
      class: 'axis-label axis-title',
      'text-anchor': 'start',
      text: '周期',
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
      cycleLabel(probe.cycle),
      `横轴范围 ${countLabel(plot.from)} – ${countLabel(plot.to)} · 当前 ${plot.pxPerCycle.toFixed(2)} px/周期`,
      '点击：广播该周期（其它视图会跟着定位）',
      'Ctrl/⌘ + 滚轮：以指针处为中心缩放',
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

/**
 * 斜纹：用于「冲刷（X）」条目。
 * 冲刷条目本身不填充（空心），所以斜纹必须是冲刷色 —— 原来那条白色斜纹
 * 是画在实色底上的提亮线，白底上看不见。
 */
function buildDefs(): SVGDefsElement {
  const defs = svgEl('defs', {});
  defs.append(
    svgEl('pattern', { id: 'tl-stripe', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, [
      svgEl('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: COLOR.abort, 'stroke-width': 1.6, 'stroke-opacity': 0.85 }),
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
): LaneRow[] {
  const rows: LaneRow[] = [];

  for (const d of domains) rows.push(clockLane(d, ctx, scan));

  // 状态机：紧跟时钟之后 —— 它讲的是"这一拍这台机器在哪个状态"
  for (const fsm of trace.fsms.values()) {
    if (visible(fsm.domain)) rows.push(fsmLane(fsm, ctx));
  }

  for (const track of trace.tracks.values()) {
    if (visible(track.domain)) rows.push(pipLane(track, ctx));
  }

  // 计数器：累计值是普通数值序列（默认折线），与数值行共用一套画法
  for (const track of trace.counters.values()) {
    if (visible(track.domain)) rows.push(counterLane(track, ctx));
  }

  // 数值：保持型阶梯（采样后一直保持到下一条），变化点单独标出来
  for (const track of trace.values.values()) {
    if (visible(track.domain)) rows.push(valueLane(track, ctx));
  }

  // 事件：evt 轨 + msg + （合并进来的）其它类型的异步记录 —— 不再单独占一节
  for (const track of trace.events.values()) {
    if (visible(track.domain)) rows.push(eventLane(track.name, track.domain, track.key, track.samples, ctx));
  }
  const messages = trace.messages.filter((m) => visible(m.pos.domain));
  if (messages.length > 0) rows.push(messageLane(messages, ctx));
  const otherAsync = scan.asyncRecords.filter((r) => r.kind !== 'evt' && visible(r.pos.domain));
  if (otherAsync.length > 0) rows.push(asyncLane(otherAsync, ctx));

  allRows = rows;
  return applyRowOrder(rows.filter((row) => !hiddenRows.has(row.key)));
}

/** 用户拖拽后的行顺序：未出现在顺序表里的行按默认顺序排在后面 */
function applyRowOrder(rows: LaneRow[]): LaneRow[] {
  if (rowOrder.length === 0) return rows;
  const rank = new Map(rowOrder.map((key, index) => [key, index]));
  return [...rows].sort((a, b) => (rank.get(a.key) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.key) ?? Number.MAX_SAFE_INTEGER));
}

/** 重画时间轴（拖拽排序后调用；顺序存在 rowOrder 里，刷新视图也不会丢） */
function rerenderTimeline(): void {
  const host = hostEl;
  const ctx = ctxRef;
  if (!host || !ctx) return;
  host.replaceChildren();
  build(host, ctx);
  if (registry !== null && registry.lanes.length > 0) applyState();
}

/** 拖拽结束：把被拖的行插到目标行的前/后，并记住顺序 */
/**
 * 把 `movingKeys` 整块搬到 `targetKey` 前/后，块内保持原相对顺序。
 * 拖动选中的行时整批一起走（批量选中的意义就在这里）。
 */
function reorderRows(movingKeys: string[], targetKey: string, after: boolean): void {
  if (!ctxRef) return;
  const current = rowOrder.length > 0 ? [...rowOrder] : registry?.lanes.map((lane) => lane.key) ?? [];
  const moving = movingKeys.filter((key) => key !== targetKey && current.includes(key));
  if (moving.length === 0) return;
  const rest = current.filter((key) => !moving.includes(key));
  const targetIndex = rest.indexOf(targetKey);
  if (targetIndex < 0) return;
  rest.splice(after ? targetIndex + 1 : targetIndex, 0, ...moving);
  rowOrder = rest;
  rerenderTimeline();
}

// ------------------------------ 时钟

function clockLane(d: DomainInfo, ctx: ViewContext, scan: Scan): LaneRow {
  const edges: DomainEdges =
    scan.edges.get(d.name) ?? { p: [], n: [], pSet: new Set(), nSet: new Set(), lo: d.firstCycle, hi: d.lastCycle, hasClk: false, synthN: false };
  const period = d.periodNs !== undefined ? `${d.periodNs} ns/周期` : d.freqHz !== undefined ? `${fmtCompact(d.freqHz)}Hz` : '未声明 period/freq';
  return {
    kind: 'lane',
    key: `clk:${d.name}`,
    group: 'clock',
    domain: d.name,
    label: d.name,
    color: colorFor(d.name),
    height: H.clk,
    hover: { kind: 'cycle', domain: d.name, cycle: Math.max(1, d.firstCycle) },
    draw(g, reg, y, h) {
      const hit = laneCanvas(g, reg, y, h);
      const high = y + 4;
      const low = y + h - 4;
      g.append(svgEl('path', { d: clockPoints(edges, reg.plot, high, low), fill: 'none', stroke: clockColor(d.name), 'stroke-width': 1.4, 'stroke-linecap': 'square' }));
      if (!edges.hasClk) g.append(svgEl('text', { x: reg.plot.x0 + 6, y: y + h - 8, class: 'axis-label', text: `域 ${d.name} 没有 [clk] 记录` }));
      cycleSurface(hit, reg, d.name, ctx, (probe) => {
        const c = probe.cycle;
        const level = levelAt(edges, c, probe.half);
        const marks = [edges.pSet.has(c) ? 'p（上升）' : null, edges.nSet.has(c) ? 'n（下降）' : null].filter((v) => v !== null);
        return [
          `时钟域 ${d.name}（${d.declared ? '@domain 声明' : '隐式建立'}）`,
          cycleLabel(c),
          `相位 ${probe.half === 0 ? 'p（上升沿之后）' : 'n（下降沿之后）'} · ${level ? '高电平' : '低电平'}`,
          `周期参数：${period}`,
          `本周期沿：${marks.length > 0 ? marks.join(' + ') : '（无）'}`,
          ...(edges.synthN ? ['下降沿：文件里只写了 [clk] p，按相位模型补在周期中点'] : []),
          `该域记录周期 ${d.firstCycle} – ${d.lastCycle} · 共 ${countLabel(d.cycles)} 周期`,
        ].join('\n');
      });
    },
  };
}

/** 方波折线：p 沿占前半格、n 沿占后半格（只有 p 记录的域，n 沿由扫描阶段按周期中点补出） */
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

/**
 * 状态机：每个状态驻留段画成**六边形**（与流水线条目、数值块同一套形状语言），
 * 两端切角正好落在状态切换处 —— 于是"这一拍是什么状态、哪一拍换的"一条泳道看完。
 * 每台状态机一条泳道（`[fsm] "名字", 状态` 的名字）。
 */
function fsmLane(fsm: FsmTrack, ctx: ViewContext): LaneRow {
  const segments = stateSegments(fsm);
  return {
    kind: 'lane',
    group: 'fsm',
    key: `fsm:${fsm.key}`,
    domain: fsm.domain,
    label: fsm.name,
    color: COLOR.neutral,
    height: H.fsm,
    select: { kind: 'fsm', key: fsm.key },
    hover: { kind: 'fsm', key: fsm.key },
    draw(g, reg, y, h) {
      const hit = laneCanvas(g, reg, y, h);
      cycleSurface(hit, reg, fsm.domain, ctx, (probe) => {
        const at = segments.find((s) => probe.cycle >= s.start && probe.cycle <= s.end);
        return [
          `状态机 ${fsm.name}（域 ${fsm.domain}）`,
          cycleLabel(probe.cycle),
          at ? `该周期状态：${at.state}（区段 ${at.start} – ${at.end}）` : '该周期没有状态记录',
          `状态集 {${fsm.stateSet.join(', ')}} · 转换 ${fsm.transitions.length} 次 · 采样 ${fsm.samples.length} 条`,
        ].join('\n');
      });
      const last = segments[segments.length - 1];
      let drawn = 0;
      // 最后一段的状态会一直保持到轨迹结束（`fsm` 与 `val` 同为保持型），所以画到该域末尾；
      // 但它只到"最后一次上报"为止是确定的，之后纯属推断，所以照 §9.5 用开放样式区分。
      const domainEnd = Math.min(reg.plot.to, ctx.trace.domains.get(fsm.domain)?.lastCycle ?? reg.plot.to);
      const openEnd = domainEnd + 1;
      for (const seg of segments) {
        if (drawn >= MAX_ITEMS) break;
        // 区段是半开区间 [start, 下一采样)；最后一段延伸到轨迹末尾
        const segEnd = seg === last ? Math.max(seg.end + 1, openEnd) : seg.end;
        const from = Math.max(seg.start, reg.plot.from);
        const to = Math.min(segEnd, reg.plot.to + 1);
        if (to <= from) continue;
        const left = reg.plot.scale(from);
        const right = Math.max(left + 1.5, reg.plot.scale(to));
        const color = colorFor(seg.state);
        const open = seg.open === true;
        const alpha = BLOCK_FILL;
        const shape = svgEl('path', {
          d: hexPath(left + 0.5, right - 0.5, y + 4, y + h - 5, 5),
          fill: color,
          'fill-opacity': alpha,
          stroke: color,
          'stroke-width': 1.1,
          'stroke-linejoin': 'round',
          ...(open ? { 'stroke-dasharray': '3 2' } : {}),
        });
        const dwell = fsm.dwellCycles.get(seg.state) ?? 0;
        hoverTarget(
          shape,
          () =>
            [
              `状态机 ${fsm.name}（域 ${fsm.domain}）`,
              `状态 ${seg.state}`,
              open
                ? `周期 ${seg.start} → ${domainEnd}（一直保持到轨迹末尾）`
                : `周期 ${seg.start} → ${segEnd}（跨 ${segEnd - seg.start} 周期）`,
              `该状态驻留合计 ${countLabel(dwell)} 周期`,
              `转换 ${fsm.transitions.length} 次 · 状态集 {${fsm.stateSet.join(', ')}}`,
              open
                ? `最后一段：最后一次上报在第 ${seg.start} 周期，之后没有记录 —— 画到轨迹末尾是因为状态保持，` +
                  '但"之后还保持了多久"不可确定（spec §9.5），所以画成浅色虚线的开放段'
                : '',
            ]
              .filter((line) => line !== '')
              .join('\n'),
          () => ctx.selection.set({ kind: 'fsm', key: fsm.key }),
        );
        g.append(shape);
        const width = right - left;
        if (width >= 26) {
          g.append(
            svgEl('text', {
              x: (left + right) / 2,
              y: y + h / 2 + 3.6,
              'text-anchor': 'middle',
              style: `font-size:10px;font-weight:600;pointer-events:none;fill:${inkOn(color, alpha)}`,
              text: clip(seg.state, width - 6),
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
    group: 'pipeline',
    domain: track.domain,
    label: track.name,
    color: colorFor(track.name),
    height: H.pip,
    hover: { kind: 'cycle', domain: track.domain, cycle: Math.max(1, track.firstCycle) },
    menu: pipelineMenu(track),
    draw(g, reg, y, h) {
      const hit = laneCanvas(g, reg, y, h);
      // 条目按**取值**着色，而不是按行：同一条指令在 IF/ID/EX/MEM/WB 里是同一个颜色，
      // 一眼就能顺着颜色把一条指令跟到写回。没有标记的条目退回轨道色。
      const laneColor = colorFor(track.name);
      const colorOfItem = (item: { tag: ScalarValue | null }): string => (item.tag === null ? laneColor : colorFor(numericKey(item.tag)));
      let tagsDrawn = 0;
      // 沿用/推断画面的上界：该域自己的末周期。域此后再无记录，画出去就是编造数据
      const domainEnd = Math.min(reg.plot.to, ctx.trace.domains.get(track.domain)?.lastCycle ?? reg.plot.to);
      cycleSurface(hit, reg, track.domain, ctx, (probe) =>
        [
          `轨道 ${track.name}（域 ${track.domain}）`,
          cycleLabel(probe.cycle),
          `本周期占用 ${track.occupancy.get(probe.cycle) ?? 0} · 到达 ${track.arrivals.get(probe.cycle) ?? 0} · 离开 ${track.departures.get(probe.cycle) ?? 0}`,
          `${track.items.length} 条目 · ${track.completed} 完成 · ${track.aborted} 冲刷 · ${track.open} 未闭合`,
        ].join('\n'),
      );

      // 气泡：该级本周期没有内容 —— 用虚线框标出来
      // 与条目同一种形状（六边形），只是空心虚线：一眼能看出这是「占位/无内容」
      const bubble = (start: number, end: number, inferred: boolean): void => {
        const left = clamp(reg.plot.scale(start), reg.plot.x0, reg.plot.x1);
        const right = clamp(reg.plot.scale(end + 1), reg.plot.x0, reg.plot.x1);
        const width = Math.max(3, right - left);
        const box = svgEl('path', {
          d: hexPath(left + 0.5, left + 0.5 + Math.max(2, width - 1), y + 4, y + h - 5, 4),
          fill: COLOR.bubble,
          'fill-opacity': 0.08,
          stroke: COLOR.bubble,
          'stroke-width': 1,
          // 推断段与实测段靠虚线疏密区分（推断的更疏）：靠降低不透明度区分太弱，
          // 那样"延续到末尾"就只剩个影子，等于没画
          'stroke-dasharray': inferred ? '2 5' : '4 3',
          'stroke-linejoin': 'round',
        });
        hoverTarget(
          box,
          () =>
            [
              `气泡：${track.name}`,
              `周期 ${start}${end > start ? ` – ${end}` : ''}（共 ${end - start + 1} 周期）`,
              inferred
                ? `推断：第 ${track.lastCycle} 周期之后该轨道没有记录，而域 ${track.domain} 还在记录 —— 沿用"无内容"直到轨迹末尾`
                : '这些周期该轨道没有在飞内容',
            ].join('\n'),
          () => ctx.selection.set({ kind: 'cycle', domain: track.domain, cycle: start }),
        );
        g.append(box);
      };
      for (const range of track.bubbleRanges) bubble(range.start, range.end, false);
      // 推断的气泡尾巴：末尾已知"无内容"，且该域仍在继续（写到域自己的末周期为止，
      // 再往后这个域根本没有记录，画出去就是编造）
      const tailFrom = track.lastCycle + 1;
      if ((track.occupancy.get(track.lastCycle) ?? 0) === 0 && tailFrom <= domainEnd) bubble(tailFrom, domainEnd, true);

      const barH = h - 9;
      const barY = y + 4;
      for (const item of shown) {
        const color = colorOfItem(item);
        const open = item.closed === null;
        const aborted = item.closed === 'X';
        const enterX = reg.plot.scale(item.enter.cycle + phaseOffset(item.enter, item.async));
        // 同域用关闭周期作锚点；跨域锚点在 enter 域上（spec §9.4），不再叠加出记录的相位；
        // 未闭合只画到轨道末周期，**不伪造**退出周期
        const anchor = item.closeAnchorCycle;
        // 未闭合条目：内容一直在飞，画到该域末尾（不伪造退出周期，只是把已知状态延续下去）。
        // 这里用的是**半开**末端（与 anchor 同一口径）：要覆盖到第 domainEnd 周期，末端就得是 domainEnd + 1
        const endCycle = open || anchor === null ? domainEnd + 1 : anchor;
        const endShift = open || anchor === null || item.crossDomain ? 0 : phaseOffset(item.exit ?? item.abort ?? item.enter, item.closeAsync);
        const right = Math.max(reg.plot.x0 + 1, Math.min(reg.plot.scale(endCycle + endShift), reg.plot.x1));
        const x = clamp(enterX, reg.plot.x0, reg.plot.x1 - 1);
        const w = Math.max(1.5, right - x);
        reg.itemBoxes.set(`${track.name}\u0000${item.enterSeq}`, { x, y: barY, w, h: barH });

        // 每个条目画成六边形（不再用圆角矩形）：两端切角处就是它与相邻条目的数值分界。
        // 冲刷（X）条目不填充：靠「空心 + 斜纹 + 虚线框」表达，虚线框与空泡同一套画法，
        // 于是"这个周期没有内容"和"有内容但被冲掉"一眼能分开，又不会误认成实心条目。
        const hollow = item.orphan || aborted;
        const rect = svgEl('path', {
          d: hexPath(x, x + w, barY, barY + barH, 4),
          ...(item.orphan
            ? { fill: 'var(--surface)' }
            : aborted
              ? { fill: 'none' }
              : { fill: color, 'fill-opacity': BLOCK_FILL }),
          stroke: item.orphan ? COLOR.orphan : aborted ? COLOR.abort : color,
          'stroke-width': aborted ? 1 : 1.2,
          'stroke-linejoin': 'round',
          ...(open || aborted ? { 'stroke-dasharray': '4 3' } : {}),
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
          g.append(svgEl('path', { d: hexPath(x, x + w, barY, barY + barH, 4), fill: 'url(#tl-stripe)', 'pointer-events': 'none' }));
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
        if (w >= 30 && tagsDrawn < TAG_BUDGET && item.tag) {
          tagsDrawn++;
          g.append(
            svgEl('text', {
              x: x + 3,
              y: y + h - 11,
              style: `font-size:10px;font-weight:600;fill:${inkOn(hollow ? null : color, hollow ? 1 : BLOCK_FILL)};pointer-events:none`,
              text: clip(formatScalarBy(item.tag, valueFormatOf(`pip:${track.name}`)), w - 6),
            }),
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
  const lines = [
    `轨道 ${track.name}（域 ${track.domain}）`,
    `标记 ${item.tag ? formatScalarBy(item.tag, valueFormatOf(`pip:${track.name}`)) : '（无）'}`,
  ];
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
  if (open) lines.push(`未闭合：内容仍在飞，画到该域末尾（第 ${track.lastCycle} 周期之后没有记录，不伪造退出周期）`);
  lines.push(`跨域 ${item.crossDomain ? '是' : '否'} · 入 seq ${item.enterSeq}${item.closeSeq !== null ? ` · 出 seq ${item.closeSeq}` : ''}`);
  return lines.join('\n');
}

// ------------------------------ 占用度


// ------------------------------ 计数器


// ------------------------------ 数值

/** 数值轨里能画成折线的取样：int/bits（无 x/z）与 real */
function numericOf(value: ScalarValue): number | null {
  if (value.kind === 'real') return value.num ?? null;
  if ((value.kind === 'int' || value.kind === 'bits') && value.big !== undefined) return Number(value.big);
  return null;
}

/** 采样序列泳道的差异点：几何画法共用，取数与提示各管各的 */
interface SeriesConfig {
  /** 行键（也是隐藏/记忆用的键，如 `val:core.ipc` / `cnt:core.retired`） */
  key: string;
  name: string;
  domain: string;
  group: LaneGroup;
  color: string;
  height: number;
  hover: Selection;
  /** 有数值的采样点（按文件顺序） */
  points: { pos: Position; async: boolean; value: ScalarValue; numeric: number; unknown: boolean }[];
  /** 没有数值时的"变化点"（字符串/符号轨） */
  marks: { pos: Position; async: boolean }[];
  defaultMode: ValueMode;
  /** 是否提供 rv32/rv64（计数器这类非指令流不给） */
  allowRv: boolean;
  tip: (cycle: number, format: ValueFormat) => string;
}

/**
 * 一条"采样序列"泳道：数值轨与计数器轨共用。
 * 三种显示模式（六边形块 / 折线 / 保持型阶梯）的画法只写在这里一份。
 */
function seriesLane(cfg: SeriesConfig, ctx: ViewContext): LaneRow {
  const format = valueFormatOf(cfg.key);
  const mode = valueModeOf(cfg.key, cfg.defaultMode);
  return {
    kind: 'lane',
    group: cfg.group,
    key: cfg.key,
    domain: cfg.domain,
    label: cfg.name,
    color: cfg.color,
    height: cfg.height,
    hover: cfg.hover,
    menu: {
      formatKey: cfg.key,
      formatWidth: widthOf(cfg.points.map((point) => point.value)),
      modeKey: cfg.key,
      defaultMode: cfg.defaultMode,
      allowRv: cfg.allowRv,
    },
    draw(g, reg, y, h) {
      const hit = laneCanvas(g, reg, y, h);
      const pad = 7;
      const top = y + pad;
      const bottom = y + h - pad;
      const numeric = cfg.points;
      const values = numeric.map((entry) => entry.numeric);
      const min = values.length > 0 ? Math.min(...values) : 0;
      const max = values.length > 0 ? Math.max(...values) : 1;
      const yOf = (value: number): number => (max === min ? (top + bottom) / 2 : bottom - ((value - min) / (max - min)) * (bottom - top));
      const xOf = (pos: Position, isAsync: boolean): number => clamp(reg.plot.scale(pos.cycle + phaseOffset(pos, isAsync)), reg.plot.x0, reg.plot.x1);

      if (numeric.length > 0) {
        const first = numeric[0]!;
        const last = numeric[numeric.length - 1]!;
        const firstX = xOf(first.pos, first.async);
        const lastX = xOf(last.pos, last.async);
        const points = numeric.map((entry) => [xOf(entry.pos, entry.async), yOf(entry.numeric)] as [number, number]);
        if (mode === 'blocks') {
          // 六边形块：每个采样到下一个采样之间一段，块里直接写出格式化后的值
          const blockH = clamp(h - 14, 12, 24);
          const segments: { left: number; right: number; value: ScalarValue; numeric: number; unknown: boolean; faint: boolean }[] = [];
          if (firstX > reg.plot.x0 + 0.5) {
            segments.push({ left: reg.plot.x0, right: firstX, value: first.value, numeric: first.numeric, unknown: first.unknown, faint: true });
          }
          // 连续同值的采样并成一段：中间没有变化，不该画出一条接缝（spec §9.3 的同值口径）
          for (const run of equalRuns(numeric)) {
            const entry = numeric[run.from]!;
            const next = numeric[run.to + 1];
            segments.push({
              left: xOf(entry.pos, entry.async),
              right: next ? xOf(next.pos, next.async) : reg.plot.x1,
              value: entry.value,
              numeric: entry.numeric,
              unknown: entry.unknown,
              faint: false,
            });
          }
          for (const segment of segments) {
            const left = clamp(segment.left, reg.plot.x0, reg.plot.x1);
            const right = clamp(segment.right, reg.plot.x0, reg.plot.x1);
            if (right - left < 1) continue;
            // 六边形块只管"这一段是这个值"，不承担数值高低的表达：一律竖直居中，
            // 否则同一行里块会随数值上下跳，反而不利于对比相邻的取值
            const centerY = (top + bottom) / 2;
            g.append(
              svgEl('path', {
                d: hexPath(left, right, centerY - blockH / 2, centerY + blockH / 2, 5),
                fill: segment.unknown ? 'var(--surface)' : cfg.color,
                'fill-opacity': segment.faint ? 0.15 : segment.unknown ? 1 : BLOCK_FILL,
                stroke: cfg.color,
                'stroke-width': 1.1,
                'stroke-linejoin': 'round',
                ...(segment.unknown ? { 'stroke-dasharray': '2 1.5' } : {}),
              }),
            );
            const width = right - left;
            if (width >= 34) {
              g.append(
                svgEl('text', {
                  x: (left + right) / 2,
                  y: centerY + 3.6,
                  'text-anchor': 'middle',
                  style: `font-size:10px;font-weight:600;pointer-events:none;fill:${inkOn(segment.unknown ? null : cfg.color, segment.unknown ? 1 : segment.faint ? 0.15 : BLOCK_FILL)}`,
                  text: clip(formatScalarBy(segment.value, format), width - 8),
                }),
              );
            }
          }
        } else if (mode === 'line') {
          // 折线：直接连采样点（两端各补到画布边界，线不断开），适合看趋势
          const polyline: [number, number][] = [[reg.plot.x0, points[0]![1]], ...points, [reg.plot.x1, points[points.length - 1]![1]]];
          g.append(svgEl('path', { d: linePath(polyline), fill: 'none', stroke: cfg.color, 'stroke-width': 1.7, 'stroke-linejoin': 'round' }));
        } else {
          // 波形：保持型阶梯；首个采样之前用更淡的实线补出（推断段），最后一个采样之后保持到画布右边
          if (firstX > reg.plot.x0 + 0.5) {
            g.append(
              svgEl('path', {
                d: `M${reg.plot.x0},${yOf(first.numeric)}L${firstX},${yOf(first.numeric)}`,
                fill: 'none',
                stroke: cfg.color,
                'stroke-width': 1.7,
                'stroke-opacity': 0.45,
              }),
            );
          }
          if (lastX < reg.plot.x1 - 0.5) {
            g.append(
              svgEl('path', {
                d: `M${lastX},${yOf(last.numeric)}L${reg.plot.x1},${yOf(last.numeric)}`,
                fill: 'none',
                stroke: cfg.color,
                'stroke-width': 1.7,
              }),
            );
          }
          g.append(svgEl('path', { d: stepPath(points), fill: 'none', stroke: cfg.color, 'stroke-width': 1.7, 'stroke-linejoin': 'round' }));
        }
        // 采样点标记：块的边界本身就是采样位置，块里也写着值，所以六边形块模式不画点
        if (mode !== 'blocks') {
          for (const entry of numeric) {
            g.append(
              svgEl('circle', {
                cx: xOf(entry.pos, entry.async),
                cy: yOf(entry.numeric),
                r: entry.unknown ? 2.6 : 1.8,
                fill: entry.unknown ? 'var(--surface)' : cfg.color,
                stroke: cfg.color,
                'stroke-width': 1.1,
                ...(entry.unknown ? { 'stroke-dasharray': '2 1.5' } : {}),
              }),
            );
          }
        }
      } else {
        // 非数值（字符串/符号）：只标变化点，值写在提示里
        for (const change of cfg.marks) {
          const x = xOf(change.pos, change.async);
          g.append(svgEl('line', { x1: x, x2: x, y1: top, y2: bottom, stroke: cfg.color, 'stroke-width': 1.2, 'stroke-opacity': 0.6 }));
        }
        g.append(svgEl('text', { x: reg.plot.x0 + 6, y: y + h - 8, class: 'axis-label', text: '非数值轨：只标变化点' }));
      }

      cycleSurface(hit, reg, cfg.domain, ctx, (probe) => cfg.tip(probe.cycle, format));
    },
  };
}

/** 数值轨：保持型采样序列，默认按六边形块画（每段一个值） */
function valueLane(track: ValueTrack, ctx: ViewContext): LaneRow {
  const shown = track.samples.length > MAX_MARKS ? track.samples.filter((_, index) => index % Math.ceil(track.samples.length / MAX_MARKS) === 0) : track.samples;
  const points = shown
    .map((sample) => ({ sample, numeric: numericOf(sample.value) }))
    .filter((entry): entry is { sample: (typeof shown)[number]; numeric: number } => entry.numeric !== null)
    .map((entry) => ({
      pos: entry.sample.pos,
      async: entry.sample.async,
      value: entry.sample.value,
      numeric: entry.numeric,
      unknown: entry.sample.value.hasXZ === true,
    }));
  const range = points.map((point) => point.numeric);
  return seriesLane(
    {
      key: `val:${track.key}`,
      name: track.name,
      domain: track.domain,
      group: 'value',
      color: colorFor(track.key),
      height: H.value,
      hover: { kind: 'value', key: track.key },
      points,
      marks: shown,
      defaultMode: 'blocks',
      allowRv: true,
      tip: (cycle, format) => {
        const current = valueAt(track, cycle);
        const numericNow = current === null ? null : numericOf(current);
        return [
          `数值 ${track.name}（域 ${track.domain}）`,
          cycleLabel(cycle),
          `该周期末取值 ${current === null ? '（尚未采样）' : formatScalarBy(current, format)}`,
          numericNow === null || range.length === 0 ? '' : `区间 ${fmtCompact(Math.min(...range))} – ${fmtCompact(Math.max(...range))}`,
          `${track.samples.length} 次采样 · ${track.changes.length} 次变化`,
          current !== null && current.hasXZ === true ? '含未知位/高阻位（x/z）' : '',
        ]
          .filter((line) => line !== '')
          .join('\n');
      },
    },
    ctx,
  );
}

/** 计数器轨：累计值是一条普通数值序列，默认按折线画 */
function counterLane(track: CounterTrack, ctx: ViewContext): LaneRow {
  const shown = track.samples.length > MAX_MARKS ? track.samples.filter((_, index) => index % Math.ceil(track.samples.length / MAX_MARKS) === 0) : track.samples;
  const points = shown.map((sample) => ({
    pos: sample.pos,
    async: sample.async,
    value: intScalar(sample.total),
    numeric: sample.total,
    unknown: false,
  }));
  return seriesLane(
    {
      key: `cnt:${track.key}`,
      name: track.name,
      domain: track.domain,
      group: 'counter',
      color: colorFor(track.key),
      height: H.cnt,
      hover: { kind: 'counter', key: track.key },
      points,
      marks: [],
      defaultMode: 'line',
      allowRv: false,
      tip: (cycle, format) => {
        const total = counterTotalAt(track, cycle);
        const delta = track.deltaByCycle.get(cycle) ?? 0;
        return [
          `计数器 ${track.name}（域 ${track.domain}）`,
          cycleLabel(cycle),
          `该周期末累计 ${total === null ? '（尚未采样）' : formatScalarBy(intScalar(total), format)}`,
          `本周期增量 ${delta === 0 ? '0' : `${delta > 0 ? '+' : ''}${fmtInt(delta)}`}`,
          `${track.samples.length} 条记录 · 终值 ${fmtInt(track.total)}`,
        ].join('\n');
      },
    },
    ctx,
  );
}

/** 计数器这类整数 → ScalarValue：让 dec/hex/oct/bin 的格式选择同样生效 */
function intScalar(value: number): ScalarValue {
  const whole = Math.trunc(value);
  return { kind: 'int', text: String(whole), raw: String(whole), big: BigInt(whole) };
}

/** 每行数值的显示格式（dec/hex/oct/bin/rv32/rv64），按行记忆，默认 hex */
const valueFormats = new Map<string, ValueFormat>();

/** 数值行的显示模式：波形(保持型阶梯) / 折线 / 六边形块（像流水线那样每段一个块） */
type ValueMode = 'wave' | 'line' | 'blocks';

const VALUE_MODES: { id: ValueMode; label: string; glyph: string }[] = [
  { id: 'wave', label: '波形（保持型阶梯）', glyph: '⊓' },
  { id: 'line', label: '折线（直接连采样点）', glyph: '∿' },
  { id: 'blocks', label: '六边形块（每段一个值）', glyph: '⬡' },
];

const valueModes = new Map<string, ValueMode>();

/** 显示模式：用户选过就用用户的，否则用该行类型的默认（数值=六边形块、计数器=折线） */
function valueModeOf(key: string, fallback: ValueMode = 'wave'): ValueMode {
  return valueModes.get(key) ?? fallback;
}

/**
 * 着色用的键：**只看数值本身**。
 *
 * 不能用 `valueKey`（它把声明宽度也算进去）：`16'h9117` 与 `32'h9117` 是同一个
 * 数值、应该同色，按 valueKey 会分成两种颜色；也不能用格式化后的文本（换个进制
 * 颜色就变了）。所以位向量取十进制数值，其它类型取原文。
 */
function numericKey(value: ScalarValue): string {
  return value.big !== undefined && value.hasXZ !== true ? `n:${value.big}` : `t:${value.text}`;
}

/** 宽度估计：声明宽度 / 实际位数，按行取最大值 */
function widthOf(values: ScalarValue[]): number {
  return values.reduce((max, value) => {
    const declared = value.width ?? 0;
    const needed = value.big === undefined ? 0 : Math.max(1, value.big < 0n ? (-value.big).toString(2).length + 1 : value.big.toString(2).length);
    return Math.max(max, declared, needed);
  }, 0);
}

const isFormattable = (values: ScalarValue[]): boolean =>
  values.length > 0 && !values.every((value) => value.kind === 'str' || value.kind === 'sym');

/** 默认用 hex 显示：RTL 里绝大多数数值是位向量，十进制反而不便对照 */
function valueFormatOf(key: string): ValueFormat {
  return valueFormats.get(key) ?? 'hex';
}

function valueMenu(track: ValueTrack): LaneRow['menu'] {
  const values = track.samples.map((sample) => sample.value);
  const menu: NonNullable<LaneRow['menu']> = { modeKey: track.key };
  if (isFormattable(values)) {
    menu.formatKey = track.key;
    menu.formatWidth = widthOf(values);
  }
  return menu;
}

function pipelineMenu(track: TrackInfo): LaneRow['menu'] | undefined {
  const tags = track.items.map((item) => item.tag).filter((tag): tag is ScalarValue => tag !== null);
  if (!isFormattable(tags)) return undefined;
  return { formatKey: `pip:${track.name}`, formatWidth: widthOf(tags) };
}

// ------------------------------------------------------------------ 右键菜单

interface MenuItem {
  label: string;
  checked: boolean;
  pick: () => void;
}

interface MenuSection {
  title: string;
  items: MenuItem[];
}

let openMenuNode: HTMLElement | null = null;

function closeRowMenu(): void {
  openMenuNode?.remove();
  openMenuNode = null;
}

/** 在鼠标处弹出一个轻量菜单（单选式），点击条目立即生效并关闭 */
function openRowMenu(clientX: number, clientY: number, sections: MenuSection[]): void {
  closeRowMenu();
  if (sections.length === 0) return;
  const root = el('div', { class: 'ctx-menu', role: 'menu' });
  for (const section of sections) {
    root.append(el('div', { class: 'ctx-title', text: section.title }));
    for (const item of section.items) {
      const node = el('button', { class: `ctx-item${item.checked ? ' is-on' : ''}`, type: 'button', role: 'menuitemradio' }, [
        el('span', { class: 'ctx-tick', text: item.checked ? '✓' : '' }),
        el('span', { text: item.label }),
      ]);
      node.addEventListener('click', (event) => {
        event.stopPropagation();
        item.pick();
        closeRowMenu();
      });
      root.append(node);
    }
  }
  // 先挂上去再量真实尺寸：菜单高度取决于条目数（数值行有 9 项，接近 300px），
  // 用常量估算必然在靠下的行上把菜单顶出屏幕，底下的条目就点不到了
  root.style.visibility = 'hidden';
  root.style.left = '0px';
  root.style.top = '0px';
  document.body.append(root);
  const box = root.getBoundingClientRect();
  const gap = 8;
  const maxTop = window.innerHeight - box.height - gap;
  const maxLeft = window.innerWidth - box.width - gap;
  // 光标下方放不下就翻到上方；上下都放不下（菜单比视口还高）就贴顶并允许滚动
  const top =
    clientY + box.height <= window.innerHeight - gap ? clientY : clientY - box.height >= gap ? clientY - box.height : Math.max(gap, maxTop);
  root.style.left = `${clamp(clientX, gap, Math.max(gap, maxLeft))}px`;
  root.style.top = `${top}px`;
  root.style.maxHeight = `${Math.max(120, window.innerHeight - gap * 2)}px`;
  root.style.overflowY = 'auto';
  root.style.visibility = '';
  openMenuNode = root;
}

/**
 * 右键菜单。作用于 `menuTargets(row)`（通常是整批选中）：
 *  - 「显示格式」只给有格式的行（数值/计数器/流水线；时钟、事件行没有）
 *  - 「显示模式」只给有显示模式的行（数值/计数器）—— **时钟/事件/流水线这类
 *    不能改显示方式的行不会被批量操作改到**
 *  - 勾选状态按"作用范围内全部一致"才算选中，混合时不勾
 */
function menuSectionsFor(row: LaneRow): MenuSection[] {
  const sections: MenuSection[] = [];
  const targets = menuTargets(row);
  const batch = targets.length > 1;
  /** 选中多行时标出"这次会改到几行"，并在有行不适用时说明跳过了几行 */
  const scope = (applicable: number): string => {
    if (!batch) return '';
    const skipped = targets.length - applicable;
    return `（${applicable} 行${skipped > 0 ? `，跳过 ${skipped} 行不适用` : ''}）`;
  };

  const formats = targets.filter((target) => target.menu?.formatKey !== undefined);
  if (formats.length > 0) {
    const allowRv = formats.every((target) => target.menu?.allowRv !== false);
    const width = Math.min(...formats.map((target) => target.menu?.formatWidth ?? 32));
    const keys = formats.map((target) => target.menu!.formatKey!);
    sections.push({
      title: `显示格式${scope(formats.length)}`,
      items: VALUE_FORMATS.filter((item) => {
        if (item.id === 'rv32') return allowRv && width <= 32;
        if (item.id === 'rv64') return allowRv && width <= 64;
        return true;
      }).map((item) => ({
        label: item.label,
        checked: formats.every((target) => valueFormatOf(target.menu!.formatKey!) === item.id),
        pick: () => {
          for (const key of keys) valueFormats.set(key, item.id);
          rerenderTimeline();
        },
      })),
    });
  }

  const modes = targets.filter((target) => target.menu?.modeKey !== undefined);
  if (modes.length > 0) {
    const keys = modes.map((target) => target.menu!.modeKey!);
    sections.push({
      title: `显示模式${scope(modes.length)}`,
      items: VALUE_MODES.map((mode) => ({
        label: `${mode.glyph}  ${mode.label}`,
        checked: modes.every((target) => valueModeOf(target.menu!.modeKey!, target.menu!.defaultMode ?? 'wave') === mode.id),
        pick: () => {
          for (const key of keys) valueModes.set(key, mode.id);
          rerenderTimeline();
        },
      })),
    });
  }

  sections.push({
    title: '行',
    items: [
      {
        label: batch ? `隐藏这 ${targets.length} 行` : '隐藏此行',
        checked: false,
        pick: () => {
          for (const target of targets) hiddenRows.add(target.key);
          rerenderTimeline();
        },
      },
    ],
  });
  return sections;
}

/** 给行头与泳道都挂上右键菜单（在泳道上右键也能改） */
function installRowMenu(node: HTMLElement | SVGElement, row: LaneRow): void {
  node.addEventListener('contextmenu', (event) => {
    const me = event as MouseEvent;
    me.preventDefault();
    // 右键未选中的行 → 选择收窄到它；右键选中的行 → 菜单作用于整批
    if (!selectedRows.has(row.key)) selectRow(row, 'only');
    openRowMenu(me.clientX, me.clientY, menuSectionsFor(row));
  });
}

// 系统主题切换会换掉整套 CSS 变量：底色缓存作废，重画一次
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  backdrop = null;
  rerenderTimeline();
});
document.addEventListener('click', () => closeRowMenu());
// 菜单是 fixed 定位，画布滚动后位置就对不上那一行了；捕获阶段才能收到内层滚动容器的 scroll
window.addEventListener('scroll', () => closeRowMenu(), true);
document.addEventListener('keydown', (event) => {
  if ((event as KeyboardEvent).key === 'Escape') {
    closeRowMenu();
    // Esc 也顺手取消批量选中
    if (selectedRows.size > 0) {
      selectedRows = new Set();
      anchorKey = null;
      applyRowSelection();
    }
  }
});

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
    group: 'event',
    domain,
    label: name,
    color: colorFor(key),
    height: H.evt,
    hover: { kind: 'cycle', domain, cycle: samples.length > 0 ? samples[0]!.pos.cycle : 1 },
    draw(g, reg, y, h) {
      const hit = laneCanvas(g, reg, y, h);
      const plot = reg.plot;
      cycleSurface(hit, reg, domain, ctx, (probe) =>
        [
          `事件 ${name}（域 ${domain}）`,
          cycleLabel(probe.cycle),
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
    group: 'event',
    key: 'msg:all',
    domain: messages[0]!.pos.domain,
    label: '消息',
    color: COLOR.msg,
    height: H.evt,
    draw(g, reg, y, h) {
      const hit = laneCanvas(g, reg, y, h);
      const plot = reg.plot;
      cycleSurface(hit, reg, messages[0]!.pos.domain, ctx, (probe) => {
        const here = messages.filter((m) => m.pos.cycle === probe.cycle);
        return [
          `消息（${messages.length} 条）`,
          cycleLabel(probe.cycle),
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
    group: 'event',
    key: 'async:all',
    domain: records[0]!.pos.domain,
    label: '异步事件',
    color: COLOR.async,
    height: H.evt,
    draw(g, reg, y, h) {
      const hit = laneCanvas(g, reg, y, h);
      const plot = reg.plot;
      cycleSurface(hit, reg, records[0]!.pos.domain, ctx, (probe) => {
        const here = records.filter((r) => r.pos.cycle === probe.cycle);
        return [
          `异步记录（${records.length} 条）`,
          cycleLabel(probe.cycle),
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
  if (hoverSel === null) hideHoverCycle();
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
    label.textContent = `${sel.domain} · ${cycleLabel(sel.cycle)}`;
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

/**
 * 每周期像素：`fitWidth` = 适应宽度；`options.zoom > 0` = 用户显式选择；`0` = 自动铺满但至少 8px/周期。
 * 缩放本身不设上下限（滚轮/± 按钮可以一直放大缩小），只保留画布总宽的保险。
 */
function pixelScale(ctx: ViewContext, host: HTMLElement, span: number): number {
  // 重建时旧滚动容器已从文档摘掉（clientWidth = 0），此时用上一次量到的宽度或容器宽度估算
  const live = scrollEl?.isConnected ? scrollEl.clientWidth : chartAvail > 0 ? chartAvail : host.clientWidth;
  const avail = Math.max(200, live - GUTTER - SIDE * 2 - 2);
  const ceiling = MAX_PLOT_WIDTH / Math.max(1, span);
  const floor = MIN_PLOT_WIDTH / Math.max(1, span);
  // 「适应宽度」要正好铺满，所以不受手动缩放的像素上限约束
  if (fitWidth) return clamp(avail / span, floor, ceiling);
  const zoom = ctx.options.zoom;
  const explicit = Number.isFinite(zoom) && zoom > 0;
  return clamp(explicit ? zoom : Math.max(avail / span, PX_DEFAULT), floor, ceiling);
}

/** 清空并重画；「适应宽度」下首帧量宽不准时再补一帧，保证正好铺满 */
function paint(host: HTMLElement, ctx: ViewContext): void {
  const before = chartAvail;
  clear(host);
  build(host, ctx);
  if (fitWidth && Math.abs(chartAvail - before) > 1) {
    clear(host);
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

/**
 * Ctrl/⌘ + 滚轮：以指针所在周期为锚点缩放；普通滚轮保持浏览器原生滚动，
 * 免得横向拖动轨迹时被缩放打断。
 */
function installWheelZoom(scroll: HTMLElement): void {
  scroll.addEventListener(
    'wheel',
    (event) => {
      const wheel = event as WheelEvent;
      if (!wheel.ctrlKey && !wheel.metaKey) return;
      wheel.preventDefault();
      const reg = registry;
      const plot = reg?.plot;
      if (!reg || !plot) return;
      const box = reg.svg.getBoundingClientRect();
      const userX = box.width > 0 ? (wheel.clientX - box.left) * (plot.width / box.width) : plot.x0;
      const anchor = clamp(Math.round(plot.scale.invert(clamp(userX, plot.x0, plot.x1))), plot.from, plot.to);
      const next = plot.pxPerCycle * (wheel.deltaY < 0 ? 1.2 : 1 / 1.2);
      if (!Number.isFinite(next) || next <= 0 || Math.abs(next - plot.pxPerCycle) < 1e-6) return;
      fitWidth = false;
      ctxRef!.options.zoom = Number(next.toFixed(4));
      rebuild(false, anchor);
    },
    { passive: false },
  );
}

function rebuildAnchored(center: number | null): void {
  rebuild(false, center);
}

function stepZoom(factor: number): void {
  const ctx = ctxRef;
  if (!ctx) return;
  const current = registry?.plot.pxPerCycle ?? PX_DEFAULT;
  const next = current * factor;
  if (!Number.isFinite(next) || next <= 0 || Math.abs(next - current) < 1e-6) return;
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
    selectedRows = new Set();
    anchorKey = null;
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
