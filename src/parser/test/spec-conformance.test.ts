/**
 * 一致性测试：断言 docs/examples.md 里公开的每一项期望结果。
 * 这些数字是规范的一部分 —— 任何一条失败都意味着实现或文档有 bug。
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { parseChiperf, occupancyAt, latencyStats } from '../src/index.ts';
import type { Trace } from '../src/types.ts';

const EXAMPLES = join(import.meta.dir, '../../../docs/examples');

async function loadAsync(name: string): Promise<Trace> {
  return parseChiperf(await Bun.file(join(EXAMPLES, `${name}.chiperf`)).text());
}

const countOf = (trace: Trace, code: string) => trace.diagnosticCounts.get(code) ?? 0;
const track = (trace: Trace, name: string) => trace.tracks.get(name)!;
const counter = (trace: Trace, domain: string, name: string) => trace.counters.get(`${domain}\u0000${name}`)!;

describe('minimal.chiperf（docs/examples.md §1）', () => {
  test('8 条事件、2 个周期、无诊断', async () => {
    const trace = await loadAsync('minimal');
    expect(trace.records.length).toBe(8);
    expect(trace.diagnostics.length).toBe(0);
    expect(trace.domains.get('default')!.cycles).toBe(2);
    expect(trace.domains.get('default')!.negEdges).toBe(1);
    expect(trace.domains.get('default')!.periodNs).toBe(1);
  });

  test('位置与序号（spec §6.3）', async () => {
    const trace = await loadAsync('minimal');
    const positions = trace.records.map((r) => `${r.pos.cycle}${r.pos.phase}#${r.pos.seq}`);
    expect(positions).toEqual(['1p#1', '1p#2', '1p#3', '1p#4', '1p#5', '1p#6', '1n#7', '2p#8']);
  });

  test('计数器与数值', async () => {
    const trace = await loadAsync('minimal');
    expect(counter(trace, 'default', 'Branch Miss').total).toBe(1);
    expect(counter(trace, 'default', 'Cache Hit').total).toBe(1);
    expect(trace.values.get('default\u0000PC')!.samples[0]!.value.text).toBe('0x800001d0');
  });

  test('IF 轨道：同周期进出 ⇒ 延迟 0、占用度恒为 0', async () => {
    const trace = await loadAsync('minimal');
    const ifTrack = track(trace, 'IF');
    expect(ifTrack.items.length).toBe(1);
    expect(ifTrack.items[0]!.latencyCycles).toBe(0);
    expect(occupancyAt(ifTrack, 1)).toBe(0);
    expect(occupancyAt(ifTrack, 2)).toBe(0);
  });
});

describe('rv32i-pipeline.chiperf（docs/examples.md §2）', () => {
  test('102 条事件、12 个周期、唯一诊断是 1 次自环', async () => {
    const trace = await loadAsync('rv32i-pipeline');
    expect(trace.records.length).toBe(102);
    expect(trace.domains.get('default')!.cycles).toBe(12);
    expect(trace.diagnostics.length).toBe(1);
    expect(countOf(trace, 'self_transition')).toBe(1);
  });

  test('每周期第一条记录的 seq 与记录数', async () => {
    const trace = await loadAsync('rv32i-pipeline');
    const first = new Map<number, number>();
    const counts = new Map<number, number>();
    for (const r of trace.records) {
      if (!first.has(r.pos.cycle)) first.set(r.pos.cycle, r.pos.seq);
      counts.set(r.pos.cycle, (counts.get(r.pos.cycle) ?? 0) + 1);
    }
    expect([...first.entries()].sort((a, b) => a[0] - b[0])).toEqual([
      [0, 1], [1, 7], [2, 13], [3, 23], [4, 33], [5, 45], [6, 59], [7, 71], [8, 81], [9, 89], [10, 92], [11, 95], [12, 99],
    ]);
    expect([...counts.entries()].sort((a, b) => a[0] - b[0]).map(([, n]) => n)).toEqual([6, 6, 10, 10, 12, 14, 12, 10, 8, 3, 3, 4, 4]);
  });

  test('占用度表（60 格逐格核对）', async () => {
    const trace = await loadAsync('rv32i-pipeline');
    const table: Record<string, number[]> = {
      'core.if': [1, 1, 1, 1, 1, 0, 1, 0, 0, 0, 0, 0],
      'core.id': [0, 1, 1, 1, 1, 0, 0, 1, 0, 0, 0, 0],
      'core.ex': [0, 0, 1, 1, 1, 0, 0, 0, 1, 0, 0, 0],
      'core.mem': [0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 0, 0],
      'core.wb': [0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 0],
    };
    for (const [name, expected] of Object.entries(table)) {
      const series = [];
      for (let c = 1; c <= 12; c++) series.push(occupancyAt(track(trace, name), c));
      expect(`${name}:${series.join(',')}`).toBe(`${name}:${expected.join(',')}`);
    }
  });

  test('所有条目延迟均为 1 周期；2 条被冲刷；无 orphan、无未闭合', async () => {
    const trace = await loadAsync('rv32i-pipeline');
    for (const name of ['core.if', 'core.id', 'core.ex', 'core.mem', 'core.wb']) {
      const t = track(trace, name);
      expect(`${name} latencies=${[...new Set(t.latencies)].join(',')}`).toBe(`${name} latencies=1`);
      expect(t.orphan).toBe(0);
      expect(t.open).toBe(0);
    }
    expect(track(trace, 'core.if').aborted).toBe(1);
    expect(track(trace, 'core.id').aborted).toBe(1);
    expect(track(trace, 'core.ex').aborted).toBe(0);
  });

  test('计数器终值', async () => {
    const trace = await loadAsync('rv32i-pipeline');
    expect(counter(trace, 'default', 'core.retired').total).toBe(4);
    expect(counter(trace, 'default', 'core.icache.access').total).toBe(6);
    expect(counter(trace, 'default', 'core.icache.miss').total).toBe(1);
    expect(counter(trace, 'default', 'core.br.miss').total).toBe(1);
  });

  test('状态机：跳转与自环', async () => {
    const trace = await loadAsync('rv32i-pipeline');
    const ctrl = trace.fsms.get('default\u0000core.ctrl')!;
    expect(ctrl.transitions.length).toBe(7);
    expect(ctrl.transitions.filter((t) => t.selfLoop).length).toBe(0);
    // 首条记录没有前驱状态：`from` 为 null（视图层渲染为 unknown）
    expect(ctrl.transitions.map((t) => `${t.from}->${t.to}`)).toEqual([
      'null->RESET', 'RESET->FETCH', 'FETCH->RUN', 'RUN->FETCH', 'FETCH->RUN', 'RUN->DRAIN', 'DRAIN->DONE',
    ]);
    const icache = trace.fsms.get('default\u0000core.icache.ctrl')!;
    expect(icache.transitions.filter((t) => t.selfLoop).length).toBe(1);
  });

  test('气泡：core.if 与 core.id 在第 6 周期各有一个气泡', async () => {
    const trace = await loadAsync('rv32i-pipeline');
    // 活跃区间 = [首条记录周期, 末条记录周期]：core.if 为 [1,8]，core.id 为 [2,9]
    expect(track(trace, 'core.if').bubbles).toEqual([6, 8]);
    expect(track(trace, 'core.id').bubbles).toEqual([6, 7, 9]);
    expect(track(trace, 'core.if').bubbleRanges).toEqual([
      { start: 6, end: 6 },
      { start: 8, end: 8 },
    ]);
  });
});

describe('multiclk.chiperf（docs/examples.md §3）', () => {
  test('双域周期数、25 条事件、1 次跨域诊断', async () => {
    const trace = await loadAsync('multiclk');
    expect(trace.records.length).toBe(25);
    expect(trace.domains.get('core')!.cycles).toBe(2);
    expect(trace.domains.get('mem')!.cycles).toBe(4);
    expect(countOf(trace, 'cross_domain')).toBe(1);
    expect(countOf(trace, 'orphan_exit')).toBe(0);
  });

  test('同名不同域的追踪对象彼此独立（spec §7 追踪键）', async () => {
    const trace = await loadAsync('multiclk');
    expect(counter(trace, 'core', 'stall').total).toBe(2);
    expect(counter(trace, 'mem', 'stall').total).toBe(1);
    expect(counter(trace, 'mem', 'mem.access').total).toBe(3);
    expect(countOf(trace, 'name_reused')).toBe(0);
  });

  test('跨域条目不报周期延迟，只报两端位置', async () => {
    const trace = await loadAsync('multiclk');
    const item = track(trace, 'core.l2').items[0]!;
    expect(item.enter.domain).toBe('core');
    expect(item.enter.cycle).toBe(1);
    expect(item.exit!.domain).toBe('mem');
    expect(item.exit!.cycle).toBe(2);
    expect(item.crossDomain).toBe(true);
    expect(item.latencyCycles).toBeNull();
    // core 声明了 1.0ns，mem 由 800MHz 换算得 1.25ns（spec §8.2）
    expect(item.latencyNs).toBeCloseTo((2 - 1) * 1.25 - (1 - 1) * 1.0, 10);
  });

  test('同域同周期进出 ⇒ 延迟 0', async () => {
    const trace = await loadAsync('multiclk');
    const zero = track(trace, 'mem.bank0').items.find((i) => i.latencyCycles === 0)!;
    expect(zero).toBeDefined();
    expect(zero.enter.cycle).toBe(2);
  });
});

describe('postprocess.chiperf（docs/examples.md §4）', () => {
  test('无 clk 记录：位置全部来自 at=，周期计数保持 0', async () => {
    const trace = await loadAsync('postprocess');
    expect(trace.records.length).toBe(11);
    expect(trace.hasAtOverride).toBe(true);
    expect(trace.domains.get('default')!.cycles).toBe(0);
    expect(trace.domains.get('mem')!.cycles).toBe(0);
    expect(trace.diagnostics.length).toBe(0);
    expect(countOf(trace, 'at_clk_conflict')).toBe(0);
  });

  test('at= 的相位缺省为 p', async () => {
    const trace = await loadAsync('postprocess');
    const id = trace.records.find((r) => r.kind === 'pip' && r.track === 'ID' && r.dir === 'I')!;
    expect(`${id.pos.cycle}${id.pos.phase}`).toBe('2p');
  });

  test('轨道延迟与计数器', async () => {
    const trace = await loadAsync('postprocess');
    expect(latencyStats(track(trace, 'IF')).count).toBe(1);
    expect(track(trace, 'IF').items[0]!.latencyCycles).toBe(1);
    expect(track(trace, 'ID').items[0]!.latencyCycles).toBe(1);
    expect(counter(trace, 'default', 'Retired').total).toBe(2);
    expect(counter(trace, 'mem', 'stall').total).toBe(1);
  });
});

describe('async-events.chiperf（docs/examples.md §5）', () => {
  test('17 条事件、3 个周期、无诊断', async () => {
    const trace = await loadAsync('async-events');
    expect(trace.records.length).toBe(17);
    expect(trace.domains.get('default')!.cycles).toBe(3);
    expect(trace.diagnostics.length).toBe(0);
  });

  test('async 记录就是 seq 7/8/13/14，位置与沿对齐记录同一套规则', async () => {
    const trace = await loadAsync('async-events');
    const asyncSeqs = trace.records.filter((r) => r.async).map((r) => r.seq);
    expect(asyncSeqs).toEqual([7, 8, 13, 14]);
    for (const seq of asyncSeqs) {
      const rec = trace.records.find((r) => r.seq === seq)!;
      expect(rec.pos.phase).toBe('n');
      expect(rec.pos.cycle === 1 || rec.pos.cycle === 2).toBe(true);
    }
  });

  test('async 不改变派生量：延迟仍按周期算、计数照常累加', async () => {
    const trace = await loadAsync('async-events');
    const item = track(trace, 'core.l2').items[0]!;
    expect(item.async).toBe(false);
    expect(item.closeAsync).toBe(true);
    expect(item.latencyCycles).toBe(1);
    expect(occupancyAt(track(trace, 'core.l2'), 1)).toBe(1);
    expect(occupancyAt(track(trace, 'core.l2'), 2)).toBe(0);
    expect(counter(trace, 'default', 'core.instr').total).toBe(4);
  });
});

describe('faults.chiperf（docs/examples.md §6）', () => {
  test('17 条有效事件、跳过 3 行', async () => {
    const trace = await loadAsync('faults');
    expect(trace.records.length).toBe(17);
    expect(trace.skipped.length).toBe(3);
    expect(trace.skipped.map((s) => s.reason).sort()).toEqual(['invalid_record', 'unknown_directive', 'unknown_kind']);
  });

  test('语义异常各 1 次（含 async 误用与域拼写）', async () => {
    const trace = await loadAsync('faults');
    for (const code of ['orphan_exit', 'redundant_edge', 'negative_total', 'self_transition', 'undeclared_domain', 'async_on_clk']) {
      expect(`${code}=${countOf(trace, code)}`).toBe(`${code}=1`);
    }
  });

  test('数据被保留：负计数、跨域漂移、被忽略的 async', async () => {
    const trace = await loadAsync('faults');
    expect(counter(trace, 'default', 'Retired').total).toBe(-8);
    expect(counter(trace, 'cor', 'Retired').total).toBe(1);
    const clk = trace.records.filter((r) => r.kind === 'clk');
    expect(clk.length).toBe(6);
    expect(clk.every((c) => c.async === false)).toBe(true);
    // orphan 出队不伪造配对，也不进入延迟分布
    expect(latencyStats(track(trace, 'IF')).count).toBe(0);
    expect(track(trace, 'IF').orphan).toBe(1);
  });
});

describe('truncated.chiperf（docs/examples.md §7）', () => {
  test('残行被丢弃并保留原文（spec §10.1）', async () => {
    const trace = await loadAsync('truncated');
    expect(trace.records.length).toBe(7);
    expect(trace.truncatedTail).toBe('[cnt] "Retire');
    expect(countOf(trace, 'truncated_tail')).toBe(1);
    expect(countOf(trace, 'eof_without_end_marker')).toBe(1);
  });

  test('未闭合条目被暴露为 open，不伪造退出（spec §10.5）', async () => {
    const trace = await loadAsync('truncated');
    const id = track(trace, 'ID');
    expect(id.open).toBe(1);
    expect(id.items[0]!.closed).toBeNull();
    expect(id.items[0]!.exit).toBeNull();
    expect(track(trace, 'IF').completed).toBe(1);
  });
});

describe('future-version.chiperf（docs/examples.md §8）', () => {
  test('默认拒绝未知主版本', async () => {
    const text = await Bun.file(join(EXAMPLES, 'future-version.chiperf')).text();
    expect(() => parseChiperf(text)).toThrow(/主版本/);
  });

  test('显式忽略版本时才按 1.x 解析', async () => {
    const text = await Bun.file(join(EXAMPLES, 'future-version.chiperf')).text();
    const trace = parseChiperf(text, { ignoreVersion: true });
    expect(trace.records.length).toBe(2);
    expect(trace.endSeen).toBe(true);
    expect(trace.version).toMatchObject({ major: 2, minor: 0, explicit: true });
  });
});

describe('§9.4 延迟统计（中位 / 方差）', () => {
  /** 造一条只有一个轨道 T 的轨迹：入都在周期 1，出按给定的延迟落在各自周期 */
  const traceWithLatencies = (latencies: number[]): Trace => {
    const lines = ['chiperf 1.0', '[clk] p'];
    latencies.forEach((_, index) => lines.push(`[pip] "T", I, 0x${(index + 10).toString(16)}`));
    lines.push('[clk] n');
    const max = Math.max(...latencies);
    for (let cycle = 2; cycle <= 1 + max; cycle++) {
      lines.push('[clk] p');
      latencies.forEach((latency, index) => {
        if (latency === cycle - 1) lines.push(`[pip] "T", O, 0x${(index + 10).toString(16)}`);
      });
      lines.push('[clk] n');
    }
    lines.push('@end');
    return parseChiperf(`${lines.join('\n')}\n`);
  };

  test('奇数个样本：中位数取中间那个', () => {
    const stats = latencyStats(track(traceWithLatencies([1, 1, 3]), 'T'));
    expect(stats.count).toBe(3);
    expect(stats.median).toBe(1);
    expect(stats.avg).toBeCloseTo(5 / 3, 10);
    expect(stats.variance).toBeCloseTo(8 / 9, 10);
  });

  test('偶数个样本：中位数取中间两个的平均', () => {
    const stats = latencyStats(track(traceWithLatencies([1, 2]), 'T'));
    expect(stats.median).toBe(1.5);
    expect(stats.avg).toBe(1.5);
    expect(stats.variance).toBeCloseTo(0.25, 10);
  });

  test('延迟全部相同：方差为 0，直方图只有一档', () => {
    const stats = latencyStats(track(traceWithLatencies([2, 2, 2]), 'T'));
    expect(stats.median).toBe(2);
    expect(stats.variance).toBeCloseTo(0, 10);
    expect(stats.histogram).toEqual([{ latency: 2, count: 3 }]);
  });

  test('没有已完成条目时返回全 0 而不是 NaN', () => {
    const trace = parseChiperf('chiperf 1.0\n[clk] p\n[pip] "T", I, 0xa\n[clk] n\n@end\n');
    const stats = latencyStats(track(trace, 'T'));
    expect(stats).toMatchObject({ count: 0, min: 0, max: 0, avg: 0, median: 0, variance: 0, histogram: [] });
    expect(Number.isNaN(stats.variance)).toBe(false);
  });
});

