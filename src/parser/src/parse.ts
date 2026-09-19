/**
 * chiperf 1.0 —— 解析器（spec §10：鲁棒性 / §5：语法 / §6：位置 / §7：事件）
 *
 * 单遍、流式、前缀封闭：
 *  - 记录不跨行，记录自包含 ⇒ 任意按行切断的前缀都能解析（§10.1）
 *  - 末尾未以行终止符结束的行被丢弃并记为 `truncated_tail`（§10.1）
 *  - 未知类型/指令跳过，未知属性忽略，非法记录逐行跳过并计数（§10.2 / §10.3）
 *  - 语义异常只产生诊断，不修改数据、不中断解析（§10.4）
 */
import type {
  ClockInfo,
  Diagnostic,
  DiagnosticCode,
  EventRecord,
  MsgRecord,
  Phase,
  Position,
  ScalarValue,
  SkippedLine,
  Trace,
  ResetMark,
} from './types.ts';
import { CLOCK_NAME } from './types.ts';
import { parseArgs, decodeAt, stripComment, type Arg } from './lexer.ts';
import { Deriver, type DeriveContext } from './derive.ts';
import { formatValue, scanValue } from './value.ts';

export class UnsupportedVersionError extends Error {
  constructor(
    readonly major: number,
    readonly minor: number,
  ) {
    super(`chiperf ${major}.${minor} 的主版本不受支持（本解析器实现 1.x）；如需尽力解析请设置 ignoreVersion`);
    this.name = 'UnsupportedVersionError';
  }
}

export interface ParseOptions {
  /** 是否在结果里收集全部记录（默认 true）。流式处理超大文件时设 false 以保持内存有界。 */
  collectRecords?: boolean;
  /** 忽略未知主版本（默认 false：按 spec §5.4 拒绝） */
  ignoreVersion?: boolean;
}

const EVENT_KINDS = new Set(['clk', 'cnt', 'val', 'pip', 'fsm', 'evt', 'msg']);
/** 控制记录（spec §7.7）：不占位置、不占 seq、不进可视化 */
const CONTROL_KINDS = new Set(['rst']);

const emptyClock = (): ClockInfo => ({
  cycles: 0,
  posEdges: 0,
  negEdges: 0,
  firstCycle: Number.POSITIVE_INFINITY,
  lastCycle: 0,
});

export class ChiperfParser {
  private clock: ClockInfo = emptyClock();
  private clockPhase: Phase = '-';
  private readonly diagnostics: Diagnostic[] = [];
  private readonly diagnosticCounts = new Map<string, number>();
  private readonly skipped: SkippedLine[] = [];
  private readonly meta: Record<string, string> = {};
  private readonly records: EventRecord[] = [];
  private readonly resets: ResetMark[] = [];
  /** 复位时要整个换掉（此前的派生状态一律作废），所以不是 readonly */
  private deriver: Deriver;
  private readonly deriveCtx: DeriveContext;
  private seq = 0;
  private lineNo = 0;
  private chars = 0;
  private bytes = 0;
  private pending = '';
  private truncatedTail: string | null = null;
  private version = { major: 1, minor: 0, explicit: false, raw: undefined as string | undefined };
  private endSeen = false;
  private hasAtOverride = false;
  /** 是否出现过 clk / at=，用于 at_clk_conflict */
  private usedClk = false;
  private usedAt = false;
  private readonly collectRecords: boolean;
  private readonly ignoreVersion: boolean;

  constructor(opts: ParseOptions = {}) {
    this.collectRecords = opts.collectRecords ?? true;
    this.ignoreVersion = opts.ignoreVersion ?? false;
    this.deriveCtx = {
      diag: (code, line, message) => this.diag(code, line, message),
    };
    this.deriver = new Deriver(this.deriveCtx);
  }

