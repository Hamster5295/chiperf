/**
 * 内置示例（src/sample.ts）的语义自检
 *
 * 示例是"载入示例"按钮的全部内容，也是这个工具给人的第一印象，所以它必须自己站得住。
 * 这里只断言它**宣称**的两件事，都是看一眼注释能核对、错了却很难发现的：
 *  - 被冲刷的指令确实占用过流水级（不是零宽区间）
 *  - 被冲刷的指令此后不再出现在 EX/MEM/WB
 *
 * 零宽区间（`I` 与 `X` 同拍）本身合法（spec §9.4 的"同周期撤销"），但按定义不计入
 * 任何周期的占用度：图上只是周期交界处的一个薄片，占用度曲线里完全看不到。
 * 用它表达"指令在 IF/ID 里待了一拍然后被冲掉"是错的。
 */
import { describe, expect, test } from 'bun:test';
import { Deriver, parseChiperf, valueKey, type TrackInfo } from '../../parser/src/index.ts';
import { sampleTrace } from '../src/sample.ts';

function tracksOf(text: string): Map<string, TrackInfo> {
  const trace = parseChiperf(text);
  const deriver = new Deriver({
    cyclesOf: () => 1,
    domainInfo: (name: string) => ({ name }) as never,
    diag: () => {},
  });
  for (const rec of trace.records) deriver.onRecord(rec);
  return deriver.tracks;
}

describe('内置示例', () => {
  test('被冲刷的条目各占用一个周期（不是零宽区间）', () => {
    const spans = [...tracksOf(sampleTrace()).values()]
      .flatMap((track) => track.items.filter((item) => item.closed === 'X').map((item) => ({ track: track.name, item })))
      // 跨度 0 = `I` 与 `X` 同拍 ⇒ 占用度曲线里看不到它，图上只剩一个薄片
      .map(({ track, item }) => `${track}@${item.enter.cycle} 跨度 ${item.closeAnchorCycle! - item.enter.cycle}`)
      .sort();
    expect(spans).toEqual(['core.id@6 跨度 1', 'core.if@6 跨度 1']);
  });

  test('被冲刷的指令不再进入 EX/MEM/WB', () => {
    const tracks = tracksOf(sampleTrace());
    const killed = new Set(
      [...tracks.values()]
        .flatMap((track) => track.items.filter((item) => item.closed === 'X' && item.tag !== null).map((item) => valueKey(item.tag!))),
    );
    expect(killed.size).toBe(2);
    const offenders = ['core.ex', 'core.mem', 'core.wb'].flatMap((name) =>
      (tracks.get(name)?.items ?? []).filter((item) => item.tag !== null && killed.has(valueKey(item.tag))).map((item) => `${name} 出现了被冲刷的指令`),
    );
    expect(offenders).toEqual([]);
  });
});
