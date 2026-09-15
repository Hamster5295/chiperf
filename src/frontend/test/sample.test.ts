/**
 * 内置示例（src/sample.ts）的语义自检
 *
 * 示例是"载入示例"按钮的全部内容，也是这个工具给人的第一印象，所以它必须自己站得住。
 * 这里断言它**宣称**的那件事，看一眼注释能核对、错了却很难发现：
 * 分支在 EX 解析出预测错误后，IF/ID 里的年轻指令确实占用了流水级（各占一拍以上），
 * 然后两级**变空**（冲刷），而不是继续保持旧值、也不是零宽区间。
 *
 * 零宽区间（同拍设值又变空）本身合法（spec §9.4），但按定义不计入任何周期的占用度：
 * 图上只是周期交界处的一个薄片，占用度曲线里完全看不到。用它表达"指令在 IF/ID 里
 * 待了一拍然后被冲掉"是错的。v2.0 起 `[pip]` 是保持型取值，所以"冲刷"只能表现为
 * "该级被设成 bubble"——示例里那两条指令从此哪儿都没去。
 */
import { describe, expect, test } from 'bun:test';
import { Deriver, parseChiperf, valueKey, type PipelineItem, type TrackInfo } from '../../parser/src/index.ts';
import { sampleTrace } from '../src/sample.ts';

function tracksOf(text: string): Map<string, TrackInfo> {
  const trace = parseChiperf(text);
  const deriver = new Deriver({
    cyclesOf: () => 1,
    domainInfo: (name: string) => ({ name }) as never,
    diag: () => {},
  });
  for (const rec of trace.records) deriver.onRecord(rec);
  deriver.finish(); // 占用度/气泡是收尾时算的（spec §9.4），不调用就只剩 items
  return deriver.tracks;
}

/** 被冲刷的指令：进过 IF/ID，但从没到过 EX/MEM/WB（示例里就是分支之后的年轻指令） */
function flushedItems(tracks: Map<string, TrackInfo>): { track: string; item: PipelineItem }[] {
  const later = new Set(
    ['core.ex', 'core.mem', 'core.wb'].flatMap((name) =>
      (tracks.get(name)?.items ?? []).filter((i) => i.value !== null).map((i) => valueKey(i.value)),
    ),
  );
  return ['core.if', 'core.id'].flatMap((track) =>
    (tracks.get(track)?.items ?? [])
      .filter((item) => item.value !== null && !later.has(valueKey(item.value)))
      .map((item) => ({ track, item })),
  );
}

describe('内置示例', () => {
  test('被冲刷的指令各占用了一拍以上（不是零宽区间）', () => {
    const spans = flushedItems(tracksOf(sampleTrace()))
      .map(({ track, item }) => `${track}@${item.enter.cycle}→${item.close!.cycle} 驻留 ${item.latencyCycles}`)
      .sort();
    expect(spans).toEqual(['core.id@6→7 驻留 1', 'core.if@4→6 驻留 2', 'core.if@6→7 驻留 1']);
  });

  test('被冲刷的指令不再进入 EX/MEM/WB，且冲刷后该级变空（bubble）', () => {
    const tracks = tracksOf(sampleTrace());
    const flushed = flushedItems(tracks);
    expect(new Set(flushed.map(({ item }) => valueKey(item.value))).size).toBe(2);

    const offenders = ['core.ex', 'core.mem', 'core.wb'].flatMap((name) => {
      const killed = new Set(flushed.map(({ item }) => valueKey(item.value)));
      return (tracks.get(name)?.items ?? [])
        .filter((item) => item.value !== null && killed.has(valueKey(item.value)))
        .map((item) => `${name} 出现了被冲刷的指令`);
    });
    expect(offenders).toEqual([]);

    // 冲刷发生在周期 7：两级从这一拍起没有内容，直到重定向后的取指进来（第 8 / 9 拍）
    expect(tracks.get('core.if')!.bubbles).toEqual([7, 11]);
    expect(tracks.get('core.id')!.bubbles).toEqual([7, 8, 12]);
  });
});
