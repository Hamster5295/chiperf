/**
 * 流水线视图 —— **概览 + 每个流水级一张大方框**。
 *
 * 每个流水级（一条 `pip` 轨道 = 一级流水，如 `core.if`）的方框里放两项指标：
 *
 *  - **占用 vs 空泡（饼图）**：该级活跃周期里"有内容"与"空泡"的比例。
 *    占用度是半开区间 `[enter, close)`（spec §9.4），所以活跃区间内每个周期
 *    非"有内容"即"空泡"，两者相加就是活跃周期数。
 *  - **延迟分布（横向柱状图）**：统计已结束条目，按出现次数取前 10 个延迟，
 *    并给出中位 / 平均 / 方差等数值。
 *
 * 其余内容（气泡区间列表、逐周期占用度曲线、条目明细）已按要求移除；
 * 逐周期与逐条目的细节在时间轴视图里看。
 *
 * **统计范围**：波形上打了两个标记时（`ctx.markers.range()`），本视图的统计只算
 * 两个标记之间（闭区间）的数据；标记只在**松手提交**时通知，所以拖拽期间不会反复重算。
 */
import type { TrackInfo } from '../../../parser/src/index.ts';
import { bubbleStats, itemsWithin, latencyStats, type Distribution } from '../../../parser/src/index.ts';
import { card, countLabel, el, emptyState, hoverTarget, statTile, svgEl, svgRoot } from '../charts.ts';
import { abortable, runChunked } from '../chunk.ts';
import type { Marker, MarkerRange } from '../markers.ts';
import { fmtInt, type Selection, type View, type ViewContext } from '../view.ts';

// ------------------------------------------------------------------ 状态

interface StageHighlight {
  node: Element;
  match: (selection: Selection) => boolean;
}

interface PipelineState {
  container: HTMLElement;
  ctx: ViewContext;
  highlights: StageHighlight[];
  unsubscribe: (() => void) | null;
  /** 标记订阅：标记只在**松手提交**时通知（见 markers.ts），所以拖拽期间不会触发重算 */
  markerUnsub: (() => void) | null;
  /** 正在进行的一轮分片重算；新一轮开始或卸载时取消掉它，避免旧结果覆盖新结果 */
  compute: { signal: AbortSignal; abort: () => void } | null;
}

let active: PipelineState | null = null;

function visibleTracks(ctx: ViewContext): TrackInfo[] {
  const tracks = [...ctx.trace.tracks.values()];
  // 按首次出现的周期排：流水级顺序（IF → ID → EX …）就是数据里出现的顺序
  return [...tracks].sort((a, b) => a.firstCycle - b.firstCycle || a.name.localeCompare(b.name));
}

// ------------------------------------------------------------------ 统计范围（标记区间）

/** 该级实际生效的统计区间（闭区间）；`null` = 全量 */
interface TrackRange {
  from: number;
  to: number;
}

/**
 * 这一级该按哪个区间统计。没有标记时返回 null（全量）。
 */
function effectiveRange(track: TrackInfo, range: MarkerRange | null): TrackRange | null {
  if (range === null) return null;
  return { from: range.from, to: range.to };
}

/**
 * 一级流水在某个统计范围下的全部数字。
 *
 * 为什么要一次算完：概览块与每级卡片用的是同一批数（算两遍纯属浪费），
 * 而且分片重算时要让"算"与"画"在同一片里完成，页面上才不会出现半算完的卡片。
 *
 * `range === null`（没打标记 / 这一级不在标记所在域）时，**每个字段都走改动前的原路径**
 * （`track.closed`、`track.bubbles`、`latencyStats(track)`…），所以"没有标记 ⇒ 数字一个都不变"
 * 是结构上成立的，而不是靠两套公式凑巧相等。
 */
interface StageNumbers {
  /** 是否真的按标记区间筛过（false = 这一级仍是全量） */
  filtered: boolean;
  /** 统计覆盖的周期数 */
  cycles: number;
  /** 空泡周期数 */
  bubbleCycles: number;
  /** 区间内第一个气泡周期（点图例跳转用）；没有气泡时为 null */
  firstBubble: number | null;
  items: number;
  closed: number;
  open: number;
  /** 最长气泡段（区间生效时是**落在区间里的那一段**） */
  widest: { start: number; end: number; length: number } | null;
  latency: Distribution;
  bubbleDist: Distribution;
}

