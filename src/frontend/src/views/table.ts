/**
 * 表格视图 —— 智能数据表：数据集切换 / 多列排序 / 过滤 / 列开关 / 虚拟滚动 / 行详情 / CSV 导出
 *
 * 性能：所有数据集共用一条"固定行高 + 只渲染可视窗口"的渲染路径，
 * 任何时刻 DOM 里最多 ~50 个 <tr>，因此几万行也不会卡。
 * 排序键、选中键一律用**列键 / 字符串键**而不是行列下标，切数据集或换文件都不会错位。
 */
import { cycleTime, fmtInt, fmtPosition, fmtValue, type Selection, type View, type ViewContext } from '../view.ts';
import { clear, colorFor, el, hoverTarget } from '../charts.ts';
import type {
  CounterTrack,
  Diagnostic,
  EventRecord,
  EventTrack,
  FsmTrack,
  PipelineItem,
  ScalarValue,
  SkippedLine,
  Timed,
  Trace,
  ValueTrack,
} from '../../../parser/src/index.ts';

// ------------------------------------------------------------------ 常量

const DASH = '—';
/** 固定行高（px）；虚拟滚动完全依赖它 */
const ROW_H = 28;
const HEAD_H = 30;
/** 可视窗口上下各预渲染多少行（留缓冲，小滚动就不必重画） */
const BUFFER = 12;

const CELL_STYLE = 'padding:0 10px;overflow:hidden;text-overflow:ellipsis';
const INPUT_STYLE =
  'font:inherit;font-size:12px;padding:5px 9px;border-radius:var(--radius-sm);border:1px solid var(--border-strong);background:var(--surface);color:var(--text);min-width:210px';
const SELECT_STYLE =
  'font:inherit;font-size:12px;padding:5px 8px;border-radius:var(--radius-sm);border:1px solid var(--border-strong);background:var(--surface);color:var(--text)';
const PANEL_STYLE =
  'position:absolute;right:0;top:calc(100% + 6px);z-index:6;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);box-shadow:var(--shadow);padding:8px;min-width:210px;max-height:320px;overflow:auto;display:flex;flex-direction:column;gap:3px;text-align:left';
const PILL_STYLE =
  'position:absolute;right:8px;bottom:6px;padding:2px 9px;border-radius:999px;border:1px solid var(--border);background:color-mix(in srgb, var(--surface) 92%, transparent);color:var(--text-muted);font-size:11px;pointer-events:none';

// ------------------------------------------------------------------ 列与行模型

type SortValue = number | string | null;

/** 一个单元格：字符串是简写；对象可带排序键、等宽、chip 等附加信息 */
interface CellSpec {
  /** 显示文本（同时用于搜索与 CSV 导出） */
  t: string;
  /** 完整文本（显示被截断时，悬停/详情用全文） */
  full?: string;
  mono?: boolean;
  color?: string;
  /** 以 chip 形式渲染 */
  chip?: boolean;
  /** 覆盖排序键（默认按文本推断） */
  sort?: SortValue;
}

type CellOut = string | CellSpec;

interface ColumnSpec<T> {
  key: string;
  label: string;
  /** 列宽（px，配合 table-layout:fixed；容器更宽时按比例分配） */
  width: number;
  align?: 'right';
  mono?: boolean;
  cell(row: T): CellOut;
}

/** 泛型被擦除后的数据集：行是 unknown，取值经闭包转发 */
interface Dataset {
  id: string;
  title: string;
  hint: string;
  empty: string;
  columns: ColumnSpec<never>[];
  colKeys: string[];
  rows: unknown[];
  /** 记录页的类型 chip（值为 null 时不显示） */
  kinds: { kind: string; count: number }[] | null;
  defaultSort: SortSpec[];
  cell(row: unknown, col: number): CellOut;
  sortValue(row: unknown, col: number): SortValue;
  selection(row: unknown): Selection;
  kindOf(row: unknown): string | null;
  titleOf(row: unknown): string;
  detail(row: unknown): [string, string][];
}

interface DatasetSpec<T> {
  id: string;
  title: string;
  hint: string;
  empty: string;
  columns: ColumnSpec<T>[];
  rows(): T[];
  /** 需要类型快速过滤时给出候选类型 */
  kinds?: string[];
  defaultSort?: { key: string; dir: 1 | -1 }[];
  selection(row: T): Selection;
  kindOf?(row: T): string | null;
  titleOf(row: T): string;
  detail(row: T): [string, string][];
}

function defineDataset<T>(spec: DatasetSpec<T>): Dataset {
  const rows = spec.rows();
  let kinds: { kind: string; count: number }[] | null = null;
  if (spec.kinds) {
    const counts = new Map<string, number>(spec.kinds.map((k) => [k, 0]));
    for (const row of rows) {
      const kind = spec.kindOf?.(row);
      if (kind !== undefined && kind !== null && counts.has(kind)) counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    kinds = [...counts]
      .filter(([, n]) => n > 0)
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
  }
  const defaultSort: SortSpec[] = [];
  for (const wanted of spec.defaultSort ?? []) {
    if (spec.columns.some((c) => c.key === wanted.key)) defaultSort.push({ key: wanted.key, dir: wanted.dir });
  }
  return {
    id: spec.id,
    title: spec.title,
    hint: spec.hint,
    empty: spec.empty,
    columns: spec.columns as unknown as ColumnSpec<never>[],
    colKeys: spec.columns.map((c) => c.key),
    rows,
    kinds,
    defaultSort,
    cell: (row, col) => spec.columns[col]!.cell(row as T),
    sortValue: (row, col) => sortKeyOf(spec.columns[col]!.cell(row as T)),
    selection: (row) => spec.selection(row as T),
    kindOf: (row) => spec.kindOf?.(row as T) ?? null,
    titleOf: (row) => spec.titleOf(row as T),
    detail: (row) => spec.detail(row as T),
  };
}

function cellText(cell: CellOut): string {
  return typeof cell === 'string' ? cell : cell.t;
}

function sortKeyOf(cell: CellOut): SortValue {
  if (typeof cell !== 'string' && cell.sort !== undefined) return cell.sort;
  const text = cellText(cell);
  if (text === '' || text === DASH) return null;
  return /^-?\d{1,15}$/.test(text) ? Number(text) : text.toLowerCase();
}

function compareSort(a: SortValue, b: SortValue): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1; // 空值恒排最后
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'zh');
}

