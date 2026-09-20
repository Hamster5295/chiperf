/**
 * RISC-V 译码器的交叉校验脚本（**不是** bun test，依赖真实工具链）
 *
 * 把一批指令交给 riscv64 汇编器汇编，再把每条指令字交给 `src/rv.ts` 的 rvDecode，
 * 与**源码原文**逐条比对（比 objdump 输出更好比：不受别名 j/jr/ret/nop 的干扰）。
 * RV64 与 RV32 各跑一遍；某个 xlen 下不存在的指令（ld/sd/*W/c.jal…）自动跳过。
 * 末尾还会打印一段可直接粘进 test/rv.test.ts 的测试代码 —— 编码来自工具链，
 * 不是手推的。
 *
 * 用法：PATH=/opt/riscv/bin:$PATH bun run rv-check.ts
 * 依赖：riscv64-unknown-elf-as / riscv64-unknown-elf-objdump（本机在 /opt/riscv）
 */
import { $ } from 'bun';
import { rvDecode } from './src/rv.ts';

const lines: string[] = [];
const add = (...xs: string[]): void => lines.push(...xs);

// ---------------------------------------------------------------- 整数基座
add(
  'addi a0, a1, 5', 'slti a2, a3, -7', 'sltiu a4, a5, 11', 'xori a6, a7, 0x7ff', 'ori s0, s1, 1', 'andi s2, s3, 12',
  'slli a0, a1, 3', 'srli a0, a1, 31', 'srai a0, a1, 63', 'slli a0, a1, 32',
  'add a0, a1, a2', 'sub a0, a1, a2', 'sll a0, a1, a2', 'slt a0, a1, a2', 'sltu a0, a1, a2', 'xor a0, a1, a2',
  'srl a0, a1, a2', 'sra a0, a1, a2', 'or a0, a1, a2', 'and a0, a1, a2',
  'lui a3, 0x1000', 'auipc a3, 0x1ffff',
  'lb a0, 8(a1)', 'lh a0, -2(a1)', 'lw a0, 4(a1)', 'ld a0, 16(a1)', 'lbu a0, 0(a1)', 'lhu a0, 6(a1)', 'lwu a0, 12(a1)',
  'sb a0, 3(a1)', 'sh a0, 4(a1)', 'sw a0, 8(a1)', 'sd a0, 16(a1)',
  'jal ra, +16', 'jal zero, -4096', 'jalr ra, 0(a0)', 'jalr zero, -8(sp)',
  'fence', 'fence rw, rw', 'fence.i', 'fence.tso', 'pause',
  'ecall', 'ebreak', 'mret', 'sret', 'wfi', 'sfence.vma', 'sfence.vma a0, a1',
  'mret',
);
// RV64 W 形式
add(
  'addiw a0, a1, 5', 'addiw a0, a1, -1', 'addi a0, a1, -2048', 'andi a0, a1, -1', 'slliw a0, a1, 3', 'srliw a0, a1, 3', 'sraiw a0, a1, 3',
  'addw a0, a1, a2', 'subw a0, a1, a2', 'sllw a0, a1, a2', 'srlw a0, a1, a2', 'sraw a0, a1, a2',
);
// Zicsr
add(
  'csrrw a0, mstatus, a1', 'csrrs a0, mtvec, a1', 'csrrc a0, mcause, a1',
  'csrrwi a0, misa, 3', 'csrrsi a0, mip, 1', 'csrrci a0, mhartid, 0',
  'csrrw a0, satp, a1', 'csrrs a0, cycle, a1', 'csrrs a0, instret, a1', 'csrrs a0, fcsr, a1',
  'csrrs a0, stvec, a1', 'csrrs a0, medeleg, a1', 'csrrs a0, pmpaddr3, a1', 'csrrs a0, mhpmcounter3, a1',
);
// M
add(
  'mul a0, a1, a2', 'mulh a0, a1, a2', 'mulhsu a0, a1, a2', 'mulhu a0, a1, a2',
  'div a0, a1, a2', 'divu a0, a1, a2', 'rem a0, a1, a2', 'remu a0, a1, a2',
  'mulw a0, a1, a2', 'divw a0, a1, a2', 'divuw a0, a1, a2', 'remw a0, a1, a2', 'remuw a0, a1, a2',
);
// A
add(
  'lr.w a0, (a1)', 'lr.w.aq a0, (a1)', 'lr.w.rl a0, (a1)', 'lr.w.aqrl a0, (a1)', 'lr.d a0, (a1)', 'lr.d.aqrl a0, (a1)',
  'sc.w a0, a1, (a2)', 'sc.w.aqrl a0, a1, (a2)', 'sc.d a0, a1, (a2)',
  'amoswap.w a0, a1, (a2)', 'amoswap.w.aq a0, a1, (a2)', 'amoswap.d.aqrl a0, a1, (a2)',
  'amoadd.w a0, a1, (a2)', 'amoadd.d a0, a1, (a2)', 'amoxor.w a0, a1, (a2)', 'amoxor.d a0, a1, (a2)',
  'amoand.w a0, a1, (a2)', 'amoand.d a0, a1, (a2)', 'amoor.w a0, a1, (a2)', 'amoor.d a0, a1, (a2)',
  'amomin.w a0, a1, (a2)', 'amomin.d a0, a1, (a2)', 'amomax.w a0, a1, (a2)', 'amomax.d a0, a1, (a2)',
  'amominu.w a0, a1, (a2)', 'amominu.d a0, a1, (a2)', 'amomaxu.w a0, a1, (a2)', 'amomaxu.d a0, a1, (a2)',
);
// F / D / H
add(
  'flw ft0, 4(a0)', 'fsw ft0, 8(a0)', 'fld ft0, 16(a0)', 'fsd ft0, 24(a0)', 'flh ft0, 2(a0)', 'fsh ft0, 6(a0)',
  'fadd.s ft0, ft1, ft2', 'fadd.d ft0, ft1, ft2', 'fadd.h ft0, ft1, ft2',
  'fsub.s ft0, ft1, ft2', 'fsub.d ft0, ft1, ft2', 'fmul.s ft0, ft1, ft2', 'fmul.d ft0, ft1, ft2',
  'fdiv.s ft0, ft1, ft2', 'fdiv.d ft0, ft1, ft2', 'fsqrt.s ft0, ft1', 'fsqrt.d ft0, ft1', 'fsqrt.d ft0, ft1, rtz',
  'fsgnj.s ft0, ft1, ft2', 'fsgnjn.s ft0, ft1, ft2', 'fsgnjx.d ft0, ft1, ft2',
  'fmin.s ft0, ft1, ft2', 'fmax.d ft0, ft1, ft2',
  'fmadd.s ft0, ft1, ft2, ft3', 'fmadd.d ft0, ft1, ft2, ft3', 'fmsub.d ft0, ft1, ft2, ft3',
  'fnmsub.s ft0, ft1, ft2, ft3', 'fnmadd.d ft0, ft1, ft2, ft3',
  'fcvt.s.d ft0, ft1', 'fcvt.d.s ft0, ft1', 'fcvt.s.h ft0, ft1', 'fcvt.h.d ft0, ft1',
  'fcvt.w.s a0, ft1', 'fcvt.w.s a0, ft1, rtz', 'fcvt.wu.s a0, ft1', 'fcvt.l.s a0, ft1', 'fcvt.lu.d a0, ft1',
  'fcvt.w.d a0, ft1', 'fcvt.l.h a0, ft1',
  'fcvt.s.w ft0, a0', 'fcvt.s.wu ft0, a0', 'fcvt.d.l ft0, a0', 'fcvt.d.lu ft0, a0', 'fcvt.h.w ft0, a0',
  'fmv.x.w a0, ft1', 'fmv.x.d a0, ft1', 'fmv.w.x ft0, a0', 'fmv.d.x ft0, a0',
  'feq.s a0, ft1, ft2', 'flt.s a0, ft1, ft2', 'fle.s a0, ft1, ft2',
  'feq.d a0, ft1, ft2', 'flt.d a0, ft1, ft2', 'fle.d a0, ft1, ft2',
  'fclass.s a0, ft1', 'fclass.d a0, ft1',
);
// 压缩指令
add(// 压缩指令（.option rvc）

  'c.nop', 'c.addi a0, 3', 'c.addi a0, -4', 'c.li a0, 5', 'c.li a0, -1', 'c.lui a0, 1', 'c.lui a0, 0xfffff',
  'c.addi16sp sp, 32', 'c.addi16sp sp, -64', 'c.addi4spn a0, sp, 8', 'c.addi4spn s0, sp, 1020',
  'c.slli a0, 5', 'c.srli a0, 3', 'c.srai a0, 3', 'c.andi a0, 7', 'c.andi a0, -8',
  'c.mv a0, a1', 'c.add a0, a1', 'c.sub a0, a1', 'c.xor a0, a1', 'c.or a0, a1', 'c.and a0, a1',
  'c.subw a0, a1', 'c.addw a0, a1',
  'c.lw a0, 4(a1)', 'c.ld a0, 8(a1)', 'c.sw a0, 4(a1)', 'c.sd a0, 8(a1)',
  'c.lwsp a0, 4(sp)', 'c.ldsp a0, 8(sp)', 'c.swsp a0, 4(sp)', 'c.sdsp a0, 8(sp)',
  'c.fld fs0, 8(a1)', 'c.fsd fs0, 8(a1)', 'c.fldsp ft0, 8(sp)', 'c.fsdsp ft0, 8(sp)',
  'c.jr ra', 'c.jalr a0', 'c.ebreak', 'c.addiw a0, 3',
);
// Zba / Zbb / Zbc / Zbs / Zicond
add(
  'andn a0, a1, a2', 'orn a0, a1, a2', 'xnor a0, a1, a2',
  'clz a0, a1', 'ctz a0, a1', 'cpop a0, a1', 'clzw a0, a1', 'ctzw a0, a1', 'cpopw a0, a1',
  'max a0, a1, a2', 'maxu a0, a1, a2', 'min a0, a1, a2', 'minu a0, a1, a2',
  'sext.b a0, a1', 'sext.h a0, a1', 'sext.w a0, a1', 'zext.h a0, a1',
  'rol a0, a1, a2', 'ror a0, a1, a2', 'rori a0, a1, 7', 'rolw a0, a1, a2', 'rorw a0, a1, a2', 'roriw a0, a1, 7',
  'rev8 a0, a1',
  'sh1add a0, a1, a2', 'sh2add a0, a1, a2', 'sh3add a0, a1, a2',
  'sh1add.uw a0, a1, a2', 'sh2add.uw a0, a1, a2', 'sh3add.uw a0, a1, a2',
  'add.uw a0, a1, a2', 'slli.uw a0, a1, 3',
  'bset a0, a1, a2', 'bclr a0, a1, a2', 'binv a0, a1, a2', 'bext a0, a1, a2',
  'bseti a0, a1, 7', 'bclri a0, a1, 7', 'binvi a0, a1, 7', 'bexti a0, a1, 7',
  'clmul a0, a1, a2', 'clmulr a0, a1, a2', 'clmulh a0, a1, a2',
  'czero.eqz a0, a1, a2', 'czero.nez a0, a1, a2',
);
// V（RVV 1.0）
add(
  'vsetvli t0, a0, e32, m1, ta, ma', 'vsetvli t0, a0, e8, m2, tu, mu', 'vsetvli t0, a0, e64, mf2, ta, ma',
  'vsetivli t0, 4, e32, m1, ta, ma', 'vsetvl t0, a0, a1',
  'vle8.v v1, (a0)', 'vle16.v v1, (a0)', 'vle32.v v1, (a0)', 'vle64.v v1, (a0)',
  'vse8.v v1, (a0)', 'vse32.v v1, (a0)', 'vle32.v v1, (a0), v0.t',
  'vle32ff.v v1, (a0)', 'vlseg6e32ff.v v1, (a0)',
  'vlm.v v1, (a0)', 'vsm.v v1, (a0)',
  'vl1r.v v1, (a0)', 'vl2re16.v v1, (a0)', 'vl4re32.v v1, (a0)', 'vl8re64.v v1, (a0)',
  'vs1r.v v1, (a0)', 'vs8r.v v1, (a0)',
  'vlseg2e32.v v1, (a0)', 'vsseg4e16.v v1, (a0)', 'vlse32.v v1, (a0), a1', 'vlsseg3e32.v v1, (a0), a1',
  'vluxei32.v v1, (a0), v2', 'vloxei64.v v1, (a0), v2', 'vsuxei16.v v1, (a0), v2', 'vluxseg2ei32.v v1, (a0), v2',
  'vadd.vv v1, v2, v3', 'vadd.vx v1, v2, a0', 'vadd.vi v1, v2, -1', 'vsub.vv v1, v2, v3', 'vrsub.vx v1, v2, a0',
  'vminu.vv v1, v2, v3', 'vmax.vx v1, v2, a0', 'vand.vv v1, v2, v3', 'vand.vi v1, v2, 7',
  'vrgather.vi v1, v2, 31', 'vrgatherei16.vv v1, v2, v3', 'vslideup.vx v1, v2, a0', 'vslidedown.vi v1, v2, 3',
  'vslide1up.vx v1, v2, a0', 'vslide1down.vx v1, v2, a0',
  'vadc.vvm v1, v2, v3, v0', 'vmadc.vv v1, v2, v3', 'vmerge.vxm v1, v2, a0, v0',
  'vmv.v.v v1, v2', 'vmv.v.x v1, a0', 'vmv.v.i v1, 3',
  'vsaddu.vi v1, v2, 3', 'vsll.vi v1, v2, 3', 'vssra.vx v1, v2, a0',
  'vnsrl.wi v1, v2, 3', 'vnsra.wv v1, v2, v3', 'vnclipu.wx v1, v2, a0', 'vsmul.vv v1, v2, v3',
  'vmseq.vi v1, v2, 5',
  'vmul.vv v1, v2, v3', 'vmulhu.vx v1, v2, a0', 'vmacc.vv v1, v2, v3', 'vmacc.vx v1, a0, v2',
  'vwmulu.vx v1, v2, a0', 'vwmacc.vx v1, a0, v2', 'vwmaccus.vx v1, a0, v2',
  'vwaddu.wv v1, v2, v3', 'vwsub.wx v1, v2, a0',
  'vredsum.vs v1, v2, v3', 'vwredsum.vs v1, v2, v3',
  'vmand.mm v1, v2, v3', 'vmxnor.mm v1, v2, v3', 'vcompress.vm v1, v2, v3',
  'vcpop.m a0, v2', 'vfirst.m a0, v2', 'viota.m v1, v2', 'vid.v v1', 'vmv.x.s a0, v2', 'vmv.s.x v1, a0',
  'vzext.vf2 v1, v2', 'vsext.vf4 v1, v2', 'vmv1r.v v1, v2', 'vmv8r.v v1, v2',
  'vfadd.vv v1, v2, v3', 'vfadd.vf v1, v2, fa0', 'vfrsub.vf v1, v2, fa0', 'vfwmul.vv v1, v2, v3',
  'vfwadd.wv v1, v2, v3', 'vfmadd.vv v1, v2, v3', 'vfnmacc.vf v1, fa0, v2', 'vfsqrt.v v1, v2', 'vfclass.v v1, v2',
  'vfcvt.xu.f.v v1, v2', 'vfcvt.rtz.xu.f.v v1, v2', 'vfwcvt.f.f.v v1, v2', 'vfncvt.rod.f.f.w v1, v2',
  'vmfeq.vv v1, v2, v3', 'vmfge.vf v1, v2, fa0', 'vfmerge.vfm v1, v2, fa0, v0', 'vfmv.v.f v1, fa0',
  'vfmv.f.s fa0, v2', 'vfmv.s.f v1, fa0', 'vfredosum.vs v1, v2, v3', 'vfslide1up.vf v1, v2, fa0',
  'vneg.v v1, v2', 'vnot.v v1, v2', 'vncvt.x.x.w v1, v2', 'vwcvt.x.x.v v1, v2',
  'vfneg.v v1, v2', 'vfabs.v v1, v2', 'vmmv.m v1, v2', 'vmclr.m v1', 'vmset.m v1', 'vmnot.m v1, v2',
  'vadd.vv v1, v2, v3, v0.t', 'vredsum.vs v1, v2, v3, v0.t', 'vmsbf.m v1, v2, v0.t',
);

