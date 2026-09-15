/**
 * chiperf 1.0 解析器 —— 公开 API
 *
 * 用法：
 * ```ts
 * import { parseChiperf, parseChiperfBytes } from '@chiperf/parser';
 * const trace = parseChiperf(sourceText);            // .chiperf
 * const trace2 = await parseChiperfBytes(fileBytes); // .chiperf 或 .chiperf.gz（按魔数识别）
 * ```
 * 单遍流式用法（内存有界）：
 * ```ts
 * const parser = new ChiperfParser({ collectRecords: false });
 * parser.feed(chunk1); parser.feed(chunk2);
 * const trace = parser.finish();
 * ```
 */
export * from './types.ts';
export { ChiperfParser, parseChiperf, UnsupportedVersionError, type ParseOptions } from './parse.ts';
export { parseChiperfBytes, isGzip } from './gzip.ts';
export { gunzip, type GunzipOutcome, type GunzipStatus } from './inflate.ts';
export { Deriver, deriveRecords, type DeriveContext } from './derive.ts';
export { scanValue, formatValue, valueKey, symIs, asInt } from './value.ts';
export { parseArgs, stripComment, splitTopLevel, decodeAt, type Arg } from './lexer.ts';
export {
  comparePosition,
  formatPosition,
  timeNs,
  counterTotalAt,
  counterDeltaBetween,
  valueAt,
  stateAt,
  stateSegments,
  occupancyAt,
  occupancySeries,
  bubbleStats,
  describeSamples,
  equalRuns,
  type Distribution,
  latencyStats,
  eventCounters,
  ratioBetween,
  sameValue,
} from './selectors.ts';
