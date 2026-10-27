// png.js — PNG 结构校验与尺寸读取（纯函数，零依赖）。
//
// 契约（contract.md §1.1）：导出 `inspectPng(bytes)`
//   -> { ok:true, width, height } | { ok:false, code:'invalid_output', message }
// 只回答“这段字节是不是一张完整可读的 PNG、尺寸多少”，不做采集/落盘/缩放。
//
// 规则（contract.md §7.3）：signature、块边界、IHDR、IEND、非空、无截断、可选 CRC。
// 不抛裸异常给调用方；不打印任何像素内容。

/** 8 字节 PNG 文件签名。 */
export const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 结构遍历上限：坏文件不许让循环跑太久。 */
const MAX_CHUNKS = 100000;

/** 允许声明的像素上限（防御异常尺寸）。 */
const MAX_PIXELS = 200000000;

let crcTable = null;

function getCrcTable() {
  if (crcTable) return crcTable;
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  crcTable = table;
  return table;
}

/** CRC32（PNG 规范定义）。 */
export function crc32(bytes) {
  const buf = asBuffer(bytes);
  const table = getCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Buffer / Uint8Array / ArrayBuffer 统一成 Buffer（不拷贝已有 Buffer）。 */
export function asBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  return null;
}

/** 是否带合法 PNG 签名。 */
export function hasPngSignature(bytes) {
  const buf = asBuffer(bytes);
  return Boolean(buf) && buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from(PNG_SIGNATURE));
}

/** 只读尺寸：成功 { width, height }，否则 null。 */
export function readPngSize(bytes) {
  const buf = asBuffer(bytes);
  if (!buf || !hasPngSignature(buf) || buf.length < 8 + 8 + 13 + 4) return null;
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  if (buf.readUInt32BE(8) !== 13) return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!(width > 0) || !(height > 0)) return null;
  return { width, height };
}

function bad(message) {
  return { ok: false, code: 'invalid_output', message };
}

/**
 * 完整结构校验。
 *
 * @param {Uint8Array|Buffer} bytes
 * @param {{ checkCrc?: boolean }} [options]
 * @returns {{ ok: true, width: number, height: number, bytes: number, chunks: number }
 *          | { ok: false, code: 'invalid_output', message: string }}
 */
export function inspectPng(bytes, options = {}) {
  const checkCrc = options.checkCrc !== false;
  const buf = asBuffer(bytes);

  if (!buf || buf.length === 0) return bad('PNG bytes are empty');
  if (buf.length < 8) return bad('PNG bytes are shorter than the 8-byte signature');
  if (!hasPngSignature(buf)) return bad('PNG signature mismatch (89 50 4E 47 0D 0A 1A 0A expected)');

  let offset = 8;
  let chunks = 0;
  let ihdr = null;
  let sawIend = false;

  while (offset < buf.length) {
    if (chunks >= MAX_CHUNKS) return bad('PNG has an implausible number of chunks');
    if (offset + 8 > buf.length) return bad('PNG is truncated inside a chunk header');

    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcEnd = dataEnd + 4;

    if (!/^[A-Za-z]{4}$/.test(type)) return bad(`PNG chunk type is invalid at offset ${offset}`);
    if (dataEnd > buf.length || crcEnd > buf.length) return bad(`PNG is truncated inside chunk ${type}`);

    if (chunks === 0) {
      if (type !== 'IHDR' || length !== 13) return bad('PNG first chunk is not a 13-byte IHDR');
      const width = buf.readUInt32BE(dataStart);
      const height = buf.readUInt32BE(dataStart + 4);
      if (!(width > 0) || !(height > 0)) return bad('PNG IHDR declares a non-positive size');
      if (width * height > MAX_PIXELS) return bad(`PNG IHDR declares an implausible size ${width}x${height}`);
      ihdr = { width, height };
    }

    if (checkCrc) {
      const expected = buf.readUInt32BE(dataEnd);
      const actual = crc32(buf.subarray(offset + 4, dataEnd));
      if (expected !== actual) return bad(`PNG chunk ${type} failed its CRC check`);
    }

    offset = crcEnd;
    chunks += 1;

    if (type === 'IEND') {
      if (length !== 0) return bad('PNG IEND chunk is not empty');
      sawIend = true;
      break;
    }
  }

  if (!sawIend) return bad('PNG has no IEND chunk (truncated or corrupt)');
  if (offset !== buf.length) return bad(`PNG has ${buf.length - offset} trailing bytes after IEND`);
  if (!ihdr) return bad('PNG has no IHDR');

  return { ok: true, width: ihdr.width, height: ihdr.height, bytes: buf.length, chunks };
}
