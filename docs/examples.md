# 示例与逐条推导

本文是 [`spec.md`](spec.md) 的配套验收材料：`docs/examples/` 下的每个 `.chiperf` 文件都给出**由规范语义手工推出的期望结果**。任何实现只要与本文的数字不一致，就是实现（或本规范）有 bug。

推导依据：§6（位置模型，含 §6.7 异步事件）、§7（事件语义）、§9（派生量）、§10（鲁棒性与诊断）。文中"周期 c"一律指 `c` 号周期的上升沿之后、下一个上升沿之前，位置写作 `(域, 周期, 相位, seq)`。

## 汇总

| 文件 | 事件记录数 | 期望诊断 | 覆盖点 |
| --- | --- | --- | --- |
| [`minimal.chiperf`](examples/minimal.chiperf) | 8 | 无 | AGENT.md 的最小示例：上升沿/下降沿、计数、数值、轨道同步进出 |
| [`rv32i-pipeline.chiperf`](examples/rv32i-pipeline.chiperf) | 102 | `self_transition` ×1 | 五级流水、错误路径冲刷、保持型数值、双状态机、计数器 |
| [`multiclk.chiperf`](examples/multiclk.chiperf) | 25 | `cross_domain` ×1 | 双时钟域、跨时钟域轨道、同名不同域的追踪对象彼此独立 |
| [`postprocess.chiperf`](examples/postprocess.chiperf) | 11 | 无 | 无 `clk` 记录（时间轴完全由 `at=` 给出） |
| [`async-events.chiperf`](examples/async-events.chiperf) | 17 | 无 | `async=1`：事件不落在时钟沿上，位置与派生量不变、只有渲染不对齐 |
| [`faults.chiperf`](examples/faults.chiperf) | 17 | 6 类语义异常各 ×1；跳过 3 行 | 鲁棒性：未知类型/指令/属性、非法记录、语义异常、域拼写错误、`async` 误用 |
| [`truncated.chiperf`](examples/truncated.chiperf) | 7 | `truncated_tail`、`eof_without_end_marker` | 前缀封闭性：残行被丢弃，未闭合条目被保留 |
| [`future-version.chiperf`](examples/future-version.chiperf) | 2 | 未知主版本 | 默认模式必须拒绝 `2.0`；"忽略版本"模式下是一个干净文件 |

---

## 1. minimal.chiperf

```chiperf
chiperf 1.0
@meta design="demo" note="AGENT.md 中的示例；补上可选的版本行与 @end"
@domain default, period=1.0ns

# ---- 周期 1 ----
[clk] p
[cnt] "Branch Miss"
[cnt] "Cache Hit"
[val] "PC", 0x800001d0
[pip] "IF", 0x1234abcd
[pip] "IF", bubble
[clk] n

# ---- 周期 2 ----
[clk] p
@end
```

### 位置

| seq | 记录 | 位置 | 派生 |
| --- | --- | --- | --- |
| 1 | `[clk] p` | `(default, 1, p, 1)` | 第 1 个上升沿 |
| 2 | `[cnt] "Branch Miss"` | `(default, 1, p, 2)` | `total = 1`（缺省增量 `+1`） |
| 3 | `[cnt] "Cache Hit"` | `(default, 1, p, 3)` | `total = 1` |
| 4 | `[val] "PC", 0x800001d0` | `(default, 1, p, 4)` | `PC` 从此保持该值 |
| 5 | `[pip] "IF", 0x1234abcd` | `(default, 1, p, 5)` | IF 开始持有 `0x1234abcd`（条目开始） |
| 6 | `[pip] "IF", bubble` | `(default, 1, p, 6)` | IF 变空 ⇒ 该条目驻留 `1-1 = 0` 周期，第 1 周期占用度为 0 |
| 7 | `[clk] n` | `(default, 1, n, 7)` | 同一周期进入相位 `n` |
| 8 | `[clk] p` | `(default, 2, p, 8)` | 周期推进到 2 |

### 派生量

- 域 `default`：上升沿 2、下降沿 1、周期数 2；`period=1.0ns` ⇒ 上升沿时刻分别为 0ns、1.0ns。
- 计数器：`Branch Miss = 1`、`Cache Hit = 1`，两条事件都落在 `(1, p)`。
- 数值：`PC` 在 `(1, p)` 之后恒为 `0x800001d0`；此前为 unknown。
- 轨道 `IF`：占用度 `c1 = 0`、`c2 = 0` —— 1 个条目在**同一周期**进出（`enter = exit = (1, p)`），按半开区间 `[enter, exit)` 不计入任何周期的占用度；延迟 0 周期。
- 诊断：无（`@end` 存在）。

