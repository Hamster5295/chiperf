/**
 * 状态机视图 —— 状态占用热力图、状态时序色带与跳转统计。
 *
 * 口径（spec §9.5）：状态是保持型的；`dwellCycles` = 相邻两条记录的周期差之和，
 * 色带区间是**半开**的 `[start, end)`，长度 = end − start。状态配色统一走 `colorFor(state)`，
 * 保证热力图与色带里同名同色。
 *
 * 标记区间：波形上最多两个同域标记围出一个**闭区间** `[from, to]`，本视图只统计"与这个区间
 * 相交"的数据（见 `buildScopes`）。没有标记、或状态机不在标记所在域时走**全量**口径 ——
 * 那时用的就是轨道上现成的 `dwellCycles` / `transitions` 本体，所以数字与加标记之前一致。
 */
import type { FsmTrack, Position } from '../../../parser/src/index.ts';
import { formatPosition, stateSegments } from '../../../parser/src/index.ts';
import {
  axisTicks,
  card,
  colorFor,
  countLabel,
  el,
  emptyState,
  heatColor,
  hoverTarget,
  legend,
  linearScale,
  statTile,
  svgEl,
  svgRoot,
  textColorOn,
} from '../charts.ts';
import { abortable, nextFrame, runChunked } from '../chunk.ts';
import type { MarkerRange } from '../markers.ts';
import { fmtInt, type Selection, type View, type ViewContext } from '../view.ts';

/** 选中态高亮：默认切 `is-selected` 类，SVG 元素可自定义 */
interface Highlight {
  node: Element;
  match: (selection: Selection) => boolean;
  apply?: (node: Element, active: boolean) => void;
}

interface FsmState {
  container: HTMLElement;
  ctx: ViewContext;
  highlights: Highlight[];
  unsubscribe: (() => void) | null;
  /** 标记订阅：标记被提交（打/拖/删）时重算区间统计 */
  unsubscribeMarkers: (() => void) | null;
  /** 当前这一轮重算的取消令牌：新一轮开始或卸载时取消上一轮，避免旧结果盖掉新结果 */
  token: { signal: AbortSignal; abort: () => void } | null;
  /** 统计内容挂在这里：算完之前保留上一轮的内容，不露出半算完的数据 */
  body: HTMLElement;
  /** 顶部那一行：统计范围说明 + "计算中…" */
  chips: HTMLElement;
  /** 当前被选中的状态机 key；为 null 时不淡化任何色带 */
  selectedKey: string | null;
}

let active: FsmState | null = null;

/** 每台状态机最多画这么多区段，避免超长轨迹把 DOM 撑爆 */
const MAX_SEGMENTS = 3000;

function visibleFsms(ctx: ViewContext): FsmTrack[] {
  return [...ctx.trace.fsms.values()];
}

/**
 * 全量口径的三个小工具：区间筛选时不用它们（那时候逐段裁剪现算），
 * 只用来在"没有标记 / 域不匹配"时**原样**取回轨道上的数字。
 */
function totalDwell(fsm: FsmTrack): number {
  let total = 0;
  for (const value of fsm.dwellCycles.values()) total += value;
  return total;
}

function selfLoops(fsm: FsmTrack): number {
  let count = 0;
  for (const transition of fsm.transitions) if (transition.selfLoop) count += 1;
  return count;
}

/** 该状态机驻留最多的状态（用于"峰值"与小标题） */
function peakState(fsm: FsmTrack): { state: string; dwell: number } | null {
  let best: { state: string; dwell: number } | null = null;
  for (const [state, dwell] of fsm.dwellCycles) {
    if (best === null || dwell > best.dwell) best = { state, dwell };
  }
  return best;
}

// ------------------------------------------------------------------ 统计范围（波形上的标记区间）

/** `stateSegments` 的元素：半开区间 `[start, end)` */
type BandSegment = { state: string; start: number; end: number; open: boolean };

/**
 * 一台状态机在**当前统计范围**下的数据 —— 视图只读这一份，不再直接摸
 * `fsm.dwellCycles` / `fsm.transitions`，"按区间统计"这件事因此只发生在一个地方。
 *
 * 全量口径（没有标记，或该状态机不在标记所在域）时，`dwell` / `transitions` 就是轨道上
 * 现成的 `dwellCycles` / `transitions` **本体**：没打标记时数字不变，靠的不是"算得准"，
 * 而是根本没换算法。
 */
interface FsmScope {
  fsm: FsmTrack;
  /**
   * 本台状态机实际生效的标记区间（闭）；`null` ⇒ 全量口径（没有标记，或它不在标记所在域）。
   * 一张卡片是"区间统计"还是"全量统计"就看这个字段，不再另立一个布尔量。
   */
  range: MarkerRange | null;
  /** 状态 → 区间内驻留周期数 */
  dwell: Map<string, number>;
  /** 区间内驻留周期数之和 */
  dwellTotal: number;
  /** 区间内驻留最多的状态 */
  peak: { state: string; dwell: number } | null;
  /** 区间内**发生**的跳转（跳转是瞬时事件，看它的周期落没落在区间里） */
  transitions: FsmTrack['transitions'];
  selfLoops: number;
  /** 区间内的状态记录条数 */
  samples: number;
  /** 画色带用的区段：已裁剪到区间（跨边界取相交部分，区间外的丢掉） */
  segments: BandSegment[];
}

