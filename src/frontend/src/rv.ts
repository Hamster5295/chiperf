/**
 * 数值显示格式与 RISC-V 指令译码
 *
 * 时间轴的数值行可按 dec / oct / hex / bin 显示；对 32 位以内的数据额外提供
 * rv32 / rv64 —— 按 RISC-V 指令译码后显示（RV32I/RV64I 整数子集 + 常见压缩指令）。
 * 译码只影响显示，不改动解析结果。
 */
import type { ScalarValue } from '../../parser/src/index.ts';

export type ValueFormat = 'dec' | 'oct' | 'hex' | 'bin' | 'rv32' | 'rv64';

export const VALUE_FORMATS: { id: ValueFormat; label: string }[] = [
  { id: 'dec', label: 'dec' },
  { id: 'hex', label: 'hex' },
  { id: 'oct', label: 'oct' },
  { id: 'bin', label: 'bin' },
  { id: 'rv32', label: 'rv32' },
  { id: 'rv64', label: 'rv64' },
];

/** 4 态值（含 x/z）与字符串不可数值化，按原样显示；其余按选定的进制格式化 */
export function formatScalarBy(value: ScalarValue, format: ValueFormat): string {
  if (value.kind === 'str') return `"${value.text}"`;
  if (value.kind === 'sym') return value.text;
  if (value.kind === 'real' || value.hasXZ === true || value.big === undefined) return value.text;
  const n = value.big;
  switch (format) {
    case 'dec':
      return n.toString(10);
    case 'hex':
      return `0x${n.toString(16)}`;
    case 'oct':
      return `0o${n.toString(8)}`;
    case 'bin':
      return `0b${n.toString(2)}`;
    case 'rv32':
      return rvDecode(Number(BigInt.asUintN(32, n)), 32).replace(/\s+/g, ' ').trim();
    case 'rv64':
      return rvDecode(Number(BigInt.asUintN(32, n)), 64).replace(/\s+/g, ' ').trim();
  }
}

// ------------------------------------------------------------------ RISC-V 译码

const ABI = [
  'zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2', 's0', 's1',
  'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7',
  's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11',
  't3', 't4', 't5', 't6',
];

const reg = (index: number): string => ABI[index] ?? `x${index}`;
const hex = (n: number): string => `0x${(n >>> 0).toString(16)}`;

/** 取位域 [hi:lo] */
function bits(word: number, hi: number, lo: number): number {
  return (word >>> lo) & ((1 << (hi - lo + 1)) - 1);
}

/** 有符号扩展（≤32 位） */
function sext(value: number, width: number): number {
  return (value << (32 - width)) >> (32 - width);
}

const BRANCH = ['beq', 'bne', 'blt', 'bge', 'bltu', 'bgeu'];
const LOAD = ['lb', 'lh', 'lw', 'ld', 'lbu', 'lhu', 'lwu'];
const STORE = ['sb', 'sh', 'sw', 'sd'];
const OP_IMM = ['addi', 'slti', 'sltiu', 'xori', 'ori', 'andi', 'slli', 'srli', 'srai'];
const OP = ['add', 'sll', 'slt', 'sltu', 'xor', 'srl', 'or', 'and'];

const CSR_NAME: Record<number, string> = {
  0x001: 'fflags', 0x002: 'frm', 0x003: 'fcsr', 0x300: 'mstatus', 0x305: 'mtvec',
  0x341: 'mepc', 0x342: 'mcause', 0x344: 'mip', 0x180: 'satp', 0xc00: 'cycle',
  0xc01: 'time', 0xc02: 'instret', 0xf14: 'mhartid',
};

const csrName = (index: number): string => CSR_NAME[index] ?? `0x${index.toString(16)}`;

/**
 * 译一条 32 位 RISC-V 指令；`xlen` 决定 RV32I / RV64I 的差别（`ld`/`sd`、`*W` 后缀等）。
 * 无法识别时给出 `.word 0x…` / `.c 0x…`，不抛异常。
 */
