/**
 * chiperf 1.0 —— 派生量查询辅助（spec §9 的取用接口）
 *
 * 这些函数只读 Trace，不做任何缓存；视图层按需调用即可（spec §9：派生量是函数，不必物化）。
 */
import type {
  CounterTrack,
  FsmTrack,
  Phase,
  PipelineItem,
  Position,
  ScalarValue,
  Trace,
  TrackInfo,
  ValueTrack,
} from './types.ts';
import { CLOCK_NAME } from './types.ts';
import { formatValue, valueKey } from './value.ts';

const PHASE_RANK: Record<Phase, number> = { '-': -1, p: 0, n: 1 };

/** 位置比较：先周期、后相位序（spec §9.3 的 `state_at` 判据） */
export function comparePosition(a: Position, b: Position): number {
  if (a.cycle !== b.cycle) return a.cycle - b.cycle;
  if (PHASE_RANK[a.phase] !== PHASE_RANK[b.phase]) return PHASE_RANK[a.phase] - PHASE_RANK[b.phase];
  return a.seq - b.seq;
}

export function formatPosition(pos: Position): string {
  return `${CLOCK_NAME}#${pos.cycle}.${pos.phase}`;
}


/** 采样是否按位置升序（`at=` 允许乱序，故需一次性判定并缓存） */
const sortedCache = new WeakMap<object, boolean>();

function isSorted<T extends { pos: Position }>(samples: readonly T[]): boolean {
  const cached = sortedCache.get(samples as unknown as object);
  if (cached !== undefined) return cached;
  let ok = true;
  for (let i = 1; i < samples.length; i++) {
    if (comparePosition(samples[i - 1]!.pos, samples[i]!.pos) > 0) {
      ok = false;
      break;
    }
  }
  sortedCache.set(samples as unknown as object, ok);
  return ok;
}

function lastAtOrBefore<T extends { pos: Position }>(samples: readonly T[], probe: Position): number {
  if (!isSorted(samples)) {
    let found = -1;
    for (let i = 0; i < samples.length; i++) {
      if (comparePosition(samples[i]!.pos, probe) <= 0 && (found < 0 || comparePosition(samples[i]!.pos, samples[found]!.pos) > 0)) found = i;
    }
    return found;
  }
  let lo = 0;
  let hi = samples.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (comparePosition(samples[mid]!.pos, probe) <= 0) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

function probeAt(cycle: number, phase: Phase): Position {
  return { cycle, phase, seq: Number.MAX_SAFE_INTEGER };
}

/** 计数器在某周期的累计值（最后一个 cycle ≤ c 的采样；无则 null） */
export function counterTotalAt(track: CounterTrack, cycle: number): number | null {
  const index = lastAtOrBefore(track.samples, probeAt(cycle, 'n'));
  return index < 0 ? null : track.samples[index]!.total;
}

/** 计数器在 (c1, c2] 区间内的差（spec §9.2 的 `delta_between`） */
export function counterDeltaBetween(track: CounterTrack, c1: number, c2: number): number | null {
  const a = counterTotalAt(track, c1);
  const b = counterTotalAt(track, c2);
  if (a === null || b === null) return null;
  return b - a;
}

/** 数值轨在某周期末的状态（保持型；spec §9.3） */
export function valueAt(track: ValueTrack, cycle: number, phase: Phase = 'n'): ScalarValue | null {
  const index = lastAtOrBefore(track.samples, probeAt(cycle, phase));
  return index < 0 ? null : track.samples[index]!.value;
}

/** 状态机在某周期末的状态（spec §9.5） */
export function stateAt(track: FsmTrack, cycle: number, phase: Phase = 'n'): string | null {
  const index = lastAtOrBefore(track.samples, probeAt(cycle, phase));
  return index < 0 ? null : formatValue(track.samples[index]!.value);
}

/**
 * 状态机的状态区段（连续同状态的周期区间），用于色带与热力图。
 * 除最后一段外都是半开区间 `[start, end)`；最后一段 `open === true`，
 * 表示"该状态至少持续到 start"，其驻留周期数不可确定（spec §9.5）。
 */
export function stateSegments(track: FsmTrack): { state: string; start: number; end: number; open: boolean }[] {
  const out: { state: string; start: number; end: number; open: boolean }[] = [];
  const samples = track.samples;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    const state = formatValue(s.value);
    const next = samples[i + 1];
    const end = next ? next.pos.cycle : s.pos.cycle;
    const last = out[out.length - 1];
    if (last && last.state === state) {
      last.end = Math.max(last.end, end);
      last.open = next === undefined;
    } else {
      out.push({ state, start: s.pos.cycle, end, open: next === undefined });
    }
  }
  return out;
}

