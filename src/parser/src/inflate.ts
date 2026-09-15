/**
 * gzip/DEFLATE 解压（RFC 1951 / 1952）—— 自带实现，不依赖平台 API。
 *
 * 为什么不用 `DecompressionStream`：
 *  - 它在流被截断时**丢弃全部已解出的数据**，而 spec §10.6 要求"保留截断点之前的完整记录"；
 *  - 它的错误信息无法区分"截断"与"校验和不符"（两者都只是 `inflate failed`）；
 *  - 自己解码可以逐块把数据喂给解析器，内存只保留 32KB 回溯窗口。
 */

export type GunzipStatus = 'ok' | 'truncated' | 'checksum_mismatch' | 'bad_format';

export interface GunzipOutcome {
  status: GunzipStatus;
  /** 是否至少解出一个完整成员 */
  members: number;
  /** 人类可读的说明（诊断用） */
  message?: string;
}

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097,
  6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const WINDOW = 32768;
const FLUSH_THRESHOLD = 1 << 16;

class NeedMoreInput extends Error {}

/** 位读取器：按 LSB-first 消费 */
class BitReader {
  private pos = 0;
  private bitBuf = 0;
  private bitCount = 0;

  constructor(
    private readonly data: Uint8Array,
    private readonly start: number,
  ) {
    this.pos = start;
  }

  get offset(): number {
    return this.pos - (this.bitCount >> 3);
  }

  bits(n: number): number {
    while (this.bitCount < n) {
      if (this.pos >= this.data.length) throw new NeedMoreInput();
      this.bitBuf |= this.data[this.pos++]! << this.bitCount;
      this.bitCount += 8;
    }
    const value = this.bitBuf & ((1 << n) - 1);
    this.bitBuf >>>= n;
    this.bitCount -= n;
    return value;
  }

  alignToByte(): void {
    this.bitBuf = 0;
    this.bitCount = 0;
  }