/** 分片作业：一段连续编号的长活；`runChunked` 按编号切片，片间让出主线程 */
interface ChunkJob {
  count: number;
  run: (from: number, to: number) => void;
}

/**
 * 算出每台状态机在当前标记区间下的数据。
 *
 * 为什么分片：区间统计要逐段裁剪、逐条过滤，一台状态机几万条记录一次算完会把主线程占住
 * 好几帧（页面卡住、也没有任何反馈）。这里把三类可枚举的长活（状态段裁剪 / 跳转过滤 /
 * 记录计数）各切一片，片间让出一帧，`onProgress` 报整轮进度。
 *
 * 返回 null 表示中途被取消（视图卸载、或更新的一轮已经开始了）——调用方必须丢弃这一轮的产物。
 */
async function buildScopes(
  fsms: FsmTrack[],
  range: MarkerRange | null,
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void,
): Promise<FsmScope[] | null> {
  const scopes: FsmScope[] = fsms.map((fsm) => {
    const filtered = range !== null;
    if (!filtered) {
      return {
        fsm,
        range: null,
        dwell: fsm.dwellCycles,
        dwellTotal: totalDwell(fsm),
        peak: peakState(fsm),
        transitions: fsm.transitions,
        selfLoops: selfLoops(fsm),
        samples: fsm.samples.length,
        segments: stateSegments(fsm),
      };
    }
    return {
      fsm,
      range,
      dwell: new Map<string, number>(),
      dwellTotal: 0,
      peak: null,
      transitions: [],
      selfLoops: 0,
      samples: 0,
      segments: [],
    };
  });

  const jobs: ChunkJob[] = [];
  for (const scope of scopes) {
    // `range !== null` 就是"这台状态机被筛选了"：全量口径没有要算的长活
    const marked = scope.range;
    if (marked === null) continue;
    const from = marked.from;
    const to = marked.to;
    // 先按 §9.5 切段（合并连续同状态），下面再逐段裁剪 —— 切段本身是一趟线性扫描
    const raw = stateSegments(scope.fsm);

    // ① 状态段裁剪：跨边界的段只算落在区间里的那部分
    jobs.push({
      count: raw.length,
      run: (start, stop) => {
        for (let i = start; i < stop; i++) {
          const segment = raw[i]!;
          // 半开段 `[start,end)` 裁到闭区间 `[from,to]`：上界写成 `to + 1`，长度就是"这段里
          // 有几个周期落在区间内"。区间为空（from === to）时长度是 0 或 1，不会是负数。
          const clippedFrom = Math.max(segment.start, from);
          const clippedTo = Math.min(segment.end, to + 1);
          // 交集为空 ⇒ 整段丢掉；零长段（开区间的尾段，驻留未定型）只在它的那个周期落在
          // 区间里时留下 —— 今天它本来就画成一根细条，没必要因为筛选就消失
          if (clippedTo < clippedFrom) continue;
          if (clippedTo === clippedFrom && (segment.start < from || segment.start > to)) continue;
          const length = clippedTo - clippedFrom;
          scope.segments.push({ state: segment.state, start: clippedFrom, end: clippedTo, open: segment.open });
          scope.dwell.set(segment.state, (scope.dwell.get(segment.state) ?? 0) + length);
          scope.dwellTotal += length;
        }
      },
    });

    // ② 跳转过滤：跳转发生在 `pos.cycle` 这一拍（它两端的段必然都碰到区间），
    //    只有发生在区间里的跳转才算 —— 区间外发生的跳转不能算进"这段区间有多少次跳转"
    jobs.push({
      count: scope.fsm.transitions.length,
      run: (start, stop) => {
        for (let i = start; i < stop; i++) {
          const transition = scope.fsm.transitions[i]!;
          const cycle = transition.pos.cycle;
          if (cycle < from || cycle > to) continue;
          scope.transitions.push(transition);
          if (transition.selfLoop) scope.selfLoops += 1;
        }
      },
    });

    // ③ 状态记录条数：概览里的"条"也跟着区间走
    jobs.push({
      count: scope.fsm.samples.length,
      run: (start, stop) => {
        for (let i = start; i < stop; i++) {
          const cycle = scope.fsm.samples[i]!.pos.cycle;
          if (cycle >= from && cycle <= to) scope.samples += 1;
        }
      },
    });
  }

  let total = 0;
  for (const job of jobs) total += job.count;
  let done = 0;
  for (const job of jobs) {
    const base = done;
    const completed = await runChunked(job.count, job.run, {
      signal,
      onProgress: (part) => onProgress(base + part, total),
    });
    if (!completed) return null;
    done = base + job.count;
  }

  // 峰值：区间内的最大值（全量口径直接用 `peakState`，不在这里重算）
  for (const scope of scopes) {
    if (scope.range === null) continue;
    for (const [state, dwell] of scope.dwell) {
      if (scope.peak === null || dwell > scope.peak.dwell) scope.peak = { state, dwell };
    }
  }
  return scopes;
}

