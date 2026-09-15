/**
 * chiperf 1.0 —— 派生量查询辅助（spec §9 的取用接口）
 *
 * 这些函数只读 Trace，不做任何缓存；视图层按需调用即可（spec §9：派生量是函数，不必物化）。
 */
import type {
  CounterTrack,
  DomainInfo,
  FsmTrack,
  Phase,
  Position,
  ScalarValue,
  TrackInfo,
  ValueTrack,
} from './types.ts';
import { formatValue, valueKey } from './value.ts';

const PHASE_RANK: Record<Phase, number> = { '-': -1, p: 0, n: 1 };

/** 位置比较：先周期、后相位序（spec §9.3 的 `state_at` 判据） */
export function comparePosition(a: Position, b: Position): number {
  if (a.cycle !== b.cycle) return a.cycle - b.cycle;
  if (PHASE_RANK[a.phase] !== PHASE_RANK[b.phase]) return PHASE_RANK[a.phase] - PHASE_RANK[b.phase];
  return a.seq - b.seq;
}

export function formatPosition(pos: Position): string {
  return `${pos.domain}#${pos.cycle}.${pos.phase}`;
}

/**
 * 周期 → 时间（纳秒）。域必须声明了 period/freq，否则 null（spec §8.2）。
 * 第 1 个上升沿位于 0 ns，因此 cycle 1 = 0、cycle k = (k-1)×period；
 * **cycle ≤ 0（时钟之前）没有时间基准，返回 null**，而不是算出负时间。
 */
export function timeNs(domain: DomainInfo | undefined, cycle: number): number | null {
  if (!domain || domain.periodNs === undefined) return null;
  if (cycle <= 0) return null;
  return (cycle - 1) * domain.periodNs;
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

function probeAt(domain: string, cycle: number, phase: Phase): Position {
  return { domain, cycle, phase, seq: Number.MAX_SAFE_INTEGER };
}

/** 计数器在某周期的累计值（最后一个 cycle ≤ c 的采样；无则 null） */
export function counterTotalAt(track: CounterTrack, cycle: number): number | null {
  const index = lastAtOrBefore(track.samples, probeAt(track.domain, cycle, 'n'));
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
  const index = lastAtOrBefore(track.samples, probeAt(track.domain, cycle, phase));
  return index < 0 ? null : track.samples[index]!.value;
}

/** 状态机在某周期末的状态（spec §9.5） */
export function stateAt(track: FsmTrack, cycle: number, phase: Phase = 'n'): string | null {
  const index = lastAtOrBefore(track.samples, probeAt(track.domain, cycle, phase));
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
export function latencyStats(track: TrackInfo): {
  count: number;
  min: number;
  max: number;
  avg: number;
  /** 中位数：偶数个取中间两个的平均 */
  median: number;
  /** 总体方差（单位是周期²）；开方得标准差 */
  variance: number;
  histogram: { latency: number; count: number }[];
} {
  const xs = track.latencies;
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
  const histogram = [...bins].sort((a, b) => a[0] - b[0]).map(([latency, count]) => ({ latency, count }));
  return { count: xs.length, min, max, avg, median, variance: sumSquares / xs.length - avg * avg, histogram };
}

/** 计数器之间的比率（如命中率）：两条 `delta_between` 相除（spec §9.2） */
export function ratioBetween(num: CounterTrack, den: CounterTrack, c1: number, c2: number): number | null {
  const n = counterDeltaBetween(num, c1, c2);
  const d = counterDeltaBetween(den, c1, c2);
  if (n === null || d === null || d === 0) return null;
  return n / d;
}

/** 同一取值是否构成"变化"（spec §9.3 的比较口径） */
export function sameValue(a: ScalarValue | null, b: ScalarValue | null): boolean {
  return valueKey(a) === valueKey(b);
}