  bytes(n: number): Uint8Array {
    this.alignToByte();
    if (this.pos + n > this.data.length) throw new NeedMoreInput();
    const out = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

interface Huffman {
  counts: Uint16Array;
  symbols: Uint16Array;
}

function buildHuffman(lengths: Uint8Array): Huffman {
  const counts = new Uint16Array(16);
  for (const length of lengths) counts[length] = (counts[length] ?? 0) + 1;
  counts[0] = 0;
  const offsets = new Uint16Array(16);
  for (let i = 1; i < 16; i++) offsets[i] = (offsets[i - 1] ?? 0) + (counts[i - 1] ?? 0);
  const symbols = new Uint16Array(lengths.length);
  for (let sym = 0; sym < lengths.length; sym++) {
    const length = lengths[sym]!;
    if (length !== 0) symbols[offsets[length]!++] = sym;
  }
  return { counts, symbols };
}

function decodeSymbol(reader: BitReader, huffman: Huffman): number {
  let code = 0;
  let first = 0;
  let index = 0;
  for (let length = 1; length < 16; length++) {
    code |= reader.bits(1);
    const count = huffman.counts[length] ?? 0;
    if (code - first < count) return huffman.symbols[index + (code - first)]!;
    index += count;
    first = (first + count) << 1;
    code <<= 1;
  }
  throw new Error('非法的 Huffman 码');
}

const FIXED_LIT = (() => {
  const lengths = new Uint8Array(288);
  for (let i = 0; i < 144; i++) lengths[i] = 8;
  for (let i = 144; i < 256; i++) lengths[i] = 9;
  for (let i = 256; i < 280; i++) lengths[i] = 7;
  for (let i = 280; i < 288; i++) lengths[i] = 8;
  return buildHuffman(lengths);
})();

const FIXED_DIST = buildHuffman(new Uint8Array(30).fill(5));

/** 解压流缓冲：保留 32KB 回溯窗口，超过阈值就把数据交给 emit */
class OutputBuffer {
  private buf = new Uint8Array(WINDOW * 3);
  private write = 0;

  constructor(private readonly emit: (chunk: Uint8Array) => void) {}

  private ensure(extra: number): void {
    if (this.write + extra <= this.buf.length) return;
    const grown = new Uint8Array(Math.max(this.buf.length * 2, this.write + extra));
    grown.set(this.buf.subarray(0, this.write));
    this.buf = grown;
  }

  byte(value: number): void {
    this.ensure(1);
    this.buf[this.write++] = value & 0xff;
    if (this.write >= FLUSH_THRESHOLD) this.flush();
  }

  copy(length: number, distance: number): void {
    if (distance > this.write) throw new Error('回溯距离超出已有数据');
    this.ensure(length);
    let from = this.write - distance;
    for (let i = 0; i < length; i++) this.buf[this.write++] = this.buf[from++]!;
    if (this.write >= FLUSH_THRESHOLD) this.flush();
  }

  copyBytes(bytes: Uint8Array): void {
    this.ensure(bytes.length);
    this.buf.set(bytes, this.write);
    this.write += bytes.length;
    if (this.write >= FLUSH_THRESHOLD) this.flush();
  }

  flush(): void {
    if (this.write === 0) return;
    const keep = Math.min(this.write, WINDOW);
    const emitEnd = this.write - keep;
    if (emitEnd > 0) this.emit(this.buf.subarray(0, emitEnd));
    this.buf.copyWithin(0, emitEnd, this.write);
    this.write = keep;
  }

  /** 结束：把剩余数据全部交出去 */
  drain(): void {
    if (this.write > 0) this.emit(this.buf.subarray(0, this.write));
    this.write = 0;
  }
}

/** 解压一个 DEFLATE 流，直到 final block 结束；返回最终块之后的位置 */
function inflateStream(reader: BitReader, out: OutputBuffer): void {
  for (;;) {
    const final = reader.bits(1) === 1;
    const type = reader.bits(2);
    if (type === 0) {
      const header = reader.bytes(4);
      const length = header[0]! | (header[1]! << 8);
      out.copyBytes(reader.bytes(length));
    } else if (type === 1) {
      inflateBlock(reader, out, FIXED_LIT, FIXED_DIST);
    } else if (type === 2) {
      const hlit = reader.bits(5) + 257;
      const hdist = reader.bits(5) + 1;
      const hclen = reader.bits(4) + 4;
      const clenLengths = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) clenLengths[CLEN_ORDER[i]!] = reader.bits(3);
      const clenHuff = buildHuffman(clenLengths);
      const lengths = new Uint8Array(hlit + hdist);
      for (let i = 0; i < lengths.length; ) {
        const sym = decodeSymbol(reader, clenHuff);
        if (sym < 16) {
          lengths[i++] = sym;
        } else if (sym === 16) {
          const prev = i > 0 ? lengths[i - 1]! : 0;
          const repeat = 3 + reader.bits(2);
          for (let r = 0; r < repeat; r++) lengths[i++] = prev;
        } else if (sym === 17) {
          const repeat = 3 + reader.bits(3);
          for (let r = 0; r < repeat; r++) lengths[i++] = 0;
        } else {
          const repeat = 11 + reader.bits(7);
          for (let r = 0; r < repeat; r++) lengths[i++] = 0;
        }
      }
      inflateBlock(reader, out, buildHuffman(lengths.subarray(0, hlit)), buildHuffman(lengths.subarray(hlit)));
    } else {
      throw new Error('非法的块类型 3');
    }
    if (final) return;
  }
}

function inflateBlock(reader: BitReader, out: OutputBuffer, lit: Huffman, dist: Huffman): void {
  for (;;) {
    const sym = decodeSymbol(reader, lit);
    if (sym === 256) return;
    if (sym < 256) {
      out.byte(sym);
      continue;
    }
    const lengthIndex = sym - 257;
    if (lengthIndex >= LENGTH_BASE.length) throw new Error('非法的长度码');
    const length = LENGTH_BASE[lengthIndex]! + reader.bits(LENGTH_EXTRA[lengthIndex]!);
    const distSym = decodeSymbol(reader, dist);
    if (distSym >= DIST_BASE.length) throw new Error('非法的距离码');
    const distance = DIST_BASE[distSym]! + reader.bits(DIST_EXTRA[distSym]!);
    out.copy(length, distance);
  }
}

let crcTable: Uint32Array | null = null;

/** 增量 CRC32（RFC 1952 的校验字段）；初值传 0xffffffff，最终取反 */
function crc32Update(crc: number, bytes: Uint8Array): number {
  if (crcTable === null) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
  }
  let value = crc >>> 0;
  for (const byte of bytes) value = (crcTable[(value ^ byte) & 0xff]! ^ (value >>> 8)) >>> 0;
  return value >>> 0;
}

