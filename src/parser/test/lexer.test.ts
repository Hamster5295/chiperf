/** 词法层单测（spec §4 / §5.1 / §5.2） */
import { describe, expect, test } from 'bun:test';
import { scanValue, valueKey, formatValue } from '../src/value.ts';
import { parseArgs, stripComment, splitTopLevel, decodeAt } from '../src/lexer.ts';

const scan = (s: string) => scanValue(s)!;

describe('数值字面量（spec §4.3）', () => {
  test('十进制、负数、下划线分隔', () => {
    expect(scan('1234').value).toMatchObject({ kind: 'int', text: '1234' });
    expect(scan('-3').value.big).toBe(-3n);
    expect(scan('1_000_000').value.text).toBe('1000000');
  });

  test('0x / 0b / 0o', () => {
    expect(scan('0x800001d0').value).toMatchObject({ kind: 'bits', text: '0x800001d0' });
    expect(scan('0x800001d0').value.big).toBe(0x800001d0n);
    expect(scan('0b1010').value.big).toBe(10n);
    expect(scan('0o17').value.big).toBe(15n);
    expect(scan('0xDEAD_BEEF').value.text).toBe('0xdeadbeef');
  });

  test('Verilog 风格：四种进制、可选 size、4 态', () => {
    expect(scan("32'h8000_01d0").value).toMatchObject({ kind: 'bits', width: 32, text: "32'h800001d0" });
    expect(scan("32'h8000_01d0").value.big).toBe(0x800001d0n);
    expect(scan("8'hFF").value.big).toBe(255n);
    expect(scan("4'b10xz").value).toMatchObject({ width: 4, hasXZ: true });
    expect(scan("4'b10xz").value.big).toBeUndefined();
    expect(scan("'hFF").value.kind).toBe('bits');
    expect(scan("'hFF").value.width).toBeUndefined();
    expect(scan("8'd255").value.big).toBe(255n);
    expect(scan("12'o777").value.big).toBe(511n);
    expect(scan("4'b10XZ").value.hasXZ).toBe(true);
    expect(scan("32'hz").value.hasXZ).toBe(true);
  });

  test('实数：单位不再被识别为缩放量（v1.0 已删除时间换算）', () => {
    expect(scan('1.5').value).toMatchObject({ kind: 'real', num: 1.5 });
    expect(scan('1.5e-9').value.num).toBeCloseTo(1.5e-9, 20);
    // `1.0ns` 只扫出数值部分，`ns` 留给调用方判为"不是一个合法记号"
    expect(scan('1.0ns').value).toMatchObject({ kind: 'real', text: '1.0' });
    expect(scan('1.0ns').rest).toBe('ns');
  });

  test('裸词：x/z 是 4 态标量，X/Z 是符号（spec §4.5 的冲突消解）', () => {
    expect(scan('x').value).toMatchObject({ kind: 'bits', hasXZ: true });
    expect(scan('z').value.kind).toBe('bits');
    expect(scan('X').value).toMatchObject({ kind: 'sym', text: 'X' });
    expect(scan('Z').value.kind).toBe('sym');
    expect(scan('IDLE').value.kind).toBe('sym');
  });

  test('名字里允许的裸词字符（spec §4.4）', () => {
    for (const word of ['core.if.pc', 'mem[3]', 'a-b', 'x86/alu', '$tmp', 'IF-0']) {
      expect(`${word}:${scan(word).value.kind}`).toBe(`${word}:sym`);
    }
  });

  test('扫描后剩余文本被保留（用于判定"不是一个记号"）', () => {
    expect(scan('1234p').rest).toBe('p');
    expect(scan('1234 ').rest.trim()).toBe('');
  });
});

describe('字符串（spec §4.2）', () => {
  test('转义与解码', () => {
    expect(scan('"addi a0,a0,1"').value.text).toBe('addi a0,a0,1');
    expect(scan('"a\\"b"').value.text).toBe('a"b');
    expect(scan('"l1\\nl2"').value.text).toBe('l1\nl2');
    expect(scan('"c:\\\\x"').value.text).toBe('c:\\x');
  });

  test('未知转义按字面字面容错并给出告警（spec §4.2）', () => {
    const r = scan('"a\\qb"');
    expect(r.value.text).toBe('aqb');
    expect(r.warnings?.[0]?.code).toBe('invalid_escape');
  });

  test('未闭合字符串返回 null（调用方判为非法记录）', () => {
    expect(scanValue('"abc')).toBeNull();
    expect(scanValue('"abc\\')).toBeNull();
  });
});

describe('注释与字段切分（spec §4.1 / §5.1）', () => {
  test('注释仅在不属于字符串、且在行首或空白之后时开始', () => {
    expect(stripComment('[cnt] "x"   # note').trim()).toBe('[cnt] "x"');
    expect(stripComment('# whole line')).toBe('');
    expect(stripComment('[msg] a#b')).toBe('[msg] a#b');
    expect(stripComment('[val] "a # b", 1').trim()).toBe('[val] "a # b", 1');
  });

  test('顶层逗号切分（字符串内的逗号不切）', () => {
    expect(splitTopLevel('"a,b", 1, c')).toEqual(['"a,b"', ' 1', ' c']);
  });
});

describe('字段解析（spec §5.1 的两条上下文规则）', () => {
  test('属性 vs 参数消歧', () => {
    const args = parseArgs('"core.if", I, 0x10, dom=core');
    expect(args.map((a) => a.kind)).toEqual(['pos', 'pos', 'pos', 'attr']);
    const attr = args[3]!;
    expect(attr.kind === 'attr' && attr.key).toBe('dom');
  });

  test('参数出现在属性之后 ⇒ 非法记录', () => {
    const args = parseArgs('a, dom=core, b');
    expect(args.some((a) => a.kind === 'error')).toBe(true);
  });

  test('空字段（多余逗号）⇒ 非法记录', () => {
    expect(parseArgs('"x",').some((a) => a.kind === 'error')).toBe(true);
  });

  test('at= 的值是一个整体记号：int[p|n]', () => {
    for (const text of ['1234', '1234p', '1234n', '0p']) {
      const args = parseArgs(`1p, at=${text}`);
      const at = args.find((a) => a.kind === 'attr' && a.key === 'at');
      expect(`${text}:${at?.kind}`).toBe(`${text}:attr`);
      expect(decodeAt(text)).not.toBeNull();
    }
    expect(parseArgs('1p, at=12.5p').some((a) => a.kind === 'error')).toBe(true);
    expect(parseArgs('1p, at=1234 p').some((a) => a.kind === 'error')).toBe(true);
    expect(parseArgs('1p, at=p').some((a) => a.kind === 'error')).toBe(true);
  });

  test('厂商属性键允许连字符（spec §12.3）', () => {
    const args = parseArgs('"PC", 1, x-vendor-retry=3');
    expect(args.filter((a) => a.kind === 'attr').map((a) => (a.kind === 'attr' ? a.key : ''))).toEqual(['x-vendor-retry']);
  });
});

describe('值等价比与格式化', () => {
  test('同值不同写法不相等（宽度与进制都参与比较）', () => {
    expect(valueKey(scan('0x10').value)).not.toBe(valueKey(scan('16').value));
    expect(valueKey(scan('0x10').value)).toBe(valueKey(scan('0x10').value));
    expect(valueKey(null)).toBe('∅');
  });

  test('格式化字符串值带引号，其余原样', () => {
    expect(formatValue(scan('"abc"').value)).toBe('"abc"');
    expect(formatValue(scan("32'hff").value)).toBe("32'hff");
    expect(formatValue(null)).toBe('');
  });
});
