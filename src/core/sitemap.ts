// Sitemaps as search engines read them (sitemaps.org): a urlset of <url>
// entries with <loc>, <lastmod> and language alternates (xhtml:link), or a
// sitemapindex pointing at more sitemaps; gzipped or not; or a plain text
// file with one address per line.
import { gunzipSync } from 'node:zlib';

export interface SitemapEntry {
  loc: string;
  lastmod: string | null;
  alternates: { lang: string; href: string }[];
}

export interface ParsedSitemap {
  type: 'urlset' | 'sitemapindex' | 'text' | 'unknown';
  entries: SitemapEntry[];
  /** For an index: the sitemaps it names. */
  sitemaps: { loc: string; lastmod: string | null }[];
  problems: string[];
  /** Uncompressed size in bytes. */
  bytes: number;
}

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
    .trim();

const tag = (block: string, name: string): string | null => {
  const m = new RegExp(
    `<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`,
    'i',
  ).exec(block);
  return m ? decode(m[1]!) : null;
};

/** A W3C datetime, as sitemaps want: 2026-11-23, or with a time and a zone. */
export function validLastmod(value: string): boolean {
  return (
    /^\d{4}(-\d{2}(-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?)?)?$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

export function parseSitemap(raw: Buffer): ParsedSitemap {
  let bytes = raw;
  const problems: string[] = [];
  if (raw[0] === 0x1f && raw[1] === 0x8b) {
    try {
      bytes = gunzipSync(raw, { maxOutputLength: 60 * 1024 * 1024 });
    } catch {
      return {
        type: 'unknown',
        entries: [],
        sitemaps: [],
        problems: ['it says it is gzipped but does not unzip'],
        bytes: raw.length,
      };
    }
  }
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
  const result: ParsedSitemap = {
    type: 'unknown',
    entries: [],
    sitemaps: [],
    problems,
    bytes: bytes.length,
  };
  if (bytes.length > 50 * 1024 * 1024)
    problems.push(
      `it is ${(bytes.length / 1024 / 1024).toFixed(0)} MB uncompressed; the limit is 50 MB`,
    );

  const head = text.slice(0, 4096);
  if (
    /<sitemapindex[\s>]/i.test(head) ||
    /<(?:\w+:)?sitemapindex[\s>]/i.test(text.slice(0, 20000))
  ) {
    result.type = 'sitemapindex';
    for (const m of text.matchAll(
      /<(?:[\w-]+:)?sitemap(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w-]+:)?sitemap>/gi,
    )) {
      const loc = tag(m[1]!, 'loc');
      if (loc) result.sitemaps.push({ loc, lastmod: tag(m[1]!, 'lastmod') });
      else problems.push('a <sitemap> without a <loc>');
    }
    checkBalance(text, 'sitemap', problems);
  } else if (/<(?:[\w-]+:)?urlset[\s>]/i.test(text.slice(0, 20000))) {
    result.type = 'urlset';
    for (const m of text.matchAll(/<(?:[\w-]+:)?url(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w-]+:)?url>/gi)) {
      const block = m[1]!;
      const loc = tag(block, 'loc');
      if (!loc) {
        problems.push('a <url> without a <loc>');
        continue;
      }
      const alternates: SitemapEntry['alternates'] = [];
      for (const l of block.matchAll(/<(?:[\w-]+:)?link\s([^>]*?)\/?>/gi)) {
        const attrs = l[1]!;
        const rel = /rel=["']([^"']+)["']/i.exec(attrs)?.[1];
        const lang = /hreflang=["']([^"']+)["']/i.exec(attrs)?.[1];
        const href = /href=["']([^"']+)["']/i.exec(attrs)?.[1];
        if (rel === 'alternate' && lang && href)
          alternates.push({ lang: lang.toLowerCase(), href: decode(href) });
      }
      result.entries.push({ loc, lastmod: tag(block, 'lastmod'), alternates });
    }
    checkBalance(text, 'url', problems);
    if (
      !/xmlns=["']http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9["']/i.test(
        text.slice(0, 4096),
      )
    ) {
      problems.push(
        'the <urlset> lacks the sitemaps.org namespace (xmlns="http://www.sitemaps.org/schemas/sitemap/0.9")',
      );
    }
  } else if (!/^\s*</.test(text)) {
    // A plain text sitemap: one absolute address per line.
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length && lines.every((l) => /^https?:\/\//i.test(l))) {
      result.type = 'text';
      result.entries = lines.map((loc) => ({ loc, lastmod: null, alternates: [] }));
    } else {
      problems.push('it is neither XML nor a list of addresses');
    }
  } else {
    problems.push('it is XML, but neither a <urlset> nor a <sitemapindex>');
  }

  // A bare "&" breaks XML: a parser stops there and the rest of the file is lost.
  const bare = text.match(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/gi);
  if (bare && result.type !== 'text')
    problems.push(`${bare.length} "&" not written as &amp; (the file is not valid XML)`);
  if (result.entries.length > 50000)
    problems.push(`${result.entries.length} addresses; the limit is 50,000 per sitemap`);
  return result;
}

function checkBalance(text: string, name: string, problems: string[]): void {
  const open = text.match(new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>`, 'gi'))?.length ?? 0;
  const close = text.match(new RegExp(`</(?:[\\w-]+:)?${name}>`, 'gi'))?.length ?? 0;
  if (open !== close)
    problems.push(`${open} <${name}> opened but ${close} closed (the file is cut or broken)`);
}
