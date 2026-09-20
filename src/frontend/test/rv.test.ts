/**
 * RISC-V 译码与数值格式显示测试
 *
 * 用例里的**指令编码全部来自真实工具链**（riscv64-unknown-elf-as / objdump，
 * -march=rv64gc_zicsr_zifencei_zba_zbb_zbc_zbs_zicond_zihintpause_zfh），
 * 不是手推的：位域取错、立即数拼错、funct3 张冠李戴都会在这里失败。
 * 覆盖面见 src/rv.ts 的文件头 —— RV64GC + Zicsr/Zifencei + Zba/Zbb/Zbc/Zbs + Zicond + V。
 */
import { describe, expect, test } from 'bun:test';
import { formatScalarBy, rvDecode } from '../src/rv.ts';
import { scanValue } from '../../parser/src/index.ts';

/** 归一化空白后比较，避免受对齐空格影响 */
const decode = (word: number, xlen: 32 | 64) => rvDecode(word, xlen).replace(/\s+/g, ' ').trim();

describe('RV32I / RV64I 基础', () => {
  test('算术与访存（示例轨迹里的指令）', () => {
    expect(decode(0x00150513, 32)).toBe('addi a0, a0, 1');
    expect(decode(0x00260613, 32)).toBe('addi a2, a2, 2');
    expect(decode(0x00052583, 32)).toBe('lw a1, 0(a0)');
    expect(decode(0x000016b7, 32)).toBe('lui a3, 0x1000');
    expect(decode(0x00d52223, 32)).toBe('sw a3, 4(a0)');
  });

  test('负立即数不能与 funct7 混为一谈（I 型的立即数占 bits[31:20]）', () => {
    expect(decode(0xfff5851b, 64)).toBe('addiw a0, a1, -1');
    expect(decode(0x80050513, 32)).toBe('addi a0, a0, -2048');
    expect(decode(0xfff57513, 32)).toBe('andi a0, a0, -1');
  });

  test('分支与跳转给相对偏移', () => {
    // 这 6 条是同一段带标签的源码汇编出来的（L 在 +36 处，各分支所在地址不同）
    expect(decode(0x02b50263, 32)).toBe('beq a0, a1, +36');
    expect(decode(0x02b51063, 32)).toBe('bne a0, a1, +32');
    expect(decode(0x00b54e63, 32)).toBe('blt a0, a1, +28');
    expect(decode(0x00b55c63, 32)).toBe('bge a0, a1, +24');
    expect(decode(0x00b56a63, 32)).toBe('bltu a0, a1, +20');
    expect(decode(0x00b57863, 32)).toBe('bgeu a0, a1, +16');
    expect(decode(0xff1ff0ef, 32)).toBe('jal ra, -16');
    expect(decode(0x00008067, 32)).toBe('jalr zero, 0(ra)');
    expect(decode(0x004500e7, 64)).toBe('jalr ra, 4(a0)');
  });

  test('RV64 的移位量是 6 位', () => {
    expect(decode(0x02859513, 64)).toBe('slli a0, a1, 40');
    expect(decode(0x43f5d513, 64)).toBe('srai a0, a1, 63');
    expect(decode(0x02159513, 32)).toContain('.word'); // RV32 上 bit25 必须为 0
  });

  test('RV32 与 RV64 的差别（ld / sd / *W）', () => {
    expect(decode(0x00053503, 64)).toBe('ld a0, 0(a0)');
    expect(decode(0x00053503, 32)).toContain('.word');
    expect(decode(0x0005051b, 64)).toBe('sext.w a0, a0');
    expect(decode(0x0005051b, 32)).toContain('.word');
    expect(decode(0x00b5053b, 64)).toBe('addw a0, a0, a1');
    expect(decode(0x40c5853b, 64)).toBe('subw a0, a1, a2');
  });

  test('未知编码不抛异常', () => {
    expect(decode(0xffffffff, 32)).toContain('.word');
    expect(decode(0x00000000, 32)).toContain('.c');
  });
});