  /** 追加任意文本片段（不必按行切分）；内部缓存不完整的尾行 */
  feed(chunk: string): void {
    this.chars += chunk.length;
    this.bytes += utf8Length(chunk);
    // 把上一片留下的残行并进来，然后**用游标**逐行前进。
    // 之前是每处理一行就 `pending = pending.slice(...)`：每行都要把剩下的一整片复制一遍，
    // 一片 1MB 就是 O(片长²)，大文件下光这一步就能吃掉十几秒。
    const text = this.pending.length === 0 ? chunk : this.pending + chunk;
    this.pending = '';
    let start = 0;
    let index = text.indexOf('\n', start);
    while (index >= 0) {
      this.processLine(text.slice(start, index));
      start = index + 1;
      index = text.indexOf('\n', start);
    }
    this.pending = start === 0 ? text : text.slice(start);
  }

  /** 供容器层（gzip 等）上报诊断；不影响解析流程 */
  report(code: DiagnosticCode, line: number, message: string): void {
    this.diag(code, line, message);
  }

  finish(): Trace {
    if (this.pending.replace(/\r?\n?$/, '').trim().length > 0) {
      this.truncatedTail = this.pending;
      this.diag('truncated_tail', this.lineNo + 1, `末尾未以换行结束的残行被丢弃：${JSON.stringify(this.pending)}`);
    } else if (this.pending.length > 0) {
      this.truncatedTail = null;
    }
    this.deriver.finish();
    this.finalizeDiagnostics();
    if (!this.endSeen && this.records.length > 0) {
      this.diag('eof_without_end_marker', 0, '文件没有以 @end 结束：内容可能被截断');
    }
    const lines = this.lineNo;
    return {
      version: this.version,
      meta: this.meta,
      stats: {
        lines,
        bytes: this.bytes,
        records: this.records.length,
        skipped: this.skipped.length,
        bytesPerRecord: this.records.length > 0 ? this.bytes / this.records.length : 0,
      },
      clock: this.clock,
      records: this.records,
      resets: this.resets,
      counters: this.deriver.counters,
      values: this.deriver.values,
      fsms: this.deriver.fsms,
      tracks: this.deriver.tracks,
      events: this.deriver.events,
      messages: this.deriver.messages as MsgRecord[],
      diagnostics: this.diagnostics,
      diagnosticCounts: this.diagnosticCounts,
      skipped: this.skipped,
      truncatedTail: this.truncatedTail,
      hasAtOverride: this.hasAtOverride,
      endSeen: this.endSeen,
    };
  }

  // ---------------------------------------------------------------- 行处理

  private processLine(rawLine: string): void {
    this.lineNo++;
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    // 注释对**所有**行生效（spec §4.1）：版本行与 @ 指令也先剥注释再看内容。
    // `msg` 除外 —— 它的载荷要连注释一起收下（spec §7.7），所以那条路径自己处理。
    const body = line.trim();
    const bare = stripComment(body).trim();
    if (this.lineNo === 1) {
      const m = /^chiperf[ \t]+(\d+)\.(\d+)$/.exec(bare);
      if (m) {
        this.version = { major: Number(m[1]), minor: Number(m[2]), explicit: true, raw: bare };
        if (this.version.major !== 1 && !this.ignoreVersion) {
          throw new UnsupportedVersionError(this.version.major, this.version.minor);
        }
        return;
      }
    }
    if (bare.length === 0) return;
    // spec §8.2：@end 之后的记录仍要被解析，但要产生诊断（注释不算）
    if (this.endSeen) {
      this.diag('records_after_end', this.lineNo, '@end 之后仍然出现了记录');
    }
    if (bare.startsWith('@')) {
      this.processDirective(bare);
      return;
    }
    if (body.startsWith('[')) {
      this.processEvent(line, body);
      return;
    }
    // 行首不是 [ / @ / #（含出现在首行之外的版本行，spec §5.4）
    this.skip('invalid_record', this.lineNo, line, '行首不是 `[`、`@`、`#`');
  }

