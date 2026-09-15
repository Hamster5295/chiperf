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
  Diagnostic,
  DiagnosticCode,
  DomainInfo,
  EventRecord,
  MsgRecord,
  Phase,
  Position,
  ScalarValue,
  SkippedLine,
  Trace,
  ResetMark,
} from './types.ts';
import { trackKey } from './types.ts';
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

interface DomainRuntime {
  info: DomainInfo;
  phase: Phase;
}

const TIME_UNIT_NS: Record<string, number> = { s: 1e9, ms: 1e6, us: 1e3, ns: 1, ps: 1e-3 };
const FREQ_UNIT_HZ: Record<string, number> = { Hz: 1, kHz: 1e3, MHz: 1e6, GHz: 1e9 };

export class ChiperfParser {
  private readonly domains = new Map<string, DomainRuntime>();
  private readonly diagnostics: Diagnostic[] = [];
  private readonly diagnosticCounts = new Map<string, number>();
  private readonly skipped: SkippedLine[] = [];
  private readonly meta: Record<string, string> = {};
  private readonly declared = new Set<string>();
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
  private readonly atDomains = new Set<string>();
  private readonly collectRecords: boolean;
  private readonly ignoreVersion: boolean;

  constructor(opts: ParseOptions = {}) {
    this.collectRecords = opts.collectRecords ?? true;
    this.ignoreVersion = opts.ignoreVersion ?? false;
    this.deriveCtx = {
      cyclesOf: (domain) => this.domains.get(domain)?.info.cycles ?? 0,
      domainInfo: (domain) => this.domainRuntime(domain).info,
      diag: (code, line, message) => this.diag(code, line, message),
    };
    this.deriver = new Deriver(this.deriveCtx);
  }