describe('M 扩展（乘除）', () => {
  test('基础与 RV64 的 W 形式', () => {
    expect(decode(0x02c58533, 64)).toBe('mul a0, a1, a2');
    expect(decode(0x02c5a533, 64)).toBe('mulhsu a0, a1, a2');
    expect(decode(0x02c5e533, 64)).toBe('rem a0, a1, a2');
    expect(decode(0x02c5d53b, 64)).toBe('divuw a0, a1, a2');
    expect(decode(0x02c5d53b, 32)).toContain('.word');
  });
});

describe('A 扩展（原子）', () => {
  test('lr / sc / amo，含 aq / rl 后缀与 .w/.d', () => {
    expect(decode(0x1405a52f, 64)).toBe('lr.w.aq a0, (a1)');
    expect(decode(0x1eb6352f, 64)).toBe('sc.d.aqrl a0, a1, (a2)');
    expect(decode(0x08b6252f, 64)).toBe('amoswap.w a0, a1, (a2)');
    expect(decode(0xe0b6352f, 64)).toBe('amomaxu.d a0, a1, (a2)');
    expect(decode(0x1005a52f, 64)).toBe('lr.w a0, (a1)');
    expect(decode(0x1005a52f, 32)).toBe('lr.w a0, (a1)');
    expect(decode(0x0005352f, 32)).toBe('amoadd.d a0, zero, (a0)');
  });
});

describe('F / D 扩展（浮点）', () => {
  test('访存与算术', () => {
    expect(decode(0x00452007, 64)).toBe('flw ft0, 4(a0)');
    expect(decode(0x01053007, 64)).toBe('fld ft0, 16(a0)');
    expect(decode(0x00053c27, 64)).toBe('fsd ft0, 24(a0)');
    expect(decode(0x0220f053, 64)).toBe('fadd.d ft0, ft1, ft2');
    expect(decode(0x5800f053, 64)).toBe('fsqrt.s ft0, ft1');
    expect(decode(0x1a20f043, 64)).toBe('fmadd.d ft0, ft1, ft2, ft3');
    expect(decode(0x2220a053, 64)).toBe('fsgnjx.d ft0, ft1, ft2');
    expect(decode(0x28208053, 64)).toBe('fmin.s ft0, ft1, ft2');
  });

  test('转换与搬运（含舍入模式只在非默认时打印）', () => {
    expect(decode(0xc0009553, 64)).toBe('fcvt.w.s a0, ft1, rtz');
    expect(decode(0xc000f553, 64)).toBe('fcvt.w.s a0, ft1');
    expect(decode(0xd2257053, 64)).toBe('fcvt.d.l ft0, a0');
    expect(decode(0xe0008553, 64)).toBe('fmv.x.w a0, ft1');
    expect(decode(0xf2050053, 64)).toBe('fmv.d.x ft0, a0');
    expect(decode(0xa220a553, 64)).toBe('feq.d a0, ft1, ft2');
    expect(decode(0xe2009553, 64)).toBe('fclass.d a0, ft1');
  });
});

describe('C 扩展（压缩指令）', () => {
  test('常用形式', () => {
    expect(decode(0x8082, 32)).toBe('c.jr ra');
    expect(decode(0x4501, 32)).toBe('c.li a0, 0');
    expect(decode(0x0001, 32)).toBe('c.nop');
    expect(decode(0x00006588, 64)).toBe('c.ld a0, 8(a1)');
    expect(decode(0x0000ac02, 64)).toBe('c.fsdsp ft0, 24(sp)');
    expect(decode(0x0000250d, 64)).toBe('c.addiw a0, 3');
    expect(decode(0x00002515, 64)).toBe('c.addiw a0, 5');
    expect(decode(0x00009961, 64)).toBe('c.andi a0, -8');
    expect(decode(0x00009d0d, 64)).toBe('c.subw a0, a1');
  });

  test('分支/跳转（c.j / c.beqz / c.bnez；c.jal 仅 RV32）', () => {
    expect(decode(0xa009, 64)).toBe('c.j +2');
    expect(decode(0xc111, 64)).toBe('c.beqz a0, +4');
    expect(decode(0xe109, 64)).toBe('c.bnez a0, +2');
    expect(decode(0x2011, 32)).toBe('c.jal +4');
    expect(decode(0x2011, 64)).toContain('.c'); // RV64C 同槽位是 c.addiw，rd=0 是保留编码
  });
});

