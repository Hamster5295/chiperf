/**
 * 视图层契约 —— 每个可视化视图都实现这个接口，由 app.ts 挂载与调度。
 */
import type { Position, ScalarValue, Trace } from '../../parser/src/index.ts';
import { CLOCK_NAME } from '../../parser/src/index.ts';

/** 全局选中态：表格 ↔ 时间轴 ↔ 图表的联动锚点 */
export type Selection =
  | { kind: 'item'; track: string; enterSeq: number }
  | { kind: 'cycle'; cycle: number }
  | { kind: 'counter'; key: string }
  | { kind: 'value'; key: string }
  | { kind: 'fsm'; key: string }
  | { kind: 'record'; seq: number }
  | null;

import type { MarkerBus } from './markers.ts';

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
  /** 全局筛选/选项，视图读取后自行应用 */
  options: AppOptions;
  selection: SelectionBus;
  /** 波形上的标记（最多两个）：两个标记之间的区间就是流水线/状态机统计的范围 */
  markers: MarkerBus;
  /** 请求重新挂载全部视图（数据变化时） */
  rerender(): void;
  /** 打开一个临时详情面板（右侧抽屉） */
  inspect(title: string, rows: [string, string][], body?: HTMLElement): void;
}

export interface AppOptions {
  /** 时间轴缩放：每周期像素；0 = 尚未设置（自动铺满），否则为用户显式选择的缩放 */
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

export function fmtPosition(pos: Position): string {
  return `${CLOCK_NAME} #${pos.cycle}${pos.phase === '-' ? '' : `.${pos.phase}`} (seq ${pos.seq})`;
}

export function fmtValue(value: ScalarValue | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value.kind === 'str') return `"${value.text}"`;
  return value.text;
}

/** 周期 → 人类可读文本（v1.0 只有周期号，不再做时间换算） */
export function cycleTime(cycle: number): string {
  if (cycle <= 0) return '时钟之前（周期 0）';
  return `周期 ${cycle}`;
}
