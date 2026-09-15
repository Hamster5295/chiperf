/**
 * 流水线视图 —— **概览 + 每个流水级一张大方框**。
 *
 * 每个流水级（一条 `pip` 轨道 = 一级流水，如 `core.if`）的方框里放两项指标：
 *
 *  - **占用 vs 空泡（饼图）**：该级活跃周期里"有内容"与"空泡"的比例。
 *    占用度是半开区间 `[enter, close)`（spec §9.4），所以活跃区间内每个周期
 *    非"有内容"即"空泡"，两者相加就是活跃周期数。
 *  - **延迟分布（横向柱状图）**：只统计**同域已结束**条目（跨域条目不给周期延迟，
 *    spec §6.5），按出现次数取前 10 个延迟，并给出中位 / 平均 / 方差等数值。
 *
 * 其余内容（气泡区间列表、逐周期占用度曲线、跨域表、条目明细）已按要求移除；
 * 逐周期与逐条目的细节在时间轴视图里看。
 */
import type { TrackInfo } from '../../../parser/src/index.ts';
import { bubbleStats, latencyStats, type Distribution } from '../../../parser/src/index.ts';
import { card, countLabel, el, emptyState, hoverTarget, statTile, svgEl, svgRoot } from '../charts.ts';
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
}

let active: PipelineState | null = null;

