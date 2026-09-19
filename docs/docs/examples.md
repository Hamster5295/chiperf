# 示例

本页给出 8 个 Chiperf 示例文件。每个文件都先完整地列出内容，再说明每个记录在什么时候生效、能算出哪些结果。文中的数字都可以对照[格式规范](spec/v1.0.md)自行复核。

记录的位置写作 `(周期, 相位, 序号)`。`p` 表示上升沿所在的前半段，`n` 表示下降沿所在的后半段；序号是该周期内的第几条记录。v1.0 只有一条全局时钟（`clock`），不再有时钟域。

> 本段几乎由 LLM 完成，仅供参考，其可读性可能并不高

## 汇总

| 文件 | 记录条数 | 提示 | 主要演示 |
| --- | --- | --- | --- |
| `minimal.chiperf` | 8 | 无 | 最短的完整文件：一次上升沿、一次下降沿、计数、数值、一个流水级 |
| `rv32i-pipeline.chiperf` | 102 | 无 | 五级流水线：分支猜错、丢弃指令、计数器、状态机 |
| `postprocess.chiperf` | 11 | 无 | 没有任何时钟记录，时间全部由 `at=` 指定 |
| `async-events.chiperf` | 17 | 无 | `async=1`：事件不在时钟跳变的那一刻发生 |
| `faults.chiperf` | 17 | 4 类提示各 ×1；跳过 3 行 | 各类错误写法，以及解析器应该怎么应对 |
| `truncated.chiperf` | 7 | `truncated_tail`、`eof_without_end_marker` | 写到一半被中断的文件仍然可以使用 |
| `future-version.chiperf` | 2 | 未知主版本 | 遇到更高的主版本号时应当拒绝 |
| `reset.chiperf` | 4 | `rst_boundary` | 系统复位后，此前的记录全部作废 |

---

## 1. minimal.chiperf

```chiperf
chiperf 1.0
@meta design="demo" note="AGENT.md 中的示例；补上可选的版本行与 @end"

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

### 每行的位置

| 序号 | 记录 | 位置 | 结果 |
| --- | --- | --- | --- |
| 1 | `[clk] p` | `(1, p, 1)` | 第 1 个上升沿 |
| 2 | `[cnt] "Branch Miss"` | `(1, p, 2)` | 该计数变为 1（没写增量时默认为 +1） |
| 3 | `[cnt] "Cache Hit"` | `(1, p, 3)` | 该计数变为 1 |
| 4 | `[val] "PC", 0x800001d0` | `(1, p, 4)` | `PC` 从这一刻起保持 0x800001d0 |
| 5 | `[pip] "IF", 0x1234abcd` | `(1, p, 5)` | `IF` 开始持有 0x1234abcd |
| 6 | `[pip] "IF", bubble` | `(1, p, 6)` | `IF` 在同一周期又变空 |
| 7 | `[clk] n` | `(1, n, 7)` | 同一周期进入后半段 |
| 8 | `[clk] p` | `(2, p, 8)` | 进入第 2 个周期 |

### 能算出什么

- 时钟 `clock`：2 个上升沿、1 个下降沿、共 2 个周期。
- 计数：`Branch Miss` 与 `Cache Hit` 各为 1，都发生在第 1 周期的前半段。
- 数值：`PC` 从第 1 周期前半段起一直是 0x800001d0；在这之前是未知。
- 观察项 `IF`：第 5、6 行在同一周期一进一出，所以它停留了 0 个周期。按照“只算开始、不算结束”的规则，它不计入任何周期的同时占用数量。
- 提示：没有（文件以 `@end` 正常结束）。

---

## 2. rv32i-pipeline.chiperf

```chiperf
chiperf 1.0
@meta design="rv32i-demo" tool="hand-written" note="演示轨迹：覆盖 7 种记录类型，非时序精确模型"
# 指令表（tag 即 PC）：
#   A 0x80000000 addi a0,a0,1
#   B 0x80000004 lw   a1,0(a0)      <- I-cache miss
#   C 0x80000008 beq  a0,a1,+8      <- 预测错误，第 5 周期在 EX 解析，第 6 周期冲刷
#   D 0x8000000c addi a2,a2,1       <- 错误路径，被冲刷
#   E 0x80000010 addi a2,a2,1       <- 错误路径，被冲刷
#   F 0x80000100 addi a3,a3,1       <- 重定向目标
#
# 流水级（进入周期 -> 离开周期）：
#   A: if 1->2  id 2->3  ex 3->4  mem 4->5  wb 5->6
#   B: if 2->3  id 3->4  ex 4->5  mem 5->6  wb 6->7
#   C: if 3->4  id 4->5  ex 5->6  mem 6->7  wb 7->8
#   D: if 4->5  id 5->6(冲刷)
#   E: if 5->6(冲刷)
#   F: if 7->8  id 8->9  ex 9->10 mem 10->11 wb 11->12

