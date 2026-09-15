/**
 * 诊断与边界语义测试（spec §9.4 跨域锚定 / §10.4 语义异常 / §10.5 未闭合）
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { parseChiperf, occupancyAt, timeNs } from '../src/index.ts';

const EXAMPLES = join(import.meta.dir, '../../../docs/examples');
const countOf = (text: string, code: string, opts = {}) => parseChiperf(text, opts).diagnosticCounts.get(code) ?? 0;

describe('§9.4 跨域条目的占用度锚定在 enter 域', () => {
  test('multiclk：core.l2 的关闭发生在 mem 域，占用度按 core 域当时的周期锚定', async () => {
    const trace = parseChiperf(await Bun.file(join(EXAMPLES, 'multiclk.chiperf')).text());
    const item = trace.tracks.get('core.l2')!.items[0]!;
    expect(item.crossDomain).toBe(true);
    // 出队记录被解析时，core 域已经推进到周期 1（core 周期 2 的那条 clk 还没出现）
    expect(item.closeAnchorCycle).toBe(1);
    // 半开区间 [1,1) ⇒ 不占任何周期
    expect(occupancyAt(trace.tracks.get('core.l2')!, 1)).toBe(0);
    expect(occupancyAt(trace.tracks.get('core.l2')!, 2)).toBe(0);
  });

  test('同域条目的锚定就是出队周期本身', () => {
    const trace = parseChiperf('[clk] p\n[pip] "t", I, 1\n[clk] p\n[clk] p\n[pip] "t", O, 1\n@end\n');
    const item = trace.tracks.get('t')!.items[0]!;
    expect(item.closeAnchorCycle).toBe(3);
    expect(item.latencyCycles).toBe(2);
    expect(occupancyAt(trace.tracks.get('t')!, 1)).toBe(1);
    expect(occupancyAt(trace.tracks.get('t')!, 2)).toBe(1);
    expect(occupancyAt(trace.tracks.get('t')!, 3)).toBe(0);
  });
});

describe('§10.5 未闭合条目', () => {
  test('未闭合条目占用到该轨道的最后周期，且不伪造退出', () => {
    const trace = parseChiperf('[clk] p\n[pip] "t", I, 1\n[clk] p\n[cnt] "x"\n@end\n');
    const track = trace.tracks.get('t')!;
    expect(track.open).toBe(1);
    expect(track.items[0]!.closed).toBeNull();
    expect(track.lastCycle).toBe(1);
    // exit 缺失 ⇒ 按 §9.4 的公式从 enter 起一直算在飞，所以第 1 周期被占用（不是气泡）
    expect(occupancyAt(track, 1)).toBe(1);
    expect(track.bubbles).toEqual([]);
  });
});

describe('§10.4 语义异常', () => {
  test('duplicate_tag：同标记条目同时在飞', () => {
    const text = '[clk] p\n[pip] "t", I, 7\n[pip] "t", I, 7\n[pip] "t", O, 7\n@end\n';
    const trace = parseChiperf(text);
    expect(trace.diagnosticCounts.get('duplicate_tag')).toBe(1);
    // 匹配取最早的一条
    expect(trace.tracks.get('t')!.items[0]!.closed).toBe('O');
    expect(trace.tracks.get('t')!.items[1]!.closed).toBeNull();
  });

  test('name_reused：同一 (域,名字) 被不同类型使用', () => {
    const trace = parseChiperf('[clk] p\n[cnt] "x"\n[val] "x", 1\n[@]\n'.replace('[@]', '[evt] "x"') + '@end\n');
    expect(trace.diagnosticCounts.get('name_reused')).toBe(2); // cnt→val、val→evt
    expect(trace.counters.size).toBe(1);
    expect(trace.values.size).toBe(1);
    expect(trace.events.size).toBe(1);
  });

  test('at_clk_conflict：同域既写 clk 又用 at=', () => {
    expect(countOf('[clk] p\n[val] "a", 1, at=5\n@end\n', 'at_clk_conflict')).toBe(1);
    expect(countOf('[val] "a", 1, at=5\n[val] "b", 2, at=6\n@end\n', 'at_clk_conflict')).toBe(0);
  });

  test('undeclared_domain：只在存在 @domain 声明时报告，且 default 豁免', () => {
    expect(countOf('@domain core\n[cnt] "a", dom=cor\n@end\n', 'undeclared_domain')).toBe(1);
    expect(countOf('@domain core\n[cnt] "a", dom=core\n[cnt] "b"\n@end\n', 'undeclared_domain')).toBe(0);
    expect(countOf('[cnt] "a", dom=cor\n@end\n', 'undeclared_domain')).toBe(0);
  });

  test('duplicate_domain / duplicate_attribute / records_after_end / redundant_edge', () => {
    expect(countOf('@domain a\n@domain a\n@end\n', 'duplicate_domain')).toBe(1);
    expect(countOf('[clk] p\n[val] "x", 1, note=a, note=b\n@end\n', 'duplicate_attribute')).toBe(1);
    expect(countOf('[clk] p\n@end\n[cnt] "x"\n', 'records_after_end')).toBe(1);
    expect(countOf('[clk] n\n[clk] n\n@end\n', 'redundant_edge')).toBe(1);
  });

  test('诊断不改变数据：语义异常时记录与派生量都保留', () => {
    const trace = parseChiperf('[clk] p\n[cnt] "c", -5\n[fsm] "f", A\n[fsm] "f", A\n@end\n');
    expect(trace.counters.get('default\u0000c')!.total).toBe(-5);
    expect(trace.fsms.get('default\u0000f')!.transitions.length).toBe(2);
    expect(trace.diagnostics.length).toBeGreaterThanOrEqual(2);
  });
});

describe('§6.7 异步事件不影响位置与派生量', () => {
  test('async 记录的位置与沿对齐记录同一套规则，计数照常累加', () => {
    const trace = parseChiperf('[clk] p\n[cnt] "c", async=1\n[pip] "t", I, 1, async=1\n[clk] n\n[pip] "t", O, 1, async=1\n@end\n');
    const records = trace.records.filter((r) => r.kind === 'cnt' || r.kind === 'pip');
    expect(records.every((r) => r.async)).toBe(true);
    expect(trace.counters.get('default\u0000c')!.total).toBe(1);
    const item = trace.tracks.get('t')!.items[0]!;
    expect(item.enter.cycle).toBe(1);
    expect(item.closeAsync).toBe(true);
    expect(item.latencyCycles).toBe(0); // 同周期进出（相位 p→n 仍属同一周期）⇒ 0 周期
  });

  test('clk 上的 async=1 被忽略并上报（沿照常生效）', () => {
    const trace = parseChiperf('[clk] p, async=1\n[clk] p\n@end\n');
    expect(trace.diagnosticCounts.get('async_on_clk')).toBe(1);
    expect(trace.domains.get('default')!.cycles).toBe(2);
    expect(trace.records.every((r) => r.async === false)).toBe(true);
  });
});

describe('§8.2 时间换算', () => {
  test('第一个上升沿位于 0 ns；时钟之前没有时间基准', () => {
    const trace = parseChiperf('@domain core, period=1.0ns\n[clk] p\n[clk] p\n[clk] n\n@end\n');
    const core = trace.domains.get('core');
    expect(timeNs(core, 1)).toBe(0);
    expect(timeNs(core, 3)).toBe(2);
    expect(timeNs(core, 0)).toBeNull(); // 时钟之前不给负时间
    expect(timeNs(trace.domains.get('default'), 5)).toBeNull(); // 未声明 period
  });

  test('freq= 换算成 period（spec §8.2）', () => {
    const trace = parseChiperf('@domain mem, freq=800MHz\n[clk] p, dom=mem\n@end\n');
    expect(trace.domains.get('mem')!.periodNs).toBeCloseTo(1.25, 10);
    expect(trace.domains.get('mem')!.freqHz).toBe(800e6);
  });
});