---

## 2. rv32i-pipeline.chiperf

一份演示轨迹（文件头注释里写明了它不是精确的微架构模型），覆盖 5 条轨道、2 个状态机、4 个计数器、3 个数值轨。

### 2.1 流水级排班

| 指令 (tag = PC) | if | id | ex | mem | wb | 结局 |
| --- | --- | --- | --- | --- | --- | --- |
| A `0x80000000` addi | 1→2 | 2→3 | 3→4 | 4→5 | 5→6 | 退休 |
| B `0x80000004` lw | 2→3 | 3→4 | 4→5 | 5→6 | 6→7 | 退休 |
| C `0x80000008` beq | 3→4 | 4→5 | 5→6 | 6→7 | 7→8 | 退休（第 5 周期在 EX 发现预测错误） |
| D `0x8000000c` addi | 4→5 | 5→6 **X** | — | — | — | 错误路径，被冲刷 |
| E `0x80000010` addi | 5→6 **X** | — | — | — | — | 错误路径，被冲刷 |
| F `0x80000100` addi | 7→8 | 8→9 | 9→10 | 10→11 | 11→12 | 退休 |

"数字→数字"表示该条目在 `k` 号周期占用该级、在第 `k+1` 个上升沿离开。

### 2.2 位置（每条记录序号）

`seq` 从 1 开始，只对事件记录递增（`@meta`/`@domain`/`@end` 与注释不占号）。每个周期第一条记录的 `seq`：

| 周期 | 0（时钟前） | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 该周期首个 seq | 1 | 7 | 13 | 23 | 33 | 45 | 59 | 71 | 81 | 89 | 92 | 95 | 99 |
| 该周期记录数 | 6 | 6 | 10 | 10 | 12 | 14 | 12 | 10 | 8 | 3 | 3 | 4 | 4 |

- 时钟之前的 6 条记录位于 `(default, 0, -, 1..6)`：`msg`、两个 FSM 的初态、`cnt abs=0`、`val if.pc = x`（4 态未知）、`val if.valid = 0`。
- 第 6 周期把两级设空：`[pip] "core.if", bubble` 位于 `(default, 6, p, 63)`，`[pip] "core.id", bubble` 位于 `(default, 6, p, 64)`（前一条把 IF 持有的 `0x80000010` 结束掉，后一条结束 ID 里的 `0x8000000c`）。
- 文件共 102 条事件记录，最后一个位置是 `(default, 12, p, 102)`；`clk` 记录共 12 条（12 个上升沿），没有 `n` 记录（该域只用上升沿插桩模式）。

### 2.3 轨道与延迟

| 轨道 | 条目（值: 起始 → 结束） | 驻留（周期） |
| --- | --- | --- |
| `core.if` | A `c1→c2`、B `c2→c3`、C `c3→c4`、D `c4→c5`、E `c5→**c6 变空**`、F `c7→c8` | 全部 1（含被冲刷的 E） |
| `core.id` | A `c2→c3`、B `c3→c4`、C `c4→c5`、D `c5→**c6 变空**`、F `c8→c9` | 全部 1 |
| `core.ex` | A `c3→c4`、B `c4→c5`、C `c5→c6`、F `c9→c10` | 全部 1 |
| `core.mem` | A `c4→c5`、B `c5→c6`、C `c6→c7`、F `c10→c11` | 全部 1 |
| `core.wb` | A `c5→c6`、B `c6→c7`、C `c7→c8`、F `c11→c12` | 全部 1 |

- 结束位置由"下一条把该级改成别的值的记录"给出（保持型语义，spec §7.4）；同一条内容在相邻两级的区间首尾相接，正是流水线的样子。
- 文件结束时所有条目都已被后续记录改掉 ⇒ **`open` 条目为 0**。
- 第 6 周期把 `core.if` / `core.id` 设成 `bubble`：E（在 `core.if` 驻留 1 周期）、D（在 `core.id` 驻留 1 周期）就此离开流水线，这正是"预测错误只冲刷年轻指令，分支本身继续执行"的建模 —— C 的 `mem`/`wb` 记录照常出现。**注意**：v1.0 里"被冲刷"与"正常离开"在数据上不可区分（spec §12.5），这里靠"它此后再没出现在任何一级"才能看出来。

