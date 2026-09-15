/**
 * 数值显示格式与 RISC-V 指令译码
 *
 * 时间轴的数值行可按 dec / oct / hex / bin 显示；对位向量额外提供 rv32 / rv64 ——
 * 按 RISC-V 指令译码后显示。覆盖面：
 *
 *  - **RV64GC** = RV32I/RV64I + M + A + F + D + C（压缩指令按低两位自动识别：
 *    低两位 ≠ 0b11 就当 16 位指令译）
 *  - **Zicsr**（csrrw/csrrs/csrrc/csrrwi/csrrsi/csrrci + 完整 CSR 名表）
 *  - **Zifencei**（fence.i）与 `fence` 的 pred/succ 解析、`pause`
 *  - **Zba/Zbb/Zbc/Zbs** 位操作（clz/ctz/cpop/rev8/rol/ror/andn/min/max/
 *    sh1add/clmul/bset/bclr/binv/bext/sext.b/zext.h…）
 *  - **Zicond**（czero.eqz/nez）、**Zfh**(H) 的半精度浮点
 *
 * 译码只影响显示，不改动解析结果。没有 PC，所以跳转/分支给的是**相对偏移**；
 * 认不出的编码给 `.word 0x…` / `.c 0x…`，不抛异常。
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
    // 指令编码固定看低 32 位：RISC-V 指令最多 32 位（压缩指令 16 位），
    // xlen 只影响 RV32/RV64 的合法性与少数字段宽度
    case 'rv32':
      return rvDecode(Number(BigInt.asUintN(32, n)), 32).replace(/\s+/g, ' ').trim();
    case 'rv64':
      return rvDecode(Number(BigInt.asUintN(32, n)), 64).replace(/\s+/g, ' ').trim();
  }
}

// ------------------------------------------------------------------ 位域与名字

/** 取位域 [hi:lo] */
function bits(word: number, hi: number, lo: number): number {
  return (word >>> lo) & ((1 << (hi - lo + 1)) - 1);
}

/** 有符号扩展（≤32 位） */
function sext(value: number, width: number): number {
  return (value << (32 - width)) >> (32 - width);
}

const hex = (n: number): string => `0x${(n >>> 0).toString(16)}`;

/** 整数寄存器 ABI 名（与 GNU 工具链一致） */
const ABI = [
  'zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2', 's0', 's1',
  'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7',
  's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11',
  't3', 't4', 't5', 't6',
];

/** 浮点寄存器 ABI 名（ft0-7 / fs0-1 / fa0-7 / fs2-11 / ft8-11） */
const FP_ABI = [
  'ft0', 'ft1', 'ft2', 'ft3', 'ft4', 'ft5', 'ft6', 'ft7',
  'fs0', 'fs1', 'fa0', 'fa1', 'fa2', 'fa3', 'fa4', 'fa5', 'fa6', 'fa7',
  'fs2', 'fs3', 'fs4', 'fs5', 'fs6', 'fs7', 'fs8', 'fs9', 'fs10', 'fs11',
  'ft8', 'ft9', 'ft10', 'ft11',
];

const reg = (index: number): string => ABI[index] ?? `x${index}`;
const freg = (index: number): string => FP_ABI[index] ?? `f${index}`;

/**
 * 舍入模式（funct3）。打印规则跟 GNU 工具链一致：`rne`（浮点操作默认）与
 * `dyn`（整数→浮点时该字段被忽略）都不打印，其余照写。
 */
const ROUND = ['rne', 'rtz', 'rdn', 'rup', 'rmm'];
const roundSuffix = (funct3: number): string => (funct3 >= 5 || funct3 === 0 ? '' : `, ${ROUND[funct3]}`);

// ------------------------------------------------------------------ CSR 名