# ---- 时钟之前：复位阶段（cycle 0, phase -）----
[msg] reset released; trace is synthetic and illustrative
[fsm] "core.ctrl", RESET
[fsm] "core.icache.ctrl", IDLE
[cnt] "core.retired", abs=0
[val] "core.if.pc", x
[val] "core.if.valid", 0

# ---- cycle 1 ----
[clk] p
[fsm] "core.ctrl", FETCH
[cnt] "core.icache.access"
[val] "core.if.pc", 32'h8000_0000
[val] "core.if.valid", 1
[pip] "core.if", 0x80000000

# ---- cycle 2 ----
[clk] p
[fsm] "core.ctrl", RUN
[fsm] "core.icache.ctrl", LOOKUP
[cnt] "core.icache.access"
[cnt] "core.icache.miss"
[val] "core.if.pc", 32'h8000_0004
[pip] "core.if", 0x80000004
[pip] "core.if", 0x80000004
[pip] "core.id", 0x80000000
[val] "core.id.instr", 32'h00150513          # addi a0,a0,1

# ---- cycle 3 ----
[clk] p
[fsm] "core.icache.ctrl", FILL
[cnt] "core.icache.access"
[val] "core.if.pc", 32'h8000_0008
[pip] "core.if", 0x80000008
[pip] "core.if", 0x80000008
[pip] "core.id", 0x80000004
[val] "core.id.instr", 32'h00052583          # lw a1,0(a0)
[pip] "core.id", 0x80000004
[pip] "core.ex", 0x80000000

# ---- cycle 4 ----
[clk] p
[fsm] "core.icache.ctrl", FILL               # 自环：填充需要两个周期
[cnt] "core.icache.access"
[val] "core.if.pc", 32'h8000_000c
[pip] "core.if", 0x8000000c
[pip] "core.if", 0x8000000c
[pip] "core.id", 0x80000008
[val] "core.id.instr", 32'h00b50463          # beq a0,a1,+8
[pip] "core.id", 0x80000008
[pip] "core.ex", 0x80000004
[pip] "core.ex", 0x80000004
[pip] "core.mem", 0x80000000

# ---- cycle 5 ----
[clk] p
[fsm] "core.icache.ctrl", IDLE
[cnt] "core.icache.access"
[val] "core.if.pc", 32'h8000_0010
[pip] "core.if", 0x80000010
[pip] "core.if", 0x80000010
[pip] "core.id", 0x8000000c
[val] "core.id.instr", 32'h00160613          # addi a2,a2,1
[pip] "core.id", 0x8000000c
[pip] "core.ex", 0x80000008
[pip] "core.ex", 0x80000008
[pip] "core.mem", 0x80000004
[pip] "core.mem", 0x80000004
[pip] "core.wb", 0x80000000

# ---- cycle 6：分支在 EX 解析出预测错误，重定向并冲刷年轻指令 ----
[clk] p
[cnt] "core.br.miss"
[evt] "core.redirect", 0x80000100
[val] "core.if.valid", 0
[pip] "core.if", bubble # E 被冲刷（if 内驻留 1 周期）
[pip] "core.id", bubble # D 被冲刷（id 内驻留 1 周期）
[pip] "core.ex", bubble
[pip] "core.mem", 0x80000008
[pip] "core.mem", 0x80000008
[pip] "core.wb", 0x80000004
[pip] "core.wb", 0x80000004
[cnt] "core.retired"

# ---- cycle 7 ----
[clk] p
[fsm] "core.ctrl", FETCH
[cnt] "core.icache.access"
[val] "core.if.pc", 32'h8000_0100
[val] "core.if.valid", 1
[pip] "core.if", 0x80000100
[pip] "core.mem", bubble
[pip] "core.wb", 0x80000008
[pip] "core.wb", 0x80000008
[cnt] "core.retired"