### 2.4 占用度（`inflight(track, c)`）

| 轨道 | c1 | c2 | c3 | c4 | c5 | c6 | c7 | c8 | c9 | c10 | c11 | c12 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `core.if` | 1 | 1 | 1 | 1 | 1 | **0** | 1 | 0 | 0 | 0 | 0 | 0 |
| `core.id` | 0 | 1 | 1 | 1 | 1 | **0** | 0 | 1 | 0 | 0 | 0 | 0 |
| `core.ex` | 0 | 0 | 1 | 1 | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0 |
| `core.mem` | 0 | 0 | 0 | 1 | 1 | 1 | 0 | 0 | 0 | 1 | 0 | 0 |
| `core.wb` | 0 | 0 | 0 | 0 | 1 | 1 | 1 | 0 | 0 | 0 | 1 | 0 |

- `c6` 的 `core.if` / `core.id` 占用度为 0 ⇒ 两个气泡，正是第 6 周期把两级设空留下的空洞。
- B 在 `core.mem` 只停留 1 个周期（`c5`），因为在 `c6` 它就离开了；半开区间 `[enter, exit)` 的含义在这里很直观。

### 2.5 计数器

| 计数器 | 记录所在位置 | 终值 |
| --- | --- | --- |
| `core.icache.access` | `(1,p)`、`(2,p)`*、`(3,p)`、`(4,p)`、`(5,p)`、`(7,p)` | 6 |
| `core.icache.miss` | `(2,p)` | 1 |
| `core.br.miss` | `(6,p)` | 1 |
| `core.retired` | `abs=0` 在 `(0,-)`；`+1` 在 `(6,p)`、`(7,p)`、`(8,p)`、`(12,p)` | 4 |

\* 每条记录只给一个位置代表；同一周期内可能有多条记录，按 `seq` 区分。

- 被冲刷的取指（`c4` 的 D、`c5` 的 E）仍然计入 `icache.access` —— 插桩点在取指发出处，这是刻意的：可视化的"访问数"不应因为冲刷而消失。
- `core.retired` 只在内容离开 `core.wb`（该级被设成别的值或 `bubble`）时记一次：A、B、C、F 共 4 次，与 2.1 的"退休"列一致。

### 2.6 状态机

| 状态机 | 记录 | 跳转 | 自环 |
| --- | --- | --- | --- |
| `core.ctrl` | `RESET(c0)`、`FETCH(c1)`、`RUN(c2)`、`FETCH(c7)`、`RUN(c8)`、`DRAIN(c11)`、`DONE(c12)` | `RESET→FETCH`、`FETCH→RUN`、`RUN→FETCH`、`FETCH→RUN`、`RUN→DRAIN`、`DRAIN→DONE` 共 6 次 | 0 |
| `core.icache.ctrl` | `IDLE(c0)`、`LOOKUP(c2)`、`FILL(c3)`、`FILL(c4)`、`IDLE(c5)` | `IDLE→LOOKUP`、`LOOKUP→FILL`、`FILL→FILL`、`FILL→IDLE` 共 4 次 | 1 |

- `FILL→FILL` 是**自环**：`core.icache.ctrl` 在 `c3`、`c4` 两个周期都报告 `FILL`（填充需要两个周期）⇒ 期望诊断 `self_transition` **恰好 1 次**。这是**预期内**的诊断，不是错误。
- `c7`/`c8` 上 `core.ctrl` 回到 `FETCH`/`RUN`：重定向后重新开始取指。

### 2.7 数值轨

| 数值 | 采样 | 派生 |
| --- | --- | --- |
| `core.if.pc` | `x(c0)`、`0x8000_0000(c1)`、`…004(c2)`、`…008(c3)`、`…00c(c4)`、`…010(c5)`、`0x8000_0100(c7)` | 保持型阶梯；`c6` 不采样 ⇒ 显示上一值（`…010`） |
| `core.if.valid` | `0(c0)`、`1(c1)`、`0(c6)`、`1(c7)`、`0(c8)` | 只写变化点；`1` 表示该周期有取指；`c6` 与 `c8` 之后的 0 就是气泡 |
| `core.id.instr` | `32'h00150513(c2)`、`00052583(c3)`、`00b50463(c4)`、`00160613(c5)`、`00168693(c8)` | 5 次译码采样，值域是 32 位 4 态量 |

