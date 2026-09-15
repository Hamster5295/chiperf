/**
 * `eventCounters`：把 `[evt]` 轨折算成"每条 +1 的计数器"。
 *
 * 这里关心的是几条**契约**：折算结果与原计数器同构、键不与同名 `[cnt]` 撞车、
 * async 标记原样带过来、累计值按文件顺序推进（与 `applyCounter` 同一口径）。
 */
import { describe, expect, test } from 'bun:test';
import { eventCounters, parseChiperf } from '../src/index.ts';

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
