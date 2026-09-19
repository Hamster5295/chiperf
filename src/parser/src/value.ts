/**
 * chiperf 1.0 —— 值的词法扫描与类型化（spec §4.2 / §4.3 / §4.4 / §4.5）
 *
 * 扫描顺序固定为 **字符串 → 数值 → 裸词**（spec §4 开头）。
 * 裸词 `x`/`X`/`z`/`Z` 在任何位置都表示 4 态标量（spec §4.5）。
 */
import type { ScalarValue } from './types.ts';

const WORD_CHAR = /[A-Za-z0-9_.$+\-/[\]]/;

/** 数值记号的候选（按优先级尝试；Verilog 字面量必须先于十进制） */
const RE_VERILOG = /^-?\d[\d_]*'[sS]?[bBoOdDhH][0-9a-fA-F_xXzZ]+/;
const RE_VERILOG_NOSIZE = /^-?'[sS]?[bBoOdDhH][0-9a-fA-F_xXzZ]+/;
const RE_HEX = /^-?0[xX][0-9a-fA-F_xXzZ]+/;
const RE_BIN = /^-?0[bB][01_xXzZ]+/;
const RE_OCT = /^-?0[oO][0-7_xXzZ]+/;
const RE_DEC = /^-?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?/;

export interface ScanResult {
  value: ScalarValue;
  /** 未消费的剩余文本 */
  rest: string;
  /** 扫描过程中的诊断（目前只有非法转义） */
  warnings?: { code: 'invalid_escape'; message: string }[];
}

/** 扫描一个字符串字面量；未闭合返回 null（调用方判为非法记录） */
function scanString(src: string): { value: ScalarValue; rest: string; warnings: { code: 'invalid_escape'; message: string }[] } | null {
  if (src[0] !== '"') return null;
  const warnings: { code: 'invalid_escape'; message: string }[] = [];
  let out = '';
  let i = 1;
  for (; i < src.length; i++) {
    const c = src[i]!;
    if (c === '\\') {
      const n = src[i + 1];
      if (n === undefined) return null; // 反斜杠结尾 ⇒ 未闭合
      switch (n) {
        case '\\': out += '\\'; break;
        case '"': out += '"'; break;
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        default:
          // spec §4.2：按字面字面容错并产生诊断，不丢弃整条记录
          out += n;
          warnings.push({ code: 'invalid_escape', message: `未知转义 \\${n}，按字面字符处理` });
      }
      i++;
      continue;
    }
    if (c === '"') {
      const raw = src.slice(0, i + 1);
      return { value: { kind: 'str', text: out, raw }, rest: src.slice(i + 1), warnings };
    }
    out += c;
  }
  return null; // 未闭合
}

function numericKind(literal: string): ScalarValue {
  const raw = literal;
  const norm = literal.replace(/_/g, '');
  const signed = norm.startsWith('-');
  const body = signed ? norm.slice(1) : norm;

  // Verilog 风格：<size>'[s]<base><digits>（size 可省略）
  const vm = /^(\d*)'([sS]?)([bBoOdDhH])([0-9a-fA-FxXzZ]+)$/.exec(body);
  if (vm) {
    const width = vm[1] ? Number(vm[1]) : undefined;
    const base = vm[3]!.toLowerCase();
    const digits = vm[4]!;
    const hasXZ = /[xXzZ]/.test(digits);
    const value: ScalarValue = {
      kind: 'bits',
      text: `${signed ? '-' : ''}${vm[1] ?? ''}'${base}${digits.toLowerCase()}`.replace(/_/g, ''),
      raw,
      hasXZ,
      ...(width !== undefined ? { width } : {}),
    };
    if (!hasXZ) {
      const radix = base === 'b' ? 2 : base === 'o' ? 8 : base === 'd' ? 10 : 16;
      let big = 0n;
      for (const ch of digits) big = big * BigInt(radix) + BigInt(parseInt(ch, radix));
      value.big = signed ? -big : big;
    }
    return value;
  }

  if (/^-?0[xX]/.test(norm)) {
    const digits = norm.replace(/^-?0[xX]/, '').replace(/_/g, '');
    const hasXZ = /[xXzZ]/.test(digits);
    const value: ScalarValue = { kind: 'bits', text: `${signed ? '-' : ''}0x${digits.toLowerCase()}`, raw, hasXZ };
    if (!hasXZ) {
      let big = 0n;
      for (const ch of digits) big = big * 16n + BigInt(parseInt(ch, 16));
      value.big = signed ? -big : big;
    }
    return value;
  }
  if (/^-?0[bB]/.test(norm)) {
    const digits = norm.replace(/^-?0[bB]/, '').replace(/_/g, '');
    const hasXZ = /[xXzZ]/.test(digits);
    const value: ScalarValue = { kind: 'bits', text: `${signed ? '-' : ''}0b${digits.toLowerCase()}`, raw, hasXZ };
    if (!hasXZ) value.big = signed ? -BigInt(`0b${digits}`) : BigInt(`0b${digits}`);
    return value;
  }
  if (/^-?0[oO]/.test(norm)) {
    const digits = norm.replace(/^-?0[oO]/, '').replace(/_/g, '');
    const hasXZ = /[xXzZ]/.test(digits);
    const value: ScalarValue = { kind: 'bits', text: `${signed ? '-' : ''}0o${digits.toLowerCase()}`, raw, hasXZ };
    if (!hasXZ) value.big = signed ? -BigInt(`0o${digits}`) : BigInt(`0o${digits}`);
    return value;
  }

  // 十进制：整数或实数
  if (/[.eE]/.test(body)) {
    return { kind: 'real', text: norm, raw, num: Number(norm) };
  }
  return { kind: 'int', text: norm, raw, big: BigInt(norm) };
}