export function rvDecode(word: number, xlen: 32 | 64): string {
  const w = word >>> 0;
  if ((w & 0b11) !== 0b11) return decodeCompressed(w & 0xffff, xlen);

  const opcode = bits(w, 6, 0);
  const rd = bits(w, 11, 7);
  const funct3 = bits(w, 14, 12);
  const rs1 = bits(w, 19, 15);
  const rs2 = bits(w, 24, 20);
  const funct7 = bits(w, 31, 25);
  const immI = sext(bits(w, 31, 20), 12);
  const immS = sext((bits(w, 31, 25) << 5) | bits(w, 11, 7), 12);
  const immB = sext(
    (bits(w, 31, 31) << 12) | (bits(w, 7, 7) << 11) | (bits(w, 30, 25) << 5) | (bits(w, 11, 8) << 1),
    13,
  );
  const immJ = sext((bits(w, 31, 31) << 20) | (bits(w, 19, 12) << 12) | (bits(w, 20, 20) << 11) | (bits(w, 30, 21) << 1), 21);
  // 只有裸指令字、没有 PC，所以跳转给**相对偏移**（+8 / -16），不编造绝对地址
  const target = (offset: number): string => (offset >= 0 ? `+${offset}` : `${offset}`);
  const unknown = `.word  ${hex(w)}`;

  switch (opcode) {
    case 0x37:
      return `lui    ${reg(rd)}, ${hex(bits(w, 31, 12) << 12)}`;
    case 0x17:
      return `auipc  ${reg(rd)}, ${hex(bits(w, 31, 12) << 12)}`;
    case 0x6f:
      return `jal    ${reg(rd)}, ${target(immJ)}`;
    case 0x67:
      return funct3 === 0 ? `jalr   ${reg(rd)}, ${immI}(${reg(rs1)})` : unknown;
    case 0x63: {
      const name = BRANCH[funct3];
      return name === undefined ? unknown : `${name.padEnd(6)} ${reg(rs1)}, ${reg(rs2)}, ${target(immB)}`;
    }
    case 0x03: {
      const name = LOAD[funct3];
      const ok = name !== undefined && (xlen === 64 || (name !== 'ld' && name !== 'lwu'));
      return ok ? `${name!.padEnd(6)} ${reg(rd)}, ${immI}(${reg(rs1)})` : unknown;
    }
    case 0x23: {
      const name = STORE[funct3];
      const ok = name !== undefined && (xlen === 64 || name !== 'sd');
      return ok ? `${name!.padEnd(6)} ${reg(rs2)}, ${immS}(${reg(rs1)})` : unknown;
    }
    case 0x13: {
      const name = OP_IMM[funct3];
      if (name === undefined) return unknown;
      if (funct3 === 1 || funct3 === 5) {
        // 移位类：funct7 区分逻辑/算术右移
        if (funct7 !== 0x00 && funct7 !== 0x20) return unknown;
        const shamt = rs2 & (xlen === 32 ? 0x1f : 0x3f);
        const shift = funct3 === 1 ? 'slli' : funct7 === 0x20 ? 'srai' : 'srli';
        return `${shift.padEnd(6)} ${reg(rd)}, ${reg(rs1)}, ${shamt}`;
      }
      return `${name.padEnd(6)} ${reg(rd)}, ${reg(rs1)}, ${immI}`;
    }
    case 0x33: {
      const name = OP[funct3];
      if (name === undefined) return unknown;
      if (funct7 === 0x20 && funct3 === 0) return `sub    ${reg(rd)}, ${reg(rs1)}, ${reg(rs2)}`;
      if (funct7 !== 0x00) return unknown;
      return `${name.padEnd(6)} ${reg(rd)}, ${reg(rs1)}, ${reg(rs2)}`;
    }
    case 0x1b: {
      if (xlen !== 64) return unknown;
      if (funct3 === 0) return `${(funct7 === 0x20 ? 'addiw' : 'addiw').padEnd(6)} ${reg(rd)}, ${reg(rs1)}, ${immI}`;
      if (funct3 === 1) {
        if (funct7 !== 0x00) return unknown;
        return `slliw  ${reg(rd)}, ${reg(rs1)}, ${bits(w, 24, 20)}`;
      }
      if (funct3 === 5) {
        if (funct7 !== 0x00 && funct7 !== 0x20) return unknown;
        return `${(funct7 === 0x20 ? 'sraiw' : 'srliw').padEnd(6)} ${reg(rd)}, ${reg(rs1)}, ${bits(w, 24, 20)}`;
      }
      return unknown;
    }
    case 0x3b: {
      if (xlen !== 64) return unknown;
      if (funct7 === 0x00 && funct3 === 0) return `addw   ${reg(rd)}, ${reg(rs1)}, ${reg(rs2)}`;
      if (funct7 === 0x20 && funct3 === 0) return `subw   ${reg(rd)}, ${reg(rs1)}, ${reg(rs2)}`;
      if (funct7 === 0x00 && funct3 === 1) return `sllw   ${reg(rd)}, ${reg(rs1)}, ${reg(rs2)}`;
      if (funct7 === 0x00 && funct3 === 5) return `srlw   ${reg(rd)}, ${reg(rs1)}, ${reg(rs2)}`;
      if (funct7 === 0x20 && funct3 === 5) return `sraw   ${reg(rd)}, ${reg(rs1)}, ${reg(rs2)}`;
      return unknown;
    }
    case 0x0f:
      if (funct3 === 0) return `fence  ${bits(w, 27, 24)}, ${bits(w, 23, 20)}`;
      return funct3 === 1 ? 'fence.i' : unknown;
    case 0x73: {
      if (funct3 === 0) {
        if (immI === 0) return 'ecall';
        if (immI === 1) return 'ebreak';
        if (immI === 0x102) return 'sret';
        if (immI === 0x302) return 'mret';
        return `.word  ${hex(w)}  (system ${immI})`;
      }
      const names = ['csrrw', 'csrrs', 'csrrc', undefined, 'csrrwi', 'csrrsi', 'csrrci'];
      const name = names[funct3];
      if (name === undefined) return unknown;
      const source = funct3 >= 4 ? String(rs1) : reg(rs1);
      return `${name.padEnd(6)} ${reg(rd)}, ${csrName(immI & 0xfff)}, ${source}`;
    }
    default:
      return unknown;
  }
}