`core.id.instr` 是"宽位向量 + 注释里给反汇编"的推荐写法：解析器拿到的是机器友好的 `32'h…`，人偶尔打开文件时靠行尾注释理解。

### 2.8 诊断汇总

| 诊断 | 次数 | 说明 |
| --- | --- | --- |
| `self_transition` | 1 | `core.icache.ctrl` 连续两周期 `FILL` |
| 其它全部诊断 | 0 | 没有 `open`、重复属性、非法记录 |

---

## 3. multiclk.chiperf

两个时钟域，`core`（1.0ns）与 `mem`（800MHz ⇒ 周期 1.25ns）。

### 位置与域状态

| 事件 | 位置 | 说明 |
| --- | --- | --- |
| `[clk] p, dom=core` | `(core, 1, p)` | core 第 1 个上升沿 |
| `[cnt] "stall", dom="core"` | `(core, 1, p)` | 计入 `(core, "stall")` |
| `[val] "core.if.pc", …, dom="core"` | `(core, 1, p)` | —— |
| `[pip] "core.l2", 0x4000, dom="core"` | `(core, 1, p)` | `core.l2` 开始持有 `0x4000` |
| `[clk] p, dom=mem` | `(mem, 1, p)` | mem 第 1 个上升沿（与 core 的周期计数无关） |
| `[cnt] "stall", dom="mem"` | `(mem, 1, p)` | 计入 `(mem, "stall")`，与上一个**不是**同一个计数器 |
| `[clk] n, dom=core` / `[clk] n, dom=mem` | `(core, 1, n)` / `(mem, 1, n)` | 两个域的下降沿 |
| `[pip] "core.l2", bubble, dom="mem"` | `(mem, 2, p)` | `core.l2` 变空；该条目的起始在 core、结束在 mem（`cross_domain`） |

### 派生量

| 派生量 | 值 |
| --- | --- |
| 周期数 | `core` = 2、`mem` = 4 |
| 下降沿数 | `core` = 2、`mem` = 3 |
| 上升沿时刻 | core：0ns、1.0ns；mem：0ns、1.25ns、2.5ns、3.75ns（`@domain` 只用于时间换算，不推进周期） |
| 计数器 | `(core, "stall") = 2`、`(mem, "stall") = 1`、`(mem, "mem.access") = 3` |
| 轨道 `core.l2` | 1 个条目：`enter = (core,1,p)`、`exit = (mem,2,p)` |
| 轨道 `mem.bank0` | 2 个条目：`0x40`（`mem c2→c2`，延迟 0 周期）、`0x44`（`mem c3→c4`，延迟 1 周期） |

- 跨域条目 **不给** 以周期为单位的延迟（`core.l2` 的两端分别在 core 与 mem 的周期 1/2 上，两个数字不可相减）⇒ 期望诊断 `cross_domain` **恰好 1 次**。
- 两条 `"stall"` 记录落在不同域 ⇒ 按 §7 的追踪键 `(域, 名字)` 是**两条独立轨迹**，不会互相累加，也**不**产生 `name_reused`。
- `mem.bank0` 的第 1 个条目在同一周期进出：延迟 0，且占用度不计入任何周期（半开区间）。

---

## 4. postprocess.chiperf

没有一条 `clk` 记录：时间轴完全由 `at=` 给出。这是后处理工具（把别的格式转成 chiperf）应采用的写法。

| seq | 记录 | 位置 |
| --- | --- | --- |
| 1 | `[val] "PC", 32'h8000_0000, at=1p` | `(default, 1, p, 1)` |
| 2 | `[cnt] "Retired", at=1p` | `(default, 1, p, 2)` |
| 3 | `[pip] "IF", 0x80000000, at=1p` | `(default, 1, p, 3)` |
| 4 | `[val] "PC", 32'h8000_0004, at=2p` | `(default, 2, p, 4)` |
| 5 | `[pip] "IF", bubble, at=2p` | `(default, 2, p, 5)`，该条目驻留 `2-1 = 1` 周期 |
| 6 | `[pip] "ID", 0x80000000, at=2` | `(default, 2, p, 6)`（相位字母缺省 ⇒ `p`） |
| 7 | `[val] "PC", 32'h8000_0008, at=3p` | `(default, 3, p, 7)` |
| 8 | `[pip] "ID", bubble, at=3p` | `(default, 3, p, 8)`，该条目驻留 1 周期 |
| 9 | `[cnt] "Retired", at=3p` | `(default, 3, p, 9)` |
| 10 | `[val] "PC", 32'h8000_000c, at=3n` | `(default, 3, n, 10)` |
| 11 | `[cnt] "stall", dom="mem", at=7p` | `(mem, 7, p, 11)` |