/** 统计范围说明：「有区间」与「未打标记」两种文案 */
function scopeChips(range: MarkerRange | null, fsms: FsmTrack[]): HTMLElement[] {
  void fsms;
  if (range === null) {
    return [
      el('span', {
        class: 'chip',
        text: '未打标记：统计全量',
        title: '在时间轴上打两个标记，这里的统计就只算两个标记之间的那一段',
      }),
    ];
  }
  return [
    el('span', {
      class: 'chip',
      text: `标记区间：周期 ${fmtInt(range.from)} – ${fmtInt(range.to)}（只统计这一段）`,
      title:
        '只有与闭区间相交的状态段才算数：跨边界的段只算落在区间里的那部分；跳转只看发生在区间里的',
    }),
  ];
}

/** 最后一条记录的状态：它的驻留还没定型（spec §9.5） */
function tailState(fsm: FsmTrack): string | null {
  const last = fsm.samples[fsm.samples.length - 1];
  return last === undefined ? null : formatState(last.value);
}

function formatState(value: FsmTrack['samples'][number]['value']): string {
  return value.kind === 'str' ? `"${value.text}"` : value.text;
}

// ------------------------------------------------------------------ 每台状态机各自的占用热力

/**
 * 一台状态机一张卡片：行内只放**它自己的**状态，格子 = 该状态的驻留周期数。
 * 颜色按该状态机自身的峰值归一（独立可读），卡片小标题里给出峰值以便跨状态机比较。
 *
 * 数字一律取自 `scope`：区间筛选时它是"区间内的驻留"，未筛选时它原样就是 `dwellCycles`。
 */
function fsmCard(scope: FsmScope, ctx: ViewContext, state: FsmState): HTMLElement {
  const { fsm } = scope;
  const total = scope.dwellTotal;
  const peak = scope.peak;
  // 末状态的驻留还没定型（spec §9.5）：这张卡片按全量统计时就照旧提它
  const tail = tailState(fsm);
  const tailCycle = fsm.samples[fsm.samples.length - 1]?.pos.cycle ?? null;
  const tailVisible =
    tail !== null &&
    (scope.range === null || (tailCycle !== null && tailCycle >= scope.range.from && tailCycle <= scope.range.to));
  // 同一个口径在卡片里出现好几次（小标题 / tooltip / 详情抽屉），措辞保持一致
  const filtered = scope.range !== null;
  const dwellLabel = filtered ? '区间内驻留' : '总驻留';
  const recordLabel = filtered ? '区间内状态记录' : '状态记录';
  const cards = card(
    `状态机 · ${fsm.name}`,
    `${fsm.stateSet.length} 个状态 · ${dwellLabel} ${fmtInt(total)} 周期` +
      (peak ? ` · 峰值 ${peak.state} ${fmtInt(peak.dwell)} 周期` : '') +
      (tailVisible ? ` · 末状态 ${tail} 仍在上报（驻留未定型）` : ''),
  );

  const cells = el('div', {
    style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(108px,1fr));gap:6px',
  });
  const peakDwell = peak?.dwell ?? 0;
  for (const name of fsm.stateSet) {
    const dwell = scope.dwell.get(name) ?? 0;
    const background = heatColor(peakDwell > 0 ? dwell / peakDwell : 0);
    const foreground = textColorOn(background);
    const share = total > 0 ? (dwell / total) * 100 : 0;
    const isTail = tailVisible && name === tail;
    const cell = el(
      'div',
      {
        style: [
          `background:${background}`,
          `color:${foreground}`,
          'border-radius:6px',
          'padding:6px 8px',
          'display:flex',
          'flex-direction:column',
          'gap:1px',
          'min-width:0',
          'cursor:pointer',
          isTail ? 'outline:1px dashed currentColor;outline-offset:-3px' : '',
        ]
          .filter(Boolean)
          .join(';'),
      },
      [
        el('span', {
          style: 'font-size:10.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
          title: name,
          text: name,
        }),
        el('span', { style: 'font-size:12.5px;font-variant-numeric:tabular-nums', text: `${fmtInt(dwell)} 周期` }),
        el('span', { style: 'font-size:10px;opacity:.85', text: `${share.toFixed(1)}%${isTail ? ' · 未定型' : ''}` }),
      ],
    );
    hoverTarget(
      cell,
      () =>
        [
          `状态机 ${fsm.name}`,
          `状态 ${name}`,
          `${dwellLabel} ${fmtInt(dwell)} 周期`,
          `占该状态机 ${share.toFixed(2)}%（${dwellLabel} ${fmtInt(total)} 周期）`,
          isTail ? '末状态：后面还没有新记录，驻留周期数仍会增长（spec §9.5）' : '',
        ]
          .filter((line) => line !== '')
          .join('\n'),
      () =>
        selectFsm(ctx, fsm, `状态占用 · ${name}`, [
          ['状态机', fsm.name],
          ['状态', name],
          ['驻留周期', fmtInt(dwell)],
          ['占比', `${share.toFixed(2)}%`],
          [`该状态机${dwellLabel}`, `${fmtInt(total)} 周期`],
          ['该状态机状态数', String(fsm.stateSet.length)],
          [recordLabel, `${fmtInt(scope.samples)} 条`],
        ]),
    );
    cells.append(cell);
  }

  // ① 状态占用比例
  cards.body.append(
    el('h4', { class: 'fsm-section', text: `状态占用比例 · ${fsm.stateSet.length} 个状态` }),
    cells,
    legend([
      { label: '驻留少', color: heatColor(0) },
      { label: '驻留多', color: heatColor(1) },
      {
        label: `按${filtered ? '区间内' : '本状态机'}峰值 ${peakDwell > 0 ? fmtInt(peakDwell) : 0} 周期归一`,
        color: heatColor(0.7),
      },
    ]),
  );
  // ② 该状态机自己的状态时序色带
  cards.body.append(el('h4', { class: 'fsm-section', text: '状态时序色带' }), stateBands([scope], ctx, state));
  // ③ 该状态机的状态转移图（由相邻两条 fsm 记录推断）
  cards.body.append(
    el('h4', { class: 'fsm-section', text: '状态转移图' }),
    el('p', {
      class: 'muted',
      style: 'margin:-2px 0 4px;font-size:11.5px',
      text: '箭头方向 = 转移方向，箭头颜色 = 转移频度；虚线圆圈是"起始"入口（第一条记录没有前驱状态）',
    }),
    transitionGraph(scope, ctx),
  );

  state.highlights.push({
    node: cards.root,
    match: (selection) => selection?.kind === 'fsm' && selection.key === fsm.key,
  });
  return cards.root;
}