function stageNumbers(track: TrackInfo, range: TrackRange | null): StageNumbers {
  let widest: StageNumbers['widest'] = null;

  if (range === null) {
    // 全量：与改动前逐字一致
    for (const bubble of track.bubbleRanges) {
      const length = bubble.end - bubble.start + 1;
      if (widest === null || length > widest.length) widest = { start: bubble.start, end: bubble.end, length };
    }
    return {
      filtered: false,
      cycles: Math.max(0, track.lastCycle - track.firstCycle + 1),
      bubbleCycles: track.bubbles.length,
      firstBubble: track.bubbles[0] ?? null,
      items: track.items.length,
      closed: track.closed,
      open: track.open,
      widest,
      latency: latencyStats(track),
      bubbleDist: bubbleStats(track),
    };
  }

  // 周期：区间与本级活跃范围的交集（不相交 ⇒ 0 个周期，占用率自然显示 "—"，不会除零）
  const from = Math.max(track.firstCycle, range.from);
  const to = Math.min(track.lastCycle, range.to);
  const cycles = to >= from ? to - from + 1 : 0;

  // 气泡：跨边界的段只算**落在区间里的那部分**（与解析器 bubbleStats 同一口径），
  // 否则"区间内有 1 个空泡周期"却会计出 10 个周期长的段
  let bubbleCycles = 0;
  let firstBubble: number | null = null;
  for (const bubble of track.bubbleRanges) {
    const start = Math.max(bubble.start, range.from);
    const end = Math.min(bubble.end, range.to);
    if (end < start) continue;
    const length = end - start + 1;
    if (firstBubble === null) firstBubble = start;
    bubbleCycles += length;
    if (widest === null || length > widest.length) widest = { start, end, length };
  }

  // 条目：与区间**相交**的算进来（跨边界、但确实在这段里飞过的也算，口径见解析器 itemsWithin）
  const within = itemsWithin(track, range.from, range.to);
  let closed = 0;
  let open = 0;
  for (const item of within) {
    if (item.close === null) open += 1;
    else closed += 1;
  }

  return {
    filtered: true,
    cycles,
    bubbleCycles,
    firstBubble,
    items: within.length,
    closed,
    open,
    widest,
    latency: latencyStats(track, range),
    bubbleDist: bubbleStats(track, range),
  };
}

/**
 * 顶部的范围说明 —— 任何时刻页面上都要写清楚"这批数字统计的是哪一段"。
 * 只打了一个标记时算没有区间（`range()` 返回 null），这时顺带说清楚原因。
 */
function scopeChip(markers: Marker[], range: MarkerRange | null): HTMLElement {
  if (range !== null) {
    return el('span', { class: 'chip chip-ok', text: `标记区间：周期 ${range.from} – ${range.to}（只统计这一段）` });
  }
  if (markers.length === 0) return el('span', { class: 'chip', text: '未打标记：统计全量' });
  const only = markers[0]!;
  return el('span', { class: 'chip', text: `只有 1 个标记（周期 ${only.cycle}）：再打一个才有区间，当前统计全量` });
}

/** 卡片上的范围说明：让用户一眼看出这一级被筛了没有 */
function stageScopeChip(stats: StageNumbers, range: MarkerRange): HTMLElement {
  return el('span', {
    class: 'chip chip-ok',
    text: `标记区间：周期 ${range.from} – ${range.to}（本级只统计这一段：${countLabel(stats.cycles)} 周期 · ${countLabel(stats.items)} 条目）`,
  });
}

// ------------------------------------------------------------------ 配色

/** 有内容 / 空泡：空泡沿用时间轴的橙色，跨视图是同一个概念 */
const OCCUPIED_COLOR = '#3b82f6';
const BUBBLE_COLOR = '#f97316';

/** 延迟分布的颜色：冷 → 暖扫一遍，柱子之间颜色不同，柱高仍表示次数 */
const LATENCY_RAMP: [number, number, number][] = [
  [99, 102, 241], // indigo
  [168, 85, 247], // purple
  [236, 72, 153], // pink
  [244, 63, 94], // rose
];

