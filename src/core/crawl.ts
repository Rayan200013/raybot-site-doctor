// Finding a site's pages (its sitemaps, or its links when it has none) and
// reading them one by one, politely. Shared by check_sitemaps, check_site and
// check_structured_data.
import { bodyText } from './http.ts';
import { isHtml, key, readPage, robotsDirectives, type PageFacts } from './page.ts';
import { Site, type Fetched, type Hop, type RobotsState } from './site.ts';
import { parseSitemap, type ParsedSitemap, type SitemapEntry } from './sitemap.ts';
import type { Rule } from './robots.ts';

export type Progress = (done: number, total: number | undefined, message: string) => void;

export interface PageRecord {
  url: string;
  key: string;
  final: string;
  status: number | null;
  chain: Hop[];
  error?: string;
  blockedBy?: Rule | 'unreachable-robots';
  leftSiteTo?: string;
  contentType: string | null;
  headers: Record<string, string>;
  facts?: PageFacts;
  noindex: boolean;
  robotsSaid: string[];
  bytes: number;
  wireBytes: number;
  encoding: string | null;
  ttfbMs: number | null;
  truncated: boolean;
}

export function recordFrom(fetched: Fetched): PageRecord {
  const res = fetched.response;
  const record: PageRecord = {
    url: fetched.requested,
    key: key(fetched.final),
    final: fetched.final,
    status: res?.status ?? null,
    chain: fetched.chain,
    contentType: res?.headers['content-type'] ?? null,
    headers: res?.headers ?? {},
    noindex: false,
    robotsSaid: [],
    bytes: res?.body.length ?? 0,
    wireBytes: res?.wireBytes ?? 0,
    encoding: res?.encoding ?? null,
    ttfbMs: res?.ttfbMs ?? null,
    truncated: res?.truncated ?? false,
  };
  if (fetched.error) record.error = fetched.error;
  if (fetched.blockedBy) record.blockedBy = fetched.blockedBy;
  if (fetched.leftSiteTo) record.leftSiteTo = fetched.leftSiteTo;
  if (res && res.status >= 200 && res.status < 300 && isHtml(record.contentType ?? undefined)) {
    record.facts = readPage(bodyText(res), fetched.final);
    const r = robotsDirectives(record.facts, res.headers['x-robots-tag']);
    record.noindex = r.noindex;
    record.robotsSaid = r.said;
  } else if (res) {
    const r = robotsDirectives({ robots: [] } as unknown as PageFacts, res.headers['x-robots-tag']);
    record.noindex = r.noindex;
    record.robotsSaid = r.said;
  }
  return record;
}

export async function readOne(site: Site, url: string): Promise<PageRecord> {
  return recordFrom(await site.fetch(url, { kind: 'page' }));
}

// ---------------------------------------------------------------------------

export interface SitemapRead {
  url: string;
  from: 'robots.txt' | 'the usual address' | 'a sitemap index';
  status: number | null;
  error?: string;
  parsed?: ParsedSitemap;
  redirectedTo?: string;
  contentType: string | null;
}

export interface Discovery {
  robots: RobotsState;
  sitemaps: SitemapRead[];
  entries: (SitemapEntry & { sitemap: string })[];
}

const MAX_SITEMAPS = 100;

export async function discover(
  site: Site,
  origin: string,
  progress?: Progress,
): Promise<Discovery> {
  const robots = await site.robotsFor(origin);
  const queue: { url: string; from: SitemapRead['from'] }[] = [];
  const named = robots.robots?.sitemaps ?? [];
  for (const s of named) {
    try {
      queue.push({ url: new URL(s, origin).href, from: 'robots.txt' });
    } catch {
      // An invalid Sitemap line; check_sitemaps reports it from robots.txt itself.
    }
  }
  const usual = queue.length === 0;
  if (usual) queue.push({ url: new URL('/sitemap.xml', origin).href, from: 'the usual address' });

  const sitemaps: SitemapRead[] = [];
  const entries: Discovery['entries'] = [];
  const seen = new Set<string>();
  while (queue.length && sitemaps.length < MAX_SITEMAPS) {
    const next = queue.shift()!;
    if (seen.has(next.url)) continue;
    seen.add(next.url);
    progress?.(sitemaps.length, undefined, `reading sitemap ${next.url}`);
    const fetched = await site.fetch(next.url, {
      kind: 'resource',
      accept: 'application/xml,text/xml;q=0.9,*/*;q=0.5',
      maxBytes: 60 * 1024 * 1024,
    });
    const res = fetched.response;
    const read: SitemapRead = {
      url: next.url,
      from: next.from,
      status: res?.status ?? null,
      contentType: res?.headers['content-type'] ?? null,
    };
    if (fetched.error) read.error = fetched.error;
    if (fetched.final !== next.url) read.redirectedTo = fetched.final;
    if (res && res.status === 200) {
      read.parsed = parseSitemap(res.body);
      if (read.parsed.type === 'sitemapindex') {
        for (const child of read.parsed.sitemaps) {
          try {
            queue.push({ url: new URL(child.loc, next.url).href, from: 'a sitemap index' });
          } catch {
            read.parsed.problems.push(`an invalid <loc>: ${child.loc}`);
          }
        }
      } else {
        for (const e of read.parsed.entries) entries.push({ ...e, sitemap: next.url });
      }
    }
    sitemaps.push(read);
    // No sitemap at /sitemap.xml: try the other usual name once.
    if (usual && sitemaps.length === 1 && res?.status !== 200) {
      queue.push({ url: new URL('/sitemap_index.xml', origin).href, from: 'the usual address' });
    }
  }
  return { robots, sitemaps, entries };
}

