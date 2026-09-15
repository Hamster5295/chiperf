/**
 * chiperf 1.0 —— 行内词法与字段切分（spec §4.1 / §5.1 / §5.2）
 *
 * 上下文相关规则只有两条（spec §5.1）：`at=` 的值是一个整体记号；`msg` 的载荷是行尾原文。
 * 后者由 parse.ts 在分派时处理，本模块负责前者与通用的注释/字段切分。
 */
import type { ScalarValue } from './types.ts';
import { scanValue } from './value.ts';

export type Arg =
  | { kind: 'pos'; value: ScalarValue }
  | { kind: 'attr'; key: string; value: ScalarValue | null; text: string }
  | { kind: 'error'; reason: string; text: string };

/** 去掉行尾注释：`#` 位于行首或前面是空白，且不在字符串内（spec §4.1） */
export function stripComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"' && line[i - 1] !== '\\') inString = !inString;
    else if (c === '#' && !inString && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) {
      return line.slice(0, i);
    }
  }
  return line;
}

/** 按顶层逗号切分字段，字符串内的逗号不切（spec §5.1） */
/** 顶层切分：引号内的分隔符不算（`sep` 决定哪些字符算分隔符） */
function splitOn(s: string, isSep: (c: string) => boolean): string[] {
  const out: string[] = [];
  let cur = '';
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"' && s[i - 1] !== '\\') {
      inString = !inString;
      cur += c;
      continue;
    }
    if (!inString && isSep(c)) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** 记录字段的顶层切分：只认逗号（spec §5.1） */
export function splitTopLevel(s: string): string[] {
  return splitOn(s, (c) => c === ',');
}

/**
 * 指令字段的顶层切分（spec §8）：逗号**或空白**都算分隔符。
 * 指令的语法写作 `@ <名> [位置参数...] [属性...]`，§8.1 的例子就是空白分隔的
 * （`@meta design="x" tool="y"`），而 `@domain core, period=1.0ns` 又是逗号分隔，
 * 两种写法都在用，所以两种都收 —— 未加引号的记号本来就不含空白，切分无歧义。
 */
export function splitDirectiveFields(s: string): string[] {
  return splitOn(s, (c) => c === ',' || c === ' ' || c === '\t');
}

/** 找出顶层（不在字符串内）的第一个 `=` 的位置 */
function findAssign(s: string): number {
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"' && s[i - 1] !== '\\') inString = !inString;
    else if (c === '=' && !inString) return i;
  }
  return -1;
}

const RE_AT_VALUE = /^-?\d+[pn]?$/;

/**
 * 解析一条记录的字段列表。
 * 消歧规则（spec §5.1）：字段首记号后紧跟 `=` ⇒ 属性；否则位置参数。
 */
export function parseArgs(fieldText: string, opts: { allowAttrs?: boolean; spaceSeparated?: boolean } = {}): Arg[] {
  const trimmed = fieldText.trim();
  if (trimmed.length === 0) return [];
  const args: Arg[] = [];
  let sawAttr = false;

  // 指令允许空白分隔（splitDirectiveFields），记录只认逗号（§5.1）
  const fields = opts.spaceSeparated === true ? splitDirectiveFields(trimmed) : splitTopLevel(trimmed);
  for (const rawField of fields) {
    const field = rawField.trim();
    if (field.length === 0) {
      // 指令里 `, ` 这种"逗号 + 空白"的组合会产生空段，忽略；
      // 记录里空字段是语法错误（§5.1：不允许空字段）
      if (opts.spaceSeparated === true) continue;
      args.push({ kind: 'error', reason: '空字段（多余的逗号）', text: rawField });
      continue;
    }
    if (opts.allowAttrs === false) {
      args.push({ kind: 'error', reason: '该记录不接受属性（msg）', text: field });
      continue;
    }
    const eq = findAssign(field);
    if (eq < 0) {
      const scanned = scanValue(field);
      if (!scanned || scanned.rest.trim().length > 0) {
        args.push({ kind: 'error', reason: '位置参数不是单个合法值的记号', text: field });
        continue;
      }
      if (scanned.value.kind === 'sym' && scanned.value.text === '') {
        args.push({ kind: 'error', reason: '空位置参数', text: field });
        continue;
      }
      if (sawAttr) {
        args.push({ kind: 'error', reason: '位置参数出现在属性之后', text: field });
        continue;
      }
      args.push({ kind: 'pos', value: scanned.value });
      continue;
    }

    // 属性
    const key = field.slice(0, eq).trim();
    const valueText = field.slice(eq + 1).trim();
    if (key.length === 0 || !/^[A-Za-z0-9_.$+\-/[\]]+$/.test(key)) {
      args.push({ kind: 'error', reason: '属性键不是合法裸词', text: field });
      continue;
    }
    if (key === 'at') {
      // spec §5.1 规则 2：`at=` 的值是一个整体记号，内容必须匹配 int[p|n]
      if (!RE_AT_VALUE.test(valueText)) {
        args.push({ kind: 'error', reason: 'at 的值不符合 int[p|n]', text: field });
        continue;
      }
      sawAttr = true;
      args.push({ kind: 'attr', key, value: null, text: valueText });
      continue;
    }
    const scanned = scanValue(valueText);
    if (!scanned || scanned.rest.trim().length > 0) {
      args.push({ kind: 'error', reason: '属性值不是单个合法值的记号', text: field });
      continue;
    }
    sawAttr = true;
    args.push({ kind: 'attr', key, value: scanned.value.text === '' ? null : scanned.value, text: valueText });
  }

  return args;
}

/** 从 `at=` 的值解出 (cycle, phase)；缺省相位为 `p`（spec §5.2） */
export function decodeAt(text: string): { cycle: number; phase: 'p' | 'n' } | null {
  const m = /^(-?\d+)([pn])?$/.exec(text);
  if (!m) return null;
  return { cycle: Number(m[1]), phase: (m[2] as 'p' | 'n' | undefined) ?? 'p' };
}