function rampColor(t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  const scaled = clamped * (LATENCY_RAMP.length - 1);
  const index = Math.min(LATENCY_RAMP.length - 2, Math.floor(scaled));
  const k = scaled - index;
  const from = LATENCY_RAMP[index]!;
  const to = LATENCY_RAMP[index + 1]!;
  const mix = from.map((c, i) => Math.round(c + (to[i]! - c) * k));
  return `rgb(${mix[0]} ${mix[1]} ${mix[2]})`;
}

// ------------------------------------------------------------------ 指标 1：饼图

/**
 * 甜甜圈：用 `stroke-dasharray` 画弧（比逐段算扇形路径短得多，接缝也干净）。
 * 圆心写占比数字，图例在右边 —— 两张切片时，直接读数字比看扇形角度准。
 */
function donut(
  items: { label: string; value: number; color: string }[],
  size: number,
  center: { value: string; label: string },
): SVGSVGElement {
  const svg = svgRoot(size, size);
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const cx = size / 2;
  const cy = size / 2;
  const thickness = Math.max(12, size * 0.13);
  const r = size / 2 - thickness / 2 - 1;
  const circumference = 2 * Math.PI * r;
  // 底环：让"0%"也能看出这是个环
  svg.append(svgEl('circle', { cx, cy, r, fill: 'none', stroke: 'var(--surface-2)', 'stroke-width': thickness }));
  if (total > 0) {
    let offset = 0;
    for (const item of items) {
      if (item.value <= 0) continue;
      const length = (item.value / total) * circumference;
      const arc = svgEl('circle', {
        cx,
        cy,
        r,
        fill: 'none',
        stroke: item.color,
        'stroke-width': thickness,
        'stroke-dasharray': `${length.toFixed(2)} ${(circumference - length).toFixed(2)}`,
        'stroke-dashoffset': (-offset).toFixed(2),
        transform: `rotate(-90 ${cx} ${cy})`,
      });
      hoverTarget(arc, () => `${item.label}\n${fmtInt(item.value)} 周期\n占比 ${((item.value / total) * 100).toFixed(1)}%`);
      svg.append(arc);
      offset += length;
    }
  }
  svg.append(
    svgEl('text', {
      x: cx,
      y: cy + 2,
      'text-anchor': 'middle',
      // fill 必须显式给：SVG 文字默认黑色，深色主题下会看不见
      style: 'font-size:19px;font-weight:640;font-variant-numeric:tabular-nums;fill:var(--text)',
      text: center.value,
    }),
    svgEl('text', {
      x: cx,
      y: cy + 17,
      'text-anchor': 'middle',
      class: 'axis-label',
      text: center.label,
    }),
  );
  return svg;
}

/** 图例：色块 + 名称 + 周期数 + 占比（数值直接写出来，不靠悬停才知道） */
function pieLegend(items: { label: string; value: number; color: string; total: number }[]): HTMLElement {
  return el(
    'ul',
    { class: 'metric-legend' },
    items.map((item) =>
      el('li', {}, [
        el('i', { class: 'swatch', style: `background:${item.color}` }),
        el('span', { text: item.label }),
        el('b', { text: countLabel(item.value) }),
        el('span', { class: 'muted', text: item.total > 0 ? `${((item.value / item.total) * 100).toFixed(1)}%` : '—' }),
      ]),
    ),
  );
}

/**
 * 占用 vs 空泡 —— **按周期数**的饼图。
 *
 * 占用度是半开区间 `[enter, close)`，活跃窗口内每个周期非"有内容"即"空泡"，
 * 所以两张切片的周期数直接相加就是分母；区间生效时分子分母都只算区间内的周期
 * （"这段区间里有内容的周期数 ÷ 这段区间的周期数"）。
 */
