/**
 * `.chiperf.gz` 容器（spec §3.1 / §10.6）
 *
 * 用自带的 inflate（inflate.ts）边解压边喂给解析器：
 *  - 多成员 gzip 流按成员顺序拼接（spec §3.1）
 *  - 流被截断时**保留**截断点之前的所有完整记录（spec §10.6）
 *  - CRC/ISIZE 校验失败只上报诊断，不丢数据（spec §10.6）
 *  - 内存只保留 32KB 回溯窗口 + 解析器的有界状态
 */
import type { Trace } from './types.ts';
import { ChiperfParser, type ParseOptions } from './parse.ts';
import { gunzip, type GunzipStatus } from './inflate.ts';

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

/** 按前两字节魔数判定 gzip（spec §3.1，后缀冲突时以魔数为准） */
export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === GZIP_MAGIC_0 && bytes[1] === GZIP_MAGIC_1;
}

const STATUS_DIAGNOSTIC: Record<Exclude<GunzipStatus, 'ok'>, 'gzip_truncated' | 'gzip_checksum_mismatch' | 'gzip_bad_format'> = {
  truncated: 'gzip_truncated',
  checksum_mismatch: 'gzip_checksum_mismatch',
  bad_format: 'gzip_bad_format',
};

/** 解析字节流：自动识别 gzip（spec §3.1） */
export function parseChiperfBytes(bytes: Uint8Array, opts: ParseOptions = {}): Trace {
  const parser = new ChiperfParser(opts);
  const decoder = new TextDecoder('utf-8');

  if (!isGzip(bytes)) {
    parser.feed(decoder.decode(bytes));
    return parser.finish();
  }

  const outcome = gunzip(bytes, (chunk) => parser.feed(decoder.decode(chunk, { stream: true })));
  parser.feed(decoder.decode());
  if (outcome.status !== 'ok') {
    parser.report(STATUS_DIAGNOSTIC[outcome.status], 0, `${outcome.message ?? outcome.status}（已保留截断点之前的数据）`);
  }
  return parser.finish();
}