describe('Zicsr / Zifencei / 特权指令', () => {
  test('CSR 读写与立即数形式', () => {
    expect(decode(0x30059573, 64)).toBe('csrrw a0, mstatus, a1');
    expect(decode(0x3011d573, 64)).toBe('csrrwi a0, misa, 3');
    expect(decode(0x1805a573, 64)).toBe('csrrs a0, satp, a1');
    expect(decode(0xf1402573, 64)).toBe('csrrs a0, mhartid, zero');
  });

  test('成组的 CSR 名按区间给出', () => {
    expect(decode(0xb035a573, 64)).toBe('csrrs a0, mhpmcounter3, a1');
    expect(decode(0x3255a573, 64)).toBe('csrrs a0, mhpmevent5, a1');
    expect(decode(0x3bf5a573, 64)).toBe('csrrs a0, pmpaddr15, a1');
    expect(decode(0x00002573, 64)).toBe('csrrs a0, 0x0, zero'); // 不认识的 CSR 给地址
  });

  test('围栏与特权指令', () => {
    expect(decode(0x0000100f, 64)).toBe('fence.i');
    expect(decode(0x0330000f, 64)).toBe('fence rw, rw');
    expect(decode(0x8330000f, 64)).toBe('fence.tso');
    expect(decode(0x0100000f, 64)).toBe('pause');
    expect(decode(0x12b50073, 64)).toBe('sfence.vma a0, a1');
    expect(decode(0x00000073, 32)).toBe('ecall');
    expect(decode(0x00100073, 32)).toBe('ebreak');
    expect(decode(0x30200073, 64)).toBe('mret');
  });
});

describe('Zba / Zbb / Zbc / Zbs / Zicond', () => {
  test('Zbb：单目与双目的位操作', () => {
    expect(decode(0x60059513, 64)).toBe('clz a0, a1');
    expect(decode(0x6025951b, 64)).toBe('cpopw a0, a1');
    expect(decode(0x60459513, 64)).toBe('sext.b a0, a1');
    expect(decode(0x0805c53b, 64)).toBe('zext.h a0, a1');
    expect(decode(0x6b85d513, 64)).toBe('rev8 a0, a1');
    expect(decode(0x6075d513, 64)).toBe('rori a0, a1, 7');
    expect(decode(0x40c5f533, 64)).toBe('andn a0, a1, a2');
    expect(decode(0x0ac5f533, 64)).toBe('maxu a0, a1, a2');
  });

  test('Zba / Zbs / Zbc / Zicond', () => {
    expect(decode(0x20c5a53b, 64)).toBe('sh1add.uw a0, a1, a2');
    expect(decode(0x08c5853b, 64)).toBe('add.uw a0, a1, a2');
    expect(decode(0x0835951b, 64)).toBe('slli.uw a0, a1, 3');
    expect(decode(0x28c59533, 64)).toBe('bset a0, a1, a2');
    expect(decode(0x4875d513, 64)).toBe('bexti a0, a1, 7');
    expect(decode(0x0ac5b533, 64)).toBe('clmulh a0, a1, a2');
    expect(decode(0x0ec5f533, 64)).toBe('czero.nez a0, a1, a2');
  });
});