/** 标准 CSR 名（含机器/监督/用户三种特权级与 `*h` 高位半字） */
const CSR_NAMES: Record<number, string> = {
  // 用户态浮点与计数器
  0x001: 'fflags', 0x002: 'frm', 0x003: 'fcsr',
  0xc00: 'cycle', 0xc01: 'time', 0xc02: 'instret',
  0xc80: 'cycleh', 0xc81: 'timeh', 0xc82: 'instreth',
  // 监督态
  0x100: 'sstatus', 0x102: 'sedeleg', 0x103: 'sideleg', 0x104: 'sie', 0x105: 'stvec',
  0x106: 'scounteren', 0x10a: 'senvcfg', 0x140: 'sscratch', 0x141: 'sepc', 0x142: 'scause',
  0x143: 'stval', 0x144: 'sip', 0x180: 'satp', 0x14d: 'stimecmp', 0x15d: 'stimecmph',
  // 机器态
  0x300: 'mstatus', 0x301: 'misa', 0x302: 'medeleg', 0x303: 'mideleg', 0x304: 'mie',
  0x305: 'mtvec', 0x306: 'mcounteren', 0x310: 'mstatush', 0x30a: 'menvcfg', 0x31a: 'menvcfgh',
  0x320: 'mcountinhibit', 0x323: 'mhpmevent3', 0x324: 'mhpmevent4', 0x33f: 'mhpmevent31',
  0x340: 'mscratch', 0x341: 'mepc', 0x342: 'mcause', 0x343: 'mtval', 0x344: 'mip',
  0x34a: 'mtinst', 0x34b: 'mtval2',
  0xb00: 'mcycle', 0xb02: 'minstret', 0xb80: 'mcycleh', 0xb82: 'minstreth',
  0x3a0: 'pmpcfg0', 0x3a1: 'pmpcfg1', 0x3a2: 'pmpcfg2', 0x3a3: 'pmpcfg3',
  0x3b0: 'pmpaddr0', 0x3b1: 'pmpaddr1', 0x3b2: 'pmpaddr2', 0x3b3: 'pmpaddr3',
  0x3b4: 'pmpaddr4', 0x3b5: 'pmpaddr5', 0x3b6: 'pmpaddr6', 0x3b7: 'pmpaddr7',
  // 机器态陷阱处理（N 扩展）/ 调试
  0x7a0: 'tselect', 0x7a1: 'tdata1', 0x7a2: 'tdata2', 0x7a3: 'tdata3',
  0x7b0: 'dcsr', 0x7b1: 'dpc', 0x7b2: 'dscratch0', 0x7b3: 'dscratch1',
  0xf11: 'mvendorid', 0xf12: 'marchid', 0xf13: 'mimpid', 0xf14: 'mhartid', 0xf15: 'mconfigptr',
};

/** 按区间生成的 CSR 名（性能计数器、PMP 地址等成组出现） */
function csrRangeName(index: number): string | null {
  if (index >= 0x3b0 && index <= 0x3ef) return `pmpaddr${index - 0x3b0}`; // 0x3b0-0x3ef: pmpaddr0-63
  if (index >= 0xb00 && index <= 0xb1f) return index === 0xb00 ? 'mcycle' : index === 0xb02 ? 'minstret' : `mhpmcounter${index - 0xb00}`;
  if (index >= 0xb80 && index <= 0xb9f) return index === 0xb80 ? 'mcycleh' : index === 0xb82 ? 'minstreth' : `mhpmcounter${index - 0xb80}h`;
  if (index >= 0x320 && index <= 0x33f) return `mhpmevent${index - 0x320}`;
  if (index >= 0xc00 && index <= 0xc1f) return index === 0xc00 ? 'cycle' : index === 0xc01 ? 'time' : index === 0xc02 ? 'instret' : `hpmcounter${index - 0xc00}`;
  if (index >= 0xc80 && index <= 0xc9f) return index === 0xc80 ? 'cycleh' : index === 0xc81 ? 'timeh' : index === 0xc82 ? 'instreth' : `hpmcounter${index - 0xc80}h`;
  return null;
}

/** CSR 地址里第 10-11 位是"可读/可写"位，取名时按惯例掩掉 */
const csrName = (index: number): string => CSR_NAMES[index] ?? csrRangeName(index) ?? `0x${index.toString(16)}`;

// ------------------------------------------------------------------ 32 位指令

/** funct3 → 助记词。稀疏表：下标就是 funct3（`undefined` = 该编码不合法） */
const BRANCH: Record<number, string> = { 0: 'beq', 1: 'bne', 4: 'blt', 5: 'bge', 6: 'bltu', 7: 'bgeu' };
const LOAD: Record<number, string> = { 0: 'lb', 1: 'lh', 2: 'lw', 3: 'ld', 4: 'lbu', 5: 'lhu', 6: 'lwu' };
const STORE: Record<number, string> = { 0: 'sb', 1: 'sh', 2: 'sw', 3: 'sd' };
const OP_IMM: Record<number, string> = { 0: 'addi', 1: 'slli', 2: 'slti', 3: 'sltiu', 4: 'xori', 5: 'srli', 6: 'ori', 7: 'andi' };
const OP_BASE: Record<number, string> = { 0: 'add', 1: 'sll', 2: 'slt', 3: 'sltu', 4: 'xor', 5: 'srl', 6: 'or', 7: 'and' };

/**
 * OP / OP-32 的完整表：funct7 → (funct3 → 助记词)。
 * Zba/Zbb/Zbc/Zbs 与 M、Zicond 都在这里 —— 位域取错就会译成别的指令，
 * 所以这张表是对着汇编器逐条核对过的（见 rv-check 脚本）。
 */