// ---------------------------------------------------------------- 逐条汇编
// 一条一行单独汇编：这样"源码行 ↔ 指令字"的对应关系是确定的，
// 不必去猜 objdump 的输出顺序（伪指令展开 / .option 交互都会打乱顺序）

const MARCH64 = 'rv64gcv_zicsr_zifencei_zba_zbb_zbc_zbs_zicond_zihintpause_zfh';
const MARCH32 = 'rv32gcv_zicsr_zifencei_zba_zbb_zbc_zbs_zicond_zihintpause_zfh';
const sources = lines.filter((l) => l !== '#rvc' && l !== '#norvc');

async function assembleOne(line: string, rvc: boolean, xlen: 32 | 64): Promise<number | null> {
  const src = `.text\n.globl _start\n_start:\n  .option ${rvc ? 'rvc' : 'norvc'}\n  ${line}\n`;
  await Bun.write('/tmp/one.s', src);
  const march = xlen === 64 ? MARCH64 : MARCH32;
  const abi = xlen === 64 ? 'lp64d' : 'ilp32d';
  const as = await $`riscv64-unknown-elf-as -march=${march} -mabi=${abi} -o /tmp/one.o /tmp/one.s`.quiet().nothrow();
  if (as.exitCode !== 0) return null;
  const dump = await $`riscv64-unknown-elf-objdump -d /tmp/one.o`.quiet().text();
  const m = /^\s*0:\s+([0-9a-f]{4,8})\s/m.exec(dump);
  return m ? Number.parseInt(m[1]!, 16) : null;
}