// ------------------------------------------------------------------ 状态转移图

/** 首条记录没有前驱状态，画一个虚线的"起始"入口 */
const START_NODE = '(起始)';
const GRAPH_W = 540;
const GRAPH_H = 380;
const NODE_R = 23;

interface EdgeAgg {
  from: string;
  to: string;
  count: number;
  selfLoop: boolean;
  first: Position;
  last: Position;
}

/**
 * 由相邻两条 fsm 记录推断转移，并按 (from, to) 聚合。
 * `transitions` 由调用方给：全量口径是轨道上的全部跳转，区间口径是"发生在区间里的"那些。
 */
function aggregateEdges(fsm: FsmTrack, transitions: FsmTrack['transitions']): EdgeAgg[] {
  const map = new Map<string, EdgeAgg>();
  for (const transition of transitions) {
    const from = transition.from ?? START_NODE;
    const key = `${from}\u0000${transition.to}`;
    const found = map.get(key);
    if (found) {
      found.count += 1;
      found.last = transition.pos;
    } else {
      map.set(key, {
        from,
        to: transition.to,
        count: 1,
        selfLoop: from === transition.to,
        first: transition.pos,
        last: transition.pos,
      });
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

/** 频度配色：越频繁越深（与状态身份色区分开，避免混淆"颜色 = 状态"与"颜色 = 频度"） */
function frequencyColor(share: number): string {
  return heatColor(0.18 + 0.82 * Math.max(0, Math.min(1, share)));
}

function nodePositions(names: string[]): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const cx = GRAPH_W / 2;
  const cy = GRAPH_H / 2;
  if (names.length === 1) {
    out.set(names[0]!, { x: cx, y: cy });
    return out;
  }
  const radius = Math.min(GRAPH_W, GRAPH_H) / 2 - NODE_R - 30;
  names.forEach((name, index) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / names.length;
    out.set(name, { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) });
  });
  return out;
}

/** 节点之间的曲线：两端各留出节点半径，反向边错开弯曲避免重叠 */
function edgeGeometry(a: { x: number; y: number }, b: { x: number; y: number }, bow: number) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const start = { x: a.x + ux * NODE_R, y: a.y + uy * NODE_R };
  const end = { x: b.x - ux * (NODE_R + 10), y: b.y - uy * (NODE_R + 10) };
  const mid = { x: (start.x + end.x) / 2 - uy * bow, y: (start.y + end.y) / 2 + ux * bow };
  // 标签放在曲线中点，并沿"远离画布中心"的方向外推一点：弦很密时这样能显著减少标签互相压叠
  const cx = GRAPH_W / 2;
  const cy = GRAPH_H / 2;
  const raw = { x: (start.x + end.x) / 4 + mid.x / 2, y: (start.y + end.y) / 4 + mid.y / 2 };
  const ox = raw.x - cx;
  const oy = raw.y - cy;
  const olen = Math.hypot(ox, oy) || 1;
  const label = { x: raw.x + (ox / olen) * 15, y: raw.y + (oy / olen) * 15 };
  return { start, end, mid, label, d: `M${start.x},${start.y}Q${mid.x},${mid.y} ${end.x},${end.y}` };
}

