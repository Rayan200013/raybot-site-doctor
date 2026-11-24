// The width and height of a picture from its first bytes: PNG, GIF, JPEG,
// WebP and AVIF. Enough to say whether a share image is big enough.

export function imageSize(b: Buffer): { width: number; height: number; type: string } | null {
  if (b.length < 24) return null;
  // PNG: the IHDR chunk.
  if (b.readUInt32BE(0) === 0x89504e47)
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), type: 'png' };
  // GIF
  if (b.toString('ascii', 0, 3) === 'GIF')
    return { width: b.readUInt16LE(6), height: b.readUInt16LE(8), type: 'gif' };
  // WebP
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = b.toString('ascii', 12, 16);
    if (chunk === 'VP8X' && b.length >= 30) {
      return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3), type: 'webp' };
    }
    if (chunk === 'VP8 ' && b.length >= 30) {
      return {
        width: b.readUInt16LE(26) & 0x3fff,
        height: b.readUInt16LE(28) & 0x3fff,
        type: 'webp',
      };
    }
    if (chunk === 'VP8L' && b.length >= 25) {
      const bits = b.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, type: 'webp' };
    }
    return null;
  }
  // JPEG: walk the markers to the first frame header.
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = b.readUInt16BE(i + 2);
      const isFrame =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame)
        return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5), type: 'jpeg' };
      i += 2 + len;
    }
    return null;
  }
  // AVIF / HEIF: the "ispe" property box holds the size.
  if (b.toString('ascii', 4, 8) === 'ftyp') {
    const at = b.indexOf('ispe');
    if (at > 0 && at + 16 <= b.length) {
      return {
        width: b.readUInt32BE(at + 8),
        height: b.readUInt32BE(at + 12),
        type: b.toString('ascii', 8, 12).trim(),
      };
    }
  }
  return null;
}
