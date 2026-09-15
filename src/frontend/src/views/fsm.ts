/**
 * 状态机视图 —— 状态占用热力图、状态时序色带与跳转统计。
 *
 * 口径（spec §9.5）：状态是保持型的；`dwellCycles` = 相邻两条记录的周期差之和，
 * 色带区间是**半开**的 `[start, end)`，长度 = end − start。状态配色统一走 `colorFor(state)`，
 * 保证热力图与色带里同名同色。
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
  /** 当前被选中的状态机 key；为 null 时不淡化任何色带 */
  selectedKey: string | null;
}

let active: FsmState | null = null;

/** 每台状态机最多画这么多区段，避免超长轨迹把 DOM 撑爆 */
const MAX_SEGMENTS = 3000;

function visibleFsms(ctx: ViewContext): FsmTrack[] {
  const fsms = [...ctx.trace.fsms.values()];
  const domains = ctx.options.domains;
  return domains.length === 0 ? fsms : fsms.filter((fsm) => domains.includes(fsm.domain));
}

function dwellOf(fsm: FsmTrack, state: string): number | null {
  return fsm.dwellCycles.get(state) ?? null;
}

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
 */
function fsmCard(fsm: FsmTrack, ctx: ViewContext, state: FsmState): HTMLElement {
  const total = totalDwell(fsm);
  const peak = peakState(fsm);
  const tail = tailState(fsm);
  const cards = card(
    `状态机 · ${fsm.name}`,
    `域 ${fsm.domain} · ${fsm.stateSet.length} 个状态 · 总驻留 ${fmtInt(total)} 周期` +
      (peak ? ` · 峰值 ${peak.state} ${fmtInt(peak.dwell)} 周期` : '') +
      (tail !== null ? ` · 末状态 ${tail} 仍在上报（驻留未定型）` : ''),
  );

  const cells = el('div', {
    style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(108px,1fr));gap:6px',
  });
  const peakDwell = peak?.dwell ?? 0;
  for (const name of fsm.stateSet) {
    const dwell = dwellOf(fsm, name) ?? 0;
    const background = heatColor(peakDwell > 0 ? dwell / peakDwell : 0);
    const foreground = textColorOn(background);
    const share = total > 0 ? (dwell / total) * 100 : 0;
    const isTail = tail !== null && name === tail;
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
          `状态机 ${fsm.name}（域 ${fsm.domain}）`,
          `状态 ${name}`,
          `驻留 ${fmtInt(dwell)} 周期`,
          `占该状态机 ${share.toFixed(2)}%（总驻留 ${fmtInt(total)} 周期）`,
          isTail ? '末状态：后面还没有新记录，驻留周期数仍会增长（spec §9.5）' : '',
        ]
          .filter((line) => line !== '')
          .join('\n'),
      () =>
        selectFsm(ctx, fsm, `状态占用 · ${name}`, [
          ['状态机', fsm.name],
          ['时钟域', fsm.domain],
          ['状态', name],
          ['驻留周期', fmtInt(dwell)],
          ['占比', `${share.toFixed(2)}%`],
          ['该状态机总驻留', `${fmtInt(total)} 周期`],
          ['该状态机状态数', String(fsm.stateSet.length)],
          ['状态记录', `${fmtInt(fsm.samples.length)} 条`],
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
      { label: `按本状态机峰值 ${peakDwell > 0 ? fmtInt(peakDwell) : 0} 周期归一`, color: heatColor(0.7) },
    ]),
  );
  // ② 该状态机自己的状态时序色带
  cards.body.append(el('h4', { class: 'fsm-section', text: '状态时序色带' }), stateBands([fsm], ctx, state));
  // ③ 该状态机的状态转移图（由相邻两条 fsm 记录推断）
  cards.body.append(
    el('h4', { class: 'fsm-section', text: '状态转移图' }),
    el('p', {
      class: 'muted',
      style: 'margin:-2px 0 4px;font-size:11.5px',
      text: '箭头方向 = 转移方向，箭头颜色 = 转移频度；虚线圆圈是"起始"入口（第一条记录没有前驱状态）',
    }),
    transitionGraph(fsm, ctx),
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

/** 由相邻两条 fsm 记录推断转移，并按 (from, to) 聚合 */
function aggregateEdges(fsm: FsmTrack): EdgeAgg[] {
  const map = new Map<string, EdgeAgg>();
  for (const transition of fsm.transitions) {
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

function transitionGraph(fsm: FsmTrack, ctx: ViewContext): HTMLElement {
  const edges = aggregateEdges(fsm);
  const names = [...(edges.some((e) => e.from === START_NODE) ? [START_NODE] : []), ...fsm.stateSet];
  const pos = nodePositions(names);
  const total = Math.max(1, edges.reduce((sum, e) => sum + e.count, 0));
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
          `发生 ${fmtInt(edge.count)} 次 · 占该状态机跳转的 ${share.toFixed(1)}%`,
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
          ['时钟域', fsm.domain],
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
    const dwell = isStart ? null : (dwellOf(fsm, name) ?? 0);
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
              `驻留 ${fmtInt(dwell ?? 0)} 周期`,
              `来自 ${edges.filter((e) => e.to === name).reduce((sum, e) => sum + e.count, 0)} 次跳转`,
              `离开 ${edges.filter((e) => e.from === name).reduce((sum, e) => sum + e.count, 0)} 次`,
              '点击查看该状态的详情',
            ]).join('\n'),
      () =>
        isStart
          ? selectFsm(ctx, fsm, '起始状态', [['状态机', fsm.name], ['说明', '第一条 fsm 记录，没有前驱']])
          : selectFsm(ctx, fsm, `状态 · ${name}`, [
              ['状态机', fsm.name],
              ['时钟域', fsm.domain],
              ['驻留周期', fmtInt(dwell ?? 0)],
              ['占比', `${(((dwell ?? 0) / Math.max(1, totalDwell(fsm))) * 100).toFixed(2)}%`],
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
      { label: `${fmtInt(total)} 次跳转`, color: 'transparent' },
    ]),
  );
  return wrap;
}