function transitionGraph(scope: FsmScope, ctx: ViewContext): HTMLElement {
  const { fsm } = scope;
  const edges = aggregateEdges(fsm, scope.transitions);
  const names = [...(edges.some((e) => e.from === START_NODE) ? [START_NODE] : []), ...fsm.stateSet];
  const pos = nodePositions(names);
  const edgeTotal = edges.reduce((sum, e) => sum + e.count, 0);
  // 份额的分母至少为 1：空图（一次跳转都没有）时不能除零
  const total = Math.max(1, edgeTotal);
  // 图例上的"次数"：按全量统计的卡片沿用改动前的写法；区间口径给精确值 —— 区间里一次跳转
  // 都没有时不能显示成"1 次"
  const filtered = scope.range !== null;
  const totalLabel = filtered ? edgeTotal : total;
  const dwellLabel = filtered ? '区间内驻留' : '驻留';
  const maxCount = Math.max(1, ...edges.map((e) => e.count));
  const svg = svgRoot(GRAPH_W, GRAPH_H, { style: 'width:100%;max-width:560px;height:auto' });

  // 箭头：颜色随边变化，所以每条边一个 marker
  const defs = svgEl('defs', {});
  edges.forEach((edge, index) => {
    defs.append(
      svgEl('marker', {
        id: `fsm-arrow-${index}-${fsm.key.replace(/[^\w]/g, '')}`,
        viewBox: '0 0 10 10',
        refX: 9,
        refY: 5,
        markerWidth: 5,
        markerHeight: 5,
        orient: 'auto-start-reverse',
      }, [svgEl('path', { d: 'M0,0 L10,5 L0,10 z', fill: frequencyColor(edge.count / maxCount) })]),
    );
  });
  svg.append(defs);

  // 先画边，节点盖在上面
  const edgeLayer = svgEl('g', {});
  svg.append(edgeLayer);
  const nodeLayer = svgEl('g', {});
  svg.append(nodeLayer);

  const seenPair = new Set(edges.map((e) => `${e.from}\u0000${e.to}`));
  for (const [index, edge] of edges.entries()) {
    const color = frequencyColor(edge.count / maxCount);
    const share = (edge.count / total) * 100;
    const from = pos.get(edge.from);
    const to = pos.get(edge.to);
    if (from === undefined || to === undefined) continue;
    const group = svgEl('g', { style: 'cursor:pointer' });
    let labelAt: { x: number; y: number };

    if (edge.selfLoop) {
      const x = from.x;
      const y = from.y;
      labelAt = { x, y: y - NODE_R - 30 };
      group.append(
        svgEl('path', {
          d: `M${x - 12},${y - NODE_R + 4}C${x - 26},${y - NODE_R - 34} ${x + 26},${y - NODE_R - 34} ${x + 12},${y - NODE_R + 4}`,
          fill: 'none',
          stroke: color,
          'stroke-width': 1.8,
          'marker-end': `url(#fsm-arrow-${index}-${fsm.key.replace(/[^\w]/g, '')})`,
        }),
      );
    } else {
      const bow = seenPair.has(`${edge.to}\u0000${edge.from}`) ? 26 : 12;
      const geometry = edgeGeometry(from, to, bow);
      labelAt = geometry.label;
      group.append(
        svgEl('path', {
          d: geometry.d,
          fill: 'none',
          stroke: color,
          'stroke-width': 1.4 + Math.min(2.6, (edge.count / maxCount) * 2.6),
          'marker-end': `url(#fsm-arrow-${index}-${fsm.key.replace(/[^\w]/g, '')})`,
        }),
      );
    }

    const label = svgEl('text', {
      x: labelAt.x,
      y: labelAt.y,
      'text-anchor': 'middle',
      style: 'font-size:10px;font-weight:600;font-variant-numeric:tabular-nums;paint-order:stroke;stroke:var(--surface);stroke-width:3.5px',
      fill: color,
      text: String(edge.count),
    });
    group.append(label);
    hoverTarget(
      group,
      () =>
        [
          `${edge.from} → ${edge.to}${edge.selfLoop ? '（自环）' : ''}`,
          `发生 ${fmtInt(edge.count)} 次 · 占该状态机${filtered ? '区间内' : ''}跳转的 ${share.toFixed(1)}%`,
          edge.selfLoop ? '自环 = 同一状态连续两次上报（spec §9.5）' : '',
          `首次 ${formatPosition(edge.first)}`,
          `最后 ${formatPosition(edge.last)}`,
          '由相邻两条 fsm 记录推断',
        ]
          .filter((line) => line !== '')
          .join('\n'),
      () =>
        selectFsm(ctx, fsm, `${edge.from} → ${edge.to}`, [
          ['状态机', fsm.name],
          ['转移', `${edge.from} → ${edge.to}`],
          ['次数', fmtInt(edge.count)],
          ['占比', `${share.toFixed(2)}%`],
          ['类型', edge.selfLoop ? '自环' : '普通跳转'],
        ]),
    );
    edgeLayer.append(group);
  }

  for (const name of names) {
    const at = pos.get(name);
    if (at === undefined) continue;
    const isStart = name === START_NODE;
    const dwell = isStart ? null : (scope.dwell.get(name) ?? 0);
    const color = isStart ? 'var(--text-muted)' : colorFor(name);
    const node = svgEl('g', { style: 'cursor:pointer' });
    node.append(
      svgEl('circle', {
        cx: at.x,
        cy: at.y,
        r: NODE_R,
        fill: isStart ? 'var(--surface-2)' : 'var(--surface)',
        stroke: color,
        'stroke-width': 2,
        ...(isStart ? { 'stroke-dasharray': '3 3' } : {}),
      }),
    );
    node.append(
      svgEl('text', {
        x: at.x,
        y: at.y + 3.5,
        'text-anchor': 'middle',
        style: 'font-size:10.5px;font-weight:600',
        fill: color,
        text: name.length > 8 ? `${name.slice(0, 7)}…` : name,
      }),
    );
    if (dwell !== null) {
      node.append(
        svgEl('text', {
          x: at.x,
          y: at.y + NODE_R + 12,
          'text-anchor': 'middle',
          class: 'axis-label',
          style: 'font-size:9.5px',
          text: `${fmtInt(dwell)} 周期`,
        }),
      );
    }
    hoverTarget(
      node,
      () =>
        (isStart
          ? ['起始：该状态机的第一条记录（还没有前驱状态）', fsm.name]
          : [
              `状态 ${name}`,
              `${dwellLabel} ${fmtInt(dwell ?? 0)} 周期`,
              `来自 ${edges.filter((e) => e.to === name).reduce((sum, e) => sum + e.count, 0)} 次跳转`,
              `离开 ${edges.filter((e) => e.from === name).reduce((sum, e) => sum + e.count, 0)} 次`,
              '点击查看该状态的详情',
            ]).join('\n'),
      () =>
        isStart
          ? selectFsm(ctx, fsm, '起始状态', [['状态机', fsm.name], ['说明', '第一条 fsm 记录，没有前驱']])
          : selectFsm(ctx, fsm, `状态 · ${name}`, [
              ['状态机', fsm.name],
              ['驻留周期', fmtInt(dwell ?? 0)],
              ['占比', `${(((dwell ?? 0) / Math.max(1, scope.dwellTotal)) * 100).toFixed(2)}%`],
            ]),
    );
    nodeLayer.append(node);
  }

  const wrap = el('div', { style: 'display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap' }, [svg]);
  wrap.append(
    legend([
      { label: '箭头颜色 = 频度', color: frequencyColor(0.15) },
      { label: '低', color: frequencyColor(0.25) },
      { label: '中', color: frequencyColor(0.6) },
      { label: '高', color: frequencyColor(1) },
      { label: `${fmtInt(totalLabel)} 次跳转${filtered ? '（区间内）' : ''}`, color: 'transparent' },
    ]),
  );
  return wrap;
}

