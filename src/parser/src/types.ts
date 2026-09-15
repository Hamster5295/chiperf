/**
 * chiperf 1.0 —— 数据类型定义
 *
 * 这些类型是解析器的公开契约（spec §7 / §9）。前端与工具只依赖这里导出的名字，
 * 不依赖解析器内部实现。
 */

/** 相位：`p` = 上升沿之后，`n` = 下降沿之后，`-` = 尚无时钟（时钟之前，cycle 0） */
export type Phase = 'p' | 'n' | '-';

/** 时钟沿（spec §7.1） */
export type Edge = 'p' | 'n';

/** 事件位置（spec §6.3） */
export interface Position {
  domain: string;
  cycle: number;
  phase: Phase;
  /** 全局自增序号，从 1 开始；只对**被接受**的事件记录递增（spec §6.3） */
  seq: number;
}

/** 值的语义类型（spec §4.5）；`scaled` 是缩放量，仅在 `@domain` 的 `period=`/`freq=` 中合法 */
export type ValueKind = 'int' | 'bits' | 'real' | 'str' | 'sym' | 'scaled';

/** 一个类型化的标量值 */
export interface ScalarValue {
  kind: ValueKind;
  /** 规范形文本：去掉 `_` 分隔符、十六进制统一小写、字符串已解码转义 */
  text: string;
  /** 原始记号（未归一化），用于精确回显 */
  raw: string;
  /** `int` / 无 `x`/`z` 的 `bits` 的整数值（可超过 53 位） */
  big?: bigint;
  /** `real` 的数值 */
  num?: number;
  /** `bits` 携带未知位/高阻位（`x`/`z`） */
  hasXZ?: boolean;
  /** Verilog 字面量的声明宽度（`32'h...` ⇒ 32），未声明则 undefined */
  width?: number;
  /** `scaled` 的数值与单位 */
  scale?: number;
  unit?: string;
}

export type PipDirection = 'I' | 'O' | 'X';

interface RecordBase {
  /** 源文件中的 1-based 行号 */
  line: number;
  /** 位置里的全局序号 */
  seq: number;
  pos: Position;
  /** 是否带 `async=1`（spec §6.7）：事件不是时钟沿采样得到的 */
  async: boolean;
  /** 原始行（不含行终止符），用于表格视图与诊断 */
  raw: string;
}

export interface ClkRecord extends RecordBase {
  kind: 'clk';
  edge: Edge;
}

export interface CntRecord extends RecordBase {
  kind: 'cnt';
  name: string;
  /** 增量（缺省 +1 时也已填好）；与 `abs` 互斥 */
  delta: number | null;
  /** `abs=` 绝对值设置；与 `delta` 互斥 */
  abs: number | null;
}

export interface ValRecord extends RecordBase {
  kind: 'val';
  name: string;
  value: ScalarValue;
}

export interface PipRecord extends RecordBase {
  kind: 'pip';
  track: string;
  dir: PipDirection;
  tag: ScalarValue | null;
}

export interface FsmRecord extends RecordBase {
  kind: 'fsm';
  name: string;
  state: ScalarValue;
}

export interface EvtRecord extends RecordBase {
  kind: 'evt';
  name: string;
  payload: ScalarValue | null;
}

export interface MsgRecord extends RecordBase {
  kind: 'msg';
  /** 行尾原文（去首尾空白；若整体是合法字符串字面量则剥除引号并解码转义） */
  text: string;
}

export type EventRecord =
  | ClkRecord
  | CntRecord
  | ValRecord
  | PipRecord
  | FsmRecord
  | EvtRecord
  | MsgRecord;

export type EventKind = EventRecord['kind'];

