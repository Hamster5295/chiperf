/**
 * 状态机视图 —— 状态占用热力图、状态时序色带与跳转统计。
 *
 * 口径（spec §9.5）：状态是保持型的；`dwellCycles` = 相邻两条记录的周期差之和，
 * 色带区间是**半开**的 `[start, end)`，长度 = end − start。状态配色统一走 `colorFor(state)`，
 * 保证热力图与色带里同名同色。
 */
import type { FsmTrack } from '../../../parser/src/index.ts';
import { stateSegments } from '../../../parser/src/index.ts';
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
function fsmHeatCard(fsm: FsmTrack, ctx: ViewContext, state: FsmState): HTMLElement {
  const total = totalDwell(fsm);
  const peak = peakState(fsm);
  const tail = tailState(fsm);
  const cards = card(
    `状态占用 · ${fsm.name}`,
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

  cards.body.append(
    cells,
    legend([
      { label: '驻留少', color: heatColor(0) },
      { label: '驻留多', color: heatColor(1) },
      { label: `按本状态机峰值 ${peakDwell > 0 ? fmtInt(peakDwell) : 0} 周期归一`, color: heatColor(0.7) },
    ]),
  );

  state.highlights.push({
    node: cards.root,
    match: (selection) => selection?.kind === 'fsm' && selection.key === fsm.key,
  });
  return cards.root;
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

interface TransitionRow {
  fsm: FsmTrack;
  from: string | null;
  to: string;
  count: number;
  selfLoop: boolean;
}

function transitionRows(fsms: FsmTrack[]): TransitionRow[] {
  const rows: TransitionRow[] = [];
  const index = new Map<string, TransitionRow>();
  for (const fsm of fsms) {
    for (const transition of fsm.transitions) {
      const key = `${fsm.key}\u0000${transition.from ?? ''}\u0000${transition.to}`;
      const found = index.get(key);
      if (found) {
        found.count += 1;
        found.selfLoop = found.selfLoop || transition.selfLoop;
        continue;
      }
      const row: TransitionRow = {
        fsm,
        from: transition.from,
        to: transition.to,
        count: 1,
        selfLoop: transition.selfLoop,
      };
      index.set(key, row);
      rows.push(row);
    }
  }
  rows.sort(
    (a, b) =>
      a.fsm.name.localeCompare(b.fsm.name) ||
      b.count - a.count ||
      (a.from ?? '').localeCompare(b.from ?? '') ||
      a.to.localeCompare(b.to),
  );
  return rows;
}

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
  for (const fsm of fsms) container.append(fsmHeatCard(fsm, ctx, state));

  // ---------------------------------------------------------------- 色带
  const bandCard = card('状态时序色带', '状态区间是半开的 [start, end)，长度 = end − start；颜色与热力图一致');
  bandCard.body.append(
    legend([...allStates].map((name) => ({ label: name, color: colorFor(name) }))),
    stateBands(fsms, ctx, state),
  );
  container.append(bandCard.root);

  // ---------------------------------------------------------------- 跳转表
  const rows = transitionRows(fsms);
  const jumpCard = card('跳转表（跨状态机）', 'from → to 聚合计数，含自环（同一状态连续上报，spec §9.5）；按状态机分组便于对照');
  if (rows.length === 0) {
    jumpCard.body.append(emptyState('没有跳转记录'));
  } else {
    const jumpTable = el('div', { class: 'table-wrap' }, [
      el('table', { class: 'table' }, [
        el('thead', {}, [
          el('tr', {}, ['状态机', '从', '到', '次数', '占比', '备注'].map((h) => el('th', { text: h }))),
        ]),
        el(
          'tbody',
          {},
          rows.map((row) => {
            const fsmTotal = Math.max(1, row.fsm.transitions.length);
            const tr = el('tr', {}, [
              el('td', {}, [el('code', { class: 'mono', text: row.fsm.name })]),
              el('td', { class: 'mono', text: row.from ?? '（初始）' }),
              el('td', { class: 'mono', text: row.to }),
              el('td', { class: 'num', text: fmtInt(row.count) }),
              el('td', { class: 'num', text: `${((row.count / fsmTotal) * 100).toFixed(1)}%` }),
              el(
                'td',
                { style: row.selfLoop ? 'color:var(--warn);font-weight:600' : undefined },
                [el('span', { text: row.selfLoop ? '自环' : '' })],
              ),
            ]);
            tr.style.cursor = 'pointer';
            tr.addEventListener('click', () => {
              selectFsm(ctx, row.fsm, `跳转 ${row.from ?? '（初始）'} → ${row.to}`, [
                ['状态机', row.fsm.name],
                ['时钟域', row.fsm.domain],
                ['从', row.from ?? '（初始，第一条记录）'],
                ['到', row.to],
                ['次数', fmtInt(row.count)],
                ['自环', row.selfLoop ? '是' : '否'],
                ['该状态机跳转总数', fmtInt(row.fsm.transitions.length)],
                ['该状态机总驻留', `${fmtInt(totalDwell(row.fsm))} 周期`],
              ]);
            });
            state.highlights.push({
              node: tr,
              match: (selection) => selection?.kind === 'fsm' && selection.key === row.fsm.key,
            });
            return tr;
          }),
        ),
      ]),
    ]);
    jumpCard.body.append(jumpTable);
  }
  container.append(jumpCard.root);

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