/** 轨道在某周期的占用度（spec §9.4） */
export function occupancyAt(track: TrackInfo, cycle: number): number {
  return track.occupancy.get(cycle) ?? 0;
}

/** 占用度序列（[from, to] 闭区间，缺失补 0） */
export function occupancySeries(track: TrackInfo, from: number, to: number): number[] {
  const out: number[] = [];
  for (let c = from; c <= to; c++) out.push(track.occupancy.get(c) ?? 0);
  return out;
}

/** 延迟统计（同域完成条目，spec §9.4） */
/**
 * 延迟统计（同域完成条目，spec §9.4）。
 *
 * 中位数与方差是**总体**口径（除以 n）：轨迹里的条目就是全部样本，不是抽样。
 * 方差用 `E[x²] − E[x]²` 一次遍历算出，避免先求平均再回头扫一遍。
 */
/** 一维整数样本的描述统计（延迟、气泡段长度等共用一个口径） */
export interface Distribution {
  count: number;
  min: number;
  max: number;
  avg: number;
  /** 中位数：偶数个样本取中间两个的平均 */
  median: number;
  /** 总体方差（除以 n，单位是"周期²"）；开方得标准差 */
  variance: number;
  /** 按取值升序的频次表 */
  histogram: { value: number; count: number }[];
}

/**
 * 对一组整数样本做描述统计。
 * 中位数与方差都是**总体**口径（除以 n）：轨迹里的样本就是全部样本，不是抽样。
 * 方差用 `E[x²] − E[x]²` 一次遍历算出，不必先求平均再回头扫一遍。
 */
export function describeSamples(xs: readonly number[]): Distribution {
  if (xs.length === 0) return { count: 0, min: 0, max: 0, avg: 0, median: 0, variance: 0, histogram: [] };
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;
  let sumSquares = 0;
  const bins = new Map<number, number>();
  for (const x of xs) {
    min = Math.min(min, x);
    max = Math.max(max, x);
    sum += x;
    sumSquares += x * x;
    bins.set(x, (bins.get(x) ?? 0) + 1);
  }
  const avg = sum / xs.length;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const histogram = [...bins].sort((a, b) => a[0] - b[0]).map(([value, count]) => ({ value, count }));
  return { count: xs.length, min, max, avg, median, variance: sumSquares / xs.length - avg * avg, histogram };
}

/** 延迟统计（同域完成条目，spec §9.4） */
/**
 * 与闭区间 `[from, to]`（周期）**相交**的条目 —— 即"这段区间里在这一级在飞过"的那些。
 *
 * 用于视图上的区间统计（在波形上打两个标记，只看两标记之间的数据）：
 * 跨越边界、但确实在这段区间里待过的条目**算进来**，完全在区间外的**不算**
 * （"不统计其他地方"）。
 */
export function itemsWithin(track: TrackInfo, from: number, to: number): PipelineItem[] {
  return track.items.filter((item) => {
    const end = item.close?.cycle ?? track.lastCycle;
    return item.enter.cycle <= to && end >= from;
  });
}

/**
 * 条目的驻留分布（周期）。给了 `range` 就只统计**与区间相交**的条目，
 * 口径与 `itemsWithin` 一致；不给则统计全部已结束条目（等价于今天的行为）。
 */
export function latencyStats(track: TrackInfo, range?: { from: number; to: number }): Distribution {
  if (range === undefined) return describeSamples(track.latencies);
  const values: number[] = [];
  for (const item of itemsWithin(track, range.from, range.to)) {
    if (item.latencyCycles !== null) values.push(item.latencyCycles);
  }
  return describeSamples(values);
}

