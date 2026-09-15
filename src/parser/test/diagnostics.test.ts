/**
 * 诊断与边界语义测试（spec §9.4 跨域锚定 / §10.4 语义异常 / §10.5 未闭合）
 *
 * v2.0 起 `[pip]` 是"直接指定该级的新值或 bubble"，没有 I/O/X 方向，
 * 所以这里的 fixture 全部改成新语法。
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

  test('同域条目的锚定就是"被改掉"那一拍本身', () => {
    const trace = parseChiperf('[clk] p\n[pip] "t", 1\n[clk] p\n[clk] p\n[pip] "t", bubble\n@end\n');
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
    const trace = parseChiperf('[clk] p\n[pip] "t", 1\n[clk] p\n[cnt] "x"\n@end\n');
    const track = trace.tracks.get('t')!;
    expect(track.open).toBe(1);
    expect(track.items[0]!.close).toBeNull();
    expect(track.lastCycle).toBe(1);
    // close 缺失 ⇒ 按 §9.4 从 enter 起一直算在飞，所以第 1 周期被占用（不是气泡）
    expect(occupancyAt(track, 1)).toBe(1);
    expect(track.bubbles).toEqual([]);
  });
});

describe('§10.4 语义异常', () => {
  // v1.x 的 duplicate_tag 在新模型里不需要存在：同一个值再写一次就是"还在保持"
  test('重复写同一个值不产生新条目（也就没有重复标记可言）', () => {
    const trace = parseChiperf('[clk] p\n[pip] "t", 7\n[pip] "t", 7\n[clk] p\n[pip] "t", bubble\n@end\n');
    const track = trace.tracks.get('t')!;
    expect([...trace.diagnosticCounts]).toEqual([]);
    expect(track.items.length).toBe(1);
    expect(track.items[0]!.value!.text).toBe('7');
    expect(track.items[0]!.close!.cycle).toBe(2);
  });

  test('记录缺值 / 仍是 v1.x 的方向：跳过该行，方向另有计数', () => {
    const missing = parseChiperf('[clk] p\n[pip] "t"\n@end\n');
    expect(missing.skipped.map((s) => s.reason)).toEqual(['invalid_record']);
    expect(missing.skipped[0]!.detail).toContain('缺少新值');
    const legacy = parseChiperf('[clk] p\n[pip] "t", I, 7\n[pip] "t", O, 7\n@end\n');
    expect([...legacy.diagnosticCounts]).toEqual([['pip_legacy_direction', 2]]);
    expect(legacy.skipped.length).toBe(2);
    expect(legacy.tracks.size).toBe(0);
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
    const trace = parseChiperf('[clk] p\n[cnt] "c", async=1\n[pip] "t", 1, async=1\n[clk] n\n[pip] "t", bubble, async=1\n@end\n');
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

describe('指令字段的分隔符（spec §8）', () => {
  test('空白分隔的 @meta 与逗号分隔等价', () => {
    const spaces = parseChiperf(['chiperf 2.1', '@meta design="x" tool="y"', '@end', ''].join('\n'));
    const commas = parseChiperf(['chiperf 2.1', '@meta design="x", tool="y"', '@end', ''].join('\n'));
    expect(spaces.meta).toEqual({ design: 'x', tool: 'y' });
    expect(commas.meta).toEqual(spaces.meta);
    expect(spaces.diagnostics.length).toBe(0);
    expect(spaces.skipped.length).toBe(0);
  });

  test('空白分隔的 @domain 也能解析出 period', () => {
    const trace = parseChiperf(['chiperf 2.1', '@domain core, period=2.5ns note="主时钟"', '@end', ''].join('\n'));
    expect(trace.domains.get('core')!.periodNs).toBe(2.5);
    expect(trace.domains.get('core')!.note).toBe('主时钟');
  });

  test('记录仍然只认逗号：空白分隔的属性是非法记录', () => {
    const trace = parseChiperf(['chiperf 2.1', '[clk] p, dom=core note="x"', '@end', ''].join('\n'));
    expect(trace.records.length).toBe(0);
    expect(trace.skipped.map((s) => s.reason)).toEqual(['invalid_record']);
  });
});