// ------------------------------------------------------------------ 时序色带

const BAND_LABEL_WIDTH = 132;
const BAND_HEIGHT = 15;
const BAND_ROW_HEIGHT = 22;

function stateBands(fsms: FsmTrack[], ctx: ViewContext, state: FsmState): HTMLElement {
  let from = Number.POSITIVE_INFINITY;
  let to = 0;
  for (const fsm of fsms) {
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
  const height = fsms.length * BAND_ROW_HEIGHT + axisHeight;
  const svg = svgRoot(width, height);
  const x = linearScale(from, to + 1, BAND_LABEL_WIDTH, BAND_LABEL_WIDTH + plotWidth);
  const truncated: string[] = [];

  for (const [index, fsm] of fsms.entries()) {
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
    const segments = stateSegments(fsm);
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
            ['时钟域', fsm.domain],
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

  const axisY = fsms.length * BAND_ROW_HEIGHT;
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

function renderFsm(state: FsmState): void {
  const { container, ctx } = state;
  container.replaceChildren();
  state.highlights = [];

  const fsms = visibleFsms(ctx);
  if (fsms.length === 0) {
    const empty = card('状态机', '没有可显示的状态机');
    empty.body.append(emptyState(ctx.trace.fsms.size === 0 ? '这份轨迹没有 fsm 记录' : '当前时钟域筛选下没有状态机'));
    container.append(empty.root);
    return;
  }

  const allStates = new Set<string>();
  let transitions = 0;
  let loops = 0;
  let dwell = 0;
  for (const fsm of fsms) {
    for (const name of fsm.stateSet) allStates.add(name);
    transitions += fsm.transitions.length;
    loops += selfLoops(fsm);
    dwell += totalDwell(fsm);
  }

  // ---------------------------------------------------------------- 概览
  const overview = card('状态机概览', '状态是保持型的：驻留周期 = 相邻两条记录的周期差之和（spec §9.5）');
  overview.body.append(
    el('div', { class: 'stat-row' }, [
      statTile('状态机', countLabel(fsms.length), [...new Set(fsms.map((fsm) => fsm.domain))].join(' · ')),
      statTile('状态数', countLabel(allStates.size), `合计 ${fmtInt(fsms.reduce((sum, fsm) => sum + fsm.stateSet.length, 0))} 个（含重复）`),
      statTile('跳转', countLabel(transitions), `${fmtInt(fsms.reduce((sum, fsm) => sum + fsm.samples.length, 0))} 条状态记录`),
      statTile('自环', countLabel(loops), loops > 0 ? '同一状态连续两次上报' : '没有自环'),
      statTile('总驻留', countLabel(dwell), '所有状态机之和（周期）'),
    ]),
  );
  container.append(overview.root);

  // ---------------------------------------------------------------- 每台状态机各自的占用
  // 不把不同状态机塞进同一张表：每台状态机的状态集合、驻留口径与峰值都不同，
  // 合并后大多数格子会是空的，也看不出"某个模块各状态占了多少周期"。
  for (const fsm of fsms) container.append(fsmCard(fsm, ctx, state));

  applySelection(state);
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
  active?.unsubscribe?.();
  const state: FsmState = { container, ctx, highlights: [], unsubscribe: null, selectedKey: null };
  renderFsm(state);
  state.unsubscribe = ctx.selection.subscribe(() => applySelection(state));
  active = state;
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
    active?.unsubscribe?.();
    active = null;
  },
};

export default fsmView;