# ---- cycle 8 ----
[clk] p
[fsm] "core.ctrl", RUN
[val] "core.if.valid", 0
[pip] "core.if", bubble
[pip] "core.id", 0x80000100
[val] "core.id.instr", 32'h00168693          # addi a3,a3,1
[pip] "core.wb", bubble
[cnt] "core.retired"

# ---- cycle 9 ----
[clk] p
[pip] "core.id", bubble
[pip] "core.ex", 0x80000100

# ---- cycle 10 ----
[clk] p
[pip] "core.ex", bubble
[pip] "core.mem", 0x80000100

# ---- cycle 11 ----
[clk] p
[fsm] "core.ctrl", DRAIN
[pip] "core.mem", bubble
[pip] "core.wb", 0x80000100

# ---- cycle 12 ----
[clk] p
[pip] "core.wb", bubble
[cnt] "core.retired"
[fsm] "core.ctrl", DONE
@end
```

这是一份写给五级流水线的演示。处理器把一条指令拆成五步依次处理，分别是取指 `if`、译码 `id`、执行 `ex`、访存 `mem`、写回 `wb`。文件开头的注释已经说明，它只用于演示格式，并不是精确的电路模型。文件里包含 5 个流水级、2 个状态机、4 个计数器、3 个数值。

### 2.1 每条指令在各级的时间

| 指令（tag 即 PC） | if | id | ex | mem | wb | 结局 |
| --- | --- | --- | --- | --- | --- | --- |
| A `0x80000000` addi | 1→2 | 2→3 | 3→4 | 4→5 | 5→6 | 完成 |
| B `0x80000004` lw | 2→3 | 3→4 | 4→5 | 5→6 | 6→7 | 完成 |
| C `0x80000008` beq | 3→4 | 4→5 | 5→6 | 6→7 | 7→8 | 完成（第 5 周期在 ex 发现猜错） |
| D `0x8000000c` addi | 4→5 | 5→6 **X** | — | — | — | 走错路，被丢弃 |
| E `0x80000010` addi | 5→6 **X** | — | — | — | — | 走错路，被丢弃 |
| F `0x80000100` addi | 7→8 | 8→9 | 9→10 | 10→11 | 11→12 | 完成 |

“1→2”表示该条目在第 1 个周期进入这一级，到第 2 个上升沿离开。

### 2.2 每行的序号与位置

`seq` 从 1 开始，只给事件记录编号（`@meta`、`@end` 和注释都不占号）。每个周期的第一条记录的序号如下：

| 周期 | 0（时钟之前） | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 该周期首个序号 | 1 | 7 | 13 | 23 | 33 | 45 | 59 | 71 | 81 | 89 | 92 | 95 | 99 |
| 该周期记录数 | 6 | 6 | 10 | 10 | 12 | 14 | 12 | 10 | 8 | 3 | 3 | 4 | 4 |

- 时钟之前的 6 条记录位于 `(0, -, 1..6)`，依次是：一段文字说明、两个状态机的初态、`cnt abs=0`、`val if.pc = x`（未知）、`val if.valid = 0`。
- 第 6 周期把两级清空：`[pip] "core.if", bubble` 位于 `(6, p, 63)`，`[pip] "core.id", bubble` 位于 `(6, p, 64)`。前一条结束了 `core.if` 里的 `0x80000010`，后一条结束了 `core.id` 里的 `0x8000000c`。
- 文件共 102 条事件记录，最后一个位置是 `(12, p, 102)`；`clk` 记录共 12 条（12 个上升沿），没有下降沿记录（这个文件只在上升沿记录）。

### 2.3 各观察项的停留时间

| 观察项 | 条目（值: 开始 → 结束） | 停留（周期） |
| --- | --- | --- |
| `core.if` | A `c1→c2`、B `c2→c3`、C `c3→c4`、D `c4→c5`、E `c5→**c6 变空**`、F `c7→c8` | 全部 1（含被丢弃的 E） |
| `core.id` | A `c2→c3`、B `c3→c4`、C `c4→c5`、D `c5→**c6 变空**`、F `c8→c9` | 全部 1 |
| `core.ex` | A `c3→c4`、B `c4→c5`、C `c5→c6`、F `c9→c10` | 全部 1 |
| `core.mem` | A `c4→c5`、B `c5→c6`、C `c6→c7`、F `c10→c11` | 全部 1 |
| `core.wb` | A `c5→c6`、B `c6→c7`、C `c7→c8`、F `c11→c12` | 全部 1 |

- 某项的结束时间，由下一条改写它的记录决定（一条记录会一直保持到被改写，见规范 §7.4）。同一条指令在相邻两级的区间首尾相接，正好体现出指令一级一级往前走的顺序。
- 文件结束时，所有条目都已经被后面的记录改写，因此没有悬空未结束的条目。
- 第 6 周期把 `core.if` 和 `core.id` 清空：E（在 `core.if` 停留 1 个周期）和 D（在 `core.id` 停留 1 个周期）就此离开流水线。这表示分支猜错时只丢弃比分支更晚进入的指令，分支自己继续执行——C 在 `mem`、`wb` 的记录照常出现。**注意**：在 1.0 版里，被丢弃和正常离开在数据上无法区分（规范 §12.5），只能靠“它此后再没出现在任何一级”看出来。

### 2.4 每个周期同时有几条

| 观察项 | c1 | c2 | c3 | c4 | c5 | c6 | c7 | c8 | c9 | c10 | c11 | c12 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `core.if` | 1 | 1 | 1 | 1 | 1 | **0** | 1 | 0 | 0 | 0 | 0 | 0 |
| `core.id` | 0 | 1 | 1 | 1 | 1 | **0** | 0 | 1 | 0 | 0 | 0 | 0 |
| `core.ex` | 0 | 0 | 1 | 1 | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0 |
| `core.mem` | 0 | 0 | 0 | 1 | 1 | 1 | 0 | 0 | 0 | 1 | 0 | 0 |
| `core.wb` | 0 | 0 | 0 | 0 | 1 | 1 | 1 | 0 | 0 | 0 | 1 | 0 |

- 第 6 周期 `core.if` 和 `core.id` 同时处理的数量都是 0，也就是两个空档。
- B 只在第 5 周期出现在 `core.mem`，因为第 6 周期它就离开了。这里能直观看到“只算开始、不算结束”的含义。

### 2.5 计数器

| 计数器 | 记录所在位置 | 终值 |
| --- | --- | --- |
| `core.icache.access` | `(1,p)`、`(2,p)`*、`(3,p)`、`(4,p)`、`(5,p)`、`(7,p)` | 6 |
| `core.icache.miss` | `(2,p)` | 1 |
| `core.br.miss` | `(6,p)` | 1 |
| `core.retired` | `abs=0` 在 `(0,-)`；`+1` 在 `(6,p)`、`(7,p)`、`(8,p)`、`(12,p)` | 4 |

\* 同一周期里可能有多条记录，这里只列出一条代表，靠序号区分。

- 取指被丢弃（第 4 周期的 D、第 5 周期的 E）仍然计入 `core.icache.access`：统计点设在取指发出的位置，这是有意的——访问次数不应该因为分支猜错而凭空消失。
- `core.retired` 只在内容离开 `core.wb`（该级被改写成别的值或 `bubble`）时加一次：A、B、C、F 共 4 次，与 2.1 的“完成”一列一致。

### 2.6 状态机

| 状态机 | 记录 | 跳转 | 连续两次同一状态 |
| --- | --- | --- | --- |
| `core.ctrl` | `RESET(c0)`、`FETCH(c1)`、`RUN(c2)`、`FETCH(c7)`、`RUN(c8)`、`DRAIN(c11)`、`DONE(c12)` | `RESET→FETCH`、`FETCH→RUN`、`RUN→FETCH`、`FETCH→RUN`、`RUN→DRAIN`、`DRAIN→DONE` 共 6 次 | 0 |
| `core.icache.ctrl` | `IDLE(c0)`、`LOOKUP(c2)`、`FILL(c3)`、`FILL(c4)`、`IDLE(c5)` | `IDLE→LOOKUP`、`LOOKUP→FILL`、`FILL→FILL`、`FILL→IDLE` 共 4 次 | 1 |

- `FILL→FILL` 是连续两次报告同一个状态：`core.icache.ctrl` 在第 3、4 两个周期都是 `FILL`（填充需要两个周期）。保持型语义下"状态未变但被再次上报"是正常写法，只记成一次自环，**不产生诊断**。
- 第 7、8 周期 `core.ctrl` 回到 `FETCH`、`RUN`：重新开始取指。

### 2.7 数值

| 数值 | 采样 | 说明 |
| --- | --- | --- |
| `core.if.pc` | `x(c0)`、`0x8000_0000(c1)`、`…004(c2)`、`…008(c3)`、`…00c(c4)`、`…010(c5)`、`0x8000_0100(c7)` | 数值会一直保持到下一次采样；第 6 周期没有采样，所以显示上一个值 `…010` |
| `core.if.valid` | `0(c0)`、`1(c1)`、`0(c6)`、`1(c7)`、`0(c8)` | 只写变化点；`1` 表示该周期有取指；第 6、8 周期之后的 `0` 就是空档 |
| `core.id.instr` | `32'h00150513(c2)`、`00052583(c3)`、`00b50463(c4)`、`00160613(c5)`、`00168693(c8)` | 5 次译码采样，取值是 32 位、允许出现未知位的量 |

