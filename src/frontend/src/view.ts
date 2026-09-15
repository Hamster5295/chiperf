/**
 * 视图层契约 —— 每个可视化视图都实现这个接口，由 app.ts 挂载与调度。
 */
import type { DomainInfo, Position, ScalarValue, Trace } from '../../parser/src/index.ts';

/** 全局选中态：表格 ↔ 时间轴 ↔ 图表的联动锚点 */
export type Selection =
  | { kind: 'item'; track: string; enterSeq: number }
  | { kind: 'cycle'; domain: string; cycle: number }
  | { kind: 'counter'; key: string }
  | { kind: 'value'; key: string }
  | { kind: 'fsm'; key: string }
  | { kind: 'record'; seq: number }
  | null;

export interface SelectionBus {
  get(): Selection;
  set(selection: Selection): void;
  /** hover 是高亮而非选中：不触发重画，只广播给关心它的视图 */
  hover(selection: Selection | null): void;
  subscribe(listener: (selection: Selection, kind: 'select' | 'hover') => void): () => void;
}

export interface ViewContext {
  trace: Trace;
  /** 源文件信息（文件名、字节数、是否 gzip） */
  source: { name: string; bytes: number; gzip: boolean };
  /** 全局筛选/选项（如"仅显示某域"），视图读取后自行应用 */
  options: AppOptions;
  selection: SelectionBus;
  /** 请求重新挂载全部视图（数据变化时） */
  rerender(): void;
  /** 打开一个临时详情面板（右侧抽屉） */
  inspect(title: string, rows: [string, string][], body?: HTMLElement): void;
}

export interface AppOptions {
  /** 只显示这些域（空 = 全部） */
  domains: string[];
  /** 时间轴是否用真实时间轴（需要域声明 period/freq） */
  useTimeAxis: boolean;
  /** 时间轴缩放：周期/像素 */
  zoom: number;
}

export interface View {
  id: string;
  /** 导航标签 */
  title: string;
  /** 导航与标题栏里的一句话说明 */
  hint: string;
  mount(container: HTMLElement, ctx: ViewContext): void;
  /** 选中态或选项变化时调用；实现可只重画受影响的部分 */
  refresh?(ctx: ViewContext, reason: 'options' | 'selection' | 'hover'): void;
  unmount?(): void;
}

// ------------------------------------------------------------------ 格式化

export function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}

export function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}G`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(2)}k`;
  return Number.isInteger(n) ? String(n) : n.toFixed(3);
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

export function fmtNs(ns: number): string {
  if (ns === 0) return '0 ns';
  const abs = Math.abs(ns);
  if (abs >= 1e6) return `${(ns / 1e6).toFixed(3)} ms`;
  if (abs >= 1e3) return `${(ns / 1e3).toFixed(3)} µs`;
  if (abs >= 1) return `${ns.toFixed(3)} ns`;
  return `${(ns * 1000).toFixed(1)} ps`;
}

export function fmtPosition(pos: Position): string {
  return `${pos.domain} #${pos.cycle}${pos.phase === '-' ? '' : `.${pos.phase}`} (seq ${pos.seq})`;
}

export function fmtValue(value: ScalarValue | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value.kind === 'str') return `"${value.text}"`;
  return value.text;
}

/** 周期 → 人类可读时间（域声明了 period/freq 时） */
export function cycleTime(domain: DomainInfo | undefined, cycle: number, useTime: boolean): string {
  if (cycle <= 0) return '时钟之前（周期 0）';
  if (!useTime || !domain || domain.periodNs === undefined) return `周期 ${cycle}`;
  // spec §8.2：第 k 个上升沿位于 (k-1)×period，所以周期 1 是 0 ns
  return `周期 ${cycle} · ${fmtNs((cycle - 1) * domain.periodNs)}`;
}