  private processDirective(body: string): void {
    const m = /^@([A-Za-z_][A-Za-z0-9_]*)(.*)$/.exec(body)!;
    const name = m[1]!;
    const rest = m[2] ?? '';
    if (name === 'end') {
      this.endSeen = true;
      return;
    }
    if (name === 'meta') {
      if (rest.trim().length === 0) return;
      const args = parseArgs(rest, { spaceSeparated: true });
      const bad = args.find((a) => a.kind === 'error');
      if (bad !== undefined) {
        // 以前这里把解析错误悄悄吞掉：写错分隔符会静默丢光元数据
        this.skip('invalid_record', this.lineNo, body, `@meta 的字段必须都是 键=值（${bad.reason}）`);
        return;
      }
      if (args.some((a) => a.kind !== 'attr')) {
        this.skip('invalid_record', this.lineNo, body, '@meta 的字段必须都是 键=值');
        return;
      }
      const attrs = this.collectAttrs(args);
      if (attrs === null) return;
      // 字符串值取解码后的正文；其它类型保留格式化后的形式
      for (const [key, value] of attrs) this.meta[key] = value === null ? '' : value.kind === 'str' ? value.text : formatValue(value);
      return;
    }
    this.skip('unknown_directive', this.lineNo, body, `未知指令 @${name}`);
  }

