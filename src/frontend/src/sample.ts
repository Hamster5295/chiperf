/**
 * 内置示例轨迹（生成器）
 *
 * 用一个**自洽的**顺序单发射流水模型生成轨迹：
 *   - 每条指令依次经过 if / id / ex / mem / wb，任一时刻每级最多一条，MEM 先到先得
 *     （load 的 3 周期 MEM 会挡住后面的指令，自然产生气泡）
 *   - 分支在 EX 解析出预测错误：当周期杀掉 ID/IF 里的年轻指令（X），并重定向取指
 *   - 覆盖：双时钟域、跨域条目、异步中断、计数器（含 abs= 回读）、保持型数值
 *     （十六进制/字符串/4 态）、事件、注解、状态机（含一次自环）
 */
interface Instr {
  pc: number;
  disasm: string;
  enc: string;
  ex: number;
  mem: number;
}

const PROGRAM: Instr[] = [
  { pc: 0x80000000, disasm: 'addi a0,a0,1', enc: "32'h00150513", ex: 1, mem: 1 },
  { pc: 0x80000004, disasm: 'lw   a1,0(a0)', enc: "32'h00052583", ex: 2, mem: 3 },
  { pc: 0x80000008, disasm: 'beq  a0,a1,+8', enc: "32'h00b50463", ex: 1, mem: 1 },
  { pc: 0x8000000c, disasm: 'addi a2,a2,1', enc: "32'h00160613", ex: 1, mem: 1 },
  { pc: 0x80000010, disasm: 'addi a2,a2,2', enc: "32'h00260613", ex: 1, mem: 1 },
  { pc: 0x80000100, disasm: 'lui  a3,0x1', enc: "32'h000016b7", ex: 1, mem: 1 },
  { pc: 0x80000104, disasm: 'sw   a3,4(a0)', enc: "32'h00d52223", ex: 1, mem: 4 },
  { pc: 0x80000108, disasm: 'jal  ra,-16', enc: "32'hff1ff0ef", ex: 1, mem: 1 },
];

const MISPREDICT_INDEX = 2;
const WRONG_PATH_INDICES = [3, 4];
const REDIRECT_TARGET_INDEX = 5;

interface Slot {
  instr: Instr;
  ifIn: number;
  idIn: number;
  exIn: number;
  memIn: number;
  wbIn: number;
  wbOut: number;
}

function schedule(enterOverrides: Map<number, number>, killed: Set<number> = new Set()): Slot[] {
  const slots: Slot[] = [];
  // 每一级"下一个可用周期"：被挡住时指令留在原级，占用区间自然变长（图上就是 stall）
  let freeIf = 1;
  let freeId = 1;
  let freeEx = 1;
  let freeMem = 1;
  let freeWb = 1;
  for (const [index, instr] of PROGRAM.entries()) {
    const ifIn = Math.max(enterOverrides.get(index) ?? 1, freeIf);
    const idIn = Math.max(ifIn + 1, freeId);
    const exIn = Math.max(idIn + 1, freeEx);
    const memIn = Math.max(exIn + instr.ex, freeMem);
    const wbIn = Math.max(memIn + instr.mem, freeWb);
    const wbOut = wbIn + 1;
    slots.push({ instr, ifIn, idIn, exIn, memIn, wbIn, wbOut });
    // IF/ID 只在本条离开该级后才让位；EX/MEM 按各自停留周期占用
    freeIf = idIn;
    freeId = exIn;
    if (killed.has(index)) continue; // 被冲刷的指令占用过 IF/ID，但从不进入 EX/MEM/WB
    freeEx = exIn + instr.ex;
    freeMem = memIn + instr.mem;
    freeWb = wbIn + 1;
  }
  return slots;
}

/** 某指令在第 cycle 个周期所处的一级（半开区间），不在流水里则返回 null */
function stageAt(slot: Slot, cycle: number): 'if' | 'id' | 'ex' | 'mem' | 'wb' | null {
  if (cycle >= slot.ifIn && cycle < slot.idIn) return 'if';
  if (cycle >= slot.idIn && cycle < slot.exIn) return 'id';
  if (cycle >= slot.exIn && cycle < slot.memIn) return 'ex';
  if (cycle >= slot.memIn && cycle < slot.wbIn) return 'mem';
  if (cycle >= slot.wbIn && cycle < slot.wbOut) return 'wb';
  return null;
}