const OP_TABLE: Record<number, Record<number, string>> = {
  0x00: OP_BASE,
  0x20: { 0: 'sub', 4: 'xnor', 5: 'sra', 6: 'orn', 7: 'andn' },
  0x01: { 0: 'mul', 1: 'mulh', 2: 'mulhsu', 3: 'mulhu', 4: 'div', 5: 'divu', 6: 'rem', 7: 'remu' },
  0x05: { 1: 'clmul', 2: 'clmulr', 3: 'clmulh', 4: 'min', 5: 'minu', 6: 'max', 7: 'maxu' },
  0x10: { 2: 'sh1add', 4: 'sh2add', 6: 'sh3add' },
  0x30: { 1: 'rol', 5: 'ror' },
  0x14: { 1: 'bset' },
  0x24: { 1: 'bclr', 5: 'bext' },
  0x34: { 1: 'binv' },
  0x07: { 5: 'czero.eqz', 7: 'czero.nez' },
  0x04: { 4: 'zext.h' }, // RV32 的 zext.h 在 OP-IMM，见 OP_IMM_TOP
};

const OP32_TABLE: Record<number, Record<number, string>> = {
  0x00: { 0: 'addw', 1: 'sllw', 5: 'srlw' },
  0x20: { 0: 'subw', 5: 'sraw' },
  0x01: { 0: 'mulw', 4: 'divw', 5: 'divuw', 6: 'remw', 7: 'remuw' },
  0x30: { 1: 'rolw', 5: 'rorw' },
  0x04: { 0: 'add.uw', 4: 'zext.h' },
  0x10: { 2: 'sh1add.uw', 4: 'sh2add.uw', 6: 'sh3add.uw' },
};

/** OP-IMM / OP-IMM-32 借移位槽位的 Zbb/Zbs：`funct7:funct3:rs2` → 助记词 */
const OP_IMM_TOP: Record<string, string> = {
  '0x30:1:0': 'clz', '0x30:1:1': 'ctz', '0x30:1:2': 'cpop',
  '0x30:1:4': 'sext.b', '0x30:1:5': 'sext.h',
  '0x34:5:24': 'rev8', // funct7=0x35（bit25 是 shamt[5]，查表前已清掉）
  '0x04:1:0': 'zext.h',
};
const FLOAD = { 1: 'flh', 2: 'flw', 3: 'fld' } as Record<number, string>;
const FSTORE = { 1: 'fsh', 2: 'fsw', 3: 'fsd' } as Record<number, string>;

/** SYSTEM 的 funct3 → CSR 助记词（0 与 4 不是 CSR 指令） */
const CSR_FUNCT3: Record<number, string> = { 1: 'csrrw', 2: 'csrrs', 3: 'csrrc', 5: 'csrrwi', 6: 'csrrsi', 7: 'csrrci' };

/** AMO 的 funct5 → 助记词根（`.w`/`.d` 由 funct3 决定） */
const AMO: Record<number, string> = {
  0b00000: 'amoadd', 0b00001: 'amoswap', 0b00010: 'lr', 0b00011: 'sc',
  0b00100: 'amoxor', 0b01000: 'amoor', 0b01100: 'amoand',
  0b10000: 'amomin', 0b10100: 'amomax', 0b11000: 'amominu', 0b11100: 'amomaxu',
};

/** 浮点格式（位域 fmt 的取值顺序，用于浮点槽位里的 `*.<fmt>`） */
const FP_FMT = ['s', 'd', 'h'];
/** 浮点搬运指令里单精度写作 w（`fmv.x.w` / `fmv.w.x`），与工具链一致 */
const FP_MOV = ['w', 'd', 'h'];

/** OP-FP 的算术类：funct7 → 助记词（fmt 已编进 funct7 低位） */
const FP: Record<number, string> = {
  0x00: 'fadd.s', 0x01: 'fadd.d', 0x02: 'fadd.h',
  0x04: 'fsub.s', 0x05: 'fsub.d', 0x06: 'fsub.h',
  0x08: 'fmul.s', 0x09: 'fmul.d', 0x0a: 'fmul.h',
  0x0c: 'fdiv.s', 0x0d: 'fdiv.d', 0x0e: 'fdiv.h',
  0x10: 'fsgnj.s', 0x11: 'fsgnj.d', 0x12: 'fsgnj.h',
  0x14: 'fmin.s', 0x15: 'fmin.d', 0x16: 'fmin.h',
  0x2c: 'fsqrt.s', 0x2d: 'fsqrt.d', 0x2e: 'fsqrt.h',
};

/** 整数宽度的名字（转换指令的 rs2 字段）：0/1 是 32 位，2/3 是 64 位 */
const INT_WIDTH = ['w', 'wu', 'l', 'lu'];

