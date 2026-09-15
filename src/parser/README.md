# @chiperf/parser

chiperf 1.0 的 TypeScript 实现（Bun 工具链）。规范见 [`../../docs/spec.md`](../../docs/spec.md)。

## 用法

```ts
import { parseChiperf, parseChiperfBytes, ChiperfParser } from '@chiperf/parser';

// 纯文本
const trace = parseChiperf(source);

// 字节流（自动按魔数识别 .chiperf.gz，含多成员与截断恢复）
const trace2 = await parseChiperfBytes(new Uint8Array(await file.arrayBuffer()));

// 流式（内存只与"在飞条目数 + 追踪对象数"相关，不驻留记录）
const parser = new ChiperfParser({ collectRecords: false });
for await (const chunk of stream) parser.feed(decoder.decode(chunk, { stream: true }));
const trace3 = parser.finish();
```

`parseChiperf` 在遇到未知主版本时抛 `UnsupportedVersionError`（spec §5.4）；传 `{ ignoreVersion: true }` 可尽力解析。

## 实现范围（对照 spec）

| 规范条款 | 实现 |
| --- | --- |
| §3 容器与编码 | UTF-8；LF/CRLF；`.chiperf.gz` 用**自带 inflate**（见下） |
| §4 词法 | 字符串 → 数值 → 裸词；四种进制 + Verilog 字面量 + 4 态 + 缩放量；`x`/`z` 裸词规则 |
| §5 语法 | 完整 EBNF；两条上下文规则（`at=` 的值、`msg` 的载荷） |
| §6 时间模型 | 每域 `(cycle, phase)`；`at=` 单条覆盖；跨域锚定；clk-free 模式 |
| §7 事件 | 7 种记录 + `dom=`/`at=`/`async=`/`note=` 属性 + 未知属性忽略 |
| §8 指令 | `@meta` / `@domain` / `@end`；未知指令忽略 |
| §9 派生量 | 计数器、数值、状态机、在飞条目、占用度、气泡、延迟、`latency_time`、区间差 |
| §10 鲁棒性 | 前缀封闭；未知/非法/语义异常三档处理；全部 14+ 诊断码 |
| §13 一致性 | 写入者/解析器清单（核心层 MUST、派生层 SHOULD） |

### 相对规范的补充（规范要求但未命名，或实现细节）

| 名字 | 来源 | 说明 |
| --- | --- | --- |
| `invalid_escape` | §4.2 "应当…并产生诊断" | 字符串里的未知转义（`\q`）按字面字面容错 + 该诊断 |
| `gzip_truncated` / `gzip_checksum_mismatch` / `gzip_bad_format` | §10.6 | 压缩容器层的三种失败；前两者保留已解出的数据 |
| `truncated_tail` / `skipped_*` | §10.1 / §10.2 / §10.3 | 与 §10.4 的"语义异常"分开计数（前者影响数据完整性，后者影响可信度） |

### 为什么自带 inflate（`src/inflate.ts`）

`DecompressionStream('gzip')` 在流被截断时**丢弃全部已解出的数据**，且错误信息只有 `inflate failed`，
无法区分"截断"与"校验和不符"—— 这直接违反 spec §10.6。自带实现可以：

- 边解压边把数据喂给解析器（内存只保留 32KB 回溯窗口）；
- 截断时保留截断点之前的**全部完整记录**；
- 分别上报 `gzip_truncated` / `gzip_checksum_mismatch`，并在校验失败时仍然交付完整数据；
- 正确处理多成员 gzip（§3.1），且不依赖任何运行时 API。

## 结构

| 文件 | 职责 |
| --- | --- |
| `src/types.ts` | 公开数据类型（前端只依赖这里） |
| `src/value.ts` | 值扫描与类型化（§4.3–§4.5） |
| `src/lexer.ts` | 注释剥除、字段切分、`at=` 值规则（§4.1 / §5.1） |
| `src/parse.ts` | 记录分派、校验、位置推导、诊断（§5–§7 / §10） |
| `src/derive.ts` | 在飞条目、占用度、气泡、延迟、状态机、计数器（§9） |
| `src/selectors.ts` | 只读查询（`stateAt` / `occupancyAt` / `latencyStats` …） |
| `src/inflate.ts` | DEFLATE/gzip 解码（§3.1 / §10.6） |
| `src/gzip.ts` | `.chiperf.gz` 容器层 |

## 测试

```bash
bun test        # 99 个用例，含：
bunx tsc --noEmit
```

- **一致性**：`test/spec-conformance.test.ts` 断言 `docs/examples.md` 里公开的每一项数字（事件数、诊断、每周期 seq、60 格占用度、延迟、计数器、状态机跳转、异步标记）。
- **前缀封闭性**：对 7 个语料的**每一个行边界前缀**都做一次完整解析，并核对位置与完整解析一致。
- **流式等价**：逐字符喂入与一次性解析结果完全一致。
- **容器恢复**：单成员/多成员 gzip、截断恢复、CRC 损坏仍交付数据。