export function sampleTrace(): string {
  // 先按顺序排一遍，拿到分支解析周期；再让重定向目标从其后取指
  const firstPass = schedule(new Map());
  // 分支占用 EX 的那个周期就是解析出预测错误的周期
  const mispredictCycle = firstPass[MISPREDICT_INDEX]!.exIn;
  const redirectFetch = mispredictCycle + 2;
  const overrides = new Map<number, number>([[REDIRECT_TARGET_INDEX, redirectFetch]]);
  const killedPass = schedule(overrides);

  // 冲刷：mispredictCycle 时分支在 EX 里解析出预测错误，杀掉此刻在 IF/ID 里的年轻指令
  const killedIndices: number[] = [];
  for (let index = MISPREDICT_INDEX + 1; index < killedPass.length && killedIndices.length < 2; index++) {
    const stage = stageAt(killedPass[index]!, mispredictCycle);
    if (stage === 'if' || stage === 'id') killedIndices.push(index);
  }
  // 重排一次：被冲刷的指令不再占用 EX/MEM，后面的指令才是真实的时间线
  const slots = schedule(overrides, new Set(killedIndices));

  const lines: string[] = [];
  const push = (s: string) => lines.push(s);
  const hex = (v: number) => `0x${v.toString(16).padStart(8, '0')}`;
  const perCycle = new Map<number, string[]>();
  const at = (cycle: number, line: string) => {
    const list = perCycle.get(cycle);
    if (list) list.push(line);
    else perCycle.set(cycle, [line]);
  };
  // 被冲刷的指令在 mispredictCycle 之后不再产出正常记录；
  // 注意 kill 周期**当拍**的记录必须保留（那一刻它确实占着被冲刷的那一级）
  const killByIndex = new Map<number, number>(killedIndices.map((index) => [index, mispredictCycle]));
  const put = (index: number, cycle: number, line: string) => {
    const kill = killByIndex.get(index);
    if (kill !== undefined && cycle > kill) return;
    at(cycle, line);
  };

  push('chiperf 1.0');
  push('@meta design="rv32i-demo" tool="chiperf frontend sample" date="2026-09-15" note="内置示例：双时钟域 + 5 级流水 + 异步中断"');
  push('@domain default, period=1.0ns, note="主时钟 1GHz（隐式默认域）"');
  push('@domain mem, freq=800MHz, note="内存时钟 800MHz"');
  push('');
  push('# ---- 时钟之前：复位阶段 ----');
  push('[msg] reset released');
  push('[fsm] "core.ctrl", RESET');
  push('[fsm] "core.icache.ctrl", IDLE');
  push('[fsm] "core.lsu.ctrl", IDLE');
  push('[cnt] "core.retired", abs=0');
  push('[val] "core.if.pc", x');
  push('[val] "core.if.valid", 0');
  push("[val] \"core.l1d.way\", 4'b10xz");
  push('');

  for (const [index, slot] of slots.entries()) {
    const { instr } = slot;
    const tag = hex(instr.pc);

    put(index, slot.ifIn, `[cnt] "core.icache.access"`);
    put(index, slot.ifIn, `[val] "core.if.pc", ${tag}`);
    put(index, slot.ifIn, `[val] "core.if.valid", 1`);
    put(index, slot.ifIn, `[pip] "core.if", I, ${tag}`);
    put(index, slot.idIn, `[pip] "core.if", O, ${tag}`);
    put(index, slot.idIn, `[pip] "core.id", I, ${tag}`);
    put(index, slot.idIn, `[val] "core.id.instr", ${instr.enc}`);
    if (instr.pc === PROGRAM[1]!.pc) put(index, slot.idIn, `[val] "core.id.disasm", "${instr.disasm}"`);
    put(index, slot.exIn, `[pip] "core.id", O, ${tag}`);
    put(index, slot.exIn, `[pip] "core.ex", I, ${tag}`);
    put(index, slot.memIn, `[pip] "core.ex", O, ${tag}`);
    put(index, slot.memIn, `[pip] "core.mem", I, ${tag}`);
    put(index, slot.wbIn, `[pip] "core.mem", O, ${tag}`);
    put(index, slot.wbIn, `[pip] "core.wb", I, ${tag}`);
    put(index, slot.wbOut, `[pip] "core.wb", O, ${tag}`);
    put(index, slot.wbOut, `[cnt] "core.retired"`);
  }

  // X 标在"冲刷生效的那个沿"，而不是解析出预测错误的当拍：被冲刷的指令确实占用了
  // mispredictCycle 这一拍（stageAt 说它此刻在 IF/ID 里），撤走发生在该拍末尾 ——
  // 位置取后一拍才与它自己那份 O 记录（O 也写在离开的那一拍）同一套约定。
  // 若把 X 写在 mispredictCycle 当拍，条目会成为零宽 `[c, c)`：按 §9.4 那类条目
  // 不计入任何周期的占用度，图上只剩周期交界处的一个薄片，占用度曲线里也看不到它。
  const flushCycle = mispredictCycle + 1;
  for (const index of killedIndices) {
    const slot = slots[index]!;
    at(flushCycle, `[pip] "core.${stageAt(slot, mispredictCycle)}", X, ${hex(slot.instr.pc)}`);
  }
  at(mispredictCycle, `[cnt] "core.br.miss"`);
  at(mispredictCycle, `[evt] "core.flush", ${hex(PROGRAM[MISPREDICT_INDEX]!.pc)}`);
  at(mispredictCycle, `[val] "core.if.valid", 0`);
  at(flushCycle, `[evt] "core.redirect", ${hex(PROGRAM[REDIRECT_TARGET_INDEX]!.pc)}`);

  // 控制状态机
  at(slots[0]!.ifIn, '[fsm] "core.ctrl", FETCH');
  at(slots[0]!.idIn, '[fsm] "core.ctrl", RUN');
  at(mispredictCycle, '[fsm] "core.ctrl", FLUSH');
  at(redirectFetch, '[fsm] "core.ctrl", FETCH');
  at(redirectFetch + 1, '[fsm] "core.ctrl", RUN');
  const lastCycle = Math.max(...slots.map((s) => s.wbOut)) + 3;
  at(lastCycle - 2, '[fsm] "core.ctrl", DRAIN');
  at(lastCycle, '[fsm] "core.ctrl", DONE');

  // I-cache 未命中与填充（无自环）
  at(2, `[cnt] "core.icache.miss"`);
  at(3, '[fsm] "core.icache.ctrl", LOOKUP');
  at(4, '[fsm] "core.icache.ctrl", FILL');
  at(7, '[fsm] "core.icache.ctrl", IDLE');
  // LSU：load 等待内存（WAIT 连续两拍 ⇒ 一次自环）
  const load = slots[1]!;
  at(load.memIn, '[fsm] "core.lsu.ctrl", CMD');
  at(load.memIn + 1, '[fsm] "core.lsu.ctrl", WAIT');
  at(load.memIn + 2, '[fsm] "core.lsu.ctrl", WAIT');
  at(load.wbIn, '[fsm] "core.lsu.ctrl", RESP');
  at(load.wbIn + 1, '[fsm] "core.lsu.ctrl", IDLE');
  for (let c = load.memIn; c < load.wbIn; c++) at(c, `[cnt] "core.stall.mem"`);
  // 每 5 个周期采样的派生指标
  for (let c = 5; c <= lastCycle; c += 5) {
    at(c, `[val] "core.ipc", ${(1.25 + (c % 7) / 20).toFixed(2)}`);
    at(c, `[val] "core.l2.hitrate", ${(0.86 + (c % 11) / 100).toFixed(3)}`);
  }
  // 硬件计数器周期性回读：abs= 只置总量，不贡献 delta（spec §9.2）
  at(10, `[cnt] "core.icache.access", abs=31`);
  at(20, `[cnt] "core.icache.access", abs=64`);
  // 异步中断：不在任何时钟沿上到达
  at(17, `[cnt] "core.irq", async=1`);
  at(17, `[evt] "core.irq.assert", 7, async=1`);
  at(17, '[fsm] "core.ctrl", TRAP');
  at(18, '[msg] irq serviced (vector 7)');

  // 跨时钟域请求：在默认域发起，稍后在 mem 域完成
  const crossTag = 0x9000;
  at(slots[1]!.ifIn, `[pip] "l2.req", I, ${hex(crossTag)}`);

  // 按周期输出；mem 域更快（每 4 个默认域周期多跑一拍）
  for (let cycle = 1; cycle <= lastCycle; cycle++) {
    push(`# ---- 默认域周期 ${cycle} ----`);
    push('[clk] p');
    for (const line of perCycle.get(cycle) ?? []) push(line);
    push('[clk] n');
    if (cycle % 4 === 0) {
      push('[clk] p, dom=mem');
      push(`[cnt] "mem.access", dom="mem"`);
      push(`[clk] n, dom=mem`);
    }
  }

  push('');
  push('# ---- 跨时钟域请求在 mem 域完成（不给周期延迟，spec §6.5）----');
  push('[clk] p, dom=mem');
  push(`[pip] "l2.req", O, ${hex(crossTag)}, dom="mem"`);
  push('[cnt] "mem.access", dom="mem"');
  push('[clk] n, dom=mem');
  push('');
  push('[msg] trace complete');
  push('@end');
  return `${lines.join('\n')}\n`;
}