`core.id.instr` 演示了“宽位数值 + 注释给反汇编”的推荐写法：解析器拿到的是机器友好的 `32'h…`，人偶尔打开文件时可以靠行尾注释理解。

### 2.8 提示汇总

| 提示 | 次数 | 说明 |
| --- | --- | --- |
| 全部提示 | 0 | 自环（`FILL→FILL`）是保持型语义下的正常写法，不计异常；也没有悬空未结束的条目、重复属性或非法记录 |

---

## 3. postprocess.chiperf

```chiperf
chiperf 1.0
@meta tool="chiperf-postproc" note="后处理工具输出的轨迹：没有 clk 记录，时间轴完全由 at= 给出"
# 位置全部显式：cycle + 可选相位字母（缺省 p）。
# 解析器不得因缺少 clk 记录而拒绝该文件，也不得让 at= 影响时钟状态。

[val] "PC", 32'h8000_0000, at=1p
[cnt] "Retired", at=1p
[pip] "IF", 0x80000000, at=1p

[val] "PC", 32'h8000_0004, at=2p
[pip] "IF", bubble, at=2p
[pip] "ID", 0x80000000, at=2

[val] "PC", 32'h8000_0008, at=3p
[pip] "ID", bubble, at=3p
[cnt] "Retired", at=3p

# 同一条记录也可以指定相位 n
[val] "PC", 32'h8000_000c, at=3n
[cnt] "stall", at=7p
@end
```