// ------------------------------------------------------------------ 压缩指令（C 扩展子集）

/** C 扩展的寄存器字段 */
const regP = (h: number): string => reg(8 + bits(h, 4, 2));

/** CJ 型立即数（C.J / C.JAL） */
function immCJ(h: number): number {
  return sext(
    (bits(h, 12, 12) << 11) | (bits(h, 11, 11) << 4) | (bits(h, 10, 9) << 8) | (bits(h, 8, 8) << 10) | (bits(h, 7, 7) << 6) | (bits(h, 6, 6) << 7) | (bits(h, 5, 3) << 1) | (bits(h, 2, 2) << 5),
    12,
  );
}

/** CB 型立即数（C.BEQZ / C.BNEZ） */
function immCB(h: number): number {
  return sext(
    (bits(h, 12, 12) << 8) | (bits(h, 11, 10) << 3) | (bits(h, 6, 5) << 6) | (bits(h, 4, 3) << 1) | (bits(h, 2, 2) << 5),
    9,
  );
}

function decodeCompressed(h: number, xlen: 32 | 64): string {
  const quadrant = h & 0b11;
  const funct3 = bits(h, 15, 13);
  const fallback = `.c    0x${h.toString(16)}`;
  const rd = bits(h, 11, 7);
  const rs2 = bits(h, 6, 2);

  if (quadrant === 0) {
    const uimm = (bits(h, 12, 10) << 3) | (bits(h, 6, 5) << 1); // C.LW/C.SW 的字偏移
    switch (funct3) {
      case 0: {
        const nzuimm = bits(h, 12, 5);
        return nzuimm === 0 ? fallback : `c.addi4spn ${regP(h)}, sp, ${nzuimm * 4}`;
      }
      case 2:
        return `c.lw   ${regP(h)}, ${uimm * 4}(${regP(h)})`;
      case 3:
        return xlen === 64 ? `c.ld   ${regP(h)}, ${uimm * 8}(${regP(h)})` : fallback;
      case 6:
        return `c.sw   ${regP(h)}, ${uimm * 4}(${regP(h)})`;
      case 7:
        return xlen === 64 ? `c.sd   ${regP(h)}, ${uimm * 8}(${regP(h)})` : fallback;
      default:
        return fallback;
    }
  }

  if (quadrant === 1) {
    switch (funct3) {
      case 0:
        return rd === 0 ? 'c.nop' : `c.addi ${reg(rd)}, ${sext((bits(h, 12, 12) << 5) | bits(h, 6, 2), 6)}`;
      case 1:
        return `c.jal  ${immCJ(h) >= 0 ? '+' : ''}${immCJ(h)}`;
      case 2:
        return `c.li   ${reg(rd)}, ${sext((bits(h, 12, 12) << 5) | bits(h, 6, 2), 6)}`;
      case 3: {
        if (rd === 2) {
          const imm = sext(
            (bits(h, 12, 12) << 9) | (bits(h, 6, 6) << 4) | (bits(h, 5, 5) << 6) | (bits(h, 4, 3) << 7) | (bits(h, 2, 2) << 5),
            10,
          );
          return `c.addi16sp ${imm * 16}`;
        }
        return `c.lui  ${reg(rd)}, ${hex(sext((bits(h, 12, 12) << 5) | bits(h, 6, 2), 6) << 12)}`;
      }
      case 4: {
        const sub = bits(h, 11, 10);
        if (sub === 0) return `c.srli ${regP(h)}, ${bits(h, 6, 2)}`;
        if (sub === 1) return `c.srai ${regP(h)}, ${bits(h, 6, 2)}`;
        if (sub === 2) return `c.andi ${regP(h)}, ${sext((bits(h, 12, 12) << 5) | bits(h, 6, 2), 6)}`;
        const ops = ['c.sub', 'c.xor', 'c.or', 'c.and'];
        return `${ops[bits(h, 6, 5)]}  ${regP(h)}, ${reg(8 + bits(h, 4, 2))}`;
      }
      case 5:
        return `c.j    ${immCJ(h) >= 0 ? '+' : ''}${immCJ(h)}`;
      case 6:
        return `c.beqz ${regP(h)}, ${immCB(h) >= 0 ? '+' : ''}${immCB(h)}`;
      default:
        return `c.bnez ${regP(h)}, ${immCB(h) >= 0 ? '+' : ''}${immCB(h)}`;
    }
  }

  switch (funct3) {
    case 0:
      return rd === 0 ? fallback : `c.slli ${reg(rd)}, ${(bits(h, 12, 12) << 5) | bits(h, 6, 2)}`;
    case 2: {
      const uimm = (bits(h, 12, 12) << 5) | (bits(h, 6, 4) << 2) | (bits(h, 3, 2) << 6);
      return rd === 0 ? fallback : `c.lwsp ${reg(rd)}, ${uimm}(${'sp'})`;
    }
    case 3:
      return xlen === 64 && rd !== 0 ? `c.ldsp ${reg(rd)}, ${(bits(h, 12, 12) << 5) | (bits(h, 6, 5) << 3) | (bits(h, 4, 2) << 6)}(sp)` : fallback;
    case 4:
      if (bits(h, 12, 12) === 0) {
        if (rs2 === 0) return rd === 0 ? fallback : `c.jr   ${reg(rd)}`;
        return `c.mv   ${reg(rd)}, ${reg(rs2)}`;
      }
      if (rs2 === 0) return rd === 0 ? 'c.ebreak' : `c.jalr ${reg(rd)}`;
      return `c.add  ${reg(rd)}, ${reg(rs2)}`;
    case 6: {
      const uimm = (bits(h, 12, 9) << 2) | (bits(h, 8, 7) << 6);
      return `c.swsp ${reg(rs2)}, ${uimm}(sp)`;
    }
    case 7:
      return xlen === 64 ? `c.sdsp ${reg(rs2)}, ${(bits(h, 12, 10) << 3) | (bits(h, 9, 7) << 6)}(sp)` : fallback;
    default:
      return fallback;
  }
}