describe('V 扩展（RVV 1.0）', () => {
  test('配置：vsetvli / vsetivli / vsetvl', () => {
    expect(decode(0x0d0572d7, 64)).toBe('vsetvli t0, a0, e32, m1, ta, ma');
    expect(decode(0x001572d7, 64)).toBe('vsetvli t0, a0, e8, m2, tu, mu');
    expect(decode(0x0df572d7, 64)).toBe('vsetvli t0, a0, e64, mf2, ta, ma');
    expect(decode(0xcd0272d7, 64)).toBe('vsetivli t0, 4, e32, m1, ta, ma');
    expect(decode(0x80b572d7, 64)).toBe('vsetvl t0, a0, a1');
    // 保留 vtype 不做符号化，GNU 直接给原始立即数
    expect(decode(0x100572d7, 64)).toBe('vsetvli t0, a0, 256');
    expect(decode(0xf00272d7, 64)).toBe('vsetivli t0, 4, 768');
  });

  test('单位步长 / 跨步 / 索引访存', () => {
    expect(decode(0x02050087, 64)).toBe('vle8.v v1, (a0)');
    expect(decode(0x02055087, 64)).toBe('vle16.v v1, (a0)');
    expect(decode(0x02056087, 64)).toBe('vle32.v v1, (a0)');
    expect(decode(0x02057087, 64)).toBe('vle64.v v1, (a0)');
    expect(decode(0x020560a7, 64)).toBe('vse32.v v1, (a0)');
    expect(decode(0x00056087, 64)).toBe('vle32.v v1, (a0), v0.t');
    expect(decode(0x03056087, 64)).toBe('vle32ff.v v1, (a0)');
    expect(decode(0xa3056087, 64)).toBe('vlseg6e32ff.v v1, (a0)');
    expect(decode(0x0ab56087, 64)).toBe('vlse32.v v1, (a0), a1');
    expect(decode(0x06256087, 64)).toBe('vluxei32.v v1, (a0), v2');
    expect(decode(0x0e257087, 64)).toBe('vloxei64.v v1, (a0), v2');
    expect(decode(0x062550a7, 64)).toBe('vsuxei16.v v1, (a0), v2');
  });

  test('掩码 / 整寄存器 / 段式访存', () => {
    expect(decode(0x02b50087, 64)).toBe('vlm.v v1, (a0)');
    expect(decode(0x02b500a7, 64)).toBe('vsm.v v1, (a0)');
    expect(decode(0x02850087, 64)).toBe('vl1r.v v1, (a0)'); // eew=8 时省略 re8
    expect(decode(0x22855087, 64)).toBe('vl2re16.v v1, (a0)');
    expect(decode(0x62856087, 64)).toBe('vl4re32.v v1, (a0)');
    expect(decode(0xe2857087, 64)).toBe('vl8re64.v v1, (a0)');
    expect(decode(0x028500a7, 64)).toBe('vs1r.v v1, (a0)');
    expect(decode(0xe28500a7, 64)).toBe('vs8r.v v1, (a0)');
    expect(decode(0x22056087, 64)).toBe('vlseg2e32.v v1, (a0)');
    expect(decode(0x620550a7, 64)).toBe('vsseg4e16.v v1, (a0)');
    expect(decode(0x4ab56087, 64)).toBe('vlsseg3e32.v v1, (a0), a1');
    expect(decode(0x26256087, 64)).toBe('vluxseg2ei32.v v1, (a0), v2');
  });

  test('整数算术（三操作数与立即数）', () => {
    expect(decode(0x022180d7, 64)).toBe('vadd.vv v1, v2, v3');
    expect(decode(0x022540d7, 64)).toBe('vadd.vx v1, v2, a0');
    expect(decode(0x022fb0d7, 64)).toBe('vadd.vi v1, v2, -1'); // 立即数按 5 位有符号
    expect(decode(0x0a2180d7, 64)).toBe('vsub.vv v1, v2, v3');
    expect(decode(0x0e2540d7, 64)).toBe('vrsub.vx v1, v2, a0');
    expect(decode(0x122180d7, 64)).toBe('vminu.vv v1, v2, v3');
    expect(decode(0x1e2540d7, 64)).toBe('vmax.vx v1, v2, a0');
    expect(decode(0x262180d7, 64)).toBe('vand.vv v1, v2, v3');
    expect(decode(0x2623b0d7, 64)).toBe('vand.vi v1, v2, 7');
    expect(decode(0x322fb0d7, 64)).toBe('vrgather.vi v1, v2, 31'); // 该立即数按无符号
    expect(decode(0x3a2180d7, 64)).toBe('vrgatherei16.vv v1, v2, v3');
    expect(decode(0x3a2540d7, 64)).toBe('vslideup.vx v1, v2, a0');
    expect(decode(0x3e21b0d7, 64)).toBe('vslidedown.vi v1, v2, 3');
    expect(decode(0x3a2560d7, 64)).toBe('vslide1up.vx v1, v2, a0');
    expect(decode(0x8221b0d7, 64)).toBe('vsaddu.vi v1, v2, 3');
    expect(decode(0x9621b0d7, 64)).toBe('vsll.vi v1, v2, 3');
    expect(decode(0xae2540d7, 64)).toBe('vssra.vx v1, v2, a0');
    expect(decode(0xb221b0d7, 64)).toBe('vnsrl.wi v1, v2, 3');
    expect(decode(0xb62180d7, 64)).toBe('vnsra.wv v1, v2, v3');
    expect(decode(0xba2540d7, 64)).toBe('vnclipu.wx v1, v2, a0');
    expect(decode(0x9e2180d7, 64)).toBe('vsmul.vv v1, v2, v3');
    expect(decode(0x6222b0d7, 64)).toBe('vmseq.vi v1, v2, 5');
  });

  test('进位 / 合并 / 广播', () => {
    expect(decode(0x402180d7, 64)).toBe('vadc.vvm v1, v2, v3, v0');
    expect(decode(0x462180d7, 64)).toBe('vmadc.vv v1, v2, v3');
    expect(decode(0x5c2540d7, 64)).toBe('vmerge.vxm v1, v2, a0, v0');
    expect(decode(0x5e0100d7, 64)).toBe('vmv.v.v v1, v2');
    expect(decode(0x5e0540d7, 64)).toBe('vmv.v.x v1, a0');
    expect(decode(0x5e01b0d7, 64)).toBe('vmv.v.i v1, 3');
  });

  test('乘加 / 归约 / 掩码逻辑 / 扩展', () => {
    expect(decode(0x9621a0d7, 64)).toBe('vmul.vv v1, v2, v3');
    expect(decode(0x922560d7, 64)).toBe('vmulhu.vx v1, v2, a0');
    expect(decode(0xb63120d7, 64)).toBe('vmacc.vv v1, v2, v3'); // 源码顺序 vd, vs1, vs2
    expect(decode(0xb62560d7, 64)).toBe('vmacc.vx v1, a0, v2');
    expect(decode(0xe22560d7, 64)).toBe('vwmulu.vx v1, v2, a0');
    expect(decode(0xf62560d7, 64)).toBe('vwmacc.vx v1, a0, v2');
    expect(decode(0xfa2560d7, 64)).toBe('vwmaccus.vx v1, a0, v2');
    expect(decode(0xd221a0d7, 64)).toBe('vwaddu.wv v1, v2, v3'); // .w 形式后缀是 .wv/.wx
    expect(decode(0xde2560d7, 64)).toBe('vwsub.wx v1, v2, a0');
    expect(decode(0x0221a0d7, 64)).toBe('vredsum.vs v1, v2, v3');
    expect(decode(0xc62180d7, 64)).toBe('vwredsum.vs v1, v2, v3');
    expect(decode(0x6621a0d7, 64)).toBe('vmand.mm v1, v2, v3');
    expect(decode(0x7e21a0d7, 64)).toBe('vmxnor.mm v1, v2, v3');
    expect(decode(0x5e21a0d7, 64)).toBe('vcompress.vm v1, v2, v3');
    expect(decode(0x4a2320d7, 64)).toBe('vzext.vf2 v1, v2');
    expect(decode(0x4a22a0d7, 64)).toBe('vsext.vf4 v1, v2');
    expect(decode(0x9e2030d7, 64)).toBe('vmv1r.v v1, v2');
    expect(decode(0x9e23b0d7, 64)).toBe('vmv8r.v v1, v2');
  });

  test('掩码统计与标量搬移', () => {
    expect(decode(0x42282557, 64)).toBe('vcpop.m a0, v2');
    expect(decode(0x4228a557, 64)).toBe('vfirst.m a0, v2');
    expect(decode(0x522820d7, 64)).toBe('viota.m v1, v2');
    expect(decode(0x5208a0d7, 64)).toBe('vid.v v1');
    expect(decode(0x42202557, 64)).toBe('vmv.x.s a0, v2');
    expect(decode(0x420560d7, 64)).toBe('vmv.s.x v1, a0');
  });

  test('浮点向量', () => {
    expect(decode(0x022190d7, 64)).toBe('vfadd.vv v1, v2, v3');
    expect(decode(0x022550d7, 64)).toBe('vfadd.vf v1, v2, fa0');
    expect(decode(0x9e2550d7, 64)).toBe('vfrsub.vf v1, v2, fa0');
    expect(decode(0xe22190d7, 64)).toBe('vfwmul.vv v1, v2, v3');
    expect(decode(0xd22190d7, 64)).toBe('vfwadd.wv v1, v2, v3');
    expect(decode(0xa23110d7, 64)).toBe('vfmadd.vv v1, v2, v3'); // 同样 vd, vs1, vs2
    expect(decode(0xb62550d7, 64)).toBe('vfnmacc.vf v1, fa0, v2');
    expect(decode(0x4e2010d7, 64)).toBe('vfsqrt.v v1, v2');
    expect(decode(0x4e2810d7, 64)).toBe('vfclass.v v1, v2');
    expect(decode(0x4a2010d7, 64)).toBe('vfcvt.xu.f.v v1, v2');
    expect(decode(0x4a2310d7, 64)).toBe('vfcvt.rtz.xu.f.v v1, v2');
    expect(decode(0x4a2610d7, 64)).toBe('vfwcvt.f.f.v v1, v2');
    expect(decode(0x4a2a90d7, 64)).toBe('vfncvt.rod.f.f.w v1, v2');
    expect(decode(0x622190d7, 64)).toBe('vmfeq.vv v1, v2, v3');
    expect(decode(0x7e2550d7, 64)).toBe('vmfge.vf v1, v2, fa0');
    expect(decode(0x5c2550d7, 64)).toBe('vfmerge.vfm v1, v2, fa0, v0');
    expect(decode(0x5e0550d7, 64)).toBe('vfmv.v.f v1, fa0');
    expect(decode(0x42201557, 64)).toBe('vfmv.f.s fa0, v2');
    expect(decode(0x420550d7, 64)).toBe('vfmv.s.f v1, fa0');
    expect(decode(0x0e2190d7, 64)).toBe('vfredosum.vs v1, v2, v3');
    expect(decode(0x3a2550d7, 64)).toBe('vfslide1up.vf v1, v2, fa0');
  });

  test('GNU 别名（编码与正形式相同）', () => {
    expect(decode(0x0e2040d7, 64)).toBe('vneg.v v1, v2');
    expect(decode(0x2e2fb0d7, 64)).toBe('vnot.v v1, v2');
    expect(decode(0xb22040d7, 64)).toBe('vncvt.x.x.w v1, v2');
    expect(decode(0xc62060d7, 64)).toBe('vwcvt.x.x.v v1, v2');
    expect(decode(0x262110d7, 64)).toBe('vfneg.v v1, v2');
    expect(decode(0x2a2110d7, 64)).toBe('vfabs.v v1, v2');
    expect(decode(0x662120d7, 64)).toBe('vmmv.m v1, v2');
    expect(decode(0x6e10a0d7, 64)).toBe('vmclr.m v1');
    expect(decode(0x7e10a0d7, 64)).toBe('vmset.m v1');
    expect(decode(0x762120d7, 64)).toBe('vmnot.m v1, v2');
  });

  test('掩码形式与保留编码', () => {
    expect(decode(0x002180d7, 64)).toBe('vadd.vv v1, v2, v3, v0.t');
    expect(decode(0x0021a0d7, 64)).toBe('vredsum.vs v1, v2, v3, v0.t');
    expect(decode(0x5020a0d7, 64)).toBe('vmsbf.m v1, v2, v0.t');
    // 保留组合给 .word：掩码访存要求 nf=0、整寄存器访存要求 vm=1、vid.v 要求 vs2=0
    expect(decode(0x62b80007, 64)).toContain('.word');
    expect(decode(0xe08fd107, 64)).toContain('.word');
    expect(decode(0x52d8a857, 64)).toContain('.word');
    expect(decode(0x890ff957, 64)).toContain('.word');
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
    // 64 位值也走低 32 位做指令译码
    const wide = scanValue("64'h00000000c000f553")!.value;
    expect(formatScalarBy(wide, 'rv64')).toBe('fcvt.w.s a0, ft1');
  });

  test('4 态值与字符串不受格式影响（不可数值化）', () => {
    expect(formatScalarBy(fourState, 'hex')).toBe("4'b10xz");
    expect(formatScalarBy(text, 'hex')).toBe('"abc"');
  });
});