/** 扫描一个完整的值记号（字符串 / 数值 / 裸词） */
export function scanValue(src: string): ScanResult | null {
  const s = src.replace(/^[ \t]+/, '');
  if (s.length === 0) return null;

  if (s[0] === '"') {
    const r = scanString(s);
    if (!r) return null;
    return { value: r.value, rest: r.rest, warnings: r.warnings };
  }

  // 数值（含 Verilog 字面量）
  for (const re of [RE_VERILOG, RE_VERILOG_NOSIZE, RE_HEX, RE_BIN, RE_OCT, RE_DEC]) {
    const m = re.exec(s);
    if (!m) continue;
    const lit = m[0];
    const rest = s.slice(lit.length);
    return { value: numericKind(lit), rest };
  }

  // 裸词
  const start = s[0]!;
  if (!WORD_CHAR.test(start)) return null;
  let i = 0;
  while (i < s.length && WORD_CHAR.test(s[i]!)) i++;
  const word = s.slice(0, i);
  if (word === 'x' || word === 'z') {
    // spec §4.5：裸词 x/z（小写）是 4 态标量；大写 X/Z 保持为普通符号，
    // 以便与 pip 的方向 X（撤销）共存而无需按记录类型分支。
    return { value: { kind: 'bits', text: word, raw: word, hasXZ: true }, rest: s.slice(i) };
  }
  return { value: { kind: 'sym', text: word, raw: word }, rest: s.slice(i) };
}

/** 值的等价比：用于 `pip` 标记匹配（spec §7.4）与状态比较（spec §7.5） */
export function valueKey(v: ScalarValue | null): string {
  if (v === null) return '∅';
  switch (v.kind) {
    case 'int':
      return `i:${v.big ?? v.text}`;
    case 'bits':
      return `b:${v.width ?? ''}:${v.text}`;
    case 'real':
      return `r:${v.num ?? v.text}`;
    case 'str':
      return `s:${v.text}`;
    case 'sym':
      return `y:${v.text}`;
  }
}

/** 值是否等于某个裸词符号（用于 `p`/`n`/`I`/`O`/`X` 这类枚举） */
export function symIs(v: ScalarValue, want: string): boolean {
  return v.kind === 'sym' && v.text === want;
}

/** 展示用文本 */
export function formatValue(v: ScalarValue | null): string {
  if (v === null) return '';
  switch (v.kind) {
    case 'str':
      return JSON.stringify(v.text);
    case 'bits':
      return v.text;
    case 'real':
      return v.text;
    default:
      return v.text;
  }
}

/** 若值为纯整数（`int`，或宽度未声明且不含 x/z 的 `bits`）则返回其 number，否则 null */
export function asInt(v: ScalarValue): number | null {
  if (v.kind === 'int' && v.big !== undefined) return Number(v.big);
  return null;
}