/**
 * 连续空泡段长度的分布（spec §9.4 的气泡定义）。
 *
 * 一段"气泡"= 该轨道上连续的若干周期没有在飞内容；这里统计**每段有多长**，
 * 而不是"一共有多少个气泡周期"——后者是 `bubbles.length`，两者不重复：
 * 10 个周期可能是"10 段各 1 拍"，也可能是"1 段 10 拍"。
 */
export function bubbleStats(track: TrackInfo, range?: { from: number; to: number }): Distribution {
  if (range === undefined) return describeSamples(track.bubbleRanges.map((bubble) => bubble.end - bubble.start + 1));
  // 跨边界的段只算**落在区间里的那部分**：区间外的不统计，也不因为跨界而整段丢掉
  const lengths: number[] = [];
  for (const bubble of track.bubbleRanges) {
    const from = Math.max(bubble.start, range.from);
    const to = Math.min(bubble.end, range.to);
    if (to >= from) lengths.push(to - from + 1);
  }
  return describeSamples(lengths);
}
export function ratioBetween(num: CounterTrack, den: CounterTrack, c1: number, c2: number): number | null {
  const n = counterDeltaBetween(num, c1, c2);
  const d = counterDeltaBetween(den, c1, c2);
  if (n === null || d === null || d === 0) return null;
  return n / d;
}

/**
 * 把事件轨折算成"每条 +1 的计数器"（spec §9.1 的 `[evt]`）。
 *
 * 事件记录只有"发生过"这一个信息，没有增量字段，所以计数是确定的：
 * 一条记录 = 一次 +1，累计值 = 到该条为止的事件条数，
 * 每周期增量 = 该周期里的事件条数（同周期多条会累加）。
 *
 * 键带 `evt:` 前缀：`[cnt] foo` 与 `[evt] foo` 可以并存
 * （解析器只对同名不同类型报 `name_reused` 提示），而视图用键做选中与高亮，
 * 不区分就会一起亮。折算结果与原计数器**同构**，因此可以直接当 `CounterTrack` 用。
 */
export function eventCounters(trace: Trace): CounterTrack[] {
  const out: CounterTrack[] = [];
  for (const track of trace.events.values()) {
    const samples: CounterTrack['samples'] = [];
    const deltaByCycle = new Map<number, number>();
    const totalByCycle = new Map<number, number>();
    const changeCycles: number[] = [];
    let total = 0;
    for (const sample of track.samples) {
      total += 1;
      deltaByCycle.set(sample.pos.cycle, (deltaByCycle.get(sample.pos.cycle) ?? 0) + 1);
      totalByCycle.set(sample.pos.cycle, total);
      changeCycles.push(sample.pos.cycle);
      samples.push({ pos: sample.pos, delta: 1, abs: null, total, async: sample.async, line: sample.line });
    }
    out.push({
      name: track.name,
      key: `evt:${track.name}`,
      source: 'evt',
      total,
      samples,
      deltaByCycle,
      totalByCycle,
      changeCycles,
    });
  }
  return out;
}

/**
 * 把一串带取值的采样按**连续同值**切段，每段给起止下标（含端点）。
 *
 * 六边形块模式一段画一个六边形：两个连续的同值采样之间什么都没发生，
 * 画成两个六边形会在中间多一条接缝，看上去像"值变了又变回来"。
 * 同值判据用 `valueKey`（位向量按位、4 态按 4 态，spec §9.3 的比较口径），
 * 所以 `32'h1f` 与 `8'h1f` 数值相同但位宽不同 —— 不合并。
 */
export function equalRuns<T extends { value: ScalarValue }>(points: readonly T[]): { from: number; to: number }[] {
  const runs: { from: number; to: number; key: string }[] = [];
  for (let i = 0; i < points.length; i++) {
    const key = valueKey(points[i]!.value);
    const last = runs[runs.length - 1];
    if (last && last.key === key) last.to = i;
    else runs.push({ from: i, to: i, key });
  }
  return runs.map(({ from, to }) => ({ from, to }));
}

/** 同一取值是否构成"变化"（spec §9.3 的比较口径） */
export function sameValue(a: ScalarValue | null, b: ScalarValue | null): boolean {
  return valueKey(a) === valueKey(b);
}