interface Row {
  raw: unknown;
  /** 在数据集里的原始下标，用于稳定排序 */
  index: number;
  /** 缓存的搜索用文本 + 生成它时的可见列签名 */
  hay: string;
  haySig: string;
}

interface SortSpec {
  key: string;
  dir: 1 | -1;
}

/** 行的选中标识（与 Selection 一一对应） */
function selectionKey(sel: Selection): string | null {
  if (!sel) return null;
  switch (sel.kind) {
    case 'item':
      return `item\u0000${sel.track}\u0000${sel.enterSeq}`;
    case 'cycle':
      return `cycle\u0000${sel.cycle}`;
    case 'counter':
      return `counter\u0000${sel.key}`;
    case 'value':
      return `value\u0000${sel.key}`;
    case 'fsm':
      return `fsm\u0000${sel.key}`;
    case 'record':
      return `record\u0000${sel.seq}`;
  }
}

// ------------------------------------------------------------------ 单元格小工具

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function yesNo(value: boolean): CellSpec {
  return { t: value ? '是' : '否', sort: value ? 1 : 0 };
}

function chip(text: string, color: string, sort?: SortValue): CellSpec {
  return { t: text, color, chip: true, sort };
}

function numeric(text: string, sort: number): CellSpec {
  return { t: text, sort, mono: true };
}

function phaseName(phase: string): string {
  return phase === '-' ? '尚无时钟' : phase === 'p' ? 'p（上升沿之后）' : 'n（下降沿之后）';
}

// ------------------------------------------------------------------ 各数据集

function recordName(r: EventRecord): string {
  switch (r.kind) {
    case 'cnt':
    case 'val':
    case 'fsm':
    case 'evt':
      return r.name;
    case 'pip':
      return r.track;
    default:
      return DASH;
  }
}

function recordValue(r: EventRecord): string {
  switch (r.kind) {
    case 'clk':
      return r.edge === 'p' ? '↑ 上升沿' : '↓ 下降沿';
    case 'cnt':
      return r.delta !== null ? `+${r.delta}` : r.abs !== null ? `= ${r.abs}` : DASH;
    case 'val':
      return fmtValue(r.value);
    case 'pip':
      return r.value ? fmtValue(r.value) : 'bubble';
    case 'fsm':
      return fmtValue(r.state);
    case 'evt':
      return r.payload ? fmtValue(r.payload) : DASH;
    case 'msg':
      return r.text;
  }
}

function recordDetail(r: EventRecord): [string, string][] {
  const rows: [string, string][] = [
    ['序号', String(r.seq)],
    ['行号', String(r.line)],
    ['类型', r.kind],
    ['位置', fmtPosition(r.pos)],
    ['周期', String(r.pos.cycle)],
    ['相位', phaseName(r.pos.phase)],
    ['async', r.async ? '是（不在时钟沿上，落在周期内部）' : '否'],
  ];
  switch (r.kind) {
    case 'clk':
      rows.push(['时钟沿', r.edge === 'p' ? '上升沿' : '下降沿']);
      break;
    case 'cnt':
      rows.push(['计数器', r.name], ['增量', r.delta === null ? DASH : String(r.delta)], ['绝对值', r.abs === null ? DASH : String(r.abs)]);
      break;
    case 'val':
      rows.push(['数值轨', r.name], ['取值', fmtValue(r.value)], ['原始记号', r.value.raw]);
      break;
    case 'pip':
      rows.push(['轨道', r.track], ['新值', r.value ? fmtValue(r.value) : 'bubble（该级变空）']);
      break;
    case 'fsm':
      rows.push(['状态机', r.name], ['状态', fmtValue(r.state)], ['原始记号', r.state.raw]);
      break;
    case 'evt':
      rows.push(['事件', r.name], ['载荷', r.payload ? fmtValue(r.payload) : DASH]);
      break;
    case 'msg':
      rows.push(['消息', r.text]);
      break;
  }
  rows.push(['原始行', r.raw]);
  return rows;
}

function recordDataset(trace: Trace): Dataset {
  return defineDataset<EventRecord>({
    id: 'records',
    title: '记录',
    hint: '逐条事件记录；async=1 的记录不是时钟沿采样得到的，落在周期内部',
    empty: '这份轨迹没有任何事件记录',
    kinds: ['clk', 'cnt', 'val', 'pip', 'fsm', 'evt', 'msg'],
    defaultSort: [{ key: 'seq', dir: 1 }],
    rows: () => trace.records,
    kindOf: (r) => r.kind,
    selection: (r) => ({ kind: 'record', seq: r.seq }),
    titleOf: (r) => `${r.kind} · ${fmtPosition(r.pos)}`,
    columns: [
      { key: 'seq', label: 'seq', width: 66, align: 'right', cell: (r) => numeric(String(r.seq), r.seq) },
      { key: 'line', label: '行', width: 62, align: 'right', cell: (r) => numeric(String(r.line), r.line) },
      { key: 'kind', label: '类型', width: 64, cell: (r) => chip(r.kind, colorFor(r.kind), r.kind) },
      {
        key: 'cycle',
        label: '周期',
        width: 148,
        align: 'right',
        cell: (r) => ({
          t: cycleTime(r.pos.cycle),
          sort: r.pos.cycle,
        }),
      },
      {
        key: 'phase',
        label: '相位',
        width: 58,
        cell: (r) => ({ t: r.pos.phase, sort: r.pos.phase === '-' ? -1 : r.pos.phase === 'p' ? 0 : 1 }),
      },
      { key: 'async', label: 'async', width: 66, cell: (r) => (r.async ? chip('async', 'var(--warn)', 1) : { t: DASH, sort: 0 }) },
      { key: 'name', label: '名字/轨道', width: 168, cell: (r) => ({ t: recordName(r), mono: true }) },
      { key: 'value', label: '值/状态', width: 178, cell: (r) => ({ t: recordValue(r), mono: true }) },
      { key: 'raw', label: '原始行', width: 330, cell: (r) => ({ t: clip(r.raw, 90), full: r.raw, mono: true }) },
    ],
    detail: (r) => recordDetail(r),
  });
}

