/**
 * Minimal, dependency-free PNG encoder used by the fixture image provider.
 *
 * A fixture must hand back bytes a real decoder accepts — a stub string would
 * let a broken renderer pass its own tests. Deflate is emitted as *stored*
 * (uncompressed) blocks, which is a valid zlib stream and keeps this file free
 * of a Node-only `zlib` import, so the fixture works in every runtime the
 * packages are consumed from.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function u32be(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array([...type].map((ch) => ch.charCodeAt(0)));
  const body = concat([typeBytes, data]);
  return concat([u32be(data.length), body, u32be(crc32(body))]);
}

/** zlib stream made of stored deflate blocks (BTYPE = 00). */
function zlibStored(data: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([0x78, 0x01])];
  const maxBlock = 65535;
  if (data.length === 0) {
    parts.push(new Uint8Array([0x01, 0x00, 0x00, 0xff, 0xff]));
  }
  for (let offset = 0; offset < data.length; offset += maxBlock) {
    const slice = data.subarray(offset, Math.min(offset + maxBlock, data.length));
    const isFinal = offset + slice.length >= data.length;
    const len = slice.length;
    const nlen = ~len & 0xffff;
    parts.push(new Uint8Array([isFinal ? 1 : 0, len & 0xff, (len >>> 8) & 0xff, nlen & 0xff, (nlen >>> 8) & 0xff]));
    parts.push(slice);
  }
  parts.push(u32be(adler32(data)));
  return concat(parts);
}

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Encodes 8-bit RGB pixel data (`width * height * 3` bytes) as a PNG. */
export function encodePngRgb(width: number, height: number, rgb: Uint8Array): Uint8Array {
  if (rgb.length !== width * height * 3) {
    throw new Error(`encodePngRgb: expected ${width * height * 3} bytes, received ${rgb.length}`);
  }
  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const ihdr = concat([
    u32be(width),
    u32be(height),
    new Uint8Array([8, 2, 0, 0, 0]), // bit depth 8, colour type 2 (RGB)
  ]);

  return concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibStored(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Runtime-neutral base64 — avoids depending on `Buffer` or `btoa`. */
export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64_ALPHABET[b0 >> 2];
    out += BASE64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : BASE64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : BASE64_ALPHABET[b2 & 0x3f];
  }
  return out;
}