// ------------------------------------------------------------------ 时序色带

const BAND_LABEL_WIDTH = 132;
const BAND_HEIGHT = 15;
const BAND_ROW_HEIGHT = 22;

/**
 * 状态时序色带：一台状态机一行，底色 = 状态。
 *
 * 横轴：区间筛选时用标记区间（只画这一段，区间外的东西根本不出现，免得被当成统计进来的数据），
 * 未筛选时沿用"首末记录覆盖的范围"。段的来源是 `scope.segments`：未筛选时它与轨道上的
 * `stateSegments` 是同一份，筛选时已经按区间裁剪过。
 */
function stateBands(scopes: FsmScope[], ctx: ViewContext, state: FsmState): HTMLElement {
  let from = Number.POSITIVE_INFINITY;
  let to = 0;
  for (const scope of scopes) {
    if (scope.range !== null) {
      from = Math.min(from, scope.range.from);
      to = Math.max(to, scope.range.to);
      continue;
    }
    const fsm = scope.fsm;
    const first = fsm.samples[0]?.pos.cycle;
    const last = fsm.samples[fsm.samples.length - 1]?.pos.cycle;
    if (first !== undefined && first < from) from = first;
    if (last !== undefined && last > to) to = last;
  }
  if (!Number.isFinite(from)) from = 0;
  const span = Math.max(1, to - from + 1);
  const plotWidth = Math.max(320, Math.min(1000, span * 6));
  const width = BAND_LABEL_WIDTH + plotWidth + 8;
  const axisHeight = 20;
  const height = scopes.length * BAND_ROW_HEIGHT + axisHeight;
  const svg = svgRoot(width, height);
  const x = linearScale(from, to + 1, BAND_LABEL_WIDTH, BAND_LABEL_WIDTH + plotWidth);
  const truncated: string[] = [];

  for (const [index, scope] of scopes.entries()) {
    const fsm = scope.fsm;
    const y = index * BAND_ROW_HEIGHT;
    const group = svgEl('g');
    group.append(
      svgEl('text', {
        x: BAND_LABEL_WIDTH - 8,
        y: y + BAND_HEIGHT / 2 + 3.5,
        class: 'axis-label',
        'text-anchor': 'end',
        text: fsm.name,
      }),
    );
    const segments = scope.segments;
    const drawable = segments.length > MAX_SEGMENTS ? segments.slice(0, MAX_SEGMENTS) : segments;
    if (drawable.length < segments.length) truncated.push(fsm.name);
    for (const segment of drawable) {
      const x0 = x(segment.start);
      const x1 = x(segment.end);
      const rect = svgEl('rect', {
        x: x0,
        y,
        width: Math.max(1, x1 - x0),
        height: BAND_HEIGHT,
        fill: colorFor(segment.state),
        rx: 2,
        style: 'cursor:pointer',
      });
      const cycles = Math.max(0, segment.end - segment.start);
      hoverTarget(
        rect,
        () => `${fsm.name}\n状态 ${segment.state}\n周期 [${segment.start}, ${segment.end}) · ${fmtInt(cycles)} 周期`,
        () =>
          selectFsm(ctx, fsm, `色带 · ${segment.state}`, [
            ['状态机', fsm.name],
            ['状态', segment.state],
            ['区间', `[${segment.start}, ${segment.end})`],
            ['长度', `${fmtInt(cycles)} 周期`],
          ]),
      );
      group.append(rect);
      if (x1 - x0 > 46 && segment.state.length <= 10) {
        group.append(
          svgEl('text', {
            x: x0 + 4,
            y: y + BAND_HEIGHT - 4,
            style: 'font-size:9px;font-family:var(--mono);pointer-events:none',
            fill: '#fff',
            text: segment.state,
          }),
        );
      }
    }
    svg.append(group);
    state.highlights.push({
      node: group,
      match: (selection) => selection?.kind === 'fsm' && selection.key === fsm.key,
      apply: (node, isActive) => node.setAttribute('opacity', state.selectedKey === null || isActive ? '1' : '0.3'),
    });
  }

  const axisY = scopes.length * BAND_ROW_HEIGHT;
  svg.append(
    svgEl('line', { x1: BAND_LABEL_WIDTH, x2: BAND_LABEL_WIDTH + plotWidth, y1: axisY, y2: axisY, class: 'grid-line' }),
    svgEl('text', {
      x: BAND_LABEL_WIDTH - 8,
      y: axisY + 13,
      class: 'axis-label axis-title',
      'text-anchor': 'end',
      text: '周期',
    }),
  );
  for (const value of axisTicks(from, to, Math.max(2, Math.floor(plotWidth / 70)))) {
    const px = x(value);
    svg.append(
      svgEl('line', { x1: px, x2: px, y1: 0, y2: axisY, class: 'grid-line', opacity: 0.5 }),
      svgEl('text', { x: px, y: axisY + 13, class: 'axis-label', 'text-anchor': 'middle', text: String(value) }),
    );
  }

  const nodes: (Node | null)[] = [el('div', { class: 'chart-scroll' }, [svg])];
  if (truncated.length > 0) {
    nodes.push(el('p', { class: 'muted', text: `状态太多：${truncated.join(' · ')} 只画了前 ${fmtInt(MAX_SEGMENTS)} 段` }));
  }
  return el('div', { style: 'display:flex;flex-direction:column;gap:10px' }, nodes);
}

