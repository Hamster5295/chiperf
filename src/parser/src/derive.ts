/**
 * chiperf 1.0 —— 派生量（spec §9）
 *
 * 增量消费事件记录（单遍、内存只与"在飞条目数 + 追踪对象数"相关）。
 * 派生层从不修改数据：所有异常都只产生诊断（spec §10.4）。
 *
 * v1.0 只有一条时间轴，且每个事件类型各自维护一套轨道：轨道标识是
 * `(事件类型, 名字)`（键写作 `<类型>:<名字>`），同名不同类型互不干扰。
 */
import type {
  CounterTrack,
  DiagnosticCode,
  EventRecord,
  EventTrack,
  FsmTrack,
  PipelineItem,
  Position,
  ScalarValue,
  Timed,
  TrackInfo,
  ValueTrack,
} from './types.ts';
import { formatValue, valueKey } from './value.ts';

export interface DeriveContext {
  diag(code: DiagnosticCode, line: number, message: string): void;
}

const stateText = (v: ScalarValue | null) => (v === null ? 'unknown' : formatValue(v));

export class Deriver {
  readonly counters = new Map<string, CounterTrack>();
  readonly values = new Map<string, ValueTrack>();
  readonly fsms = new Map<string, FsmTrack>();
  readonly tracks = new Map<string, TrackInfo>();
  readonly events = new Map<string, EventTrack>();
  readonly messages: EventRecord[] = [];
  /** 轨道名 → 该级**当前**持有的设置（值或气泡），用于判断"值变了没有" */
  private readonly pipHeld = new Map<string, { key: string; item: PipelineItem | null }>();

  constructor(private readonly ctx: DeriveContext) {}

  onRecord(rec: EventRecord): void {
    switch (rec.kind) {
      case 'clk':
        break;
      case 'cnt':
        this.applyCounter(rec);
        break;
      case 'val':
        this.applyValue(rec);
        break;
      case 'fsm':
        this.applyFsm(rec);
        break;
      case 'pip':
        this.applyPip(rec);
        break;
      case 'evt':
        this.applyEvent(rec);
        break;
      case 'msg':
        this.messages.push(rec);
        break;
    }
  }

  /** 收尾：完成占用度/气泡等需要全局视角的派生量 */
  finish(): void {
    for (const track of this.tracks.values()) this.finalizeTrack(track);
  }

  private applyCounter(rec: Extract<EventRecord, { kind: 'cnt' }>): void {
    let track = this.counters.get(rec.name);
    if (!track) {
      track = {
        name: rec.name,
        key: `cnt:${rec.name}`,
        source: 'cnt',
        total: 0,
        samples: [],
        deltaByCycle: new Map(),
        totalByCycle: new Map(),
        changeCycles: [],
      };
      this.counters.set(rec.name, track);
    }
    let delta: number | null = null;
    if (rec.abs !== null) {
      track.total = rec.abs;
    } else {
      delta = rec.delta ?? 1;
      track.total += delta;
      track.deltaByCycle.set(rec.pos.cycle, (track.deltaByCycle.get(rec.pos.cycle) ?? 0) + delta);
    }
    if (track.total < 0) {
      this.ctx.diag('negative_total', rec.line, `计数器 "${rec.name}" 累计值变为 ${track.total}`);
    }
    track.samples.push({ pos: rec.pos, delta, abs: rec.abs, total: track.total, async: rec.async, line: rec.line });
    track.totalByCycle.set(rec.pos.cycle, track.total);
    track.changeCycles.push(rec.pos.cycle);
  }

  private applyValue(rec: Extract<EventRecord, { kind: 'val' }>): void {
    let track = this.values.get(rec.name);
    if (!track) {
      track = { name: rec.name, key: `val:${rec.name}`, samples: [], changes: [] };
      this.values.set(rec.name, track);
    }
    const prev = track.samples[track.samples.length - 1];
    const timed: Timed<ScalarValue> = { value: rec.value, pos: rec.pos, async: rec.async, line: rec.line };
    track.samples.push(timed);
    // `changes` 复用同一个对象（可用引用比较），而不是另建一份
    if (prev && valueKey(prev.value) !== valueKey(rec.value)) track.changes.push(timed);
  }

  private applyFsm(rec: Extract<EventRecord, { kind: 'fsm' }>): void {
    let track = this.fsms.get(rec.name);
    if (!track) {
      track = { name: rec.name, key: `fsm:${rec.name}`, samples: [], transitions: [], dwellCycles: new Map(), stateSet: [] };
      this.fsms.set(rec.name, track);
    }
    const prev = track.samples[track.samples.length - 1];
    const to = stateText(rec.state);
    const from = prev ? stateText(prev.value) : null;
    const selfLoop = prev !== undefined && from === to;
    track.transitions.push({ from, to, pos: rec.pos, selfLoop });
    track.samples.push({ value: rec.state, pos: rec.pos, async: rec.async, line: rec.line });
    if (!track.stateSet.includes(to)) track.stateSet.push(to);
    if (prev) {
      const span = rec.pos.cycle - prev.pos.cycle;
      track.dwellCycles.set(from!, (track.dwellCycles.get(from!) ?? 0) + span);
    }
  }

  private applyEvent(rec: Extract<EventRecord, { kind: 'evt' }>): void {
    let track = this.events.get(rec.name);
    if (!track) {
      track = { name: rec.name, key: `evt:${rec.name}`, samples: [] };
      this.events.set(rec.name, track);
    }
    track.samples.push({ value: rec.payload, pos: rec.pos, async: rec.async, line: rec.line });
  }