  private processEvent(line: string, body: string): void {
    const close = body.indexOf(']');
    if (close < 0) {
      this.skip('invalid_record', this.lineNo, line, '缺少 `]`');
      return;
    }
    const kind = body.slice(1, close);
    const rest = body.slice(close + 1);
    if (kind.length === 0 || !/^[A-Za-z0-9_-]+$/.test(kind)) {
      this.skip('invalid_record', this.lineNo, line, '记录类型名不是合法裸词');
      return;
    }
    if (CONTROL_KINDS.has(kind)) {
      this.applyReset(rest, line);
      return;
    }
    if (!EVENT_KINDS.has(kind)) {
      this.skip('unknown_kind', this.lineNo, line, `未知记录类型 [${kind}]`);
      return;
    }

    if (kind === 'msg') {
      const text = decodeMsgPayload(rest);
      const pos = this.place(null, false)!;
      this.push({ kind: 'msg', line: this.lineNo, seq: pos.seq, pos, async: false, raw: line, text });
      return;
    }

    const args = parseArgs(stripComment(rest));
    const error = args.find((a): a is Extract<Arg, { kind: 'error' }> => a.kind === 'error');
    if (error) {
      this.skip('invalid_record', this.lineNo, line, error.reason);
      return;
    }
    const positional = args.filter((a): a is Extract<Arg, { kind: 'pos' }> => a.kind === 'pos');
    const attrs = this.collectAttrs(args);
    const atArg = args.find((a): a is Extract<Arg, { kind: 'attr' }> => a.kind === 'attr' && a.key === 'at');
    const atText = atArg ? atArg.text : null;

    const asyncAttr = attrs.get('async');
    if (asyncAttr !== undefined && !(asyncAttr !== null && asyncAttr.kind === 'int' && (asyncAttr.big === 0n || asyncAttr.big === 1n))) {
      this.skip('invalid_record', this.lineNo, line, 'async 的值必须是 0 或 1');
      return;
    }
    const isAsync = asyncAttr !== undefined && asyncAttr !== null && asyncAttr.big === 1n;

    if (kind === 'clk') {
      if (positional.length !== 1) {
        this.skip('invalid_record', this.lineNo, line, 'clk 需要恰好一个参数（p 或 n）');
        return;
      }
      const edge = positional[0]!.value;
      if (edge.kind !== 'sym' || (edge.text !== 'p' && edge.text !== 'n')) {
        this.skip('invalid_record', this.lineNo, line, `clk 的沿必须是 p 或 n（收到 ${formatValue(edge)}）`);
        return;
      }
      if (isAsync) this.diag('async_on_clk', this.lineNo, 'clk 记录上的 async=1 被忽略：时钟沿本身不可能异步');
      this.usedClk = true;
      if (edge.text === 'p') {
        this.clock.cycles++;
        this.clock.posEdges++;
        this.clockPhase = 'p';
      } else {
        if (this.clockPhase === 'n') this.diag('redundant_edge', this.lineNo, '相位已经是 n，重复的下降沿');
        this.clock.negEdges++;
        this.clockPhase = 'n';
      }
      const pos: Position = { cycle: this.clock.cycles, phase: this.clockPhase, seq: ++this.seq };
      this.clock.firstCycle = Math.min(this.clock.firstCycle, pos.cycle);
      this.clock.lastCycle = Math.max(this.clock.lastCycle, pos.cycle);
      this.push({ kind: 'clk', line: this.lineNo, seq: pos.seq, pos, async: false, raw: line, edge: edge.text });
      return;
    }

    if (kind === 'cnt') {
      if (positional.length < 1 || positional.length > 2) {
        this.skip('invalid_record', this.lineNo, line, 'cnt 需要 1~2 个参数（名字[, 增量]）');
        return;
      }
      const nameValue = positional[0]!.value;
      const name = nameOf(nameValue);
      if (name === null) {
        this.skip('invalid_record', this.lineNo, line, 'cnt 的名字必须非空');
        return;
      }
      const absValue = attrs.get('abs');
      let abs: number | null = null;
      if (absValue !== undefined) {
        if (positional.length !== 1 || absValue === null || absValue.kind !== 'int') {
          this.skip('invalid_record', this.lineNo, line, 'abs= 必须与参数互斥，且值为 int');
          return;
        }
        abs = Number(absValue.big ?? 0n);
      }
      let delta: number | null = null;
      if (positional.length === 2) {
        if (abs !== null) {
          this.skip('invalid_record', this.lineNo, line, 'cnt 的增量与 abs= 不得同时出现');
          return;
        }
        const dv = positional[1]!.value;
        if (dv.kind !== 'int') {
          this.skip('invalid_record', this.lineNo, line, `cnt 的增量必须是 int（收到 ${formatValue(dv)}）`);
          return;
        }
        delta = Number(dv.big ?? 0n);
      }
      const pos = this.place(atText, isAsync);
      if (pos === null) {
        this.skip('invalid_record', this.lineNo, line, 'at 的值不符合 int[p|n]');
        return;
      }
      this.push({ kind: 'cnt', line: this.lineNo, seq: pos.seq, pos, async: isAsync, raw: line, name, delta, abs });
      return;
    }

    if (kind === 'val') {
      if (positional.length !== 2) {
        this.skip('invalid_record', this.lineNo, line, 'val 需要恰好 2 个参数（名字, 值）');
        return;
      }
      const name = nameOf(positional[0]!.value);
      const value = positional[1]!.value;
      if (name === null) {
        this.skip('invalid_record', this.lineNo, line, 'val 的名字必须非空');
        return;
      }
      const pos = this.place(atText, isAsync);
      if (pos === null) {
        this.skip('invalid_record', this.lineNo, line, 'at 的值不符合 int[p|n]');
        return;
      }
      this.push({ kind: 'val', line: this.lineNo, seq: pos.seq, pos, async: isAsync, raw: line, name, value });
      return;
    }

    if (kind === 'pip') {
      // spec §7.4（v1.0）：`[pip] <轨>, <值>` 或 `[pip] <轨>, bubble`；没有记录则保持上一值。
      // `I`/`O`/`X` 是 v1.x 的方向，留在这个位置当"值"读会静默改变含义 —— 直接判非法并给迁移提示。
      const second = positional[1]?.value;
      if (second !== undefined && second.kind === 'sym' && (second.text === 'I' || second.text === 'O' || second.text === 'X')) {
        this.skip('invalid_record', this.lineNo, line, `pip 不再有方向：第 2 个参数是该级的新值，空写 bubble（收到方向 ${second.text}）`);
        this.diag('pip_legacy_direction', this.lineNo, `[pip] 的 I/O/X 方向是早期草案的写法、v1.0 已移除：直接写该级的新值，空写 bubble`);
        return;
      }
      if (positional.length !== 2) {
        this.skip(
          'invalid_record',
          this.lineNo,
          line,
          positional.length < 2 ? 'pip 需要 2 个参数（轨道, 值|bubble）：缺少新值' : 'pip 只接受 2 个参数（轨道, 值|bubble）',
        );
        return;
      }
      const track = nameOf(positional[0]!.value);
      if (track === null) {
        this.skip('invalid_record', this.lineNo, line, 'pip 的轨道名必须非空');
        return;
      }
      const written = positional[1]!.value;
      const value = written.kind === 'sym' && written.text === 'bubble' ? null : written;
      const pos = this.place(atText, isAsync);
      if (pos === null) {
        this.skip('invalid_record', this.lineNo, line, 'at 的值不符合 int[p|n]');
        return;
      }
      this.push({ kind: 'pip', line: this.lineNo, seq: pos.seq, pos, async: isAsync, raw: line, track, value });
      return;
    }

    if (kind === 'fsm') {
      if (positional.length !== 2) {
        this.skip('invalid_record', this.lineNo, line, 'fsm 需要恰好 2 个参数（名字, 状态）');
        return;
      }
      const name = nameOf(positional[0]!.value);
      const state = positional[1]!.value;
      if (name === null) {
        this.skip('invalid_record', this.lineNo, line, 'fsm 的名字必须非空');
        return;
      }
      const pos = this.place(atText, isAsync);
      if (pos === null) {
        this.skip('invalid_record', this.lineNo, line, 'at 的值不符合 int[p|n]');
        return;
      }
      this.push({ kind: 'fsm', line: this.lineNo, seq: pos.seq, pos, async: isAsync, raw: line, name, state });
      return;
    }

    // evt
    if (positional.length < 1 || positional.length > 2) {
      this.skip('invalid_record', this.lineNo, line, 'evt 需要 1~2 个参数（名字[, 载荷]）');
      return;
    }
    const name = nameOf(positional[0]!.value);
    const payload = positional.length === 2 ? positional[1]!.value : null;
    if (name === null) {
      this.skip('invalid_record', this.lineNo, line, 'evt 的名字必须非空');
      return;
    }
    const pos = this.place(atText, isAsync);
    if (pos === null) {
      this.skip('invalid_record', this.lineNo, line, 'at 的值不符合 int[p|n]');
      return;
    }
    this.push({ kind: 'evt', line: this.lineNo, seq: pos.seq, pos, async: isAsync, raw: line, name, payload });
  }