function occupancyMetric(track: TrackInfo, stats: StageNumbers, ctx: ViewContext): HTMLElement {
  const bubbles = stats.bubbleCycles;
  const occupied = Math.max(0, stats.cycles - bubbles);
  const total = occupied + bubbles;
  const wrap = el('div', { class: 'metric-flex' });
  const ratio = total > 0 ? occupied / total : 0;
  wrap.append(
    donut(
      [
        { label: '有内容', value: occupied, color: OCCUPIED_COLOR },
        { label: '空泡', value: bubbles, color: BUBBLE_COLOR },
      ],
      136,
      total > 0 ? { value: `${(ratio * 100).toFixed(0)}%`, label: '有内容' } : { value: '—', label: '没有周期' },
    ),
  );
  const legend = pieLegend([
    { label: '有内容', value: occupied, color: OCCUPIED_COLOR, total },
    { label: '空泡', value: bubbles, color: BUBBLE_COLOR, total },
  ]);
  // 点空泡那一项：把该级第一个气泡周期广播出去（时间轴/其它视图跟着定位）。
  // 区间生效时跳的是**区间内的第一个**气泡，而不是整条轨道上的第一个。
  const firstBubble = stats.firstBubble;
  if (firstBubble !== null) {
    const bubbleItem = [...legend.children][1] as HTMLElement | undefined;
    if (bubbleItem) {
      bubbleItem.style.cursor = 'pointer';
      bubbleItem.title = `跳到该级第一个气泡周期（周期 ${firstBubble}）`;
      bubbleItem.addEventListener('click', () => ctx.selection.set({ kind: 'cycle', cycle: firstBubble }));
    }
  }
  wrap.append(legend);
  return wrap;
}

// ------------------------------------------------------------------ 指标 2：延迟分布

interface DistributionText {
  /** 每行左侧的单位文案，如 `${value} 周期` */
  unit: string;
  /** 没有样本时显示的说明 */
  empty: string;
  /** 悬停提示 */
  tip: (value: number, count: number, share: number) => string;
  /** 取值种类多于 10 种时的脚注 */
  note: (kinds: number, shown: number) => string;
}

/** 横向柱状图：每行一个取值，柱长 = 频次 / 最大频次（延迟与气泡段长度共用） */
function distributionList(stats: Distribution, text: DistributionText): HTMLElement {
  const list = el('div', { class: 'lat-list' });
  if (stats.count === 0) {
    list.append(emptyState(text.empty));
    return list;
  }
  // 按出现次数取前 10 个，再按取值升序排回来 —— 读起来才顺
  const top = [...stats.histogram]
    .sort((a, b) => b.count - a.count || a.value - b.value)
    .slice(0, 10)
    .sort((a, b) => a.value - b.value);
  const peak = Math.max(...top.map((bin) => bin.count));
  top.forEach((bin, index) => {
    const share = stats.count > 0 ? bin.count / stats.count : 0;
    // 颜色跟着取值从小到大走一遍冷暖：长空泡一眼就能从颜色上看出来
    const color = rampColor(top.length > 1 ? index / (top.length - 1) : 0);
    const bar = el('i', {
      class: 'lat-bar',
      style: `width:${Math.max(2, (bin.count / peak) * 100).toFixed(1)}%;background:${color}`,
    });
    const row = el('div', { class: `lat-row${bin.count === peak ? ' is-peak' : ''}` }, [
      el('span', { class: 'lat-key', text: `${bin.value} ${text.unit}` }),
      el('span', { class: 'lat-track' }, [bar]),
      el('span', { class: 'lat-count', text: countLabel(bin.count) }),
    ]);
    hoverTarget(row, () => text.tip(bin.value, bin.count, share));
    list.append(row);
  });
  if (stats.histogram.length > top.length) {
    list.append(el('div', { class: 'muted', style: 'font-size:10.5px;margin-top:4px', text: text.note(stats.histogram.length, top.length) }));
  }
  return list;
}