function visibleTracks(ctx: ViewContext): TrackInfo[] {
  const tracks = [...ctx.trace.tracks.values()];
  const domains = ctx.options.domains;
  const shown = domains.length === 0 ? tracks : tracks.filter((track) => domains.includes(track.domain));
  // 按首次出现的周期排：流水级顺序（IF → ID → EX …）就是数据里出现的顺序
  return [...shown].sort((a, b) => a.firstCycle - b.firstCycle || a.name.localeCompare(b.name));
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

function occupancyMetric(track: TrackInfo, ctx: ViewContext): HTMLElement {
  const cycles = Math.max(0, track.lastCycle - track.firstCycle + 1);
  const bubbles = track.bubbles.length;
  const occupied = Math.max(0, cycles - bubbles);
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
  // 点空泡那一项：把该级第一个气泡周期广播出去（时间轴/其它视图跟着定位）
  const firstBubble = track.bubbles[0];
  if (firstBubble !== undefined) {
    const bubbleItem = [...legend.children][1] as HTMLElement | undefined;
    if (bubbleItem) {
      bubbleItem.style.cursor = 'pointer';
      bubbleItem.title = `跳到该级第一个气泡周期（周期 ${firstBubble}）`;
      bubbleItem.addEventListener('click', () => ctx.selection.set({ kind: 'cycle', domain: track.domain, cycle: firstBubble }));
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

function stageCard(track: TrackInfo, state: PipelineState): HTMLElement {
  const stats = latencyStats(track);
  const cycles = Math.max(0, track.lastCycle - track.firstCycle + 1);
  const node = card(
    track.name,
    `域 ${track.domain} · 周期 ${track.firstCycle}–${track.lastCycle}（${countLabel(cycles)} 周期）· ${countLabel(track.items.length)} 条目`,
  );
  const bubbles = bubbleStats(track);
  node.body.append(
    el('div', { class: 'stage-grid' }, [
      metric('占用 vs 空泡', `${countLabel(track.bubbles.length)} 个气泡周期`, [occupancyMetric(track, state.ctx)]),
      metric(
        '延迟分布',
        stats.count === 0 ? '没有已结束条目' : `同域已结束 ${fmtInt(stats.count)} 条 · 按次数取前 10`,
        [
          distributionList(stats, {
            unit: '周期',
            empty: '该级没有已结束条目（未闭合的不计入驻留分布）',
            tip: (value, count, share) => [`延迟 ${value} 周期`, `${fmtInt(count)} 条`, `占已结束条目 ${(share * 100).toFixed(1)}%`].join('\n'),
            note: (kinds, shown) => `共 ${kinds} 种延迟，这里取出现次数最多的 ${shown} 种`,
          }),
          distributionMetrics(stats, '条'),
        ],
      ),
      metric(
        '连续空泡数分布',
        bubbles.count === 0 ? '没有气泡' : `${fmtInt(bubbles.count)} 段 · 合计 ${countLabel(bubbles.count * bubbles.avg)} 周期`,
        [
          distributionList(bubbles, {
            unit: '周期',
            empty: '该级没有气泡（活跃区间内全程有内容）',
            tip: (value, count, share) =>
              [`连续 ${value} 周期空泡`, `${fmtInt(count)} 段`, `占全部气泡段 ${(share * 100).toFixed(1)}%`, '一段 = 该级连续若干周期没有在飞内容'].join('\n'),
            note: (kinds, shown) => `共 ${kinds} 种长度，这里取出现次数最多的 ${shown} 种`,
          }),
          distributionMetrics(bubbles, '段'),
        ],
      ),
    ]),
  );
  // 只有"选中了这条轨道上的某个条目"才高亮这一级：按周期选中会把同域的所有级都点亮，
  // 反而看不出是哪一个条目被选中了（周期级的联动交给时间轴自己的整列高光）
  state.highlights.push({
    node: node.root,
    match: (selection) => selection !== null && selection.kind === 'item' && selection.track === track.name,
  });
  return node.root;
}

// ------------------------------------------------------------------ 概览

function renderPipeline(state: PipelineState): void {
  const { container, ctx } = state;
  container.replaceChildren();
  state.highlights = [];

  const tracks = visibleTracks(ctx);
  if (tracks.length === 0) {
    const empty = card('流水线', '没有可显示的 pip 轨道');
    empty.body.append(emptyState(ctx.trace.tracks.size === 0 ? '这份轨迹没有 pip 轨道' : '当前时钟域筛选下没有轨道'));
    container.append(empty.root);
    return;
  }

  let items = 0;
  let closed = 0;
  let open = 0;
  let crossDomain = 0;
  let bubbles = 0;
  let cycles = 0;
  let widest: { track: string; start: number; end: number; length: number } | null = null;
  for (const track of tracks) {
    items += track.items.length;
    closed += track.closed;
    open += track.open;
    bubbles += track.bubbles.length;
    cycles += Math.max(0, track.lastCycle - track.firstCycle + 1);
    for (const item of track.items) if (item.crossDomain) crossDomain += 1;
    for (const range of track.bubbleRanges) {
      const length = range.end - range.start + 1;
      if (widest === null || length > widest.length) widest = { track: track.name, start: range.start, end: range.end, length };
    }
  }

  const overview = card('流水线概览', '占用度是半开区间 [enter, close)；气泡 = 活跃区间内占用为 0 的周期（spec §9.4）');
  overview.body.append(
    el('div', { class: 'stat-row' }, [
      statTile('流水级', countLabel(tracks.length), `域 ${[...new Set(tracks.map((t) => t.domain))].join(' · ')}`),
      statTile('在飞条目', countLabel(items), `${closed} 已结束 · ${open} 未闭合`),
      statTile(
        '占用率',
        cycles > 0 ? `${(((cycles - bubbles) / cycles) * 100).toFixed(1)}%` : '—',
        `${countLabel(cycles - bubbles)} 有内容 / ${countLabel(bubbles)} 空泡`,
      ),
      widest
        ? statTile('最长气泡', `${countLabel(widest.length)} 周期`, `${widest.track} · ${widest.start}–${widest.end}`)
        : statTile('最长气泡', '—', '没有气泡'),
      statTile('跨域条目', countLabel(crossDomain), '不计入周期延迟分布（§6.5）'),
    ]),
  );
  container.append(overview.root);

  for (const track of tracks) container.append(stageCard(track, state));

  // 渲染完就把当前选中态套上：切到这个视图时，别处选中的条目/周期也要看得见
  applySelection(state);
}

// ------------------------------------------------------------------ 选中联动

function applySelection(state: PipelineState): void {
  const selection = state.ctx.selection.get();
  for (const highlight of state.highlights) highlight.node.classList.toggle('is-selected', highlight.match(selection));
}

function mountView(container: HTMLElement, ctx: ViewContext): void {
  active?.unsubscribe?.();
  const state: PipelineState = { container, ctx, highlights: [], unsubscribe: null };
  renderPipeline(state);
  state.unsubscribe = ctx.selection.subscribe(() => applySelection(state));
  active = state;
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
    active = null;
  },
};

export default pipelineView;