  // ---------------------------------------------------------------- 辅助

  /** 收集属性；重复键最后一条生效 + duplicate_attribute 诊断 */
  private collectAttrs(args: Arg[]): Map<string, ScalarValue | null> {
    const map = new Map<string, ScalarValue | null>();
    for (const a of args) {
      if (a.kind !== 'attr') continue;
      if (map.has(a.key)) this.diag('duplicate_attribute', this.lineNo, `属性 ${a.key} 重复出现，采用最后一条`);
      map.set(a.key, a.value);
    }
    return map;
  }

  /** 解析记录位置（spec §6.2）：`at=` 覆盖优先，否则取全局时钟当前周期/相位；命中后立即占用 seq */
  private place(atText: string | null, async: boolean): Position | null {
    let cycle = this.clock.cycles;
    let phase = this.clockPhase;
    if (atText !== null) {
      const at = decodeAt(atText);
      if (!at) return null;
      cycle = at.cycle;
      phase = at.phase;
      this.hasAtOverride = true;
      this.usedAt = true;
    }
    const pos: Position = { cycle, phase, seq: ++this.seq };
    this.clock.firstCycle = Math.min(this.clock.firstCycle, cycle);
    this.clock.lastCycle = Math.max(this.clock.lastCycle, cycle);
    void async;
    return pos;
  }