/** 归一化：把源码写法与译码结果拉到同一口径（只比"助记词 + 操作数"） */
function normalize(text: string, mine: boolean): string {
  let t = text
    .replace(/<[^>]*>/g, '')
    .replace(/\(\w+\)/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ',')
    .replace(/,/g, ', ')
    .trim()
    .toLowerCase();
  t = t.replace(/-?0x[0-9a-f]+/g, (h) => String(Number.parseInt(h, 16)));
  const mnemonic = t.split(' ')[0]!;
  // 分支/跳转的最后一项是 PC 相对目标：源码里写的是地址表达式，两边口径不同，去掉
  if (/^(beq|bne|blt|bge|bltu|bgeu|jal|c\.j|c\.jal|c\.beqz|c\.bnez)$/.test(mnemonic)) {
    const ops = t.slice(mnemonic.length + 1).split(', ');
    if (ops.length > 0) t = `${mnemonic} ${ops.slice(0, -1).join(', ')}`.trim();
  }
  // lui/auipc/c.lui：源码给未移位立即数（或带符号十进制），译码给移位后的值
  t = t.replace(/^(lui|auipc|c\.lui) (\S+), (-?\d+)$/, (_all, op, rd, imm) => {
    const value = Number.parseInt(imm, 10);
    const shifted = mine ? value : value << 12;
    const signed = shifted > 0x7fffffff ? shifted - 0x100000000 : shifted;
    return `${op} ${rd}, ${signed}`;
  });
  return t;
}