type ItemRow = { item: PipelineItem };

function itemDetail(item: PipelineItem): [string, string][] {
  return [
    ['轨道', item.track],
    ['持有值', item.value ? `${fmtValue(item.value)}（原始 ${item.value.raw}）` : DASH],
    ['起始位置', fmtPosition(item.enter)],
    ['结束位置', item.close ? fmtPosition(item.close) : DASH],
    ['状态', item.close ? '已结束（被后续记录改掉）' : '文件结束时仍持有至今'],
    ['驻留周期', item.latencyCycles !== null ? `${item.latencyCycles} 周期` : DASH],
    ['起始记录异步', item.async ? '是' : '否'],
    ['结束记录异步', item.closeAsync ? '是' : '否'],
    ['起始行号', String(item.enterLine)],
    ['结束行号', item.closeLine !== null ? String(item.closeLine) : DASH],
    ['起始序号 / 结束序号', `${item.enterSeq} / ${item.closeSeq ?? DASH}`],
  ];
}

function itemDataset(trace: Trace): Dataset {
  return defineDataset<ItemRow>({
    id: 'items',
    title: '轨道条目',
    hint: '每条 pip 条目一行：该级连续持有同一个值的那一段；占用区间是半开区间 [enter, close)',
    empty: '这份轨迹没有 pip 条目',
    defaultSort: [{ key: 'enter', dir: 1 }],
    rows: () => {
      const out: ItemRow[] = [];
      for (const track of trace.tracks.values()) for (const item of track.items) out.push({ item });
      return out;
    },
    selection: (r) => ({ kind: 'item', track: r.item.track, enterSeq: r.item.enterSeq }),
    titleOf: (r) => `条目 ${r.item.track} #${r.item.enterSeq}`,
    columns: [
      { key: 'track', label: '轨道', width: 130, mono: true, cell: (r) => ({ t: r.item.track, mono: true, color: colorFor(r.item.track) }) },
      {
        key: 'value',
        label: '持有值',
        width: 160,
        mono: true,
        cell: (r) => ({ t: r.item.value ? fmtValue(r.item.value) : DASH, mono: true, sort: r.item.value?.text ?? null }),
      },
      { key: 'enter', label: '入周期', width: 84, align: 'right', cell: (r) => numeric(String(r.item.enter.cycle), r.item.enter.cycle) },
      {
        key: 'close',
        label: '结束周期',
        width: 96,
        align: 'right',
        cell: (r) => {
          const close = r.item.close;
          if (!close) return { t: DASH, sort: null };
          return numeric(String(close.cycle), close.cycle);
        },
      },
      {
        key: 'latency',
        label: '延迟',
        width: 92,
        align: 'right',
        cell: (r) => {
          if (r.item.latencyCycles !== null) return numeric(String(r.item.latencyCycles), r.item.latencyCycles);
          return { t: DASH, sort: null };
        },
      },
      {
        key: 'state',
        label: '状态',
        width: 82,
        cell: (r) => (r.item.close ? chip('已结束', 'var(--ok)', 0) : chip('未闭合', 'var(--warn)', 2)),
      },
      {
        key: 'async',
        label: '异步',
        width: 74,
        cell: (r) => {
          const text = r.item.async && r.item.closeAsync ? '起+止' : r.item.async ? '起' : r.item.closeAsync ? '止' : '';
          return text === '' ? { t: DASH, sort: 0 } : chip(text, 'var(--warn)', 1);
        },
      },
    ],
    detail: (r) => itemDetail(r.item),
  });
}

type CounterRow = { track: CounterTrack; absReads: number };

function counterDataset(trace: Trace): Dataset {
  return defineDataset<CounterRow>({
    id: 'counters',
    title: '计数器',
    hint: '追踪键 = (域, 名字)；abs= 记录只置总量、不贡献增量',
    empty: '这份轨迹没有计数器',
    defaultSort: [{ key: 'name', dir: 1 }],
    rows: () =>
      [...trace.counters.values()].map((track) => ({
        track,
        absReads: track.samples.reduce((n, s) => (s.abs !== null ? n + 1 : n), 0),
      })),
    selection: (r) => ({ kind: 'counter', key: r.track.key }),
    titleOf: (r) => `计数器 ${r.track.name}`,
    columns: [
      { key: 'name', label: '名字', width: 170, mono: true, cell: (r) => ({ t: r.track.name, mono: true }) },
      { key: 'total', label: '终值', width: 110, align: 'right', cell: (r) => numeric(String(r.track.total), r.track.total) },
      { key: 'samples', label: '采样数', width: 84, align: 'right', cell: (r) => numeric(String(r.track.samples.length), r.track.samples.length) },
      { key: 'abs', label: 'abs 回读', width: 86, align: 'right', cell: (r) => numeric(String(r.absReads), r.absReads) },
      {
        key: 'changes',
        label: '变化周期数',
        width: 100,
        align: 'right',
        cell: (r) => numeric(String(r.track.changeCycles.length), r.track.changeCycles.length),
      },
      {
        key: 'range',
        label: '变化区间',
        width: 132,
        mono: true,
        cell: (r) => {
          const cycles = r.track.changeCycles;
          if (cycles.length === 0) return { t: DASH, sort: null, mono: true };
          return { t: `${cycles[0]} – ${cycles[cycles.length - 1]}`, sort: cycles[0], mono: true };
        },
      },
    ],
    detail: (r) => {
      const first = r.track.samples[0];
      const last = r.track.samples[r.track.samples.length - 1];
      return [
        ['计数器', r.track.name],
        ['追踪键', r.track.key],
        ['终值', String(r.track.total)],
        ['采样数', String(r.track.samples.length)],
        ['abs= 回读', String(r.absReads)],
        ['变化周期数', String(r.track.changeCycles.length)],
        ['首次采样', first ? `第 ${first.line} 行 · ${fmtPosition(first.pos)}` : DASH],
        ['末次采样', last ? `第 ${last.line} 行 · ${fmtPosition(last.pos)}` : DASH],
        ['累计取值周期数', String(r.track.totalByCycle.size)],
      ];
    },
  });
}