/** Every page a site's sitemaps name: each <loc> and each language alternate. */
export function listedPages(
  site: Site,
  discovery: Discovery,
): { url: string; fromAlternate: boolean }[] {
  const out: { url: string; fromAlternate: boolean }[] = [];
  const seen = new Set<string>();
  const push = (u: string, fromAlternate: boolean) => {
    let url: URL;
    try {
      url = new URL(u);
    } catch {
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    const k = key(url.href);
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ url: url.href, fromAlternate });
  };
  for (const e of discovery.entries) {
    push(e.loc, false);
    for (const a of e.alternates) {
      if (a.lang === 'x-default') continue;
      // The site's language versions are part of the site, wherever they live.
      try {
        site.addOrigin(new URL(a.href).origin);
      } catch {
        continue;
      }
      push(a.href, true);
    }
  }
  return out;
}

export interface CrawlResult {
  pages: PageRecord[];
  /** How the pages were found. */
  source: 'sitemaps' | 'links';
  listed: number;
  /** Pages listed or linked but not read, because the page cap was reached. */
  leftUnread: number;
  /** Pages found only by following links (not in any sitemap). */
  linkedOnly: Set<string>;
  /** Links with a query string not followed (filters, sorting, tracking), when sitemaps exist. */
  queryLinksSkipped: number;
  stoppedEarly: boolean;
}

/**
 * Reads the listed pages, then the pages they link to that no sitemap
 * names, until the cap. Without sitemaps, follows links from the first page.
 */
export async function crawl(
  site: Site,
  start: string,
  listed: string[],
  max: number,
  progress?: Progress,
): Promise<CrawlResult> {
  const pages: PageRecord[] = [];
  const done = new Set<string>();
  const queue: string[] = [];
  const queued = new Set<string>();
  const linkedOnly = new Set<string>();
  const source: CrawlResult['source'] = listed.length ? 'sitemaps' : 'links';
  const enqueue = (u: string, fromLink: boolean) => {
    const k = key(u);
    if (queued.has(k)) return;
    queued.add(k);
    queue.push(u);
    if (fromLink) linkedOnly.add(k);
  };
  if (listed.length) for (const u of listed) enqueue(u, false);
  else enqueue(start, false);

  let stoppedEarly = false;
  const skippedQueries = new Set<string>();
  while (queue.length) {
    if (pages.length >= max) {
      stoppedEarly = true;
      break;
    }
    const url = queue.shift()!;
    const total = Math.min(max, queue.length + pages.length + 1);
    progress?.(pages.length, total, `reading ${url}`);
    const record = await readOne(site, url);
    pages.push(record);
    done.add(key(url));
    done.add(record.key);
    for (const link of record.facts?.links ?? []) {
      if (/\bnofollow\b/.test(link.rel)) continue;
      let target: URL;
      try {
        target = new URL(link.href);
      } catch {
        continue;
      }
      if (!site.isOnSite(target) || (target.protocol !== 'http:' && target.protocol !== 'https:'))
        continue;
      if (looksLikeFile(target.pathname)) continue;
      // With sitemaps, an address with a query string is a filter, a sort or a
      // tracking link to a page the sitemaps already name: not followed.
      if (listed.length && target.search && !queued.has(key(target.href))) {
        skippedQueries.add(key(target.href));
        continue;
      }
      enqueue(target.href, true);
    }
  }
  const leftUnread = queue.filter((u) => !done.has(key(u))).length;
  return {
    pages,
    source,
    listed: listed.length,
    leftUnread,
    linkedOnly,
    queryLinksSkipped: skippedQueries.size,
    stoppedEarly,
  };
}

/** One record per page: a redirect that lands on a page already read is not a second copy of it. */
export function uniquePages(pages: PageRecord[]): PageRecord[] {
  const seen = new Set<string>();
  const out: PageRecord[] = [];
  for (const p of pages) {
    const k = p.status !== null && p.status < 400 && !p.error ? p.key : `${p.key} ${p.url}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

/** Links to files (a PDF, a picture) are not pages to crawl. */
export function looksLikeFile(path: string): boolean {
  return /\.(pdf|jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|heic|mp4|webm|mov|m4v|mp3|m4a|ogg|wav|zip|gz|tgz|rar|7z|dmg|exe|msi|apk|docx?|xlsx?|pptx?|odt|csv|txt|xml|rss|atom|json|js|mjs|css|map|woff2?|ttf|otf|ics|vcf|epub)$/i.test(
    path,
  );
}