/** 分布面板的数值行：中位 / 平均 / 方差 / 标准差 / 范围 / 样本 */
function distributionMetrics(stats: Distribution, sampleUnit: string): HTMLElement {
  if (stats.count === 0) return el('div', {});
  const sigma = Math.sqrt(Math.max(0, stats.variance));
  return el('div', { class: 'lat-stats' }, [
    el('span', {}, [el('span', { class: 'muted', text: '中位 ' }), el('b', { text: `${stats.median} 周期` })]),
    el('span', {}, [el('span', { class: 'muted', text: '平均 ' }), el('b', { text: `${stats.avg.toFixed(2)} 周期` })]),
    el('span', {}, [el('span', { class: 'muted', text: '方差 ' }), el('b', { text: stats.variance.toFixed(2) })]),
    el('span', {}, [el('span', { class: 'muted', text: '标准差 ' }), el('b', { text: sigma.toFixed(2) })]),
    el('span', {}, [el('span', { class: 'muted', text: '范围 ' }), el('b', { text: `${stats.min} – ${stats.max}` })]),
    el('span', {}, [el('span', { class: 'muted', text: '样本 ' }), el('b', { text: `${fmtInt(stats.count)} ${sampleUnit}` })]),
  ]);
}

function metric(title: string, hint: string, body: Node[]): HTMLElement {
  return el('div', { class: 'stage-metric' }, [
    el('div', { class: 'metric-title' }, [el('span', { text: title }), hint ? el('span', { class: 'muted', text: hint }) : null]),
    ...body,
  ]);
}

// ------------------------------------------------------------------ 每级一张大方框

/**
 * 每级一张大方框。
 *
 * 卡片里的饼图与两个分布全部按 `stats` 出数：`range` 为 null 时 `stats` 就是全量口径，
 * 这一段的 DOM 与改动前完全一致；有标记区间时，同一批数字换成区间口径。
 */
function stageCard(
  track: TrackInfo,
  stats: StageNumbers,
  range: MarkerRange | null,
  ctx: ViewContext,
  highlights: StageHighlight[],
): HTMLElement {
  const cycles = Math.max(0, track.lastCycle - track.firstCycle + 1);
  const node = card(
    track.name,
    // 副标题说的是**这条轨道本身**（覆盖范围与条目总数），与统计范围无关，所以不随标记改变
    `周期 ${track.firstCycle}–${track.lastCycle}（${countLabel(cycles)} 周期）· ${countLabel(track.items.length)} 条目`,
  );
  const latency = stats.latency;
  const bubbleDist = stats.bubbleDist;
  if (range !== null) node.body.append(el('div', { class: 'row' }, [stageScopeChip(stats, range)]));
  node.body.append(
    el('div', { class: 'stage-grid' }, [
      metric(
        '占用 vs 空泡',
        `${countLabel(stats.bubbleCycles)} 个气泡周期${stats.filtered ? '（标记区间内）' : ''}`,
        [occupancyMetric(track, stats, ctx)],
      ),
      metric(
        '延迟分布',
        latency.count === 0
          ? stats.filtered
            ? '标记区间内没有已结束条目'
            : '没有已结束条目'
          : `同域已结束 ${fmtInt(latency.count)} 条${stats.filtered ? '（标记区间内）' : ''} · 按次数取前 10`,
        [
          distributionList(latency, {
            unit: '周期',
            empty: stats.filtered ? '标记区间内没有已结束条目（未闭合的不计入驻留分布）' : '该级没有已结束条目（未闭合的不计入驻留分布）',
            tip: (value, count, share) => [`延迟 ${value} 周期`, `${fmtInt(count)} 条`, `占已结束条目 ${(share * 100).toFixed(1)}%`].join('\n'),
            note: (kinds, shown) => `共 ${kinds} 种延迟，这里取出现次数最多的 ${shown} 种`,
          }),
          distributionMetrics(latency, '条'),
        ],
      ),
      metric(
        '连续空泡数分布',
        bubbleDist.count === 0
          ? stats.filtered
            ? '标记区间内没有气泡'
            : '没有气泡'
          : `${fmtInt(bubbleDist.count)} 段 · 合计 ${countLabel(bubbleDist.count * bubbleDist.avg)} 周期${stats.filtered ? '（跨边界的段只算落在区间里的部分）' : ''}`,
        [
          distributionList(bubbleDist, {
            unit: '周期',
            empty: stats.filtered ? '标记区间内没有气泡（这一段全程有内容）' : '该级没有气泡（活跃区间内全程有内容）',
            tip: (value, count, share) =>
              [`连续 ${value} 周期空泡`, `${fmtInt(count)} 段`, `占全部气泡段 ${(share * 100).toFixed(1)}%`, '一段 = 该级连续若干周期没有在飞内容'].join('\n'),
            note: (kinds, shown) => `共 ${kinds} 种长度，这里取出现次数最多的 ${shown} 种`,
          }),
          distributionMetrics(bubbleDist, '段'),
        ],
      ),
    ]),
  );
  // 只有"选中了这条轨道上的某个条目"才高亮这一级：按周期选中会把同域的所有级都点亮，
  // 反而看不出是哪一个条目被选中了（周期级的联动交给时间轴自己的整列高光）
  highlights.push({
    node: node.root,
    match: (selection) => selection !== null && selection.kind === 'item' && selection.track === track.name,
  });
  return node.root;
}