/** 内存序字母（pred/succ 位 3..0 对应 i,o,r,w） */
function memOrder(mask: number): string {
  let text = '';
  if (mask & 8) text += 'i';
  if (mask & 4) text += 'o';
  if (mask & 2) text += 'r';
  if (mask & 1) text += 'w';
  return text.length > 0 ? text : '0';
}

/**
 * 译一条 RISC-V 指令；`xlen` 决定 RV32 / RV64 的差别（`ld`/`sd`、`*W` 后缀、
 * 移位量宽度、Zba 的 `.uw` 形式等）。无法识别时给 `.word` / `.c`，不抛异常。
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
  const funct6 = bits(w, 31, 26);
  const immI = sext(bits(w, 31, 20), 12);
  const immS = sext((bits(w, 31, 25) << 5) | bits(w, 11, 7), 12);
  const immB = sext(
    (bits(w, 31, 31) << 12) | (bits(w, 7, 7) << 11) | (bits(w, 30, 25) << 5) | (bits(w, 11, 8) << 1),
    13,
  );
  const immJ = sext((bits(w, 31, 31) << 20) | (bits(w, 19, 12) << 12) | (bits(w, 20, 20) << 11) | (bits(w, 30, 21) << 1), 21);
  // 只有裸指令字、没有 PC，所以跳转给**相对偏移**，不编造绝对地址
  const target = (offset: number): string => (offset >= 0 ? `+${offset}` : `${offset}`);
  const unknown = `.word  ${hex(w)}`;
  const r64 = xlen === 64;

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
      const ok = name !== undefined && (r64 || (name !== 'ld' && name !== 'lwu'));
      return ok ? `${name!.padEnd(6)} ${reg(rd)}, ${immI}(${reg(rs1)})` : unknown;
    }
    case 0x23: {
      const name = STORE[funct3];
      const ok = name !== undefined && (r64 || name !== 'sd');
      return ok ? `${name!.padEnd(6)} ${reg(rs2)}, ${immS}(${reg(rs1)})` : unknown;
    }
    case 0x07: {
      const name = FLOAD[funct3];
      return name === undefined ? unknown : `${name.padEnd(6)} ${freg(rd)}, ${immI}(${reg(rs1)})`;
    }
    case 0x27: {
      const name = FSTORE[funct3];
      return name === undefined ? unknown : `${name.padEnd(6)} ${freg(rs2)}, ${immS}(${reg(rs1)})`;
    }

    case 0x13: {
      const name = OP_IMM[funct3];
      if (name === undefined) return unknown;
      // 移位槽位（funct3 = 1 与 5）：既放普通移位，也放 Zbb/Zbs 的单目运算。
      // 移位量是 6 位：shamt[5] 编在 bit 25（也就是 funct7 的最低位），
      // 所以查表时要把这一位清掉，否则 `srai …, 63` 会被当成别的 funct7。
      if (funct3 === 1 || funct3 === 5) {
        const shamt = (rs2 | (((w >>> 25) & 1) << 5)) & (r64 ? 0x3f : 0x1f);
        if (!r64 && (w & (1 << 25)) !== 0) return unknown;
        const top = funct7 & 0x3e;
        const one = OP_IMM_TOP[`0x${top.toString(16)}:${funct3}:${rs2}`];
        if (one !== undefined) return `${one.padEnd(6)} ${reg(rd)}, ${reg(rs1)}`;
        if (funct3 === 1) {
          if (top === 0x00) return `slli   ${reg(rd)}, ${reg(rs1)}, ${shamt}`;
          if (top === 0x14) return `bseti  ${reg(rd)}, ${reg(rs1)}, ${shamt}`;
          if (top === 0x24) return `bclri  ${reg(rd)}, ${reg(rs1)}, ${shamt}`;
          if (top === 0x34) return `binvi  ${reg(rd)}, ${reg(rs1)}, ${shamt}`;
          return unknown;
        }
        if (top === 0x00) return `srli   ${reg(rd)}, ${reg(rs1)}, ${shamt}`;
        if (top === 0x20) return `srai   ${reg(rd)}, ${reg(rs1)}, ${shamt}`;
        if (top === 0x30) return `rori   ${reg(rd)}, ${reg(rs1)}, ${shamt}`;
        if (top === 0x24) return `bexti  ${reg(rd)}, ${reg(rs1)}, ${shamt}`;
        return unknown;
      }
      return `${name.padEnd(6)} ${reg(rd)}, ${reg(rs1)}, ${immI}`;
    }

    case 0x33: {
      const name = OP_TABLE[funct7]?.[funct3];
      if (name === undefined) return unknown;
      // zext.h（OP 槽）与 pack/packh/packw 共用编码，靠 rs2 区分
      if (funct7 === 0x04 && rs2 !== 0) return unknown;
      // zext.h 是双操作数（bclr/bext 等三操作数走通用分支）
      if (name === 'zext.h') return `zext.h ${reg(rd)}, ${reg(rs1)}`;
      return `${name.padEnd(6)} ${reg(rd)}, ${reg(rs1)}, ${reg(rs2)}`;
    }

    case 0x1b: {
      if (!r64) return unknown;
      if (funct3 === 0) {
        // 注意：I 型的立即数占 bits[31:20]，所以这里的 funct7 只是立即数的高位，
        // 不能拿它当操作码使唤 —— 只有 slli.uw 才真的用 bit25/24:20。
        const top = funct7 & 0x3e;
        if (top === 0x04) {
          const shamt = (rs2 | (((w >>> 25) & 1) << 5)) & 0x3f;
          return `slli.uw ${reg(rd)}, ${reg(rs1)}, ${shamt}`;
        }
        // sext.w = addiw rd, rs1, 0 的别名（GNU 工具链同样这么显示）
        if (immI === 0) return `sext.w ${reg(rd)}, ${reg(rs1)}`;
        return `addiw  ${reg(rd)}, ${reg(rs1)}, ${immI}`;
        if (funct7 === 0x04) return rs2 === 0 ? `sext.w ${reg(rd)}, ${reg(rs1)}` : `slli.uw ${reg(rd)}, ${reg(rs1)}, ${rs2 & 0x3f}`;
        return unknown;
      }
      if (funct3 === 1 || funct3 === 5) {
        const shamt = (rs2 | (((w >>> 25) & 1) << 5)) & 0x3f;
        const one = OP_IMM_TOP[`0x${(funct7 & 0x3e).toString(16)}:${funct3}:${rs2}`];
        // RV64 的 *W 单目运算走同一个槽位（clzw/ctzw/cpopw）
        if (one !== undefined) {
          const w1 = one === 'clz' || one === 'ctz' || one === 'cpop' ? `${one}w` : null;
          return w1 === null ? unknown : `${w1.padEnd(6)} ${reg(rd)}, ${reg(rs1)}`;
        }
        const top = funct7 & 0x3e;
        if (funct3 === 1 && top === 0x04) return `slli.uw ${reg(rd)}, ${reg(rs1)}, ${shamt}`;
        if (funct3 === 1 && top === 0x00) return `slliw  ${reg(rd)}, ${reg(rs1)}, ${shamt}`;
        if (funct3 === 5 && top === 0x00) return `srliw  ${reg(rd)}, ${reg(rs1)}, ${shamt}`;
        if (funct3 === 5 && top === 0x20) return `sraiw  ${reg(rd)}, ${reg(rs1)}, ${shamt}`;
        if (funct3 === 5 && top === 0x30) return `roriw  ${reg(rd)}, ${reg(rs1)}, ${shamt}`;
        return unknown;
      }
      return unknown;
    }

    case 0x3b: {
      if (!r64) return unknown;
      const name = OP32_TABLE[funct7]?.[funct3];
      if (name === undefined) return unknown;
      // zext.w = add.uw 的 rd,rs1,zero 别名；zext.h 只认 rs2=0
      if (funct7 === 0x04 && funct3 === 0 && rs2 === 0) return `zext.w ${reg(rd)}, ${reg(rs1)}`;
      if (funct7 === 0x04 && funct3 === 4 && rs2 === 0) return `zext.h ${reg(rd)}, ${reg(rs1)}`;
      if (funct7 === 0x04 && funct3 === 4) return unknown;
      return `${name.padEnd(6)} ${reg(rd)}, ${reg(rs1)}, ${reg(rs2)}`;
    }

    case 0x2f: {
      const funct5 = bits(w, 31, 27);
      const name = AMO[funct5];
      if (name === undefined) return unknown;
      const width = funct3 === 2 ? 'w' : funct3 === 3 ? 'd' : null;
      if (width === null) return unknown;
      const suffix = bits(w, 26, 26) === 1 ? (bits(w, 25, 25) === 1 ? '.aqrl' : '.aq') : bits(w, 25, 25) === 1 ? '.rl' : '';
      const mnemonic = `${name}.${width}${suffix}`;
      if (name === 'lr') return `${mnemonic.padEnd(6)} ${reg(rd)}, (${reg(rs1)})`;
      return `${mnemonic.padEnd(6)} ${reg(rd)}, ${reg(rs2)}, (${reg(rs1)})`;
    }

    case 0x43:
    case 0x47:
    case 0x4b:
    case 0x4f: {
      const base = { 0x43: 'fmadd', 0x47: 'fmsub', 0x4b: 'fnmsub', 0x4f: 'fnmadd' }[opcode]!;
      const fmt = bits(w, 26, 25) === 0 ? 's' : bits(w, 26, 25) === 1 ? 'd' : bits(w, 26, 25) === 2 ? 'h' : null;
      if (fmt === null) return unknown;
      return `${base}.${fmt} ${freg(rd)}, ${freg(rs1)}, ${freg(rs2)}, ${freg(bits(w, 31, 27))}${roundSuffix(funct3)}`;
    }

    case 0x53: {
      // 比较类：funct7 高 5 位固定 0b10100，低 2 位是操作数格式；funct3 选比较
      if ((funct7 & 0x7c) === 0x50) {
        const fmt = FP_FMT[funct7 & 0x03];
        const named = funct3 === 0 ? 'fle' : funct3 === 1 ? 'flt' : funct3 === 2 ? 'feq' : null;
        if (fmt === undefined || named === null) return unknown;
        return `${named}.${fmt} ${reg(rd)}, ${freg(rs1)}, ${freg(rs2)}`;
      }
      // 浮点 → 整数：funct7 = 0x60 + 源格式，rs2 选整数宽度（w/wu/l/lu）
      if (funct7 >= 0x60 && funct7 <= 0x62) {
        const from = FP_FMT[funct7 - 0x60];
        const to = INT_WIDTH[rs2];
        if (from === undefined || to === undefined) return unknown;
        if (!r64 && (to === 'l' || to === 'lu')) return unknown;
        return `fcvt.${to}.${from}`.padEnd(6) + ` ${reg(rd)}, ${freg(rs1)}${roundSuffix(funct3)}`;
      }
      // 整数 → 浮点：funct7 = 0x68 + 目标格式，rs2 选整数宽度
      if (funct7 >= 0x68 && funct7 <= 0x6a) {
        const to = FP_FMT[funct7 - 0x68];
        const from = INT_WIDTH[rs2];
        if (to === undefined || from === undefined) return unknown;
        if (!r64 && (from === 'l' || from === 'lu')) return unknown;
        return `fcvt.${to}.${from}`.padEnd(6) + ` ${freg(rd)}, ${reg(rs1)}`;
      }
      // 浮点 ↔ 浮点：funct7 = 0x20 + 目标格式，rs2 = 源格式
      if (funct7 >= 0x20 && funct7 <= 0x22 && rs2 <= 2) {
        const to = FP_FMT[funct7 - 0x20];
        const from = FP_FMT[rs2];
        if (to === undefined || from === undefined || to === from) return unknown;
        return `fcvt.${to}.${from}`.padEnd(6) + ` ${freg(rd)}, ${freg(rs1)}${roundSuffix(funct3)}`;
      }
      // fmv.x.<fmt> / fclass.<fmt>：funct7 = 0x70 + 格式，funct3 区分两者
      if (funct7 >= 0x70 && funct7 <= 0x72) {
        const fmt = FP_FMT[funct7 - 0x70];
        const mov = FP_MOV[funct7 - 0x70];
        if (fmt === undefined || mov === undefined || rs2 !== 0) return unknown;
        if (funct3 === 0) return `fmv.x.${mov} ${reg(rd)}, ${freg(rs1)}`;
        if (funct3 === 1) return `fclass.${fmt} ${reg(rd)}, ${freg(rs1)}`;
        return unknown;
      }
      // fmv.<fmt>.x：funct7 = 0x78 + 格式（单精度写作 w）
      if (funct7 >= 0x78 && funct7 <= 0x7a) {
        const mov = FP_MOV[funct7 - 0x78];
        if (mov === undefined || rs2 !== 0) return unknown;
        return `fmv.${mov}.x ${freg(rd)}, ${reg(rs1)}`;
      }
      const one = FP[funct7];
      if (one === undefined) return unknown;
      if (one.startsWith('fsqrt.')) return `${one} ${freg(rd)}, ${freg(rs1)}${roundSuffix(funct3)}`;
      if (one.startsWith('fsgnj')) {
        const named = ['fsgnj', 'fsgnjn', 'fsgnjx'][funct3];
        return named === undefined ? unknown : `${named}${one.slice(5)} ${freg(rd)}, ${freg(rs1)}, ${freg(rs2)}`;
      }
      if (one.startsWith('fmin.') || one.startsWith('fmax.')) {
        const named = funct3 === 0 ? 'fmin' : funct3 === 1 ? 'fmax' : null;
        return named === null ? unknown : `${named}${one.slice(4)} ${freg(rd)}, ${freg(rs1)}, ${freg(rs2)}`;
      }
      return `${one.padEnd(6)} ${freg(rd)}, ${freg(rs1)}, ${freg(rs2)}`;
    }

    case 0x0f: {
      if (funct3 === 0) {
        // fence.tso / pause 是 fence 的特定操作数组合
        if (w === 0x8330000f) return 'fence.tso';
        if (w === 0x0100000f) return 'pause';
        const pred = bits(w, 27, 24);
        const succ = bits(w, 23, 20);
        return pred === 0xf && succ === 0xf ? 'fence' : `fence  ${memOrder(pred)}, ${memOrder(succ)}`;
      }
      return funct3 === 1 ? 'fence.i' : unknown;
    }

    case 0x73: {
      if (funct3 === 0) {
        if (immI === 0x000) return 'ecall';
        if (immI === 0x001) return 'ebreak';
        if (immI === 0x002 && funct7 === 0x00) return 'uret';
        if (immI === 0x102) return 'sret';
        if (immI === 0x302) return 'mret';
        if (immI === 0x105) return 'wfi';
        if (funct7 === 0x09) return bits(w, 24, 20) === 0 ? 'sfence.vma' : `sfence.vma ${reg(rs1)}, ${reg(rs2)}`;
        if (funct7 === 0x19) return 'hfence.gvma';
        return unknown;
      }
      const names = CSR_FUNCT3[funct3];
      const name = names;
      if (name === undefined) return unknown;
      const source = funct3 >= 4 ? String(rs1) : reg(rs1);
      return `${name.padEnd(6)} ${reg(rd)}, ${csrName(bits(w, 31, 20) & 0xfff)}, ${source}`;
    }

    default:
      return unknown;
  }
}

// ------------------------------------------------------------------ 压缩指令

/** C 扩展的寄存器字段（对应 x8-x15）：象限 0 与象限 1 的 rs2' 在 bits[4:2] */
const regP = (h: number): string => reg(8 + bits(h, 4, 2));
/** 象限 1/2 的 rd'（c.srli/c.sub/c.andi… 的目标）在 bits[9:7] */
const regP1 = (h: number): string => reg(8 + bits(h, 9, 7));
/** C 扩展的浮点寄存器字段（同样只覆盖 f8-f15 —— 即 fs0/fs1/fa0-fa5） */
const fregP = (h: number): string => freg(8 + bits(h, 4, 2));