- 域 `default` 与 `mem` 都**没有**上升沿记录：`cycles` 与 `phase` 保持初值 `0` / `-`。这不影响事件的定位，也**不**产生任何诊断。
- `at=` 不推进时钟：即便出现过 `at=7p`，`(mem)` 的周期计数仍是 0。
- 计数器：`Retired = 2`、`(mem, "stall") = 1`；轨道 `IF`、`ID` 各 1 个条目、驻留均为 1 周期、都已结束。
- 无诊断。

---

## 5. async-events.chiperf

演示 `async=1`：事件**不是**在时钟沿上采样得到的，因此可视化把它画在两个时钟沿**之间**；但**位置与派生量完全不变**（§6.7）。

```chiperf
chiperf 1.0
@meta design="async demo" note="async=1：事件不是时钟沿采样得到的，可视化落在两个时钟沿之间"
@domain core, period=1.0ns

# ---- cycle 1 ----
[clk] p
[val] "core.pc", 32'h8000_0000
[cnt] "core.instr"
[pip] "core.l2", 0x4000
[clk] n
[val] "core.irq.level", 0                # 下降沿上采样：沿对齐（与下面的异步事件同属一个区间）
[cnt] "core.instr", async=1              # 低相位区间内发生的取指：不在任何时钟沿上
[evt] "irq.assert", 5, async=1           # 外部中断到达：与边沿无关

# ---- cycle 2 ----
[clk] p
[fsm] "core.ctrl", TRAP
[cnt] "core.instr"
[clk] n
[val] "core.pc", 32'h8000_0100, async=1  # 影子 PC 被异步改写
[pip] "core.l2", bubble, async=1          # 响应到达也是异步的（驻留仍按周期算：2-1 = 1）
[msg] irq serviced

# ---- cycle 3 ----
[clk] p
[cnt] "core.instr"
@end
```

### 位置（17 条事件）

| seq | 记录 | 位置 | 对齐 |
| --- | --- | --- | --- |
| 1 | `[clk] p` | `(core, 1, p, 1)` | —— |
| 2 | `[val] "core.pc", 32'h8000_0000` | `(core, 1, p, 2)` | 沿对齐 |
| 3 | `[cnt] "core.instr"` | `(core, 1, p, 3)` | 沿对齐，`total = 1` |
| 4 | `[pip] "core.l2", 0x4000` | `(core, 1, p, 4)` | 沿对齐 |
| 5 | `[clk] n` | `(core, 1, n, 5)` | 低相位区间开始 |
| 6 | `[val] "core.irq.level", 0` | `(core, 1, n, 6)` | 沿对齐 |
| 7 | `[cnt] "core.instr", async=1` | `(core, 1, n, 7)` | **异步**，`total = 2` |
| 8 | `[evt] "irq.assert", 5, async=1` | `(core, 1, n, 8)` | **异步** |
| 9 | `[clk] p` | `(core, 2, p, 9)` | —— |
| 10 | `[fsm] "core.ctrl", TRAP` | `(core, 2, p, 10)` | 沿对齐 |
| 11 | `[cnt] "core.instr"` | `(core, 2, p, 11)` | 沿对齐，`total = 3` |
| 12 | `[clk] n` | `(core, 2, n, 12)` | —— |
| 13 | `[val] "core.pc", 32'h8000_0100, async=1` | `(core, 2, n, 13)` | **异步** |
| 14 | `[pip] "core.l2", bubble, async=1` | `(core, 2, n, 14)` | **异步地把该级设空** |
| 15 | `[msg] irq serviced` | `(core, 2, n, 15)` | —— |
| 16 | `[clk] p` | `(core, 3, p, 16)` | —— |
| 17 | `[cnt] "core.instr"` | `(core, 3, p, 17)` | 沿对齐，`total = 4` |

### 派生量（与沿对齐事件同一套定义）