// ------------------------------------------------------------------ 概览

/** 概览块的累计量：在分片回调里边算边累加，与每级卡片共用同一批数字 */
interface PipelineTotals {
  items: number;
  closed: number;
  open: number;
  /** 气泡周期数 */
  bubbles: number;
  cycles: number;
  /** 真正被标记区间筛过的级数（概览里据此说明有多少级仍是全量） */
  filteredStages: number;
  widest: { track: string; start: number; end: number; length: number; clipped: boolean } | null;
}

function addTotals(totals: PipelineTotals, track: TrackInfo, stats: StageNumbers): void {
  totals.items += stats.items;
  totals.closed += stats.closed;
  totals.open += stats.open;
  totals.bubbles += stats.bubbleCycles;
  totals.cycles += stats.cycles;
  if (stats.filtered) totals.filteredStages += 1;
  const widest = stats.widest;
  if (widest === null) return;
  if (totals.widest === null || widest.length > totals.widest.length) {
    totals.widest = { track: track.name, start: widest.start, end: widest.end, length: widest.length, clipped: stats.filtered };
  }
}

/**
 * 概览：数字全部由 `totals` 给出，而 `totals` 是"每级各自的口径"累加出来的 ——
 * 标记区间只作用于标记所在域的级，别的域照旧全量，所以副标题里写明筛了几级。
 */
function buildOverview(tracks: TrackInfo[], totals: PipelineTotals, range: MarkerRange | null): HTMLElement {
  const note = '占用度是半开区间 [enter, close)；气泡 = 活跃区间内占用为 0 的周期（spec §9.4）';
  const subtitle =
    range === null
      ? note
      : `${note}；标记区间 周期 ${range.from}–${range.to} ⇒ ${totals.filteredStages}/${tracks.length} 级按区间统计`;
  const overview = card('流水线概览', subtitle);
  overview.body.append(
    el('div', { class: 'stat-row' }, [
      statTile('流水级', countLabel(tracks.length), `${countLabel(totals.items)} 条目`),
      statTile('在飞条目', countLabel(totals.items), `${totals.closed} 已结束 · ${totals.open} 未闭合`),
      statTile(
        '占用率',
        totals.cycles > 0 ? `${(((totals.cycles - totals.bubbles) / totals.cycles) * 100).toFixed(1)}%` : '—',
        `${countLabel(totals.cycles - totals.bubbles)} 有内容 / ${countLabel(totals.bubbles)} 空泡`,
      ),
      totals.widest
        ? statTile(
            '最长气泡',
            `${countLabel(totals.widest.length)} 周期`,
            `${totals.widest.track} · ${totals.widest.start}–${totals.widest.end}${totals.widest.clipped ? '（区间内片段）' : ''}`,
          )
        : statTile('最长气泡', '—', '没有气泡'),
    ]),
  );
  return overview.root;
}

/**
 * 重画整页。
 *
 * 为什么分片：一次重算要把每个流水级的条目筛一遍（`itemsWithin`/`latencyStats`/`bubbleStats`）
 * 再建出成百上千个 DOM/SVG 节点，几十级的轨迹上一次性做完会把主线程占满 —— 页面卡住、
 * 连"正在算"都画不出来。切片粒度就是"一级流水"，片间让出一帧（见 chunk.ts）。
 *
 * 为什么不会看到半算完的页面：卡片先造在 `DocumentFragment` 里，中途被取消（标记又变了）
 * 或视图被卸载就整个丢掉，页面上一个节点都不会落到，最后一次性替换。
 *
 * 为什么不会旧结果覆盖新结果：每一轮都有自己的 `abortable()` 令牌，新一轮开始时先取消上一轮，
 * 被取消的那一轮拿到 `false` 就直接返回。
 */