type ValueRow = { track: ValueTrack; last: Timed<ScalarValue> | undefined };

function valueDataset(trace: Trace): Dataset {
  return defineDataset<ValueRow>({
    id: 'values',
    title: '数值',
    hint: '保持型数值轨：采样后一直保持到下一条记录',
    empty: '这份轨迹没有数值轨',
    defaultSort: [{ key: 'name', dir: 1 }],
    rows: () =>
      [...trace.values.values()].map((track) => ({
        track,
        last: track.samples[track.samples.length - 1],
      })),
    selection: (r) => ({ kind: 'value', key: r.track.key }),
    titleOf: (r) => `数值 ${r.track.name}`,
    columns: [
      { key: 'name', label: '名字', width: 180, mono: true, cell: (r) => ({ t: r.track.name, mono: true }) },
      { key: 'samples', label: '采样数', width: 84, align: 'right', cell: (r) => numeric(String(r.track.samples.length), r.track.samples.length) },
      { key: 'changes', label: '变化数', width: 84, align: 'right', cell: (r) => numeric(String(r.track.changes.length), r.track.changes.length) },
      {
        key: 'value',
        label: '最后取值',
        width: 170,
        mono: true,
        cell: (r) => ({ t: r.last ? fmtValue(r.last.value) : DASH, mono: true, sort: r.last?.value.text ?? null }),
      },
      {
        key: 'cycle',
        label: '最后周期',
        width: 92,
        align: 'right',
        cell: (r) => (r.last ? numeric(String(r.last.pos.cycle), r.last.pos.cycle) : { t: DASH, sort: null }),
      },
    ],
    detail: (r) => [
      ['数值轨', r.track.name],
      ['追踪键', r.track.key],
      ['采样数', String(r.track.samples.length)],
      ['变化数', String(r.track.changes.length)],
      ['最后取值', r.last ? fmtValue(r.last.value) : DASH],
      ['原始记号', r.last ? r.last.value.raw : DASH],
      ['最后位置', r.last ? fmtPosition(r.last.pos) : DASH],
      ['取值类型', r.last ? r.last.value.kind : DASH],
    ],
  });
}

type FsmRow = { fsm: FsmTrack; from: string | null; to: string; cycle: number; phase: string; selfLoop: boolean; seq: number };

function fsmDataset(trace: Trace): Dataset {
  return defineDataset<FsmRow>({
    id: 'fsm',
    title: '状态机跳转',
    hint: '逐条状态跳转；自环是状态没变但仍然写下的记录',
    empty: '这份轨迹没有状态机',
    defaultSort: [{ key: 'cycle', dir: 1 }],
    rows: () => {
      const out: FsmRow[] = [];
      for (const fsm of trace.fsms.values()) {
        for (const t of fsm.transitions) {
          out.push({ fsm, from: t.from, to: t.to, cycle: t.pos.cycle, phase: t.pos.phase, selfLoop: t.selfLoop, seq: t.pos.seq });
        }
      }
      return out;
    },
    selection: (r) => ({ kind: 'fsm', key: r.fsm.key }),
    titleOf: (r) => `跳转 ${r.fsm.name}: ${r.from ?? '(初始)'} → ${r.to}`,
    columns: [
      { key: 'fsm', label: '状态机', width: 160, mono: true, cell: (r) => ({ t: r.fsm.name, mono: true, color: colorFor(r.fsm.name) }) },
      { key: 'from', label: 'from', width: 130, mono: true, cell: (r) => ({ t: r.from ?? '(初始)', mono: true, sort: r.from }) },
      { key: 'to', label: 'to', width: 130, mono: true, cell: (r) => ({ t: r.to, mono: true, sort: r.to }) },
      { key: 'cycle', label: '周期', width: 92, align: 'right', cell: (r) => numeric(String(r.cycle), r.cycle) },
      { key: 'phase', label: '相位', width: 58, cell: (r) => ({ t: r.phase, sort: r.phase }) },
      { key: 'loop', label: '自环', width: 70, cell: (r) => (r.selfLoop ? chip('自环', 'var(--accent)', 1) : { t: DASH, sort: 0 }) },
      {
        key: 'dwell',
        label: 'to 驻留',
        width: 92,
        align: 'right',
        cell: (r) => numeric(String(r.fsm.dwellCycles.get(r.to) ?? 0), r.fsm.dwellCycles.get(r.to) ?? 0),
      },
    ],
    detail: (r) => [
      ['状态机', r.fsm.name],
      ['追踪键', r.fsm.key],
      ['from', r.from ?? '(初始)'],
      ['to', r.to],
      ['周期', String(r.cycle)],
      ['相位', phaseName(r.phase)],
      ['自环', r.selfLoop ? '是' : '否'],
      ['序号', String(r.seq)],
      ['状态集合', r.fsm.stateSet.join(' · ') || DASH],
      ['to 驻留周期', String(r.fsm.dwellCycles.get(r.to) ?? 0)],
      ['跳转总数', String(r.fsm.transitions.length)],
    ],
  });
}

type EventRow = { track: EventTrack; sample: Timed<ScalarValue | null> };

