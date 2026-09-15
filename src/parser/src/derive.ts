/**
 * chiperf 1.0 —— 派生量（spec §9）
 *
 * 增量消费事件记录（单遍、内存只与"在飞条目数 + 追踪对象数"相关）。
 * 派生层从不修改数据：所有异常都只产生诊断（spec §10.4）。
 */
import type {
  CounterTrack,
  DiagnosticCode,
  DomainInfo,
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
import { trackKey } from './types.ts';
import { formatValue, valueKey } from './value.ts';

export interface DeriveContext {
  /** 某域当前的周期计数（跨域条目的占用度锚定用，spec §9.4） */
  cyclesOf(domain: string): number;
  /** 某域的 @domain 元数据（period 换算用，spec §8.2） */
  domainInfo(domain: string): DomainInfo;
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
  /** 出现过的域名（含 default） */
  readonly usedDomains = new Set<string>();
  /** 使用过 clk / at= 的域（用于 at_clk_conflict） */
  readonly clkDomains = new Set<string>();
  readonly atDomains = new Set<string>();
  /** (域, 名字) → 用过的语义类型，用于 name_reused */
  private readonly nameKinds = new Map<string, Set<string>>();
  /** 轨道名 → 该级**当前**持有的设置（值或气泡），用于判断"值变了没有" */
  private readonly pipHeld = new Map<string, { key: string; item: PipelineItem | null }>();

  constructor(private readonly ctx: DeriveContext) {}

  onRecord(rec: EventRecord): void {
    this.usedDomains.add(rec.pos.domain);
    this.noteNameKind(rec);
    switch (rec.kind) {
      case 'clk':
        this.clkDomains.add(rec.pos.domain);
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

  /** 收尾：完成占用度/气泡/跨域诊断等需要全局视角的派生量 */
  finish(): void {
    for (const track of this.tracks.values()) this.finalizeTrack(track);
  }

  private noteNameKind(rec: EventRecord): void {
    if (rec.kind === 'msg' || rec.kind === 'clk' || rec.kind === 'pip') return;
    const name = 'name' in rec ? rec.name : '';
    if (!name) return;
    const key = trackKey(rec.pos.domain, name);
    const kinds = this.nameKinds.get(key) ?? new Set<string>();
    if (kinds.size > 0 && !kinds.has(rec.kind)) {
      this.ctx.diag('name_reused', rec.line, `名字 "${name}" 在域 "${rec.pos.domain}" 中同时被 ${[...kinds].join('/')} 与 ${rec.kind} 使用`);
    }
    kinds.add(rec.kind);
    this.nameKinds.set(key, kinds);
  }

  private applyCounter(rec: Extract<EventRecord, { kind: 'cnt' }>): void {
    const key = trackKey(rec.pos.domain, rec.name);
    let track = this.counters.get(key);
    if (!track) {
      track = {
        name: rec.name,
        domain: rec.pos.domain,
        key,
        source: 'cnt',
        total: 0,
        samples: [],
        deltaByCycle: new Map(),
        totalByCycle: new Map(),
        changeCycles: [],
      };
      this.counters.set(key, track);
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
    const key = trackKey(rec.pos.domain, rec.name);
    let track = this.values.get(key);
    if (!track) {
      track = { name: rec.name, domain: rec.pos.domain, key, samples: [], changes: [] };
      this.values.set(key, track);
    }
    const prev = track.samples[track.samples.length - 1];
    const timed: Timed<ScalarValue> = { value: rec.value, pos: rec.pos, async: rec.async, line: rec.line };
    track.samples.push(timed);
    // `changes` 复用同一个对象（可用引用比较），而不是另建一份
    if (prev && valueKey(prev.value) !== valueKey(rec.value)) track.changes.push(timed);
  }

  private applyFsm(rec: Extract<EventRecord, { kind: 'fsm' }>): void {
    const key = trackKey(rec.pos.domain, rec.name);
    let track = this.fsms.get(key);
    if (!track) {
      track = { name: rec.name, domain: rec.pos.domain, key, samples: [], transitions: [], dwellCycles: new Map(), stateSet: [] };
      this.fsms.set(key, track);
    }
    const prev = track.samples[track.samples.length - 1];
    const to = stateText(rec.state);
    const from = prev ? stateText(prev.value) : null;
    const selfLoop = prev !== undefined && from === to;
    if (selfLoop) {
      this.ctx.diag('self_transition', rec.line, `状态机 "${rec.name}" 在周期 ${rec.pos.cycle} 自环于状态 ${to}`);
    }
    track.transitions.push({ from, to, pos: rec.pos, selfLoop });
    track.samples.push({ value: rec.state, pos: rec.pos, async: rec.async, line: rec.line });
    if (!track.stateSet.includes(to)) track.stateSet.push(to);
    if (prev) {
      const span = rec.pos.cycle - prev.pos.cycle;
      track.dwellCycles.set(from!, (track.dwellCycles.get(from!) ?? 0) + span);
    }
  }

  private applyEvent(rec: Extract<EventRecord, { kind: 'evt' }>): void {
    const key = trackKey(rec.pos.domain, rec.name);
    let track = this.events.get(key);
    if (!track) {
      track = { name: rec.name, domain: rec.pos.domain, key, samples: [] };
      this.events.set(key, track);
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
    const track = this.trackFor(rec.track, rec.pos.domain);
    // 活跃区间按**记录**算（spec §9.4 的 track_first/last_cycle）；跨域记录锚到轨道绑定域的当前周期
    const anchor = rec.pos.domain === track.domain ? rec.pos.cycle : this.ctx.cyclesOf(track.domain);
    track.firstCycle = Math.min(track.firstCycle, anchor);
    track.lastCycle = Math.max(track.lastCycle, anchor);

    const key = valueKey(rec.value); // null ⇒ '∅'（气泡）
    const held = this.pipHeld.get(rec.track);
    if (held !== undefined && held.key === key) return; // 同一个值再写一次：仍在保持，不是新条目

    if (held !== undefined && held.item !== null) {
      const item = held.item;
      item.close = rec.pos;
      item.closeSeq = rec.seq;
      item.closeAsync = rec.async;
      item.closeLine = rec.line;
      item.crossDomain = rec.pos.domain !== item.enter.domain;
      if (!item.crossDomain) {
        item.latencyCycles = rec.pos.cycle - item.enter.cycle;
        item.closeAnchorCycle = rec.pos.cycle;
      } else {
        // 跨域条目：不给周期延迟（spec §6.5），改用时间延迟或两端位置
        const a = this.ctx.domainInfo(item.enter.domain);
        const b = this.ctx.domainInfo(rec.pos.domain);
        if (a.periodNs !== undefined && b.periodNs !== undefined) {
          item.latencyNs = (rec.pos.cycle - 1) * b.periodNs - (item.enter.cycle - 1) * a.periodNs;
        }
        // 占用度按 enter 域统计：结束时刻锚定到 enter 域当前的周期（spec §9.4）
        item.closeAnchorCycle = this.ctx.cyclesOf(item.enter.domain);
        this.ctx.diag('cross_domain', rec.line, `轨道 "${rec.track}" 的条目跨域：起在 "${item.enter.domain}" 周期 ${item.enter.cycle}，止在 "${rec.pos.domain}" 周期 ${rec.pos.cycle}`);
      }
      track.items[track.items.length - 1] = item;
    }

    if (rec.value === null) {
      this.pipHeld.set(rec.track, { key, item: null }); // 气泡段
      return;
    }
    const item: PipelineItem = {
      track: rec.track,
      domain: rec.pos.domain,
      value: rec.value,
      enter: rec.pos,
      close: null,
      crossDomain: false,
      latencyCycles: null,
      latencyNs: null,
      closeAnchorCycle: null,
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

  private trackFor(name: string, domain: string): TrackInfo {
    let track = this.tracks.get(name);
    if (!track) {
      track = {
        name,
        domain,
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
        const anchor = item.closeAnchorCycle;
        if (anchor !== null) track.departures.set(anchor, (track.departures.get(anchor) ?? 0) + 1);
      }
      const c = item.enter.cycle;
      track.arrivals.set(c, (track.arrivals.get(c) ?? 0) + 1);
    }

    // 逐周期占用度：已结束条目占半开区间 [enter, close)（同周期改掉 ⇒ 不占任何周期）；
    // 未闭合条目从 enter 起一直算在飞，可观测窗口到该轨道的最后周期（spec §9.4）
    for (const item of track.items) {
      if (item.close === null) {
        for (let c = item.enter.cycle; c <= track.lastCycle; c++) {
          track.occupancy.set(c, (track.occupancy.get(c) ?? 0) + 1);
        }
        continue;
      }
      const end = item.closeAnchorCycle ?? item.enter.cycle;
      for (let c = item.enter.cycle; c < end; c++) {
        track.occupancy.set(c, (track.occupancy.get(c) ?? 0) + 1);
      }
    }

    for (let c = track.firstCycle; c <= track.lastCycle; c++) {
      if ((track.occupancy.get(c) ?? 0) === 0) track.bubbles.push(c);
    }
    let start: number | null = null;
    for (let c = track.firstCycle; c <= track.lastCycle + 1; c++) {
      const isBubble = c <= track.lastCycle && track.bubbles.includes(c);
      if (isBubble && start === null) start = c;
      else if (!isBubble && start !== null) {
        track.bubbleRanges.push({ start, end: c - 1 });
        start = null;
      }
    }
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
