// A small PNG reader, enough for the browser's own screenshots: 8-bit grey,
// grey+alpha, RGB, RGBA or palette, not interlaced. Returns RGB pixels.
import { inflateSync } from 'node:zlib';

export interface Pixels {
  width: number;
  height: number;
  /** Three bytes per pixel: red, green, blue. */
  rgb: Uint8Array;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function decodePng(buf: Buffer): Pixels {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = 0;
  let interlace = 0;
  let palette: Buffer | null = null;
  const data: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const name = buf.toString('ascii', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (name === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8]!;
      type = body[9]!;
      interlace = body[12]!;
    } else if (name === 'PLTE') palette = Buffer.from(body);
    else if (name === 'IDAT') data.push(body);
    else if (name === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || !(type in CHANNELS)) {
    throw new Error(
      `unsupported PNG (depth ${depth}, colour type ${type}, interlace ${interlace})`,
    );
  }
  const channels = CHANNELS[type]!;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(data));
  const out = new Uint8Array(width * height * 3);
  let prev = new Uint8Array(stride);
  let line = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const start = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const value = raw[start + x]!;
      const a = x >= channels ? line[x - channels]! : 0;
      const b = prev[x]!;
      const c = x >= channels ? prev[x - channels]! : 0;
      let v: number;
      switch (filter) {
        case 0:
          v = value;
          break;
        case 1:
          v = value + a;
          break;
        case 2:
          v = value + b;
          break;
        case 3:
          v = value + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`bad PNG filter ${filter}`);
      }
      line[x] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      const i = x * channels;
      if (type === 2 || type === 6) {
        out[o] = line[i]!;
        out[o + 1] = line[i + 1]!;
        out[o + 2] = line[i + 2]!;
      } else if (type === 3 && palette) {
        const p = line[i]! * 3;
        out[o] = palette[p]!;
        out[o + 1] = palette[p + 1]!;
        out[o + 2] = palette[p + 2]!;
      } else {
        out[o] = out[o + 1] = out[o + 2] = line[i]!;
      }
    }
    [prev, line] = [line, prev];
  }
  return { width, height, rgb: out };
}

/** Relative luminance, as WCAG defines it. */
export function luminance(r: number, g: number, b: number): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(l1: number, l2: number): number {
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