  /** 追加任意文本片段（不必按行切分）；内部缓存不完整的尾行 */
  feed(chunk: string): void {
    this.chars += chunk.length;
    this.bytes += utf8Length(chunk);
    this.pending += chunk;
    let index = this.pending.indexOf('\n');
    while (index >= 0) {
      const line = this.pending.slice(0, index);
      this.pending = this.pending.slice(index + 1);
      this.processLine(line);
      index = this.pending.indexOf('\n');
    }
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
    this.finalizeDomainDiagnostics();
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
      domains: new Map([...this.domains].map(([name, rt]) => [name, rt.info])),
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
    const body = line.trim();
    if (this.lineNo === 1) {
      const m = /^chiperf[ \t]+(\d+)\.(\d+)$/.exec(body);
      if (m) {
        this.version = { major: Number(m[1]), minor: Number(m[2]), explicit: true, raw: body };
        if (this.version.major !== 1 && !this.ignoreVersion) {
          throw new UnsupportedVersionError(this.version.major, this.version.minor);
        }
        return;
      }
    }
    if (body.length === 0 || body.startsWith('#')) return;
    // spec §8.3：@end 之后的记录仍要被解析，但要产生诊断（注释不算）
    if (this.endSeen) {
      this.diag('records_after_end', this.lineNo, '@end 之后仍然出现了记录');
    }
    if (body.startsWith('@')) {
      this.processDirective(body);
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
      // 字符串值取解码后的正文（与 @domain 的 note 一致）；其它类型保留格式化后的形式
      for (const [key, value] of attrs) this.meta[key] = value === null ? '' : value.kind === 'str' ? value.text : formatValue(value);
      return;
    }
    if (name === 'domain') {
      const args = parseArgs(rest, { spaceSeparated: true });
      if (args.some((a) => a.kind === 'error')) {
        this.skip('invalid_record', this.lineNo, body, args.find((a) => a.kind === 'error')!.reason);
        return;
      }
      const positional = args.filter((a): a is Extract<Arg, { kind: 'pos' }> => a.kind === 'pos');
      const attrs = this.collectAttrs(args);
      if (attrs === null) return;
      if (positional.length !== 1 || (positional[0]!.value.kind !== 'sym' && positional[0]!.value.kind !== 'str')) {
        this.skip('invalid_record', this.lineNo, body, '@domain 需要恰好一个域名位置参数');
        return;
      }
      const domainName = positional[0]!.value.text;
      const rt = this.domainRuntime(domainName);
      if (rt.info.declared) {
        this.diag('duplicate_domain', this.lineNo, `域 "${domainName}" 被重复声明（属性逐项合并）`);
      }
      rt.info.declared = true;
      this.declared.add(domainName);

      const period = attrs.get('period');
      const freq = attrs.get('freq');
      const note = attrs.get('note');
      if (period !== undefined) {
        const ns = scaledToNs(period);
        if (ns === null) {
          this.skip('invalid_record', this.lineNo, body, '@domain 的 period= 必须是时间缩放量（如 1.0ns）');
          return;
        }
        rt.info.periodNs = ns;
      }
      if (freq !== undefined) {
        const hz = scaledToHz(freq);
        if (hz === null) {
          this.skip('invalid_record', this.lineNo, body, '@domain 的 freq= 必须是频率缩放量（如 800MHz）');
          return;
        }
        rt.info.freqHz = hz;
        if (period === undefined) rt.info.periodNs = 1e9 / hz;
      }
      if (note !== undefined && note !== null) rt.info.note = note.kind === 'str' ? note.text : formatValue(note);
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
      const pos = this.place(new Map(), null, false)!;
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

    const domValue = attrs.get('dom');
    let domain = 'default';
    if (domValue !== undefined) {
      if (domValue === null || (domValue.kind !== 'sym' && domValue.kind !== 'str')) {
        this.skip('invalid_record', this.lineNo, line, 'dom 的值必须是域名（裸词或字符串）');
        return;
      }
      domain = domValue.text;
      if (domain.length === 0) {
        this.skip('invalid_record', this.lineNo, line, '域名不得为空');
        return;
      }
    }

    if (kind === 'clk') {
      if (positional.length !== 1) {
        this.skip('invalid_record', this.lineNo, line, 'clk 需要恰好一个位置参数（p 或 n）');
        return;
      }
      const edge = positional[0]!.value;
      if (edge.kind !== 'sym' || (edge.text !== 'p' && edge.text !== 'n')) {
        this.skip('invalid_record', this.lineNo, line, `clk 的沿必须是 p 或 n（收到 ${formatValue(edge)}）`);
        return;
      }
      if (isAsync) this.diag('async_on_clk', this.lineNo, 'clk 记录上的 async=1 被忽略：时钟沿本身不可能异步');
      const rt = this.domainRuntime(domain);
      if (edge.text === 'p') {
        rt.info.cycles++;
        rt.info.posEdges++;
        rt.phase = 'p';
      } else {
        if (rt.phase === 'n') this.diag('redundant_edge', this.lineNo, `域 "${domain}" 的相位已经是 n，重复的下降沿`);
        rt.info.negEdges++;
        rt.phase = 'n';
      }
      const pos: Position = { domain, cycle: rt.info.cycles, phase: rt.phase, seq: ++this.seq };
      rt.info.firstCycle = Math.min(rt.info.firstCycle, pos.cycle);
      rt.info.lastCycle = Math.max(rt.info.lastCycle, pos.cycle);
      this.push({ kind: 'clk', line: this.lineNo, seq: pos.seq, pos, async: false, raw: line, edge: edge.text });
      return;
    }

    if (kind === 'cnt') {
      if (positional.length < 1 || positional.length > 2) {
        this.skip('invalid_record', this.lineNo, line, 'cnt 需要 1~2 个位置参数（名字[, 增量]）');
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
          this.skip('invalid_record', this.lineNo, line, 'abs= 必须与位置参数互斥，且值为 int');
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
      const pos = this.place(attrs, atText, isAsync);
      if (pos === null) {
        this.skip('invalid_record', this.lineNo, line, 'at 的值不符合 int[p|n]');
        return;
      }
      this.push({ kind: 'cnt', line: this.lineNo, seq: pos.seq, pos, async: isAsync, raw: line, name, delta, abs });
      return;
    }

    if (kind === 'val') {
      if (positional.length !== 2) {
        this.skip('invalid_record', this.lineNo, line, 'val 需要恰好 2 个位置参数（名字, 值）');
        return;
      }
      const name = nameOf(positional[0]!.value);
      const value = positional[1]!.value;
      if (name === null || value.kind === 'scaled') {
        this.skip('invalid_record', this.lineNo, line, name === null ? 'val 的名字必须非空' : '缩放量只能出现在 @domain 的 period=/freq=');
        return;
      }
      const pos = this.place(attrs, atText, isAsync);
      if (pos === null) {
        this.skip('invalid_record', this.lineNo, line, 'at 的值不符合 int[p|n]');
        return;
      }
      this.push({ kind: 'val', line: this.lineNo, seq: pos.seq, pos, async: isAsync, raw: line, name, value });
      return;
    }

    if (kind === 'pip') {
      if (positional.length < 2 || positional.length > 3) {
        this.skip('invalid_record', this.lineNo, line, 'pip 需要 2~3 个位置参数（轨道, 方向[, 标记]）');
        return;
      }
      const track = nameOf(positional[0]!.value);
      const dir = positional[1]!.value;
      if (track === null || dir.kind !== 'sym' || (dir.text !== 'I' && dir.text !== 'O' && dir.text !== 'X')) {
        this.skip('invalid_record', this.lineNo, line, track === null ? 'pip 的轨道名必须非空' : `pip 的方向必须是 I/O/X（收到 ${formatValue(dir)}）`);
        return;
      }
      const tag = positional.length === 3 ? positional[2]!.value : null;
      if (tag !== null && tag.kind === 'scaled') {
        this.skip('invalid_record', this.lineNo, line, '缩放量只能出现在 @domain 的 period=/freq=');
        return;
      }
      const pos = this.place(attrs, atText, isAsync);
      if (pos === null) {
        this.skip('invalid_record', this.lineNo, line, 'at 的值不符合 int[p|n]');
        return;
      }
      this.push({ kind: 'pip', line: this.lineNo, seq: pos.seq, pos, async: isAsync, raw: line, track, dir: dir.text, tag });
      return;
    }

    if (kind === 'fsm') {
      if (positional.length !== 2) {
        this.skip('invalid_record', this.lineNo, line, 'fsm 需要恰好 2 个位置参数（名字, 状态）');
        return;
      }
      const name = nameOf(positional[0]!.value);
      const state = positional[1]!.value;
      if (name === null || state.kind === 'scaled') {
        this.skip('invalid_record', this.lineNo, line, name === null ? 'fsm 的名字必须非空' : '缩放量只能出现在 @domain 的 period=/freq=');
        return;
      }
      const pos = this.place(attrs, atText, isAsync);
      if (pos === null) {
        this.skip('invalid_record', this.lineNo, line, 'at 的值不符合 int[p|n]');
        return;
      }
      this.push({ kind: 'fsm', line: this.lineNo, seq: pos.seq, pos, async: isAsync, raw: line, name, state });
      return;
    }

    // evt
    if (positional.length < 1 || positional.length > 2) {
      this.skip('invalid_record', this.lineNo, line, 'evt 需要 1~2 个位置参数（名字[, 载荷]）');
      return;
    }
    const name = nameOf(positional[0]!.value);
    const payload = positional.length === 2 ? positional[1]!.value : null;
    if (name === null || (payload !== null && payload.kind === 'scaled')) {
      this.skip('invalid_record', this.lineNo, line, name === null ? 'evt 的名字必须非空' : '缩放量只能出现在 @domain 的 period=/freq=');
      return;
    }
    const pos = this.place(attrs, atText, isAsync);
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

  /** 解析记录位置（spec §6.3）：`at=` 覆盖优先，否则取域当前周期/相位；命中后立即占用 seq */
  private place(attrs: Map<string, ScalarValue | null>, atText: string | null, async: boolean): Position | null {
    const domValue = attrs.get('dom');
    const domain = domValue && domValue !== null ? domValue.text : 'default';
    const rt = this.domainRuntime(domain);
    let cycle = rt.info.cycles;
    let phase = rt.phase;
    if (atText !== null) {
      const at = decodeAt(atText);
      if (!at) return null;
      cycle = at.cycle;
      phase = at.phase;
      this.hasAtOverride = true;
      this.atDomains.add(domain);
    }
    const pos: Position = { domain, cycle, phase, seq: ++this.seq };
    rt.info.firstCycle = Math.min(rt.info.firstCycle, cycle);
    rt.info.lastCycle = Math.max(rt.info.lastCycle, cycle);
    void async;
    return pos;
  }

  private domainRuntime(name: string): DomainRuntime {
    let rt = this.domains.get(name);
    if (!rt) {
      rt = {
        phase: '-',
        info: {
          name,
          cycles: 0,
          posEdges: 0,
          negEdges: 0,
          declared: false,
          firstCycle: Number.POSITIVE_INFINITY,
          lastCycle: 0,
        },
      };
      this.domains.set(name, rt);
    }
    return rt;
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
   *  - 版本行与 `@` 指令（`@meta` / `@domain` 的 period/freq…）是**声明**不是行，保留
   *  - 周期号不重编：`cycles` 继续往前走，所以复位后的记录接着原来的周期号
   *  - 域上的"记录范围 / 沿数"按新窗口重算（它们描述的是窗口内可观察到的东西）
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

    for (const rt of this.domains.values()) {
      rt.info.posEdges = 0;
      rt.info.negEdges = 0;
      rt.info.firstCycle = Number.POSITIVE_INFINITY;
      rt.info.lastCycle = 0;
    }
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

  private finalizeDomainDiagnostics(): void {
    const { usedDomains, clkDomains } = this.deriver;
    if (this.declared.size > 0) {
      for (const domain of usedDomains) {
        if (domain === 'default' || this.declared.has(domain)) continue;
        this.diag('undeclared_domain', 0, `域 "${domain}" 被记录使用但没有 @domain 声明（可能是拼写错误）`);
      }
    }
    for (const domain of clkDomains) {
      if (this.atDomains.has(domain)) {
        this.diag('at_clk_conflict', 0, `域 "${domain}" 同时使用了 clk 记录与 at= 定位：位置与周期计数会脱节`);
      }
    }
    for (const rt of this.domains.values()) {
      if (!Number.isFinite(rt.info.firstCycle)) rt.info.firstCycle = 0;
    }
  }
}

// -------------------------------------------------------------------- 工具

function nameOf(v: ScalarValue): string | null {
  if (v.kind === 'sym' || v.kind === 'str') return v.text.length > 0 ? v.text : null;
  return null;
}

function scaledToNs(v: ScalarValue | null): number | null {
  if (!v || v.kind !== 'scaled' || v.unit === undefined) return null;
  const factor = TIME_UNIT_NS[v.unit];
  if (factor === undefined) return null;
  return (v.scale ?? 0) * factor;
}

function scaledToHz(v: ScalarValue | null): number | null {
  if (!v || v.kind !== 'scaled' || v.unit === undefined) return null;
  const factor = FREQ_UNIT_HZ[v.unit];
  if (factor === undefined) return null;
  return (v.scale ?? 0) * factor;
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

export { trackKey };
