/**
 * 鲁棒性与容器测试（spec §10）
 *
 * 重点是 §10.1 的**前缀封闭性**：任意按行切断的前缀都必须是合法文件。
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ChiperfParser, parseChiperf, parseChiperfBytes, isGzip, UnsupportedVersionError } from '../src/index.ts';

const EXAMPLES = join(import.meta.dir, '../../../docs/examples');
const FIXTURES = [
  'minimal',
  'rv32i-pipeline',
  'multiclk',
  'postprocess',
  'async-events',
  'faults',
  'truncated',
] as const;

const read = (name: string) => Bun.file(join(EXAMPLES, `${name}.chiperf`)).text();

describe('§10.1 前缀封闭性', () => {
  for (const fixture of FIXTURES) {
    test(`${fixture}：每个行边界前缀都能解析且不抛异常`, async () => {
      const text = await read(fixture);
      const full = parseChiperf(text, { ignoreVersion: true });
      let checked = 0;
      for (let i = 0; i < text.length; i++) {
        if (text[i] !== '\n') continue;
        const prefix = text.slice(0, i + 1);
        const trace = parseChiperf(prefix, { ignoreVersion: true });
        expect(trace.records.length).toBeLessThanOrEqual(full.records.length);
        // 前缀以换行结束 ⇒ 没有残行；且每条记录的位置与完整解析一致
        expect(trace.truncatedTail).toBeNull();
        for (let r = 0; r < trace.records.length; r++) {
          expect(trace.records[r]!.pos).toEqual(full.records[r]!.pos);
        }
        checked++;
      }
      expect(checked).toBeGreaterThan(3);
    });
  }

  test('末尾未以换行结束的行被丢弃并保留原文', () => {
    const parser = new ChiperfParser();
    parser.feed('[clk] p\n[cnt] "a"\n[cnt] "b');
    const trace = parser.finish();
    expect(trace.records.length).toBe(2);
    expect(trace.truncatedTail).toBe('[cnt] "b');
    expect(trace.diagnosticCounts.get('truncated_tail')).toBe(1);
  });

  test('按字节分片喂入与一次性解析等价（流式）', async () => {
    const text = await read('rv32i-pipeline');
    const whole = parseChiperf(text);
    const parser = new ChiperfParser();
    for (const ch of text) parser.feed(ch);
    const streamed = parser.finish();
    expect(streamed.records.length).toBe(whole.records.length);
    expect(streamed.records.map((r) => r.pos)).toEqual(whole.records.map((r) => r.pos));
    expect([...streamed.diagnosticCounts]).toEqual([...whole.diagnosticCounts]);
  });

  test('collectRecords:false 时记录不驻留，但派生量完整（有界内存模式）', async () => {
    const text = await read('rv32i-pipeline');
    const parser = new ChiperfParser({ collectRecords: false });
    parser.feed(text);
    const trace = parser.finish();
    expect(trace.records.length).toBe(0);
    expect(trace.stats.records).toBe(0);
    expect(trace.tracks.get('core.if')!.items.length).toBe(6);
    expect(trace.counters.get('default\u0000core.retired')!.total).toBe(4);
    expect(trace.domains.get('default')!.cycles).toBe(12);
  });
});

describe('§10.2 未知内容', () => {
  test('未知类型跳过、未知指令忽略、未知属性忽略但记录仍有效', () => {
    const trace = parseChiperf(
      [
        '[clk] p',
        '[stall] "if"',
        '[x-vendor-bp] a, b',
        '@something foo=1',
        '[val] "PC", 1, x-future=2',
        '@end',
      ].join('\n') + '\n',
    );
    expect(trace.records.length).toBe(2);
    expect(trace.skipped.filter((s) => s.reason === 'unknown_kind').length).toBe(2);
    expect(trace.skipped.filter((s) => s.reason === 'unknown_directive').length).toBe(1);
    expect(trace.values.get('default\u0000PC')!.samples.length).toBe(1);
    expect(trace.endSeen).toBe(true);
  });
});

describe('§10.3 非法记录逐行跳过，不影响其它记录', () => {
  const cases: [string, string][] = [
    ['[clk] x', 'clk 的沿取值非法'],
    ['[clk] p, n', 'clk 位置参数过多'],
    ['[cnt] "x", 1.5', 'cnt 增量不是 int'],
    ['[cnt] "x", 1, abs=2', '增量与 abs= 同时出现'],
    ['[cnt] "x", 1ns', '缩放量用在了非 @domain 位置'],
    ['[cnt] "", 1', '名字为空'],
    ['[val] "PC"', 'val 缺值'],
    ['[val] "PC", "unterminated', '字符串未闭合'],
    ['[pip] "IF", Q', 'pip 方向非法'],
    ['[fsm] "ctrl"', 'fsm 缺状态'],
    ['[val] "PC", 1, dom=123', 'dom 不是域名'],
    ['[val] "PC", 1, async=yes', 'async 不是 0/1'],
    ['[val] "PC", 1, at=1.5p', 'at 值非法'],
    ['[val] "PC", 1, dom=core, 2', '位置参数出现在属性之后'],
    ['chiperf 1.0', '版本行出现在中间'],
    ['garbage line', '行首非法'],
  ];

  for (const [bad, why] of cases) {
    test(`${why}：跳过该行且其余记录照常解析`, () => {
      const trace = parseChiperf(`[clk] p\n${bad}\n[cnt] "ok"\n@end\n`);
      expect(`${why}: records=${trace.records.length}`).toBe(`${why}: records=2`);
      expect(trace.skipped.length).toBe(1);
      expect(trace.counters.get('default\u0000ok')!.total).toBe(1);
    });
  }
});

describe('§5.4 版本行', () => {
  test('缺失版本行 ⇒ 按 1.0 解释', () => {
    const trace = parseChiperf('[clk] p\n@end\n');
    expect(trace.version).toMatchObject({ major: 1, minor: 0, explicit: false });
  });

  test('未知次版本号被接受', () => {
    const trace = parseChiperf('chiperf 1.7\n[clk] p\n@end\n');
    expect(trace.version).toMatchObject({ major: 1, minor: 7, explicit: true });
  });

  test('未知主版本默认拒绝，ignoreVersion 时可解析', () => {
    expect(() => parseChiperf('chiperf 2.0\n[clk] p\n')).toThrow(UnsupportedVersionError);
    expect(parseChiperf('chiperf 2.0\n[clk] p\n', { ignoreVersion: true }).records.length).toBe(1);
  });

  test('空文件与仅注释文件是合法空轨迹，且不报"可能被截断"', () => {
    for (const text of ['', '\n\n', '# 只有注释\n', 'chiperf 1.0\n']) {
      const trace = parseChiperf(text);
      expect(trace.records.length).toBe(0);
      expect(trace.diagnosticCounts.get('eof_without_end_marker') ?? 0).toBe(0);
    }
  });

  test('有记录但没有 @end ⇒ eof_without_end_marker', () => {
    const trace = parseChiperf('[clk] p\n');
    expect(trace.diagnosticCounts.get('eof_without_end_marker')).toBe(1);
  });
});

describe('§3.2 编码与行终止', () => {
  test('CRLF 被容忍', () => {
    const trace = parseChiperf('chiperf 1.0\r\n[clk] p\r\n[cnt] "a"\r\n@end\r\n');
    expect(trace.records.length).toBe(2);
    expect(trace.diagnostics.length).toBe(0);
  });

  test('UTF-8 名字与中文注释', () => {
    const trace = parseChiperf('[clk] p\n[cnt] "分支预测失败"   # 中文注释\n@end\n');
    expect(trace.counters.get('default\u0000分支预测失败')!.total).toBe(1);
    expect(trace.stats.bytes).toBeGreaterThan(trace.records.length * 3);
  });
});

describe('§3.1 / §10.6 gzip 容器', () => {
  test('按魔数识别并解压单成员流', async () => {
    const text = await read('minimal');
    const gz = Bun.gzipSync(new TextEncoder().encode(text));
    expect(isGzip(new Uint8Array(gz))).toBe(true);
    const trace = await parseChiperfBytes(new Uint8Array(gz));
    expect(trace.records.length).toBe(8);
    expect(trace.diagnostics.length).toBe(0);
  });

  test('多成员 gzip 按顺序拼接（spec §3.1）', async () => {
    const a = Bun.gzipSync(new TextEncoder().encode('[clk] p\n'));
    const b = Bun.gzipSync(new TextEncoder().encode('[cnt] "a"\n@end\n'));
    const joined = new Uint8Array([...a, ...b]);
    const trace = await parseChiperfBytes(joined);
    expect(trace.records.length).toBe(2);
    expect(trace.endSeen).toBe(true);
  });

  test('截断的 gzip 流：保留已解出的数据并给出诊断', async () => {
    const text = await read('rv32i-pipeline');
    const gz = new Uint8Array(Bun.gzipSync(new TextEncoder().encode(text)));
    const cut = gz.slice(0, Math.floor(gz.length * 0.9));
    const trace = await parseChiperfBytes(cut);
    // spec §10.6：截断点之前的完整记录必须保留（平台 DecompressionStream 会全部丢弃）
    expect(trace.records.length).toBeGreaterThan(0);
    expect(trace.records.length).toBeLessThan(102);
    expect(trace.diagnosticCounts.get('gzip_truncated')).toBe(1);
  });

  test('CRC 损坏：上报校验和诊断，但完整数据仍然可用', async () => {
    const text = await read('minimal');
    const gz = new Uint8Array(Bun.gzipSync(new TextEncoder().encode(text)));
    gz[gz.length - 8] = (gz[gz.length - 8] ?? 0) ^ 0xff; // 破坏 CRC32
    const trace = await parseChiperfBytes(gz);
    expect(trace.diagnosticCounts.get('gzip_checksum_mismatch')).toBe(1);
    expect(trace.records.length).toBe(8);
    expect(trace.diagnostics.filter((d) => d.code !== 'gzip_checksum_mismatch').length).toBe(0);
  });

  test('非 gzip 字节按纯文本解析', async () => {
    const trace = await parseChiperfBytes(new TextEncoder().encode('[clk] p\n@end\n'));
    expect(trace.records.length).toBe(1);
  });
});