async function renderPipeline(state: PipelineState): Promise<void> {
  const { container, ctx } = state;
  const range = ctx.markers.range();
  const tracks = visibleTracks(ctx);

  const token = abortable();
  state.compute?.abort();
  state.compute = token;

  // 计算期间页面上只有"计算中…"与范围说明：宁可短暂空着，也不让上一轮的旧数字留在屏幕上冒充新结果
  const progress = el('span', { class: 'chip', text: '计算中…' });
  const scopeRow = el('div', { class: 'row' }, [scopeChip(ctx.markers.list(), range), progress]);
  container.replaceChildren(scopeRow);

  if (tracks.length === 0) {
    const empty = card('流水线', '没有可显示的 pip 轨道');
    empty.body.append(emptyState(ctx.trace.tracks.size === 0 ? '这份轨迹没有 pip 轨道' : '没有可显示的轨道'));
    progress.remove();
    state.highlights = [];
    state.compute = null;
    container.replaceChildren(scopeRow, empty.root);
    return;
  }

  const fragment = document.createDocumentFragment();
  const highlights: StageHighlight[] = [];
  const totals: PipelineTotals = { items: 0, closed: 0, open: 0, bubbles: 0, cycles: 0, filteredStages: 0, widest: null };

  const done = await runChunked(
    tracks.length,
    (from, to) => {
      for (let index = from; index < to; index++) {
        const track = tracks[index]!;
        const stats = stageNumbers(track, effectiveRange(track, range));
        addTotals(totals, track, stats);
        fragment.append(stageCard(track, stats, range, ctx, highlights));
      }
    },
    { signal: token.signal, budgetMs: 8 },
  );

  // 被取消（视图卸载，或已经有更新的一轮接手）：这一轮的产物整个丢弃，页面保持上一轮/新那一轮的内容。
  // 但要把**自己**挂上去的"计算中…"收掉 —— 被取消不等于算完，留着它会一直骗人
  if (!done || state.compute !== token) {
    progress.remove();
    if (state.compute === token) state.compute = null;
    return;
  }

  state.compute = null;
  state.highlights = highlights;
  progress.remove();
  container.replaceChildren(scopeRow, buildOverview(tracks, totals, range), fragment);

  // 渲染完就把当前选中态套上：切到这个视图时，别处选中的条目/周期也要看得见
  applySelection(state);
}

// ------------------------------------------------------------------ 选中联动

function applySelection(state: PipelineState): void {
  const selection = state.ctx.selection.get();
  for (const highlight of state.highlights) highlight.node.classList.toggle('is-selected', highlight.match(selection));
}

function mountView(container: HTMLElement, ctx: ViewContext): void {
  // 重建（换文件 / 改选项）：上一份订阅与上一轮没算完的重算都要收掉
  active?.unsubscribe?.();
  active?.markerUnsub?.();
  active?.compute?.abort();
  const state: PipelineState = { container, ctx, highlights: [], unsubscribe: null, markerUnsub: null, compute: null };
  // 标记订阅就是"只在松手时重算"的落点：`MarkerBus` 只在增删与**拖拽提交**时通知，
  // 拖拽过程中的每一像素都不发通知，所以这里不会被打成筛子
  state.markerUnsub = ctx.markers.subscribe(() => {
    void renderPipeline(state);
  });
  state.unsubscribe = ctx.selection.subscribe(() => applySelection(state));
  active = state;
  void renderPipeline(state);
}

export const pipelineView: View = {
  id: 'pipeline',
  title: '流水线',
  hint: '每级占用/空泡比例与延迟分布',
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
    active?.unsubscribe?.();
    active?.markerUnsub?.();
    // 卸载时把还没算完的一轮也停掉：算完也没人看，还会往已摘除的容器上写
    active?.compute?.abort();
    active = null;
  },
};

export default pipelineView;