文件里没有一条 `clk` 记录，时间轴完全由 `at=` 给出。其他工具把数据转换成 Chiperf 时，可以采用这种写法。

| 序号 | 记录 | 位置 |
| --- | --- | --- |
| 1 | `[val] "PC", 32'h8000_0000, at=1p` | `(1, p, 1)` |
| 2 | `[cnt] "Retired", at=1p` | `(1, p, 2)` |
| 3 | `[pip] "IF", 0x80000000, at=1p` | `(1, p, 3)` |
| 4 | `[val] "PC", 32'h8000_0004, at=2p` | `(2, p, 4)` |
| 5 | `[pip] "IF", bubble, at=2p` | `(2, p, 5)`，该条目停留 `2-1 = 1` 个周期 |
| 6 | `[pip] "ID", 0x80000000, at=2` | `(2, p, 6)`（没写相位字母时默认为 `p`） |
| 7 | `[val] "PC", 32'h8000_0008, at=3p` | `(3, p, 7)` |
| 8 | `[pip] "ID", bubble, at=3p` | `(3, p, 8)`，该条目停留 1 个周期 |
| 9 | `[cnt] "Retired", at=3p` | `(3, p, 9)` |
| 10 | `[val] "PC", 32'h8000_000c, at=3n` | `(3, n, 10)` |
| 11 | `[cnt] "stall", at=7p` | `(7, p, 11)` |

- 整条轨迹没有任何 `clk` 记录，时钟的周期数和相位保持初始值（`0` 和空）。这不影响每条记录各自的位置，也不会产生任何提示。
- `at=` 不会推进时钟：即便出现了 `at=7p`，`mem` 的周期计数仍然是 0。
- 计数器：`Retired = 2`、`(mem, "stall") = 1`；观察项 `IF`、`ID` 各 1 个条目，都停留 1 个周期，且都已结束。
- 没有提示。

---

## 4. async-events.chiperf