function eventDataset(trace: Trace): Dataset {
  return defineDataset<EventRow>({
    id: 'events',
    title: '事件',
    hint: '瞬时事件（evt）：每一次到达算一行',
    empty: '这份轨迹没有瞬时事件',
    defaultSort: [{ key: 'cycle', dir: 1 }],
    rows: () => {
      const out: EventRow[] = [];
      for (const track of trace.events.values()) for (const sample of track.samples) out.push({ track, sample });
      return out;
    },
    selection: (r) => ({ kind: 'record', seq: r.sample.pos.seq }),
    titleOf: (r) => `事件 ${r.track.name} · ${fmtPosition(r.sample.pos)}`,
    columns: [
      { key: 'name', label: '名字', width: 190, mono: true, cell: (r) => ({ t: r.track.name, mono: true, color: colorFor(r.track.name) }) },
      {
        key: 'payload',
        label: '载荷',
        width: 170,
        mono: true,
        cell: (r) => ({ t: r.sample.value ? fmtValue(r.sample.value) : DASH, mono: true, sort: r.sample.value?.text ?? null }),
      },
      { key: 'cycle', label: '周期', width: 92, align: 'right', cell: (r) => numeric(String(r.sample.pos.cycle), r.sample.pos.cycle) },
      { key: 'phase', label: '相位', width: 58, cell: (r) => ({ t: r.sample.pos.phase, sort: r.sample.pos.phase }) },
      { key: 'async', label: '异步', width: 70, cell: (r) => (r.sample.async ? chip('async', 'var(--warn)', 1) : { t: DASH, sort: 0 }) },
    ],
    detail: (r) => [
      ['事件', r.track.name],
      ['追踪键', r.track.key],
      ['载荷', r.sample.value ? fmtValue(r.sample.value) : DASH],
      ['载荷原始记号', r.sample.value?.raw ?? DASH],
      ['位置', fmtPosition(r.sample.pos)],
      ['周期', String(r.sample.pos.cycle)],
      ['相位', phaseName(r.sample.pos.phase)],
      ['async', r.sample.async ? '是' : '否'],
      ['采样总数', String(r.track.samples.length)],
    ],
  });
}

/** 取值类警告（规范里叫诊断，其余算提示） */
const ERROR_CODES = new Set([
  'negative_total',
  'records_after_end',
  'invalid_escape',
  'at_clk_conflict',
  'truncated_tail',
  'gzip_truncated',
  'gzip_checksum_mismatch',
  'gzip_bad_format',
]);

function diagnosticDataset(trace: Trace): Dataset {
  return defineDataset<Diagnostic>({
    id: 'diagnostics',
    title: '警告',
    hint: '解析器只报告、不改数据',
    empty: '没有警告，解析很干净',
    defaultSort: [{ key: 'line', dir: 1 }],
    rows: () => trace.diagnostics,
    selection: () => null,
    titleOf: (d) => `警告 ${d.code}${d.line > 0 ? ` · 第 ${d.line} 行` : ' · 文件级'}`,
    columns: [
      {
        key: 'code',
        label: '警告码',
        width: 190,
        mono: true,
        cell: (d) => chip(d.code, ERROR_CODES.has(d.code) ? 'var(--err)' : 'var(--warn)', d.code),
      },
      {
        key: 'line',
        label: '行号',
        width: 78,
        align: 'right',
        cell: (d) => (d.line > 0 ? numeric(String(d.line), d.line) : { t: '文件级', sort: null }),
      },
      { key: 'message', label: '说明', width: 620, cell: (d) => ({ t: d.message, full: d.message }) },
    ],
    detail: (d) => [
      ['警告码', d.code],
      ['行号', d.line > 0 ? String(d.line) : '文件级（0）'],
      ['说明', d.message],
      ['总次数', String(trace.diagnosticCounts.get(d.code) ?? 0)],
    ],
  });
}

function skippedDataset(trace: Trace): Dataset {
  return defineDataset<SkippedLine>({
    id: 'skipped',
    title: '跳过的行',
    hint: '无法识别或非法的行，解析时被跳过',
    empty: '没有被跳过的行',
    defaultSort: [{ key: 'line', dir: 1 }],
    rows: () => trace.skipped,
    selection: () => null,
    titleOf: (s) => `跳过 · 第 ${s.line} 行`,
    columns: [
      { key: 'line', label: '行号', width: 78, align: 'right', cell: (s) => numeric(String(s.line), s.line) },
      { key: 'reason', label: '原因', width: 130, mono: true, cell: (s) => chip(s.reason, 'var(--warn)', s.reason) },
      { key: 'detail', label: '细节', width: 260, cell: (s) => ({ t: s.detail ?? DASH, sort: s.detail ?? null }) },
      { key: 'raw', label: '原始行', width: 520, cell: (s) => ({ t: clip(s.raw, 110), full: s.raw, mono: true }) },
    ],
    detail: (s) => [
      ['行号', String(s.line)],
      ['原因', s.reason],
      ['细节', s.detail ?? DASH],
      ['原始行', s.raw],
    ],
  });
}

const DATASET_DEFS: { id: string; title: string; make(trace: Trace): Dataset }[] = [
  { id: 'records', title: '记录', make: recordDataset },
  { id: 'items', title: '轨道条目', make: itemDataset },
  { id: 'counters', title: '计数器', make: counterDataset },
  { id: 'values', title: '数值', make: valueDataset },
  { id: 'fsm', title: '状态机跳转', make: fsmDataset },
  { id: 'events', title: '事件', make: eventDataset },
  { id: 'diagnostics', title: '警告', make: diagnosticDataset },
  { id: 'skipped', title: '跳过的行', make: skippedDataset },
];

// ------------------------------------------------------------------ 视图状态

interface State {
  ctx: ViewContext | null;
  container: HTMLElement | null;
  datasetId: string;
  dataset: Dataset | null;
  rows: Row[];
  /** 可见列下标（按列定义顺序） */
  visible: number[];
  hidden: Set<string>;
  query: string;
  kinds: Set<string>;
  sort: SortSpec[];
  filtered: Row[];
  /** 已渲染的窗口（用于避免重复渲染） */
  range: { start: number; end: number };
  unsub: (() => void) | null;
  scroller: HTMLElement | null;
  tbody: HTMLElement | null;
  status: HTMLElement | null;
  rafPending: boolean;
}

const state: State = {
  ctx: null,
  container: null,
  datasetId: 'records',
  dataset: null,
  rows: [],
  visible: [],
  hidden: new Set(),
  query: '',
  kinds: new Set(),
  sort: [],
  filtered: [],
  range: { start: -1, end: -1 },
  unsub: null,
  scroller: null,
  tbody: null,
  status: null,
  rafPending: false,
};