/** 语义诊断码（spec §10.4）。解析器只报告，不修改数据。 */
export type DiagnosticCode =
  | 'orphan_exit'
  | 'duplicate_tag'
  | 'undeclared_domain'
  | 'at_clk_conflict'
  | 'async_on_clk'
  | 'negative_total'
  | 'self_transition'
  | 'redundant_edge'
  | 'duplicate_attribute'
  | 'duplicate_domain'
  | 'name_reused'
  | 'records_after_end'
  | 'cross_domain'
  | 'eof_without_end_marker'
  | 'invalid_escape'
  | 'gzip_truncated'
  | 'gzip_checksum_mismatch'
  | 'gzip_bad_format'
  | 'truncated_tail'
  | 'skipped_unknown_kind'
  | 'skipped_unknown_directive'
  | 'skipped_invalid_record'
  | 'rst_boundary';

export interface Diagnostic {
  code: DiagnosticCode;
  /** 1-based 行号；文件级诊断（如 `eof_without_end_marker`）为 0 */
  line: number;
  /** 人类可读说明 */
  message: string;
}

/** 被跳过的行（spec §10.2 / §10.3） */
export interface SkippedLine {
  line: number;
  raw: string;
  reason: 'unknown_kind' | 'unknown_directive' | 'invalid_record';
  /** 更具体的原因（非法记录时给出） */
  detail?: string;
}

/** 时钟域（spec §6.1 / §8.2） */
export interface DomainInfo {
  name: string;
  /** 上升沿数 = 周期数（spec §6.2） */
  cycles: number;
  posEdges: number;
  negEdges: number;
  /** 是否有 `@domain` 声明 */
  declared: boolean;
  /** `@domain` 的 period= 换算出的周期（纳秒）；缺失则 undefined */
  periodNs?: number;
  freqHz?: number;
  note?: string;
  /** 该域记录（含其它类型的记录）出现的周期范围 */
  firstCycle: number;
  lastCycle: number;
}

/** 带位置的值 */
export interface Timed<T> {
  value: T;
  pos: Position;
  async: boolean;
}

/** 计数器（spec §9.2）。追踪键 = (域, 名字) */
export interface CounterTrack {
  name: string;
  domain: string;
  key: string;
  /** 终值 */
  total: number;
  /** 每条 cnt 记录（按文件顺序） */
  samples: {
    pos: Position;
    /** 增量；`abs=` 记录为 null（它只置总量，不贡献 delta） */
    delta: number | null;
    /** 绝对值设置；普通记录为 null */
    abs: number | null;
    /** 该记录之后的总量 */
    total: number;
    async: boolean;
    line: number;
  }[];
  /** 每周期增量：cycle → Σdelta（不含 abs 记录） */
  deltaByCycle: Map<number, number>;
  /** 累计值在每周期末的取值：cycle → total */
  totalByCycle: Map<number, number>;
  /** 总量发生变化的周期列表（稀疏） */
  changeCycles: number[];
}

/** 数值轨（spec §9.3）。保持型 */
export interface ValueTrack {
  name: string;
  domain: string;
  key: string;
  samples: Timed<ScalarValue>[];
  /** 发生过变化的采样（相邻取值不同，含 未知↔已知） */
  changes: Timed<ScalarValue>[];
}

/** 状态机轨（spec §9.5）。保持型 */
export interface FsmTrack {
  name: string;
  domain: string;
  key: string;
  samples: Timed<ScalarValue>[];
  transitions: { from: string | null; to: string; pos: Position; selfLoop: boolean }[];
  /** 状态名 → 占据周期数（按 §9.5 的驻留定义：相邻两条记录的周期差之和） */
  dwellCycles: Map<string, number>;
  stateSet: string[];
}

/**
 * 复位标记（spec §7.7）。
 * `[rst]` 本身**不进记录序列**：它把此前接受的事件记录整批丢掉，只留下"在哪一行丢了什么"。
 */
export interface ResetMark {
  /** `[rst]` 所在行号（从 1 开始） */
  line: number;
  /** 被这次复位丢弃的事件记录条数 */
  droppedRecords: number;
}