```chiperf
chiperf 1.0
@meta design="async demo" note="async=1：事件不是时钟沿采样得到的，可视化落在两个时钟沿之间"

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
[pip] "core.l2", bubble, async=1       # 响应到达也是异步的（延迟仍按周期算：2-1 = 1）
[msg] irq serviced

# ---- cycle 3 ----
[clk] p
[cnt] "core.instr"
@end
```

`async=1` 表示这个事件不是在时钟跳变的那一刻发生的，因此显示时把它画在两个时钟跳变之间；但它的位置和能算出的结果完全不变（规范 §6.7）。

### 每行的位置（共 17 条记录）

| 序号 | 记录 | 位置 | 是否沿对齐 |
| --- | --- | --- | --- |
| 1 | `[clk] p` | `(core, 1, p, 1)` | —— |
| 2 | `[val] "core.pc", 32'h8000_0000` | `(core, 1, p, 2)` | 是 |
| 3 | `[cnt] "core.instr"` | `(core, 1, p, 3)` | 是，`total = 1` |
| 4 | `[pip] "core.l2", 0x4000` | `(core, 1, p, 4)` | 是 |
| 5 | `[clk] n` | `(core, 1, n, 5)` | 后半段开始 |
| 6 | `[val] "core.irq.level", 0` | `(core, 1, n, 6)` | 是 |
| 7 | `[cnt] "core.instr", async=1` | `(core, 1, n, 7)` | **否**，`total = 2` |
| 8 | `[evt] "irq.assert", 5, async=1` | `(core, 1, n, 8)` | **否** |
| 9 | `[clk] p` | `(core, 2, p, 9)` | —— |
| 10 | `[fsm] "core.ctrl", TRAP` | `(core, 2, p, 10)` | 是 |
| 11 | `[cnt] "core.instr"` | `(core, 2, p, 11)` | 是，`total = 3` |
| 12 | `[clk] n` | `(core, 2, n, 12)` | —— |
| 13 | `[val] "core.pc", 32'h8000_0100, async=1` | `(core, 2, n, 13)` | **否** |
| 14 | `[pip] "core.l2", bubble, async=1` | `(core, 2, n, 14)` | **否**，异步地把这一级清空 |
| 15 | `[msg] irq serviced` | `(core, 2, n, 15)` | —— |
| 16 | `[clk] p` | `(core, 3, p, 16)` | —— |
| 17 | `[cnt] "core.instr"` | `(core, 3, p, 17)` | 是，`total = 4` |

### 能算出什么（规则与沿对齐的记录相同）

- **共 3 个周期、2 个下降沿**。周期数只由 `[clk] p` 推进，`async` 不影响它。
- 计数器 `core.instr = 4`，其中第 7 条来自异步采样——异步事件同样计入它所在周期的增量。
- 观察项 `core.l2`：开始 = `(core,1,p,4)`，结束 = `(core,2,n,14)`，停留 `2 − 1 = 1` 个周期；第 1 周期同时处理 1 条，第 2 周期为 0。结束是异步的，停留时间仍然是确定的周期差——这就是“`async` 只改变显示、不改变含义”。
- 数值 `core.pc`：`(1,p)` 采样 `0x8000_0000`，`(2,n)` 异步采样 `0x8000_0100`；`state_at(core.pc, 2) = 0x8000_0100`。
- 提示：**没有**（没有把 `async` 用在 `clk` 上）。

### 显示上的要求

- 第 7、8、13、14 条 **必须** 画在各自区间的**内部**（`(1,n)`、`(2,n)` 两个后半段），**不得** 吸附到 `[clk] n` 的刻度上；样式应当与沿对齐的事件区分开（例如空心标记或虚线）。
- `(1,n)` 区间里，第 6 条是沿对齐、第 7/8 条是异步：同一个区间既可以画在刻度上，也可以画在中间，区间内仍按序号排序。
- 反过来，如果把第 7 条错当成沿对齐，读者会以为第 2 次取指发生在下降沿的那一刻——这正是要求标注 `async` 的原因。

---

## 5. faults.chiperf

