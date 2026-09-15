/**
 * RISC-V 译码与数值格式显示测试
 *
 * 用例都是手工核过的真实编码（示例轨迹里出现的那几条 + 几个边界指令），
 * 位域取错、立即数拼错都会在这里失败。
 */
import { describe, expect, test } from 'bun:test';
import { formatScalarBy, rvDecode } from '../src/rv.ts';
import { scanValue } from '../../parser/src/index.ts';

/** 归一化空白后比较，避免受对齐空格影响 */
const decode = (word: number, xlen: 32 | 64) => rvDecode(word, xlen).replace(/\s+/g, ' ').trim();

describe('RV32I / RV64I 译码', () => {
  test('算术与访存（示例轨迹里的指令）', () => {
    expect(decode(0x00150513, 32)).toBe('addi a0, a0, 1');
    expect(decode(0x00260613, 32)).toBe('addi a2, a2, 2');
    expect(decode(0x00052583, 32)).toBe('lw a1, 0(a0)');
    expect(decode(0x000016b7, 32)).toBe('lui a3, 0x1000');
    expect(decode(0x00d52223, 32)).toBe('sw a3, 4(a0)');
  });

  test('分支与跳转给相对偏移', () => {
    expect(decode(0x00b50463, 32)).toBe('beq a0, a1, +8');
    expect(decode(0xff1ff0ef, 32)).toBe('jal ra, -16');
    expect(decode(0x00008067, 32)).toBe('jalr zero, 0(ra)');
  });

  test('系统指令', () => {
    expect(decode(0x00000073, 32)).toBe('ecall');
    expect(decode(0x00100073, 32)).toBe('ebreak');
  });

  test('RV32 与 RV64 的差别（ld / *W）', () => {
    expect(decode(0x00053503, 64)).toBe('ld a0, 0(a0)');
    expect(decode(0x00053503, 32)).toContain('.word');
    expect(decode(0x0005051b, 64)).toBe('addiw a0, a0, 0');
    expect(decode(0x0005051b, 32)).toContain('.word');
    expect(decode(0x00b5053b, 64)).toBe('addw a0, a0, a1');
  });

  test('未知编码不抛异常', () => {
    expect(decode(0xffffffff, 32)).toContain('.word');
    expect(decode(0x00000000, 32)).toContain('.c');
  });

  test('常见压缩指令', () => {
    expect(decode(0x8082, 32)).toBe('c.jr ra');
    expect(decode(0x4501, 32)).toBe('c.li a0, 0');
    expect(decode(0x0001, 32)).toBe('c.nop');
  });
});

describe('数值显示格式', () => {
  const value = scanValue('255')!.value;
  const fourState = scanValue("4'b10xz")!.value;
  const text = scanValue('"abc"')!.value;

  test('dec / hex / oct / bin', () => {
    expect(formatScalarBy(value, 'dec')).toBe('255');
    expect(formatScalarBy(value, 'hex')).toBe('0xff');
    expect(formatScalarBy(value, 'oct')).toBe('0o377');
    expect(formatScalarBy(value, 'bin')).toBe('0b11111111');
  });

  test('rv32 / rv64 按指令译码', () => {
    const instr = scanValue("32'h00150513")!.value;
    expect(formatScalarBy(instr, 'rv32')).toBe('addi a0, a0, 1');
    expect(formatScalarBy(instr, 'rv64')).toBe('addi a0, a0, 1');
  });

  test('4 态值与字符串不受格式影响（不可数值化）', () => {
    expect(formatScalarBy(fourState, 'hex')).toBe("4'b10xz");
    expect(formatScalarBy(text, 'hex')).toBe('"abc"');
  });
});