let bad = 0;
let failed = 0;
let checked = 0;
const seen = new Set<string>();
for (const xlen of [64, 32] as const) {
  for (const line of sources) {
    const word = await assembleOne(line, line.startsWith('c.'), xlen);
    if (word === null) {
      // 该指令在这个 xlen 下不存在（ld/sd/*W/c.jal…），跳过而不是失败
      failed++;
      continue;
    }
    checked++;
    const mine = rvDecode(word, xlen).replace(/\s+/g, ' ').trim();
    const want = normalize(line, false);
    const got = normalize(mine, true);
    if (want === got) continue;
    bad++;
    const key = `rv${xlen}:${want}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`✗ [rv${xlen}] 源码 ${want}\n        译码 ${got}   (word 0x${word.toString(16)})`);
  }
}
console.log(`\nrv64+rv32 共核对 ${checked} 条：不一致 ${bad} 条（去重 ${seen.size} 类），该 xlen 下不存在而跳过 ${failed} 条`);

// ---------------------------------------------------------------- 生成测试用例
// 把精选指令的（汇编器给出的）真编码 + 本译码器的输出打印成 bun:test 片段，
// 用来更新 src/frontend/test/rv.test.ts —— 编码来自工具链，不是手写猜的。
const CURATED: { line: string; note: string }[] = [
  { line: 'addiw a0, a1, -1', note: 'RV64I W 形式' },
  { line: 'slli a0, a1, 40', note: 'RV64 移位量到 6 位' },
  { line: 'srai a0, a1, 63', note: 'RV64 算术右移最大值' },
  { line: 'subw a0, a1, a2', note: 'RV64 W 形式' },
  { line: 'mul a0, a1, a2', note: 'M' },
  { line: 'mulhsu a0, a1, a2', note: 'M' },
  { line: 'divuw a0, a1, a2', note: 'RV64 M-W' },
  { line: 'rem a0, a1, a2', note: 'M' },
  { line: 'lr.w.aq a0, (a1)', note: 'A' },
  { line: 'sc.d.aqrl a0, a1, (a2)', note: 'A' },
  { line: 'amoswap.w a0, a1, (a2)', note: 'A' },
  { line: 'amomaxu.d a0, a1, (a2)', note: 'A' },
  { line: 'flw ft0, 4(a0)', note: 'F' },
  { line: 'fsd ft0, 24(a0)', note: 'D' },
  { line: 'fadd.d ft0, ft1, ft2', note: 'D' },
  { line: 'fsqrt.s ft0, ft1', note: 'F' },
  { line: 'fmadd.d ft0, ft1, ft2, ft3', note: 'FMA' },
  { line: 'fsgnjx.d ft0, ft1, ft2', note: 'D' },
  { line: 'fmin.s ft0, ft1, ft2', note: 'F' },
  { line: 'fcvt.w.s a0, ft1, rtz', note: '带舍入模式' },
  { line: 'fcvt.d.l ft0, a0', note: 'RV64 转换' },
  { line: 'fmv.x.w a0, ft1', note: 'F' },
  { line: 'fmv.d.x ft0, a0', note: 'D' },
  { line: 'feq.d a0, ft1, ft2', note: 'D 比较' },
  { line: 'fclass.d a0, ft1', note: 'D 分类' },
  { line: 'fld ft0, 16(a0)', note: 'D' },
  { line: 'csrrw a0, mstatus, a1', note: 'Zicsr' },
  { line: 'csrrwi a0, misa, 3', note: 'Zicsr 立即数形式' },
  { line: 'csrrs a0, mhpmcounter3, a1', note: 'Zicsr 区间名' },
  { line: 'csrrs a0, satp, a1', note: 'Zicsr 监督态' },
  { line: 'fence.i', note: 'Zifencei' },
  { line: 'fence rw, rw', note: 'pred/succ' },
  { line: 'fence.tso', note: 'Ztso 编码' },
  { line: 'pause', note: 'Zihintpause' },
  { line: 'sfence.vma a0, a1', note: '监督态围栏' },
  { line: 'clz a0, a1', note: 'Zbb' },
  { line: 'cpopw a0, a1', note: 'Zbb RV64' },
  { line: 'sext.b a0, a1', note: 'Zbb' },
  { line: 'zext.h a0, a1', note: 'Zbb' },
  { line: 'rev8 a0, a1', note: 'Zbb' },
  { line: 'rori a0, a1, 7', note: 'Zbb' },
  { line: 'andn a0, a1, a2', note: 'Zbb' },
  { line: 'maxu a0, a1, a2', note: 'Zbb' },
  { line: 'czero.nez a0, a1, a2', note: 'Zicond' },
  { line: 'sh1add.uw a0, a1, a2', note: 'Zba' },
  { line: 'add.uw a0, a1, a2', note: 'Zba' },
  { line: 'slli.uw a0, a1, 3', note: 'Zba' },
  { line: 'bset a0, a1, a2', note: 'Zbs' },
  { line: 'bexti a0, a1, 7', note: 'Zbs' },
  { line: 'clmulh a0, a1, a2', note: 'Zbc' },
  { line: 'c.ld a0, 8(a1)', note: 'C' },
  { line: 'c.fsdsp ft0, 24(sp)', note: 'C' },
  { line: 'c.addiw a0, 3', note: 'RV64C' },
  { line: 'c.andi a0, -8', note: 'C' },
  { line: 'c.subw a0, a1', note: 'RV64C' },
];

console.log('\n// ---------------- 生成测试用例 ----------------');
for (const { line, note } of CURATED) {
  const word = await assembleOne(line, line.startsWith('c.'), 64);
  if (word === null) {
    console.log(`// 汇编失败：${line}`);
    continue;
  }
  const mine = rvDecode(word, 64).replace(/\s+/g, ' ').trim();
  console.log(`    expect(decode(0x${word.toString(16).padStart(8, '0')}, 64)).toBe('${mine.replace(/'/g, "\\'")}'); // ${note} · ${line}`);
}
