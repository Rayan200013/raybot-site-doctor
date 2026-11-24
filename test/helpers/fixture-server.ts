// Serves a fixture site (test/fixtures/<name>) on a free local port:
// "{{ORIGIN}}" in text files becomes the site's own address, routes.json
// names redirects and whether to compress, and /share.png is drawn on the fly.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { gzipSync, deflateSync, crc32 } from 'node:zlib';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../fixtures/', import.meta.url));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.png': 'image/png',
};

interface Routes {
  redirects?: Record<string, string>;
  compress?: boolean;
}

/** A plain PNG of one colour. */
export function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  return pngFrom(width, height, Buffer.concat(Array.from({ length: height }, () => row)));
}

/**
 * A PNG full of seeded noise: a picture with real detail. Chrome does not count a
 * near-empty picture (a flat colour, a tiny SVG) as the page's largest paint.
 */
export function noisePng(width: number, height: number, seed = 7): Buffer {
  let s = seed;
  const next = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s >> 16;
  };
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      const base = 90 + Math.round(60 * Math.sin((x + y) / 30));
      row[1 + x * 3] = (base + (next() & 63)) & 0xff;
      row[2 + x * 3] = (base + 20 + (next() & 63)) & 0xff;
      row[3 + x * 3] = (base + 40 + (next() & 63)) & 0xff;
    }
    rows.push(row);
  }
  return pngFrom(width, height, Buffer.concat(rows));
}

function pngFrom(width: number, height: number, raw: Buffer): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export interface Served {
  origin: string;
  requests: string[];
  close: () => Promise<void>;
}

export async function serveFixture(name: string, port = 0): Promise<Served> {
  const dir = join(ROOT, name);
  const routes: Routes = existsSync(join(dir, 'routes.json'))
    ? JSON.parse(readFileSync(join(dir, 'routes.json'), 'utf8'))
    : {};
  const share = solidPng(1200, 630, [40, 70, 120]);
  const hero = noisePng(240, 120);
  const requests: string[] = [];
  let origin = '';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', origin);
    requests.push(`${req.method} ${url.pathname}`);
    const target = routes.redirects?.[url.pathname];
    if (target) {
      res.writeHead(301, { location: target });
      res.end();
      return;
    }
    if (url.pathname === '/share.png' || url.pathname === '/hero.png') {
      const png = url.pathname === '/share.png' ? share : hero;
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-length': png.length,
        'cache-control': 'max-age=60',
      });
      res.end(req.method === 'HEAD' ? undefined : png);
      return;
    }
    const candidates =
      url.pathname === '/'
        ? ['index.html']
        : [url.pathname.slice(1), url.pathname.slice(1) + '.html'];
    const file = candidates
      .map((c) => join(dir, c))
      .find((p) => p.startsWith(dir) && existsSync(p) && !p.endsWith('routes.json'));
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Not found</title><h1>Not found</h1>');
      return;
    }
    const type = TYPES[extname(file)] ?? 'application/octet-stream';
    let body: Buffer = readFileSync(file);
    if (/^(text|application\/xml|image\/svg)/.test(type))
      body = Buffer.from(body.toString('utf8').replaceAll('{{ORIGIN}}', origin));
    const headers: Record<string, string> = { 'content-type': type, 'cache-control': 'max-age=60' };
    if (
      routes.compress &&
      /gzip/.test(String(req.headers['accept-encoding'] ?? '')) &&
      /^(text|application\/xml|image\/svg)/.test(type)
    ) {
      body = gzipSync(body);
      headers['content-encoding'] = 'gzip';
    }
    headers['content-length'] = String(body.length);
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