/** CJ 型立即数（C.J / C.JAL） */
function immCJ(h: number): number {
  return sext(
    (bits(h, 12, 12) << 11) | (bits(h, 11, 11) << 4) | (bits(h, 10, 9) << 8) | (bits(h, 8, 8) << 10) |
      (bits(h, 7, 7) << 6) | (bits(h, 6, 6) << 7) | (bits(h, 5, 3) << 1) | (bits(h, 2, 2) << 5),
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

/** C.LW/C.SW：uimm[6] = inst[5]，uimm[5:3] = inst[12:10]，uimm[2] = inst[6]（字节偏移） */
const immCLW = (h: number): number => (bits(h, 5, 5) << 6) | (bits(h, 12, 10) << 3) | (bits(h, 6, 6) << 2);
/** C.LD/C.SD/C.FLD/C.FSD：uimm[6:5] = inst[6:5]，uimm[5:3] = inst[12:10]（字节偏移） */
const immCLD = (h: number): number => (bits(h, 6, 5) << 6) | (bits(h, 12, 10) << 3);
/** C.ADDI4SPN：nzuimm[9:6] = inst[10:7]，nzuimm[5:4] = inst[12:11]，[3] = inst[5]，[2] = inst[6] */
const immCIW = (h: number): number => (bits(h, 10, 7) << 6) | (bits(h, 12, 11) << 4) | (bits(h, 5, 5) << 3) | (bits(h, 6, 6) << 2);

function decodeCompressed(h: number, xlen: 32 | 64): string {
  const quadrant = h & 0b11;
  const funct3 = bits(h, 15, 13);
  const fallback = `.c    0x${h.toString(16)}`;
  const rd = bits(h, 11, 7);
  const rs2 = bits(h, 6, 2);
  const r64 = xlen === 64;
  const ci = sext((bits(h, 12, 12) << 5) | bits(h, 6, 2), 6);

  if (quadrant === 0) {
    switch (funct3) {
      case 0: {
        const nzuimm = immCIW(h);
        return nzuimm === 0 ? fallback : `c.addi4spn ${regP(h)}, sp, ${nzuimm}`;
      }
      case 1:
        return `c.fld  ${fregP(h)}, ${immCLD(h)}(${regP1(h)})`;
      case 2:
        return `c.lw   ${regP(h)}, ${immCLW(h)}(${regP1(h)})`;
      case 3:
        return r64 ? `c.ld   ${regP(h)}, ${immCLD(h)}(${regP1(h)})` : fallback;
      case 5:
        return `c.fsd  ${fregP(h)}, ${immCLD(h)}(${regP1(h)})`;
      case 6:
        return `c.sw   ${regP(h)}, ${immCLW(h)}(${regP1(h)})`;
      case 7:
        return r64 ? `c.sd   ${regP(h)}, ${immCLD(h)}(${regP1(h)})` : fallback;
      default:
        return fallback;
    }
  }

  if (quadrant === 1) {
    switch (funct3) {
      case 0:
        return rd === 0 ? 'c.nop' : `c.addi ${reg(rd)}, ${ci}`;
      case 1:
        // RV64C：c.addiw 的 rd=x0 是保留编码（不是 hint）
        if (r64) return rd === 0 ? fallback : `c.addiw ${reg(rd)}, ${ci}`;
        return `c.jal  ${immCJ(h) >= 0 ? '+' : ''}${immCJ(h)}`;
      case 2:
        return `c.li   ${reg(rd)}, ${ci}`;
      case 3: {
        if (rd === 2) {
          const imm = sext(
            (bits(h, 12, 12) << 9) | (bits(h, 6, 6) << 4) | (bits(h, 5, 5) << 6) | (bits(h, 4, 3) << 7) | (bits(h, 2, 2) << 5),
            10,
          );
          return `c.addi16sp sp, ${imm}`;
        }
        const nzimm = sext((bits(h, 12, 12) << 17) | (bits(h, 6, 2) << 12), 18);
        return nzimm === 0 ? fallback : `c.lui  ${reg(rd)}, ${nzimm < 0 ? String(nzimm) : hex(nzimm)}`;
      }
      case 4: {
        const sub = bits(h, 11, 10);
        if (sub === 0) return `c.srli ${regP1(h)}, ${bits(h, 6, 2)}`;
        if (sub === 1) return `c.srai ${regP1(h)}, ${bits(h, 6, 2)}`;
        if (sub === 2) return `c.andi ${regP1(h)}, ${ci}`;
        const ops = ['c.sub', 'c.xor', 'c.or', 'c.and'];
        const name = ops[bits(h, 6, 5)];
        if (name === undefined) return fallback;
        const pair = `${regP1(h)}, ${regP(h)}`;
        if (bits(h, 12, 12) === 1) {
          if (bits(h, 6, 5) === 0) return `c.subw ${pair}`;
          if (bits(h, 6, 5) === 1) return `c.addw ${pair}`;
          return fallback;
        }
        return `${name.padEnd(5)} ${pair}`;
      }
      case 5:
        return `c.j    ${immCJ(h) >= 0 ? '+' : ''}${immCJ(h)}`;
      case 6:
        return `c.beqz ${regP1(h)}, ${immCB(h) >= 0 ? '+' : ''}${immCB(h)}`;
      default:
        return `c.bnez ${regP1(h)}, ${immCB(h) >= 0 ? '+' : ''}${immCB(h)}`;
    }
  }

  switch (funct3) {
    case 0:
      return rd === 0 ? fallback : `c.slli ${reg(rd)}, ${(bits(h, 12, 12) << 5) | bits(h, 6, 2)}`;
    case 1:
      return `c.fldsp ${freg(rd)}, ${(bits(h, 12, 12) << 5) | (bits(h, 6, 5) << 3) | (bits(h, 4, 2) << 6)}(sp)`;
    case 2: {
      const uimm = (bits(h, 12, 12) << 5) | (bits(h, 6, 4) << 2) | (bits(h, 3, 2) << 6);
      return rd === 0 ? fallback : `c.lwsp ${reg(rd)}, ${uimm}(sp)`;
    }
    case 3:
      return r64 && rd !== 0 ? `c.ldsp ${reg(rd)}, ${(bits(h, 12, 12) << 5) | (bits(h, 6, 5) << 3) | (bits(h, 4, 2) << 6)}(sp)` : fallback;
    case 4:
      if (bits(h, 12, 12) === 0) {
        if (rs2 === 0) return rd === 0 ? fallback : `c.jr   ${reg(rd)}`;
        return `c.mv   ${reg(rd)}, ${reg(rs2)}`;
      }
      if (rs2 === 0) return rd === 0 ? 'c.ebreak' : `c.jalr ${reg(rd)}`;
      return `c.add  ${reg(rd)}, ${reg(rs2)}`;
    case 5:
      return `c.fsdsp ${freg(rs2)}, ${(bits(h, 12, 10) << 3) | (bits(h, 9, 7) << 6)}(sp)`;
    case 6: {
      const uimm = (bits(h, 12, 9) << 2) | (bits(h, 8, 7) << 6);
      return `c.swsp ${reg(rs2)}, ${uimm}(sp)`;
    }
    default:
      return r64 ? `c.sdsp ${reg(rs2)}, ${(bits(h, 12, 10) << 3) | (bits(h, 9, 7) << 6)}(sp)` : fallback;
  }
}