// ------------------------------------------------------------------ 跳转


function selectFsm(ctx: ViewContext, fsm: FsmTrack, title: string, rows: [string, string][]): void {
  ctx.selection.set({ kind: 'fsm', key: fsm.key });
  ctx.inspect(title, rows);
}

// ------------------------------------------------------------------ 挂载

/** 概览 + 每台状态机一张卡片；数据（`scopes`）已经算完，DOM 一次建好、一次替换 */
function buildContent(scopes: FsmScope[], range: MarkerRange | null, ctx: ViewContext, state: FsmState): Node[] {
  if (scopes.length === 0) {
    const empty = card('状态机', '没有可显示的状态机');
    empty.body.append(emptyState('这份轨迹没有 fsm 记录'));
    return [empty.root];
  }

  const allStates = new Set<string>();
  let stateSlots = 0;
  let transitions = 0;
  let loops = 0;
  let dwell = 0;
  let records = 0;
  for (const scope of scopes) {
    const inRange = scope.range !== null;
    // 区间口径下"状态数"只数区间里真的出现过的状态（全量口径仍用轨道上的状态集合）
    for (const name of inRange ? scope.dwell.keys() : scope.fsm.stateSet) allStates.add(name);
    stateSlots += inRange ? scope.dwell.size : scope.fsm.stateSet.length;
    transitions += scope.transitions.length;
    loops += scope.selfLoops;
    dwell += scope.dwellTotal;
    records += scope.samples;
  }

  // ---------------------------------------------------------------- 概览
  // 数字全部取自 `scopes`：区间口径是"这一段里的"，没有标记时就是改动前的全量数字
  const rangeNote =
    range === null ? '' : ` · 已按标记区间裁剪：周期 ${fmtInt(range.from)} – ${fmtInt(range.to)}`;
  const overview = card('状态机概览', `状态是保持型的：驻留周期 = 相邻两条记录的周期差之和（spec §9.5）${rangeNote}`);
  overview.body.append(
    el('div', { class: 'stat-row' }, [
      statTile('状态机', countLabel(scopes.length), `${countLabel(records)} 条状态记录`),
      statTile(
        '状态数',
        countLabel(allStates.size),
        `合计 ${fmtInt(stateSlots)} 个（含重复${range === null ? '' : '，区间内'}）`,
      ),
      statTile(
        '跳转',
        countLabel(transitions),
        `${fmtInt(records)} 条状态记录${range === null ? '' : '（区间内）'}`,
      ),
      statTile('自环', countLabel(loops), loops > 0 ? '同一状态连续两次上报' : '没有自环'),
      statTile(
        '总驻留',
        countLabel(dwell),
        range === null ? '所有状态机之和（周期）' : '标记区间内之和（域不匹配的状态机仍为全量）',
      ),
    ]),
  );

  // ---------------------------------------------------------------- 每台状态机各自的占用
  // 不把不同状态机塞进同一张表：每台状态机的状态集合、驻留口径与峰值都不同，
  // 合并后大多数格子会是空的，也看不出"某个模块各状态占了多少周期"。
  return [overview.root, ...scopes.map((scope) => fsmCard(scope, ctx, state))];
}