const EMPTY = new Uint8Array(0);

/**
 * 解压 gzip 流（支持多成员），把数据分块交给 `emit`。
 * 截断/校验和错误不影响已经解出的数据 —— 这是 spec §10.6 的关键要求。
 */
export function gunzip(bytes: Uint8Array, emit: (chunk: Uint8Array) => void): GunzipOutcome {
  let pos = 0;
  let members = 0;
  let status: GunzipStatus = 'ok';
  let message: string | undefined;

  while (pos < bytes.length) {
    if (bytes.length - pos < 18) {
      if (status === 'ok') {
        status = 'truncated';
        message = `gzip 流在成员头部处结束（剩余 ${bytes.length - pos} 字节）`;
      }
      return { status, members, message };
    }
    if (bytes[pos] !== 0x1f || bytes[pos + 1] !== 0x8b) {
      if (members === 0) return { status: 'bad_format', members, message: '缺少 gzip 魔数 1f 8b' };
      return { status, members, message: `成员之后有 ${bytes.length - pos} 字节无法识别的内容` };
    }
    if (bytes[pos + 2] !== 8) return { status: 'bad_format', members, message: `不支持压缩方法 ${bytes[pos + 2]}` };
    const flags = bytes[pos + 3]!;
    let headerEnd = pos + 10;
    if (flags & 0x04) {
      if (headerEnd + 2 > bytes.length) return { status: 'truncated', members, message: 'FEXTRA 被截断' };
      const extraLen = bytes[headerEnd]! | (bytes[headerEnd + 1]! << 8);
      headerEnd += 2 + extraLen;
    }
    for (const flag of [0x08, 0x10]) {
      if (flags & flag) {
        while (headerEnd < bytes.length && bytes[headerEnd] !== 0) headerEnd++;
        headerEnd++;
      }
    }
    if (flags & 0x02) headerEnd += 2;
    if (headerEnd > bytes.length) return { status: 'truncated', members, message: 'gzip 头部被截断' };

    const reader = new BitReader(bytes, headerEnd);
    let memberCrc = 0xffffffff;
    let memberLength = 0;
    const out = new OutputBuffer((chunk) => {
      memberCrc = crc32Update(memberCrc, chunk);
      memberLength += chunk.length;
      emit(chunk);
    });
    try {
      inflateStream(reader, out);
    } catch (err) {
      out.drain();
      const isEof = err instanceof NeedMoreInput;
      return {
        status: status === 'ok' && !isEof ? 'bad_format' : 'truncated',
        members,
        message: isEof ? `gzip 数据流在偏移 ${pos} 处被截断` : `解压失败：${(err as Error).message}`,
      };
    }
    out.drain();

    const trailer = reader.offset;
    if (trailer + 8 > bytes.length) {
      return { status: 'truncated', members, message: 'gzip 尾部（CRC/ISIZE）被截断' };
    }
    const expectedCrc = (bytes[trailer]! | (bytes[trailer + 1]! << 8) | (bytes[trailer + 2]! << 16) | (bytes[trailer + 3]! << 24)) >>> 0;
    const expectedSize = (bytes[trailer + 4]! | (bytes[trailer + 5]! << 8) | (bytes[trailer + 6]! << 16) | (bytes[trailer + 7]! << 24)) >>> 0;
    const actualCrc = (memberCrc ^ 0xffffffff) >>> 0;
    if (actualCrc !== expectedCrc || (memberLength >>> 0) !== expectedSize) {
      // spec §10.6：校验失败不放弃数据，只上报
      status = status === 'ok' ? 'checksum_mismatch' : status;
      message = `成员 ${members + 1} 的 CRC/ISIZE 校验失败（期望 crc=${expectedCrc.toString(16)} size=${expectedSize}，实际 crc=${actualCrc.toString(16)} size=${memberLength >>> 0}）`;
    }
    members++;
    pos = trailer + 8;
  }
  return { status, members, message };
}