- **周期数 3、下降沿 2**；`cycles` 的推进只看 `[clk] p`，`async` 与它无关。
- 计数器 `core.instr = 4`，其中 seq 7 来自异步采样 —— **异步事件照样计入它所在周期**的增量。
- 轨道 `core.l2`：`enter = (core,1,p,4)`、`exit = (core,2,n,14)` ⇒ 延迟 `2 − 1 = 1` 周期；占用度 `c1 = 1`、`c2 = 0`。"出"是异步的，延迟仍是确定的周期差 —— 这就是"`async` 只改渲染、不改语义"。
- 数值 `core.pc`：`(1,p)` 采样 `0x8000_0000`，`(2,n)` 异步采样 `0x8000_0100`；`state_at(core.pc, 2) = 0x8000_0100`。
- 诊断：**无**（没有把 `async` 用到 `clk` 上）。

### 可视化要求

- seq 7、8、13、14 四条 **必须** 画在各自区间的**内部**（`(1,n)`、`(2,n)` 两个低相位区间），**不得** 吸附到 `[clk] n` 的刻度上；样式应当与沿对齐事件区分（空心标记/虚线）。
- `(1,n)` 区间里 seq 6 是沿对齐、seq 7/8 是异步：**同一个区间可以既画在刻度上又画在中间**，区间内排序仍按 `seq`。
- 反过来，若把 seq 7 错标成沿对齐，读者会以为这第 2 条取指发生在下降沿的那一刻 —— 这正是 W11 要求标注 `async` 的原因。

---

## 6. faults.chiperf

故意注入错误。逐行期望结果：

| 行 | 内容 | 期望行为 |
| --- | --- | --- |
| `@unknown_directive foo=1` | 未知指令 | 忽略，`skipped_unknown_directive` +1 |
| `[clk] p` | 正常 | 周期 1，`seq 1` |
| `[cnt] "Retired"` ×2 | 正常 | `total = 2` |
| `[stall] "if"` | 未知类型 | 跳过，`skipped_unknown_kind` +1 |
| `[cnt] "Retired", x` | 增量不是 `int` | 跳过，`skipped_invalid_record` +1 |
| `[val] "PC", 0x80000000` | 正常 | `seq 4` |
| `[val] "PC", 32'hDEAD_BEEF, x-vendor-tag=7` | 未知属性 | 属性被忽略，**记录仍然有效**，`seq 5` |
| `[pip] "IF", bubble` | 该级本来就是空的 | 记录仍有效（`seq 6`）：只是把"空"再说一遍，**不产生任何诊断**（v1.0 没有"凭空出队"这回事，spec §7.4） |
| `[clk] p` ×2 | 只有上升沿 | 周期 2、周期 3 |
| `[clk] n` / `[clk] n` | 重复否定相位 | 第二条 `redundant_edge` +1 |
| `[cnt] "Retired", -10` | 累计变负 | `total = 2-10 = -8`，`negative_total` +1 |
| `[fsm] "ctrl", IDLE` ×2 | 自环 | `self_transition` +1 |
| `[val] "PC", 4'b10xz` | 4 态值 | 正常，值含未知位（bit1）与高阻位（bit0） |
| `[msg] tail text with, commas and # a hash are literal` | 自由文本 | 整段为文本（含 `,` 与 `#`），`seq 15` |
| `[cnt] "Retired", dom="cor"` | 域拼写错误 | 记录有效（`seq 16`），落入新建的 `cor` 域 ⇒ `undeclared_domain` +1；它**不会**并入 `core` 的 `Retired`（追踪键是 `(域, 名字)`） |
| `[clk] p, async=1` | `async` 用在时钟沿上 | 记录有效且**沿仍然生效**（周期 4，`seq 17`），属性被忽略 ⇒ `async_on_clk` +1 |
| `@end` | 正常结束 | 无 `eof_without_end_marker` |

统计：**17 条有效事件记录**；被跳过 3 行（未知类型 1、非法记录 1、未知指令 1）；语义异常 5 次（`redundant_edge`、`negative_total`、`self_transition`、`undeclared_domain`、`async_on_clk` 各 1）。

关键点：

- `x-vendor-tag=7` 与 `[stall]` 这两行的对比说明了两条不同的容错策略 —— **未知属性忽略并继续用这一行**，**未知类型整行跳过**。前者不损失数据，后者无法解释语义。
- `dom="cor"` 说明为什么需要 `undeclared_domain` 诊断：拼错域名不会报错，而是**静默新建一条时间轴**，数据被拆开却看不出异常。
- 本文件的边沿序列是 `p, p, n, n, p`（故意混合了"只写 p"与"写 p/n"两种模式来触发 `redundant_edge`），因此它同时也是写入者指南 W10 的反例 —— 鲁棒性用例就要覆盖不合规输入。