```chiperf
chiperf 1.0
@meta design="robustness fixture" note="故意注入未知类型/未知指令/未知属性/非法记录/语义异常"
# 期望的解析结果见 docs/examples.md（每个注入点标注了期望诊断）

@unknown_directive foo=1                     # skipped_unknown_directive
[clk] p
[cnt] "Retired"
[cnt] "Retired"
[stall] "if"                                 # skipped_unknown_kind
[cnt] "Retired", x                           # skipped_invalid_record（增量不是 int）
[val] "PC", 0x80000000
[val] "PC", 32'hDEAD_BEEF, x-vendor-tag=7    # 未知属性被忽略，记录仍有效
[pip] "IF", bubble # orphan_exit（无在飞条目）
[clk] p
[clk] p                                      # 合法：只插桩上升沿
[clk] n
[clk] n                                      # redundant_edge
[cnt] "Retired", -10                         # negative_total
[fsm] "ctrl", IDLE
[fsm] "ctrl", IDLE                           # 自环：正常写法，不是异常
[val] "PC", 4'b10xz                          # 4 态值：未知位/高阻位
[msg] tail text with, commas and # a hash are literal
[cnt] "Retired"                              # 正常累加
[clk] p, async=1                             # async_on_clk（时钟沿本身不可能异步：属性被忽略，沿仍然生效）
@end
```

这个文件故意写错一些地方。逐行的预期结果如下：

| 行 | 内容 | 预期行为 |
| --- | --- | --- |
| `@unknown_directive foo=1` | 未知指令 | 忽略，`skipped_unknown_directive` +1 |
| `[clk] p` | 正常 | 第 1 周期，序号 1 |
| `[cnt] "Retired"` ×2 | 正常 | `total = 2` |
| `[stall] "if"` | 未知类型 | 整行跳过，`skipped_unknown_kind` +1 |
| `[cnt] "Retired", x` | 增量不是整数 | 整行跳过，`skipped_invalid_record` +1 |
| `[val] "PC", 0x80000000` | 正常 | 序号 4 |
| `[val] "PC", 32'hDEAD_BEEF, x-vendor-tag=7` | 未知属性 | 属性被忽略，**这一行仍然有效**，序号 5 |
| `[pip] "IF", bubble` | 该级本来就是空的 | 记录仍然有效（序号 6）：只是把“空”又说了一遍，**不产生任何提示**（1.0 版没有“凭空出队”这回事，规范 §7.4） |
| `[clk] p` ×2 | 只有上升沿 | 第 2、3 周期 |
| `[clk] n` / `[clk] n` | 重复的下降沿 | 第 2 条产生 `redundant_edge` +1 |
| `[cnt] "Retired", -10` | 累计变成负数 | `total = 2-10 = -8`，`negative_total` +1 |
| `[fsm] "ctrl", IDLE` ×2 | 连续两次同一状态 | 正常：记成一次自环，**不产生提示**（自环不是异常，规范 §9.5） |
| `[val] "PC", 4'b10xz` | 含未知位和高阻位的值 | 正常，值里第 1 位未知、第 0 位高阻 |
| `[msg] tail text with, commas and # a hash are literal` | 自由文本 | 整段都是文本（包括 `,` 和 `#`），序号 15 |
| `[cnt] "Retired"` | 正常 | 记录有效（序号 16），`total` 再 +1 |
| `[clk] p, async=1` | 把 `async` 用在时钟上 | 记录有效且**沿仍然生效**（第 4 周期，序号 17），属性被忽略，产生 `async_on_clk` +1 |
| `@end` | 正常结束 | 不产生 `eof_without_end_marker` |

统计：**17 条有效事件记录**；跳过 3 行（未知类型 1、非法记录 1、未知指令 1）；提示 3 次（`redundant_edge`、`negative_total`、`async_on_clk` 各 1）。

几个要点：

- `x-vendor-tag=7` 与 `[stall]` 这两行说明了两种不同的容错方式——**未知属性会被忽略，但这一行继续使用**；**未知类型则整行跳过**。前者不丢数据，后者无法解释含义。
- 本文件的边沿顺序是 `p, p, n, n, p`，故意混合了“只写 p”和“写 p/n”两种写法来触发 `redundant_edge`，因此它同时也是写入者指南 W10 的反例：容错用例本来就要覆盖不合规的输入。

## 6. truncated.chiperf

```chiperf
chiperf 1.0
@meta design="truncation fixture" note="模拟仿真崩溃：末尾记录只写了一半，且没有 @end"
[clk] p
[cnt] "Retired"
[pip] "IF", 0x80000000
[pip] "IF", bubble
[pip] "ID", 0x80000000
[val] "PC", 0x80000000
[clk] p
[cnt] "Retire
```

