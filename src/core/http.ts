// One HTTP request, done by hand with node:http so the report can say exactly
// what came over the wire: the status, every header, the bytes before and
// after decompression, and how long the first byte took. Never follows
// redirects by itself: the caller decides, hop by hop.
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { USER_AGENT } from '../version.ts';

export interface HttpResponse {
  url: string;
  status: number;
  /** Header names in lower case; repeated headers joined with ", ". */
  headers: Record<string, string>;
  /** The body after decompression. */
  body: Buffer;
  /** Body bytes as they came over the wire (compressed, when it was). */
  wireBytes: number;
  /** The content-encoding the server used, if any. */
  encoding: string | null;
  /** True when the body was longer than the limit and was cut. */
  truncated: boolean;
  ttfbMs: number;
  totalMs: number;
}

export interface RequestOptions {
  method?: 'GET' | 'HEAD';
  accept?: string;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

export class RequestError extends Error {
  constructor(message: string, url: string, code: string) {
    super(message);
    this.url = url;
    this.code = code;
  }
  readonly url: string;
  readonly code: string;
}

const DEFAULT_TIMEOUT = 15_000;
const DEFAULT_MAX = 10 * 1024 * 1024;

export function request(target: URL, options: RequestOptions = {}): Promise<HttpResponse> {
  const { method = 'GET', timeoutMs = DEFAULT_TIMEOUT, maxBytes = DEFAULT_MAX, signal } = options;
  const lib = target.protocol === 'https:' ? https : target.protocol === 'http:' ? http : null;
  if (!lib)
    return Promise.reject(new RequestError(`not an http(s) address`, target.href, 'BAD_URL'));
  const started = performance.now();

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (message: string, code: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      reject(new RequestError(message, target.href, code));
    };
    const req = lib.request(
      target,
      {
        method,
        headers: {
          'user-agent': USER_AGENT,
          accept:
            options.accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-encoding': 'gzip, deflate, br',
          'accept-language': 'en;q=0.9, *;q=0.5',
        },
      },
      (res) => {
        const ttfbMs = performance.now() - started;
        const chunks: Buffer[] = [];
        let wire = 0;
        let truncated = false;
        res.on('data', (chunk: Buffer) => {
          wire += chunk.length;
          if (wire > maxBytes) {
            truncated = true;
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
          }
          const raw = Buffer.concat(chunks);
          const encoding = (headers['content-encoding'] ?? '').trim().toLowerCase() || null;
          let body: Buffer = raw;
          if (encoding && raw.length && !truncated) {
            try {
              body = decompress(raw, encoding, maxBytes);
            } catch {
              // A body that says it is compressed but isn't: keep the bytes as they came.
              body = raw;
            }
          }
          resolve({
            url: target.href,
            status: res.statusCode ?? 0,
            headers,
            body,
            wireBytes: wire,
            encoding,
            truncated,
            ttfbMs,
            totalMs: performance.now() - started,
          });
        };
        res.on('end', finish);
        res.on('close', finish);
        res.on('error', (e) => fail(e.message, 'READ'));
      },
    );
    const timer = setTimeout(
      () => fail(`no answer within ${timeoutMs / 1000} s`, 'TIMEOUT'),
      timeoutMs,
    );
    req.on('error', (e: NodeJS.ErrnoException) => fail(describeError(e), e.code ?? 'NETWORK'));
    if (signal) {
      if (signal.aborted) fail('cancelled', 'CANCELLED');
      signal.addEventListener('abort', () => fail('cancelled', 'CANCELLED'), { once: true });
    }
    req.end();
  });
}

function decompress(raw: Buffer, encoding: string, maxBytes: number): Buffer {
  const opts = { maxOutputLength: maxBytes * 8 };
  if (encoding === 'gzip' || encoding === 'x-gzip') return zlib.gunzipSync(raw, opts);
  if (encoding === 'br') return zlib.brotliDecompressSync(raw, opts);
  if (encoding === 'deflate') {
    try {
      return zlib.inflateSync(raw, opts);
    } catch {
      return zlib.inflateRawSync(raw, opts);
    }
  }
  const zstd = (zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer })
    .zstdDecompressSync;
  if (encoding === 'zstd' && zstd) return zstd(raw);
  return raw;
}

function describeError(e: NodeJS.ErrnoException): string {
  switch (e.code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'the address does not resolve (DNS)';
    case 'ECONNREFUSED':
      return 'the connection was refused (is the server running?)';
    case 'ECONNRESET':
      return 'the connection was reset';
    case 'CERT_HAS_EXPIRED':
      return 'its HTTPS certificate has expired';
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return 'its HTTPS certificate is self-signed (not trusted)';
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return 'its HTTPS certificate is for another name';
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return 'its HTTPS certificate chain is incomplete';
    default:
      return e.message;
  }
}

/** Reads a body as text, using the charset its headers or its own markup name. */
export function bodyText(res: HttpResponse): string {
  const type = res.headers['content-type'] ?? '';
  let charset = /charset=["']?([\w-]+)/i.exec(type)?.[1];
  if (!charset) {
    const head = res.body.subarray(0, 2048).toString('latin1');
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(res.body);
  } catch {
    return new TextDecoder('utf-8').decode(res.body);
  }
}
