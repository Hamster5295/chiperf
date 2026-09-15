/**
 * `eventCounters`：把 `[evt]` 轨折算成"每条 +1 的计数器"。
 *
 * 这里关心的是几条**契约**：折算结果与原计数器同构、键不与同名 `[cnt]` 撞车、
 * async 标记原样带过来、累计值按文件顺序推进（与 `applyCounter` 同一口径）。
 */
import { describe, expect, test } from 'bun:test';
import { bubbleStats, equalRuns, eventCounters, itemsWithin, latencyStats, parseChiperf, scanValue } from '../src/index.ts';

const SOURCE = `chiperf 1.0
@domain default, period=1.0ns
[clk] p
[evt] "retire", 0x1
[cnt] "retire"
[clk] n
[clk] p
[evt] "retire", 0x2
[evt] "retire", 0x3
[evt] "miss", 64, async=1
[clk] n
[clk] p
[evt] "retire", 0x4
[clk] n
`;

const trace = parseChiperf(SOURCE);
const byName = (name: string) => eventCounters(trace).find((t) => t.name === name)!;

describe('eventCounters', () => {
  test('每条事件 +1，终值 = 事件条数', () => {
    expect(byName('retire').total).toBe(4);
    expect(byName('miss').total).toBe(1);
    expect(byName('retire').samples.map((s) => [s.delta, s.abs, s.total])).toEqual([
      [1, null, 1],
      [1, null, 2],
      [1, null, 3],
      [1, null, 4],
    ]);
  });

  test('每周期增量按周期累加（同周期多条会叠加），累计值取该周期末', () => {
    const retire = byName('retire');
    expect([...retire.deltaByCycle]).toEqual([
      [1, 1],
      [2, 2],
      [3, 1],
    ]);
    expect([...retire.totalByCycle]).toEqual([
      [1, 1],
      [2, 3],
      [3, 4],
    ]);
    expect(retire.changeCycles).toEqual([1, 2, 2, 3]);
  });

  test('async 标记原样带过来（异步事件不在时钟沿上）', () => {
    expect(byName('miss').samples[0]!.async).toBe(true);
    expect(byName('retire').samples.every((s) => !s.async)).toBe(true);
  });

  test('行号指向产生该采样的那条记录', () => {
    const line = byName('retire').samples[0]!.line;
    expect(SOURCE.split('\n')[line - 1]).toContain('[evt] "retire", 0x1');
  });

  test('同名 [cnt] 与 [evt] 是两条轨，键不撞车', () => {
    const keys = eventCounters(trace).map((t) => t.key);
    expect(keys).toContain('default\u0000evt:retire');
    expect(keys).not.toContain('default\u0000retire');
    expect(trace.counters.get('default\u0000retire')!.source).toBe('cnt');
    expect(byName('retire').source).toBe('evt');
  });

  test('没有 evt 记录时返回空列表', () => {
    expect(eventCounters(parseChiperf('chiperf 1.0\n[cnt] "x"\n'))).toEqual([]);
  });
});

describe('equalRuns', () => {
  const point = (src: string) => ({ value: scanValue(src)!.value });

  test('连续同值合并成一段，起止都是下标（含端点）', () => {
    expect(equalRuns(['1', '1', '1', '2', '2', '1'].map(point))).toEqual([
      { from: 0, to: 2 },
      { from: 3, to: 4 },
      { from: 5, to: 5 },
    ]);
  });

  // 就是报上来的那个现象：两个一样的值画成两个六边形，中间多一条缝
  test('两个连续的同值只算一段', () => {
    expect(equalRuns(['8\'h2a', "8'h2a"].map(point))).toEqual([{ from: 0, to: 1 }]);
  });

  // 判据是 valueKey（`i:` 整数 / `b:宽度:正文` 位向量 …），与算不算"变化"用的是同一套口径：
  // 同一条轨上的采样本来也不会中途换类型，这里只是把边界钉住
  test('同值判据是 valueKey：位宽 / 进制 / 十进制与位向量都不算同值', () => {
    expect(equalRuns(["8'h2a", "32'h2a"].map(point))).toHaveLength(2); // 位宽不同
    expect(equalRuns(["8'h2a", "8'h2A"].map(point))).toHaveLength(1); // 十六进制大小写归一化
    expect(equalRuns(["4'b1x", "4'b1z"].map(point))).toHaveLength(2); // 未知位 vs 高阻位
    expect(equalRuns(["32'h1", '1'].map(point))).toHaveLength(2); // 位向量 vs 十进制整数
  });

  test('空列表与单点', () => {
    expect(equalRuns([])).toEqual([]);
    expect(equalRuns(['7'].map(point))).toEqual([{ from: 0, to: 0 }]);
  });
});