这个文件模拟写入程序在被中断：文件**没有**以换行结束，最后一行是半条记录 `[cnt] "Retire`。

| 序号 | 记录 | 位置 | 结果 |
| --- | --- | --- | --- |
| 1 | `[clk] p` | `(1, p, 1)` | 第 1 周期 |
| 2 | `[cnt] "Retired"` | `(1, p, 2)` | `total = 1` |
| 3 | `[pip] "IF", 0x80000000` | `(1, p, 3)` | `IF` 开始持有它 |
| 4 | `[pip] "IF", bubble` | `(1, p, 4)` | 停留 0 周期 |
| 5 | `[pip] "ID", 0x80000000` | `(1, p, 5)` | `ID` 开始持有它，**之后没有任何记录改写它** |
| 6 | `[val] "PC", 0x80000000` | `(1, p, 6)` | `PC` 保持 |
| 7 | `[clk] p` | `(2, p, 7)` | 第 2 周期 |
| — | `[cnt] "Retire` | 丢弃 | `truncated_tail` 保留原文 |

- **7 条有效事件记录**；残行**不得**被解析（否则会得到一条名为 `Retire` 的假计数）。
- 观察项 `ID` 还留着 1 个没有结束的条目（开始 = `(1,p,5)`，值 `0x80000000`），显示时应当画成开放的区间，而不是伪造一个结束位置。
- 没有 `@end`，因此产生 `eof_without_end_marker`。
- 这正是规范 §10.1 所说的“前缀封闭”的具体例子：无论在哪一行边界被切断，剩下的部分都是一个可以正常解析、含义完整的 Chiperf 文件。

## 7. future-version.chiperf

```chiperf
chiperf 2.0
@meta note="未知主版本：默认模式必须拒绝；显式忽略版本模式可尽力解析"
[clk] p
[cnt] "Retired"
@end
```

第一行是 `chiperf 2.0`，比当前主版本更高。默认情况下解析器**必须**拒绝这个文件；只有在明确开启“忽略版本”模式时才尽力解析。文件里这 2 条事件记录本身是合法的，因此这个用例可以区分“因版本拒绝”和“因语法错误拒绝”两种失败。

## 8. reset.chiperf —— 系统复位

```chiperf
chiperf 1.0
@meta design="rst-demo", tool="handwritten", note="演示 [rst]：复位前的记录整批作废"

# ---- 复位之前：这些记录都不会进入可视化 ----
[clk] p
[cnt] "retired"
[val] "core.pc", 0x1000
[pip] "core.if", 0x1000
[clk] n
[clk] p
[cnt] "retired"
[clk] n

[rst]                                   # 系统复位：此前全部事件记录作废

# ---- 复位之后：窗口从这里开始 ----
[clk] p
[cnt] "retired"                         # 累计从这里重新开始（= 1，不是 3）
[val] "core.pc", 0x8000
[clk] n
@end
```

逐条说明：

| 项 | 结果 |
| --- | --- |
| 记录条数 | 复位前 8 条被丢弃；`stats.records = 4`（复位后的 `p`/`cnt`/`val`/`n`） |
| 复位标记 | `resets = [{ line: 15, droppedRecords: 8 }]`；`rst` 自身不是记录，不占序号、不占位置 |
| 计数器 `retired` | 终值 **1**（复位前那次增量已随记录作废） |
| 数值 `core.pc` | 只剩复位后的 0x8000 一次采样；复位前是未知，而不是 0x1000 |
| 观察项 `core.if` | **不存在**：它唯一那条记录在复位前，随复位一起消失 |
| 时钟状态 | 时钟的周期号**不重编**，继续往下排；边沿数和记录范围按新窗口重新计算 |
| 周期号 | 不重新编号：复位后的记录接着原来的周期号（本例是第 3 个周期），时钟不会“回到 0” |
| 提示 | 一条 `rst_boundary`（信息性）；复位前的提示和跳过行一并作废 |

复位时正在处理的条目会被销毁：复位之前 `[pip] "core.if", 0x1000` 的状态随记录一起作废，复位后该级处于“未开始”状态，直到下一条 `[pip]` 把它设成某个值或 `bubble`（规范 §7.4 / §7.8）。复位后写 `[pip] "core.if", bubble` 也完全正常——那只是“该级变空”，不产生提示。