const datasetCache = new Map<string, Dataset>();
let cacheTrace: Trace | null = null;

function datasetFor(id: string, ctx: ViewContext): Dataset {
  if (cacheTrace !== ctx.trace) {
    datasetCache.clear();
    cacheTrace = ctx.trace;
  }
  const cached = datasetCache.get(id);
  if (cached) return cached;
  const def = DATASET_DEFS.find((d) => d.id === id) ?? DATASET_DEFS[0]!;
  const built = def.make(ctx.trace);
  datasetCache.set(id, built);
  return built;
}

/** 确保当前数据集的行已就绪；切换数据集（或换文件）时重置过滤/排序/列显隐 */
function ensureDataset(ctx: ViewContext): Dataset {
  const ds = datasetFor(state.datasetId, ctx);
  if (state.dataset !== ds) {
    state.dataset = ds;
    state.datasetId = ds.id;
    state.rows = ds.rows.map((raw, index) => ({ raw, index, hay: '', haySig: '' }));
    state.hidden = new Set();
    state.kinds = new Set();
    state.query = '';
    state.sort = ds.defaultSort.map((s) => ({ ...s }));
    state.range = { start: -1, end: -1 };
  }
  return ds;
}

// ------------------------------------------------------------------ 过滤 / 排序

function sortFiltered(): void {
  const ds = state.dataset;
  if (!ds || state.sort.length === 0) return;
  const active: { col: number; dir: 1 | -1 }[] = [];
  for (const spec of state.sort) {
    const col = ds.colKeys.indexOf(spec.key);
    if (col >= 0) active.push({ col, dir: spec.dir });
  }
  if (active.length === 0) return;
  const keys = active.map((a) => state.filtered.map((row) => ds.sortValue(row.raw, a.col)));
  state.filtered.sort((a, b) => {
    for (let k = 0; k < active.length; k++) {
      const cmp = compareSort(keys[k]![a.index] ?? null, keys[k]![b.index] ?? null) * active[k]!.dir;
      if (cmp !== 0) return cmp;
    }
    return a.index - b.index; // 稳定：保持数据集原顺序
  });
}

function applyFilter(): void {
  const ds = state.dataset;
  if (!ds) return;
  const cols: number[] = [];
  ds.colKeys.forEach((key, i) => {
    if (!state.hidden.has(key)) cols.push(i);
  });
  state.visible = cols;
  const sig = cols.join(',');
  const query = state.query.trim().toLowerCase();
  const out: Row[] = [];
  for (const row of state.rows) {
    if (state.kinds.size > 0) {
      const kind = ds.kindOf(row.raw);
      if (kind === null || !state.kinds.has(kind)) continue;
    }
    if (query !== '') {
      if (row.haySig !== sig) {
        const parts: string[] = [];
        for (const col of cols) {
          const text = cellText(ds.cell(row.raw, col));
          parts.push(text.length > 300 ? text.slice(0, 300) : text);
        }
        row.hay = parts.join('\u0000').toLowerCase();
        row.haySig = sig;
      }
      if (!row.hay.includes(query)) continue;
    }
    out.push(row);
  }
  state.filtered = out;
  sortFiltered();
  rebuildTable();
}

// ------------------------------------------------------------------ 渲染

function placeholderRow(colspan: number, text: string, height: number): HTMLTableRowElement {
  const style = height > 0 ? `height:${height}px;padding:0;border:0` : 'padding:22px;text-align:center;color:var(--text-muted)';
  return el('tr', {}, [el('td', { colspan: String(colspan), style, text })]);
}

function cellNode(col: ColumnSpec<never>, out: CellOut): HTMLTableCellElement {
  const spec: CellSpec = typeof out === 'string' ? { t: out } : out;
  const cls = [col.align === 'right' ? 'num' : '', (spec.mono ?? col.mono) ? 'mono' : ''].filter(Boolean).join(' ');
  const td = el('td', { class: cls, style: `${CELL_STYLE};height:${ROW_H}px;line-height:${ROW_H - 1}px` });
  if (spec.chip) {
    const color = spec.color ?? 'var(--text-muted)';
    td.append(
      el('span', { class: 'badge', style: `background:color-mix(in srgb, ${color} 14%, transparent);color:${color}`, text: spec.t }),
    );
  } else {
    td.textContent = spec.t;
    if (spec.color) td.style.color = spec.color;
  }
  return td;
}

function buildRow(ds: Dataset, row: Row, cols: number[], selected: string | null): HTMLTableRowElement {
  const tr = el('tr');
  const selection = ds.selection(row.raw);
  if (selected !== null && selectionKey(selection) === selected) tr.classList.add('is-selected');
  for (const col of cols) tr.append(cellNode(ds.columns[col]!, ds.cell(row.raw, col)));
  hoverTarget(tr, () => {
    const lines = [ds.titleOf(row.raw)];
    let shown = 0;
    for (const col of cols) {
      if (shown >= 7) break;
      const def = ds.columns[col]!;
      const spec = ds.cell(row.raw, col);
      lines.push(`${def.label}: ${clip(typeof spec === 'string' ? spec : (spec.full ?? spec.t), 200)}`);
      shown++;
    }
    lines.push('单击选中 · 双击查看全部字段');
    return lines.join('\n').replace(/[&<>]/g, (ch) => (ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : '&gt;'));
  });
  tr.addEventListener('click', () => {
    if (selection) state.ctx?.selection.set(selection);
  });
  tr.addEventListener('dblclick', () => state.ctx?.inspect(ds.titleOf(row.raw), ds.detail(row.raw)));
  tr.addEventListener('mouseenter', () => {
    if (selection) state.ctx?.selection.hover(selection);
  });
  tr.addEventListener('mouseleave', () => state.ctx?.selection.hover(null));
  return tr;
}