/**
 * 区间统计：波形上打两个标记之后，流水线/状态机只统计两标记之间的数据。
 *
 * 用手算的轨迹钉住口径：条目按"与区间**相交**"算，气泡段按"落在区间里的**那部分**"算长。
 * 周期编排：c1 起持有 → c3 变空 → c5 起持有 → c7 变空，域记录到 c9。
 */
const RANGE_SOURCE = `chiperf 1.0
@domain default, period=1.0ns
[clk] p
[pip] "t", 1
[clk] n
[clk] p
[clk] n
[clk] p
[pip] "t", bubble
[clk] n
[clk] p
[clk] n
[clk] p
[pip] "t", 2
[clk] n
[clk] p
[clk] n
[clk] p
[pip] "t", bubble
[clk] n
[clk] p
[clk] n
@end
`;

const rangeTrack = parseChiperf(RANGE_SOURCE).tracks.get('t')!; // 默认域的追踪键省略域前缀

describe('区间统计（标记）', () => {
  test('两个条目的驻留都是 2 周期；区间只留下与它相交的那个', () => {
    expect(latencyStats(rangeTrack).count).toBe(2);
    expect(latencyStats(rangeTrack).max).toBe(2);
    // c4–c6：第一条目在 c3 就结束了，第二条目 c5 起 —— 只剩它
    expect(latencyStats(rangeTrack, { from: 4, to: 6 })).toMatchObject({ count: 1, min: 2, max: 2 });
    // 覆盖全区间 ⇒ 与不筛完全一样
    expect(latencyStats(rangeTrack, { from: 1, to: 9 })).toEqual(latencyStats(rangeTrack));
  });

  test('itemsWithin 按“在区间里在飞过”筛，跨界的那条也算', () => {
    expect(itemsWithin(rangeTrack, 1, 9)).toHaveLength(2);
    expect(itemsWithin(rangeTrack, 1, 3)).toHaveLength(1); // 第一条目在 c3 结束，相交
    expect(itemsWithin(rangeTrack, 4, 4)).toHaveLength(0); // c4 什么都没有
    expect(itemsWithin(rangeTrack, 6, 8)).toHaveLength(1); // 第二条目 c5–c7，被 c6 切到
  });

  test('气泡段长按“落在区间里的那部分”算，不因跨界整段丢弃', () => {
    // 全量：气泡 [3,4] 长 2、[7,7] 长 1
    expect(bubbleStats(rangeTrack)).toMatchObject({ count: 2, max: 2, min: 1 });
    // c4–c7：两段各被削成 1 个周期
    expect(bubbleStats(rangeTrack, { from: 4, to: 7 })).toMatchObject({ count: 2, min: 1, max: 1 });
    // c5–c6：正落在"有内容"的中段，区间里没有气泡
    expect(bubbleStats(rangeTrack, { from: 5, to: 6 }).count).toBe(0);
  });

  test('退化区间（from === to）不产生 NaN', () => {
    const single = latencyStats(rangeTrack, { from: 6, to: 6 });
    expect(Number.isFinite(single.count)).toBe(true);
    expect(bubbleStats(rangeTrack, { from: 6, to: 6 }).count).toBe(0);
  });
});