## 7. truncated.chiperf

模拟仿真器在写第 10 行时被杀掉：文件**没有**以换行结束，最后一行是半条记录 `[cnt] "Retire`。

| seq | 记录 | 位置 | 派生 |
| --- | --- | --- | --- |
| 1 | `[clk] p` | `(default, 1, p, 1)` | 周期 1 |
| 2 | `[cnt] "Retired"` | `(default, 1, p, 2)` | `total = 1` |
| 3 | `[pip] "IF", 0x80000000` | `(default, 1, p, 3)` | IF 开始持有它 |
| 4 | `[pip] "IF", bubble` | `(default, 1, p, 4)` | 驻留 0 周期 |
| 5 | `[pip] "ID", 0x80000000` | `(default, 1, p, 5)` | ID 开始持有它，**之后没有任何记录改掉** |
| 6 | `[val] "PC", 0x80000000` | `(default, 1, p, 6)` | `PC` 保持 |
| 7 | `[clk] p` | `(default, 2, p, 7)` | 周期 2 |
| — | `[cnt] "Retire` | 丢弃 | `truncated_tail` 保留原文 |

- **7 条有效事件记录**；残行 **不得** 被解析（否则会得到一条名为 `Retire` 的伪计数）。
- 轨道 `ID` 留下 1 个 `open` 条目（`enter = (default,1,p,5)`，值 `0x80000000`）⇒ 可视化应画成开放区间，而不是伪造一个结束位置。
- 没有 `@end` ⇒ `eof_without_end_marker`。
- 这正是 §10.1 前缀封闭性的具体体现：截断到任意行边界，剩下的部分都是一个可以正常解析、语义自洽的 chiperf 文件。

## 8. future-version.chiperf

首行是 `chiperf 2.0`（比当前主版本更高的版本）。默认模式下解析器 **必须** 拒绝该文件；只有在显式开启"忽略版本"模式时才尽力解析。文件里的 2 条事件记录本身是合法的，因此这个用例可以区分"版本拒绝"与"语法错误"两种失败路径。

## 9. `reset.chiperf` —— 系统复位（v1.1）

```
chiperf 1.1
@domain default, period=1.0ns
@meta design="rst-demo"

[clk] p
[cnt] "retired"
[val] "core.pc", 0x1000
[pip] "core.if", 0x1000
[clk] n
[clk] p
[cnt] "retired"
[clk] n

[rst]                                   # 复位：以上全部记录作废

[clk] p
[cnt] "retired"                         # 累计从这里重新开始（= 1，不是 3）
[val] "core.pc", 0x8000
[clk] n
@end
```

逐条推导：

| 项 | 结果 |
| --- | --- |
| 记录条数 | 复位前 8 条被丢弃；**`stats.records = 4`**（复位后的 `p`/`cnt`/`val`/`n`） |
| 复位标记 | `resets = [{ line: 15, droppedRecords: 8 }]`；`rst` 自身不是记录，不占 `seq`、不占位置 |
| 计数器 `retired` | 终值 **1**（复位前那次增量已随记录作废） |
| 数值 `core.pc` | 只剩复位后的 0x8000 一次采样；复位前是 `unknown` 而不是 0x1000 |
| 轨道 `core.if` | **不存在**：它唯一那条 `I` 在复位前，随复位一起没了 |
| 域 `default` | `period=1.0ns` 与 `@meta` **保留**（`@` 指令是声明不是行）；沿数与记录范围按新窗口重算 |
| 周期号 | 不重编：复位后的记录接着原来的周期号（本例第 3 个周期），时钟不"回到 0" |
| 诊断 | 一条 `rst_boundary`（信息性）；复位前的诊断与跳过行一并作废 |

复位处正在飞的条目会被销毁：复位之前 `[pip] "core.if", 0x1000` 的保持状态随记录一起作废，复位后该级处于"未开始"状态，直到下一条 `[pip]` 把它设成某个值或 `bubble`（spec §7.4 / §7.8）。复位后写 `[pip] "core.if", bubble` 也完全正常 —— 那只是"该级变空"，不产生诊断。