  private push(rec: EventRecord): void {
    if (this.collectRecords) this.records.push(rec);
    this.deriver.onRecord(rec);
  }

  /**
   * `[rst]` 系统复位（spec §7.7）：**丢弃此前接受的全部事件记录**，从这一行重新开始。
   *
   * 丢弃是"当作没发生过"，不是"画在图上"：
   *  - 记录、派生状态（在飞条目/计数器/数值/状态机）、诊断、跳过行全部作废
   *  - 版本行与 `@` 指令（`@meta`…）是**声明**不是行，保留
   *  - 周期号不重编：`cycles` 继续往前走，所以复位后的记录接着原来的周期号
   *  - 时钟上的"记录范围 / 沿数"按新窗口重算（它们描述的是窗口内可观察到的东西）
   */
  private applyReset(rest: string, line: string): void {
    if (stripComment(rest).trim() !== '') {
      this.skip('invalid_record', this.lineNo, line, '[rst] 不带参数');
      return;
    }
    const dropped = this.records.length;
    this.records.length = 0;
    this.resets.push({ line: this.lineNo, droppedRecords: dropped });

    // 派生状态整个重来：新建一个 Deriver 比逐项清理更不容易漏
    this.deriver = new Deriver(this.deriveCtx);

    // 复位前的诊断/跳过行也是关于被丢弃数据的，一并作废
    this.diagnostics.length = 0;
    this.diagnosticCounts.clear();
    this.skipped.length = 0;

    this.clock.posEdges = 0;
    this.clock.negEdges = 0;
    this.clock.firstCycle = Number.POSITIVE_INFINITY;
    this.clock.lastCycle = 0;
    this.diag('rst_boundary', this.lineNo, `系统复位：丢弃此前 ${dropped} 条事件记录（版本行与 @ 指令保留）`);
  }

  private skip(reason: SkippedLine['reason'], line: number, raw: string, detail?: string): void {
    this.skipped.push({ line, raw, reason, ...(detail ? { detail } : {}) });
    const code: DiagnosticCode =
      reason === 'unknown_kind' ? 'skipped_unknown_kind' : reason === 'unknown_directive' ? 'skipped_unknown_directive' : 'skipped_invalid_record';
    this.diag(code, line, detail ?? reason, false);
  }

  private diag(code: DiagnosticCode, line: number, message: string, count = true): void {
    this.diagnostics.push({ code, line, message });
    if (count) this.diagnosticCounts.set(code, (this.diagnosticCounts.get(code) ?? 0) + 1);
  }

  private finalizeDiagnostics(): void {
    if (this.usedClk && this.usedAt) {
      this.diag('at_clk_conflict', 0, '文件同时使用了 clk 记录与 at= 定位：位置与周期计数会脱节');
    }
    if (!Number.isFinite(this.clock.firstCycle)) this.clock.firstCycle = 0;
  }
}

// -------------------------------------------------------------------- 工具

function nameOf(v: ScalarValue): string | null {
  if (v.kind === 'sym' || v.kind === 'str') return v.text.length > 0 ? v.text : null;
  return null;
}

function decodeMsgPayload(rest: string): string {
  const trimmed = rest.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    const scanned = scanValue(trimmed);
    if (scanned && scanned.rest.trim().length === 0 && scanned.value.kind === 'str') return scanned.value.text;
  }
  return trimmed;
}

function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** 解析完整文本（spec §5 的 `file` 产生式） */
export function parseChiperf(text: string, opts: ParseOptions = {}): Trace {
  const parser = new ChiperfParser(opts);
  parser.feed(text);
  return parser.finish();
}