/**
 * 重算并整份替换统计内容。
 *
 * 为什么只在提交时重算：时间轴只在**松手**时提交标记位置（`MarkerBus.move` 只在松手时调用），
 * 订阅回调因此天然不会在拖拽过程中触发 —— 否则每移动一像素都要把整份状态机统计重算一遍。
 * 为什么先让出一帧：好让"计算中…"真的被画出来，不然同步的准备阶段会把它一起压后。
 * 为什么先算完再换 DOM：中途的产物不上屏，免得看到"一半旧数据、一半新数据"的卡片。
 */
async function recompute(state: FsmState): Promise<void> {
  const { ctx } = state;
  const fsms = visibleFsms(ctx);
  const range = ctx.markers.range();

  // 上一轮还没算完就作废：否则它的产物可能盖掉这一轮
  state.token?.abort();
  const token = abortable();
  state.token = token;

  const busy = el('span', { class: 'chip', text: '计算中…' });
  state.chips.replaceChildren(...scopeChips(range, fsms), busy);
  await nextFrame();

  const scopes = await buildScopes(fsms, range, token.signal, (done, total) => {
    busy.textContent = total > 0 ? `计算中… ${Math.round((done / total) * 100)}%` : '计算中…';
  });
  // 被取消（卸载，或更新的一轮已经接管）：这一轮的产物整个丢掉，DOM 留给接管者
  if (scopes === null || state.token !== token) return;
  state.token = null;

  state.highlights = [];
  state.body.replaceChildren(...buildContent(scopes, range, ctx, state));
  state.chips.replaceChildren(...scopeChips(range, fsms));
  applySelection(state);
}

/** 退订 + 取消还没算完的这一轮（卸载、重新挂载时用） */
function dispose(state: FsmState): void {
  state.unsubscribe?.();
  state.unsubscribeMarkers?.();
  state.unsubscribe = null;
  state.unsubscribeMarkers = null;
  state.token?.abort();
  state.token = null;
}

function applySelection(state: FsmState): void {
  const selection = state.ctx.selection.get();
  state.selectedKey = selection?.kind === 'fsm' ? selection.key : null;
  for (const highlight of state.highlights) {
    const isActive = highlight.match(selection);
    if (highlight.apply) highlight.apply(highlight.node, isActive);
    else highlight.node.classList.toggle('is-selected', isActive);
  }
}

function mountView(container: HTMLElement, ctx: ViewContext): void {
  if (active !== null) dispose(active);
  const chips = el('div', { style: 'display:flex;gap:6px;align-items:center;flex-wrap:wrap' });
  // 卡片挂在 `body` 里而不是直接挂在容器下，所以间距得自己给（容器的 `.view` 有 gap: 16px）
  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
  container.replaceChildren(chips, body);
  const state: FsmState = {
    container,
    ctx,
    highlights: [],
    unsubscribe: null,
    unsubscribeMarkers: null,
    token: null,
    chips,
    body,
    selectedKey: null,
  };
  // 先订阅再首算：算的过程中提交了标记也不会漏（新一轮会取消上一轮的令牌）
  state.unsubscribeMarkers = ctx.markers.subscribe(() => void recompute(state));
  state.unsubscribe = ctx.selection.subscribe(() => applySelection(state));
  active = state;
  void recompute(state);
}

export const fsmView: View = {
  id: 'fsm',
  title: '状态机',
  hint: '状态占用热力图与跳转',
  mount(container, ctx) {
    mountView(container, ctx);
  },
  refresh(ctx, reason) {
    if (!active) return;
    if (reason === 'options') {
      mountView(active.container, ctx);
      return;
    }
    active.ctx = ctx;
    applySelection(active);
  },
  unmount() {
    if (active !== null) dispose(active);
    active = null;
  },
};

export default fsmView;