  /**
   * `[pip]`：把该级设成一个值（或气泡）。**保持型** —— 没有记录就保持上一值（spec §7.4）。
   *
   * 值变了就是"上一条目结束、新条目开始"；重复写同一个值是空操作（该级一直持有它，
   * 这正是 v1.x 的 `duplicate_tag` 在新模型里不需要存在的原因）。气泡段不进 `items`：
   * 占用度与气泡由"条目区间 + 活跃区间"的差推出（与 §9.4 的旧口径逐格一致）。
   */
  private applyPip(rec: Extract<EventRecord, { kind: 'pip' }>): void {
    const track = this.trackFor(rec.track);
    // 活跃区间按**记录**算（spec §9.4 的 track_first/last_cycle）
    track.firstCycle = Math.min(track.firstCycle, rec.pos.cycle);
    track.lastCycle = Math.max(track.lastCycle, rec.pos.cycle);

    const key = valueKey(rec.value); // null ⇒ '∅'（气泡）
    const held = this.pipHeld.get(rec.track);
    if (held !== undefined && held.key === key) return; // 同一个值再写一次：仍在保持，不是新条目

    if (held !== undefined && held.item !== null) {
      const item = held.item;
      item.close = rec.pos;
      item.closeSeq = rec.seq;
      item.closeAsync = rec.async;
      item.closeLine = rec.line;
      item.latencyCycles = rec.pos.cycle - item.enter.cycle;
      track.items[track.items.length - 1] = item;
    }

    if (rec.value === null) {
      this.pipHeld.set(rec.track, { key, item: null }); // 气泡段
      return;
    }
    const item: PipelineItem = {
      track: rec.track,
      value: rec.value,
      enter: rec.pos,
      close: null,
      latencyCycles: null,
      enterSeq: rec.seq,
      closeSeq: null,
      async: rec.async,
      closeAsync: false,
      enterLine: rec.line,
      closeLine: null,
    };
    track.items.push(item);
    this.pipHeld.set(rec.track, { key, item });
  }

  private trackFor(name: string): TrackInfo {
    let track = this.tracks.get(name);
    if (!track) {
      track = {
        name,
        key: `pip:${name}`,
        items: [],
        firstCycle: Number.POSITIVE_INFINITY,
        lastCycle: 0,
        occupancy: new Map(),
        arrivals: new Map(),
        departures: new Map(),
        bubbles: [],
        bubbleRanges: [],
        closed: 0,
        open: 0,
        latencies: [],
      };
      this.tracks.set(name, track);
    }
    return track;
  }

  private finalizeTrack(track: TrackInfo): void {
    if (!Number.isFinite(track.firstCycle)) {
      // 轨道由记录创建，这里只可能是"记录全被 [rst] 丢弃"的极端情况
      track.firstCycle = 0;
      track.lastCycle = 0;
      return;
    }

    // 计数：未闭合（文件结束时仍持有至今）与已结束条目的驻留周期
    for (const item of track.items) {
      if (item.close === null) {
        track.open++;
      } else {
        track.closed++;
        if (item.latencyCycles !== null) track.latencies.push(item.latencyCycles);
        track.departures.set(item.close.cycle, (track.departures.get(item.close.cycle) ?? 0) + 1);
      }
      const c = item.enter.cycle;
      track.arrivals.set(c, (track.arrivals.get(c) ?? 0) + 1);
    }

    // 逐周期占用度用**差分数组**：先记区间两端的增量，再一遍前缀和还原。
    // 逐条目把区间里的每一拍都写进 Map 在长驻留/大量条目下是 O(Σ区间长度)，这里降成
    // O(条目数 + 周期跨度)。已结束条目占半开区间 [enter, close)（同周期改掉 ⇒ 不占任何周期）；
    // 未闭合条目从 enter 起一直算在飞，可观测窗口到该轨道的最后周期（spec §9.4）。
    const delta = new Map<number, number>();
    const addRange = (from: number, to: number): void => {
      if (to <= from) return;
      delta.set(from, (delta.get(from) ?? 0) + 1);
      delta.set(to, (delta.get(to) ?? 0) - 1);
    };
    for (const item of track.items) {
      if (item.close === null) addRange(item.enter.cycle, track.lastCycle + 1);
      else addRange(item.enter.cycle, item.close.cycle);
    }

    // 一遍扫过周期跨度：同时得到占用度、气泡列表与气泡区间。
    // 曾经在循环里用 `track.bubbles.includes(c)` 判断气泡 —— 那是 O(周期数 × 气泡数)，
    // 几百万记录的轨迹会在这里卡上十几秒。
    let running = 0;
    let start: number | null = null;
    for (let c = track.firstCycle; c <= track.lastCycle; c++) {
      running += delta.get(c) ?? 0;
      if (running > 0) {
        track.occupancy.set(c, running);
        if (start !== null) {
          track.bubbleRanges.push({ start, end: c - 1 });
          start = null;
        }
      } else {
        track.bubbles.push(c);
        if (start === null) start = c;
      }
    }
    if (start !== null) track.bubbleRanges.push({ start, end: track.lastCycle });
  }
}

/** 便捷：把记录数组一次性喂给 deriver（供非流式调用方使用） */
export function deriveRecords(records: EventRecord[], ctx: DeriveContext): Deriver {
  const d = new Deriver(ctx);
  for (const r of records) d.onRecord(r);
  d.finish();
  return d;
}

export type { EventTrack, Timed, Position };