function updateStatus(): void {
  const node = state.status;
  if (!node) return;
  const total = state.filtered.length;
  const all = state.rows.length;
  const parts: string[] = [`共 ${fmtInt(total)} 行`];
  if (total > 0 && state.range.end > state.range.start) {
    parts.push(`显示 ${fmtInt(state.range.start + 1)}–${fmtInt(state.range.end)}`);
  }
  if (total !== all) parts.push(`已从 ${fmtInt(all)} 行筛选`);
  const ds = state.dataset;
  if (ds && state.sort.length > 0) {
    parts.push(`排序 ${state.sort.map((s) => `${ds.columns[ds.colKeys.indexOf(s.key)]?.label ?? s.key} ${s.dir === 1 ? '▲' : '▼'}`).join('，')}`);
  }
  node.textContent = parts.join('，');
}

function renderWindow(force = false): void {
  const ds = state.dataset;
  const tbody = state.tbody;
  const scroller = state.scroller;
  if (!ds || !tbody || !scroller) return;
  const total = state.filtered.length;
  const cols = state.visible;
  const viewH = scroller.clientHeight || 420;
  const first = Math.max(0, Math.floor(scroller.scrollTop / ROW_H) - BUFFER);
  const last = Math.min(total, first + Math.ceil(viewH / ROW_H) + BUFFER * 2 + 2);
  if (!force && first === state.range.start && last === state.range.end) return;
  state.range = { start: first, end: last };
  clear(tbody);
  if (total === 0) {
    tbody.append(placeholderRow(cols.length, state.rows.length === 0 ? ds.empty : '没有匹配的行：试着清空搜索或筛选', 0));
    updateStatus();
    return;
  }
  const selected = selectionKey(state.ctx?.selection.get() ?? null);
  if (first > 0) tbody.append(placeholderRow(cols.length, '', first * ROW_H));
  for (let i = first; i < last; i++) tbody.append(buildRow(ds, state.filtered[i]!, cols, selected));
  if (last < total) tbody.append(placeholderRow(cols.length, '', (total - last) * ROW_H));
  updateStatus();
}

function rebuildTable(): void {
  const ds = state.dataset;
  const scroller = state.scroller;
  if (!ds || !scroller) return;
  const cols = state.visible;
  const minWidth = cols.reduce((sum, c) => sum + ds.columns[c]!.width, 0);
  const headRow = el('tr');
  for (const c of cols) {
    const col = ds.columns[c]!;
    const order = state.sort.findIndex((s) => s.key === col.key);
    const arrow = order < 0 ? '' : state.sort[order]!.dir === 1 ? ' ▲' : ' ▼';
    const rank = order >= 0 && state.sort.length > 1 ? String(order + 1) : '';
    const th = el('th', {
      style: `${CELL_STYLE};height:${HEAD_H}px;line-height:${HEAD_H - 1}px;cursor:pointer;user-select:none`,
      text: `${col.label}${arrow}${rank}`,
    });
    if (col.align === 'right') th.style.textAlign = 'right';
    th.addEventListener('click', (event) => onHeaderClick(col.key, event.shiftKey));
    headRow.append(th);
  }
  const table = el('table', { class: 'table', style: `table-layout:fixed;width:100%;min-width:${Math.max(520, minWidth)}px` }, [
    el('colgroup', {}, cols.map((c) => el('col', { style: `width:${ds.columns[c]!.width}px` }))),
    el('thead', {}, [headRow]),
  ]);
  const tbody = el('tbody');
  table.append(tbody);
  clear(scroller);
  scroller.append(table);
  scroller.scrollTop = 0;
  state.tbody = tbody;
  state.range = { start: -1, end: -1 };
  renderWindow(true);
}

/**
 * 表头点击：升序 → 降序 → 不排序；按住 Shift 追加/切换次级排序列。
 */
function onHeaderClick(key: string, shift: boolean): void {
  const sort = state.sort;
  const idx = sort.findIndex((s) => s.key === key);
  if (shift) {
    if (idx < 0) state.sort = [...sort, { key, dir: 1 }];
    else if (sort[idx]!.dir === 1) state.sort = sort.map((s, i) => (i === idx ? { key, dir: -1 as const } : s));
    else state.sort = sort.filter((_, i) => i !== idx);
  } else if (idx === 0 && sort.length === 1) {
    state.sort = sort[0]!.dir === 1 ? [{ key, dir: -1 }] : [];
  } else {
    state.sort = [{ key, dir: 1 }];
  }
  applyFilter();
}

/** 选中行若不在可视窗口内，滚动到视野中间 */
function revealSelection(sel: Selection): void {
  const ds = state.dataset;
  const scroller = state.scroller;
  if (!ds || !scroller) return;
  const key = selectionKey(sel);
  if (key === null) return;
  let hit = -1;
  for (let i = 0; i < state.filtered.length; i++) {
    if (selectionKey(ds.selection(state.filtered[i]!.raw)) === key) {
      hit = i;
      break;
    }
  }
  if (hit < 0) return;
  const top = hit * ROW_H;
  const viewH = scroller.clientHeight || 0;
  if (top < scroller.scrollTop || top + ROW_H > scroller.scrollTop + viewH) {
    scroller.scrollTop = Math.max(0, top - viewH / 2);
  }
}

// ------------------------------------------------------------------ CSV 导出