describe('reset.chiperf（docs/examples.md §9，spec §7.7/§7.8）', () => {
  const load = async (): Promise<Trace> => parseChiperf(await Bun.file(join(EXAMPLES, 'reset.chiperf')).text());

  test('复位前的记录整批作废：只有复位后的 4 条记录', async () => {
    const trace = await load();
    expect(trace.stats.records).toBe(4);
    expect(trace.records.map((r) => `${r.kind}@${r.pos.cycle}`)).toEqual(['clk@3', 'cnt@3', 'val@3', 'clk@3']);
    expect(trace.resets).toEqual([{ line: 15, droppedRecords: 8 }]);
    // rst 自身不入记录序列，也不占 seq
    expect(trace.records.some((r) => (r as { kind: string }).kind === 'rst')).toBe(false);
    expect(trace.records[0]!.seq).toBe(9);
  });

  test('计数器/数值都从复位处重新开始', async () => {
    const trace = await load();
    expect(counter(trace, 'default', 'retired').total).toBe(1);
    const pc = trace.values.get('default\u0000core.pc')!;
    expect(pc.samples.map((s) => s.value.text)).toEqual(['0x8000']);
  });

  test('复位前在飞的条目随之消失（轨道整个不存在）', async () => {
    const trace = await load();
    expect(trace.tracks.size).toBe(0);
  });

  test('@ 指令与版本行是声明不是行：域元数据保留', async () => {
    const trace = await load();
    const domain = trace.domains.get('default')!;
    expect(domain.periodNs).toBe(1);
    expect(domain.declared).toBe(true);
    expect(trace.meta['design']).toContain('rst-demo');
    expect(trace.version.minor).toBe(1);
    // 沿数与记录范围按复位后的窗口重算；周期号不重编（新窗口从第 3 个周期开始）
    expect(domain.posEdges).toBe(1);
    expect(domain.negEdges).toBe(1);
    expect(domain.cycles).toBe(3);
    expect(domain.firstCycle).toBe(3);
    expect(domain.lastCycle).toBe(3);
  });

  test('只留下一条信息性诊断 rst_boundary', async () => {
    const trace = await load();
    expect(trace.diagnostics.map((d) => d.code)).toEqual(['rst_boundary']);
    expect(trace.diagnostics[0]!.message).toContain('丢弃此前 8 条');
  });

  test('复位后关闭一个被丢弃的条目 → orphan_exit（窗口内确实匹配不到）', () => {
    const trace = parseChiperf(
      ['chiperf 1.1', '[clk] p', '[pip] "T", I, 0xa', '[clk] n', '[rst]', '[clk] p', '[pip] "T", O, 0xa', '[clk] n', '@end', ''].join('\n'),
    );
    expect(trace.records.length).toBe(3);
    const item = track(trace, 'T').items[0]!;
    expect(item.orphan).toBe(true);
    expect(countOf(trace, 'orphan_exit')).toBe(1);
  });

  test('[rst] 不接受任何参数', () => {
    const trace = parseChiperf(['chiperf 1.1', '[rst] dom=default', '[clk] p', '@end', ''].join('\n'));
    expect(trace.records.length).toBe(1);
    expect(trace.skipped.map((s) => s.reason)).toEqual(['invalid_record']);
  });
});