/** 在飞条目（spec §7.4 / §9.4） */
export interface PipelineItem {
  track: string;
  domain: string;
  tag: ScalarValue | null;
  /** 入记录位置 */
  enter: Position;
  /** 出/撤记录位置（原样保留，可能是另一个域） */
  exit: Position | null;
  abort: Position | null;
  /** 关闭类型：`O` = 完成，`X` = 撤销，`null` = 文件结束时仍未闭合 */
  closed: 'O' | 'X' | null;
  /** 是否跨域条目（enter 与 close 的域不同） */
  crossDomain: boolean;
  /** 同域延迟（周期差）；跨域或未闭合时为 null */
  latencyCycles: number | null;
  /** 跨域且两端域都声明了 period 时的时间延迟（纳秒）；否则 null */
  latencyNs: number | null;
  /** 关闭时刻在 enter 域上锚定的周期（占用度按 enter 域统计，spec §9.4） */
  closeAnchorCycle: number | null;
  /** 入、出记录的全局序号，便于表格排序与定位 */
  enterSeq: number;
  closeSeq: number | null;
  /** 是否由 orphan（无匹配在飞条目）产生 */
  orphan: boolean;
  /** 入记录是否异步（spec §6.7） */
  async: boolean;
  /** 出/撤记录是否异步 */
  closeAsync: boolean;
  enterLine: number;
  closeLine: number | null;
}

/** 轨道（spec §7.4 的追踪键 = 轨道名，不含域） */
export interface TrackInfo {
  name: string;
  /** 绑定域：该轨道第一条记录所在的域 */
  domain: string;
  items: PipelineItem[];
  /** 该轨道记录覆盖的周期范围（按绑定域） */
  firstCycle: number;
  lastCycle: number;
  /** 逐周期占用度（下标 = 周期号，稀疏区段为 0）；半开区间 [enter, close) */
  occupancy: Map<number, number>;
  arrivals: Map<number, number>;
  departures: Map<number, number>;
  aborts: Map<number, number>;
  /** 气泡周期（占用度为 0 且在活跃区间内） */
  bubbles: number[];
  /** 气泡区间（连续气泡合并；**含两端**，与占用度的半开区间口径不同，刻意如此以便直接显示 "6–8"） */
  bubbleRanges: { start: number; end: number }[];
  completed: number;
  aborted: number;
  open: number;
  orphan: number;
  /** 已完成条目的延迟（同域，周期） */
  latencies: number[];
  /** 两条同标记条目同时在飞 */
  duplicateTags: number;
}

/** 瞬时事件（spec §7.6）。追踪键 = (域, 名字) */
export interface EventTrack {
  name: string;
  domain: string;
  key: string;
  samples: Timed<ScalarValue | null>[];
}

/** 解析结果 */
export interface Trace {
  version: { major: number; minor: number; explicit: boolean; raw?: string };
  meta: Record<string, string>;
  /** 源文件字节/字符数（未压缩）与行数，用于总览 */
  stats: {
    lines: number;
    bytes: number;
    records: number;
    skipped: number;
    /** 每条记录的平均字节数 */
    bytesPerRecord: number;
  };
  domains: Map<string, DomainInfo>;
  records: EventRecord[];
  /** `[rst]` 复位标记（spec §7.7）：复位前的事件记录已被丢弃，这里只留下"丢了什么" */
  resets: ResetMark[];
  counters: Map<string, CounterTrack>;
  values: Map<string, ValueTrack>;
  fsms: Map<string, FsmTrack>;
  tracks: Map<string, TrackInfo>;
  events: Map<string, EventTrack>;
  messages: MsgRecord[];
  diagnostics: Diagnostic[];
  /** 诊断码 → 次数 */
  diagnosticCounts: Map<string, number>;
  skipped: SkippedLine[];
  /** 末尾未以换行结束、被丢弃的残行原文（spec §10.1） */
  truncatedTail: string | null;
  /** 是否出现过 `at=`（出现过的文件不保证位置单调，spec §6.3） */
  hasAtOverride: boolean;
  /** 是否见到 `@end` */
  endSeen: boolean;
}

/** 追踪键：(域, 名字) ⇒ 稳定的字符串 key */
export function trackKey(domain: string, name: string): string {
  return `${domain}\u0000${name}`;
}