function exportCsv(): void {
  const ds = state.dataset;
  if (!ds) return;
  const esc = (text: string) => (/[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
  const cols = state.visible.map((c) => ds.columns[c]!);
  const lines: string[] = [cols.map((c) => esc(c.label)).join(',')];
  for (const row of state.filtered) {
    const cells: string[] = [];
    for (const col of state.visible) cells.push(esc(cellText(ds.cell(row.raw, col))));
    lines.push(cells.join(','));
  }
  const blob = new Blob([`\ufeff${lines.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: `chiperf-${ds.id}.csv`, style: 'display:none' });
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ------------------------------------------------------------------ 工具栏与挂载

function buildTabsBar(ds: Dataset): HTMLElement {
  const bar = el('div', { class: 'toolbar' }, [el('span', { class: 'toolbar-label', text: '数据集' })]);
  for (const def of DATASET_DEFS) {
    const on = def.id === ds.id;
    const btn = el('button', { class: `chip chip-toggle${on ? ' is-on' : ''}`, text: def.title });
    btn.addEventListener('click', () => {
      if (def.id === state.datasetId) return;
      state.datasetId = def.id;
      if (state.ctx) ensureDataset(state.ctx);
      buildDom();
    });
    bar.append(btn);
  }
  bar.append(el('div', { class: 'toolbar-spacer' }), el('span', { class: 'muted', style: 'font-size:11.5px', text: ds.hint }));
  return bar;
}

function buildFilterBar(ds: Dataset, ctx: ViewContext): HTMLElement {
  const bar = el('div', { class: 'toolbar' });

  // 全列搜索
  const input = el('input', {
    type: 'search',
    placeholder: '搜索所有可见列（大小写不敏感）',
    value: state.query,
    style: INPUT_STYLE,
  });
  input.addEventListener('input', () => {
    state.query = input.value;
    applyFilter();
  });
  bar.append(el('div', { class: 'toolbar-group' }, [el('span', { class: 'toolbar-label', text: '搜索' }), input]));

  // 记录页的类型快速过滤
  if (ds.kinds && ds.kinds.length > 1) {
    const group = el('div', { class: 'toolbar-group' }, [el('span', { class: 'toolbar-label', text: '类型' })]);
    for (const { kind, count } of ds.kinds) {
      const color = colorFor(kind);
      const on = state.kinds.has(kind);
      const btn = el('button', { class: `chip chip-toggle${on ? ' is-on' : ''}`, text: `${kind} ${fmtInt(count)}` });
      if (on) btn.style.cssText = `background:color-mix(in srgb, ${color} 14%, transparent);color:${color};border-color:transparent`;
      btn.addEventListener('click', () => {
        const next = !state.kinds.has(kind);
        if (next) state.kinds.add(kind);
        else state.kinds.delete(kind);
        btn.classList.toggle('is-on', next);
        btn.style.cssText = next ? `background:color-mix(in srgb, ${color} 14%, transparent);color:${color};border-color:transparent` : '';
        applyFilter();
      });
      group.append(btn);
    }
    bar.append(group);
  }

  // 列开关
  const panel = el('div', { style: PANEL_STYLE });
  const summary = el('summary', { class: 'btn', style: 'list-style:none;cursor:pointer', text: '' });
  const details = el('details', { style: 'position:relative' }, [summary, panel]);
  const syncSummary = () => {
    summary.textContent = `列 ${ds.colKeys.length - state.hidden.size}/${ds.colKeys.length}`;
  };
  syncSummary();
  const toggles: HTMLInputElement[] = [];
  ds.colKeys.forEach((key, i) => {
    const box = el('input', { type: 'checkbox' });
    box.checked = !state.hidden.has(key);
    box.addEventListener('change', () => {
      if (box.checked) state.hidden.delete(key);
      else state.hidden.add(key);
      applyFilter();
      syncSummary();
    });
    toggles.push(box);
    panel.append(el('label', { class: 'row', style: 'font-size:12px;gap:6px;cursor:pointer' }, [box, el('span', { text: ds.columns[i]!.label })]));
  });
  const selectAll = el('button', { class: 'btn btn-ghost', style: 'font-size:11.5px;justify-content:flex-start', text: '全选' });
  selectAll.addEventListener('click', () => {
    state.hidden.clear();
    toggles.forEach((box) => (box.checked = true));
    applyFilter();
    syncSummary();
  });
  panel.prepend(selectAll);

  // 重置（过滤 + 排序 + 列显隐）
  const reset = el('button', { class: 'btn btn-ghost', text: '重置' });
  reset.addEventListener('click', () => {
    state.query = '';

    state.kinds = new Set();
    state.hidden = new Set();
    state.sort = ds.defaultSort.map((s) => ({ ...s }));
    buildDom();
  });

  // 导出当前视图
  const exportBtn = el('button', { class: 'btn', text: '导出 CSV' });
  exportBtn.addEventListener('click', exportCsv);

  bar.append(el('div', { class: 'toolbar-spacer' }), reset, details, exportBtn);
  return bar;
}

function buildDom(): void {
  const ctx = state.ctx;
  const container = state.container;
  if (!ctx || !container) return;
  const ds = ensureDataset(ctx);
  clear(container);

  const scroller = el('div', { class: 'table-wrap', style: 'height:60vh;overflow:auto' });
  scroller.addEventListener(
    'scroll',
    () => {
      if (state.rafPending) return;
      state.rafPending = true;
      requestAnimationFrame(() => {
        state.rafPending = false;
        renderWindow();
      });
    },
    { passive: true },
  );
  const status = el('div', { style: PILL_STYLE, role: 'status', text: '' });
  state.scroller = scroller;
  state.tbody = null;
  state.status = status;

  const wrap = el('div', { style: 'position:relative' }, [scroller, status]);
  container.append(buildTabsBar(ds), buildFilterBar(ds, ctx), wrap);
  applyFilter();
}

function subscribe(ctx: ViewContext): void {
  state.unsub?.();
  state.unsub = ctx.selection.subscribe((sel, kind) => {
    // 别的视图正在显示时容器已脱离文档，不必重画
    if (kind !== 'select' || !state.container?.isConnected) return;
    revealSelection(sel);
    renderWindow(true);
  });
}

export const tableView: View = {
  id: 'table',
  title: '表格',
  hint: '可排序、可过滤、可导出的智能表格',

  mount(container, ctx) {
    state.ctx = ctx;
    state.container = container;
    state.rafPending = false;
    subscribe(ctx);
    buildDom();
    // 从别的视图切回来时，把当前的选中项滚进视野
    revealSelection(ctx.selection.get());
    renderWindow(true);
  },

  refresh(ctx, reason) {
    state.ctx = ctx;
    if (reason === 'hover') return;
    if (!state.container) return;
    if (reason === 'selection') {
      revealSelection(ctx.selection.get());
      renderWindow(true);
      return;
    }
    // options：域选项 / 时间轴标签都可能变，整块重画
    for (const row of state.rows) row.haySig = '';
    buildDom();
  },

  unmount() {
    state.unsub?.();
    state.unsub = null;
    state.container = null;
    state.scroller = null;
    state.tbody = null;
    state.status = null;
    state.rafPending = false;
  },
};

export default tableView;
