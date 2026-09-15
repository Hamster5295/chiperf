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

/** 状态列顺序：按各状态机出现顺序归并（稳定、可复现） */
function stateColumns(fsms: FsmTrack[]): string[] {
  const columns: string[] = [];
  for (const fsm of fsms) {
    for (const state of fsm.stateSet) if (!columns.includes(state)) columns.push(state);
  }
  return columns;
}

// ------------------------------------------------------------------ 热力图

function heatmap(fsms: FsmTrack[], columns: string[], ctx: ViewContext, state: FsmState): HTMLElement {
  let peak = 0;
  for (const fsm of fsms) {
    for (const dwell of fsm.dwellCycles.values()) if (dwell > peak) peak = dwell;
  }
  const width = `${Math.max(64, Math.round(420 / Math.max(1, columns.length)))}px`;

  const header = el('tr', {}, [
    el('th', { text: '状态机' }),
    ...columns.map((column) =>
      el('th', { style: `text-align:center;min-width:${width}` }, [
        el('span', { style: `color:${colorFor(column)}`, text: column }),
      ]),
    ),
    el('th', { style: 'text-align:right', text: '总驻留' }),
  ]);

  const bodyRows = fsms.map((fsm) => {
    const total = totalDwell(fsm);
    const row = el('tr', {}, [
      el('td', {}, [
        el('code', { class: 'mono', text: fsm.name }),
        el('div', { class: 'muted', style: 'font-size:10.5px', text: `${fsm.domain} · ${fmtInt(fsm.samples.length)} 条记录` }),
      ]),
      ...columns.map((column) => {
        const dwell = dwellOf(fsm, column);
        if (dwell === null) {
          const blank = el('td', { style: 'text-align:center' }, [el('div', { style: 'height:19px' })]);
          hoverTarget(blank, () => `${fsm.name}\n没有状态 ${column}`);
          return blank;
        }
        const background = heatColor(peak > 0 ? dwell / peak : 0);
        const cell = el('div', {
          style: `background:${background};color:${textColorOn(background)};border-radius:4px;padding:4px 6px;text-align:center;font-variant-numeric:tabular-nums;font-size:11px;cursor:pointer`,
          text: fmtInt(dwell),
        });
        const share = total > 0 ? (dwell / total) * 100 : 0;
        hoverTarget(
          cell,
          () => `${fsm.name}\n状态 ${column}\n驻留 ${fmtInt(dwell)} 周期\n占该状态机 ${share.toFixed(1)}%（总驻留 ${fmtInt(total)} 周期）`,
          () => selectFsm(ctx, fsm, `热力图 · ${column}`, [
            ['状态机', fsm.name],
            ['时钟域', fsm.domain],
            ['状态', column],
            ['驻留周期', fmtInt(dwell)],
            ['占比', `${share.toFixed(2)}%`],
            ['该状态机总驻留', `${fmtInt(total)} 周期`],
            ['状态数', String(fsm.stateSet.length)],
          ]),
        );
        return el('td', {}, [cell]);
      }),
      el('td', { class: 'num', text: fmtInt(total) }),
    ]);
    state.highlights.push({
      node: row,
      match: (selection) => selection?.kind === 'fsm' && selection.key === fsm.key,
    });
    return row;
  });

  return el('div', { class: 'table-wrap' }, [
    el('table', { class: 'table' }, [el('thead', {}, [header]), el('tbody', {}, bodyRows)]),
  ]);
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
  rows.sort((a, b) => b.count - a.count || a.fsm.name.localeCompare(b.fsm.name) || (a.from ?? '').localeCompare(b.from ?? ''));
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

  const columns = stateColumns(fsms);
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

  // ---------------------------------------------------------------- 热力图
  const heatCard = card('状态占用热力图', '格子颜色 = 驻留周期（按全局最大值归一）；空白表示该状态机没有这个状态');
  heatCard.body.append(el('div', { class: 'chart-scroll' }, [heatmap(fsms, columns, ctx, state)]));
  heatCard.body.append(
    legend([
      { label: '驻留少', color: heatColor(0) },
      { label: '驻留多', color: heatColor(1) },
    ]),
  );
  container.append(heatCard.root);

  // ---------------------------------------------------------------- 色带
  const bandCard = card('状态时序色带', '状态区间是半开的 [start, end)，长度 = end − start；颜色与热力图一致');
  bandCard.body.append(
    legend([...allStates].map((name) => ({ label: name, color: colorFor(name) }))),
    stateBands(fsms, ctx, state),
  );
  container.append(bandCard.root);

  // ---------------------------------------------------------------- 跳转表
  const rows = transitionRows(fsms);
  const jumpCard = card('跳转表', 'from → to 聚合计数，含自环（同一状态连续上报，spec §9.5）');
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
