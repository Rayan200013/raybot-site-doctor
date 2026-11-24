// check_page: one address as a search engine and a share preview see it.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { defineTool, common, parseTarget, UserError } from '../core/tool.ts';
import { Findings, type Catalogue } from '../core/report.ts';
import { Site, toUrl } from '../core/site.ts';
import { readOne, type PageRecord } from '../core/crawl.ts';
import { key } from '../core/page.ts';
import { imageSize } from '../core/image-size.ts';
import { kb, quote, length, ms } from '../core/text.ts';
import { PAGE_KINDS, checkPageItself, checkReachable } from '../checks/page-rules.ts';

const KINDS: Catalogue = {
  ...PAGE_KINDS,
  'canonical-broken': {
    severity: 'fix-first',
    title: 'The canonical address does not answer 200',
    advice:
      'Point rel="canonical" at the final, working address of the page (no redirect, no error).',
  },
  'hreflang-broken': {
    severity: 'fix-first',
    title: 'A language version named in hreflang does not answer 200',
    advice:
      'Point each hreflang link at the working, final address of that language version; search engines drop the whole set when links in it fail.',
  },
  'hreflang-not-reciprocal': {
    severity: 'worth-fixing',
    title: 'A language version does not point back',
    advice:
      'Each version must list the others, this page included; one-way hreflang links are ignored.',
  },
  'share-image-broken': {
    severity: 'fix-first',
    title: 'The share image does not load',
    advice:
      'Make og:image a full https address of a picture that answers 200 with an image Content-Type; otherwise shared links show no picture.',
  },
  'share-image-small': {
    severity: 'worth-fixing',
    title: 'The share image is smaller than 200×200',
    advice:
      'Facebook ignores images under 200×200 and most apps show a small thumbnail; use about 1200×630.',
  },
};

export function registerCheckPage(server: McpServer): void {
  defineTool(server, {
    name: 'check_page',
    title: 'Check one page',
    description:
      'Reads one web page the way a search engine and a WhatsApp or Facebook link preview see it, and ranks what is wrong. Reports: the status and redirects; the title and meta description (present, length); the H1; the canonical address (and that it answers); robots meta and X-Robots-Tag; lang and dir; the hreflang language versions (each one loads and points back); the share title, description and image (and that the image loads and is big enough); the viewport; JSON-LD types; images without alt; HTML size, compression, caching and server time. Read-only: GET requests only, robots.txt followed.',
    input: {
      url: z.string().describe('The page to check, for example https://example.com/about'),
      ignore_robots_txt: common.ignore_robots_txt,
      delay_ms: common.delay_ms,
      kind: common.kind,
    },
    async run(args, ctx) {
      const url = parseTarget(args.url, toUrl);
      const started = new Date();
      const site = new Site(url, {
        ignoreRobots: args.ignore_robots_txt,
        delayMs: args.delay_ms,
        signal: ctx.signal,
      });
      const f = new Findings(KINDS);
      ctx.progress(0, 4, `reading ${url.href}`);
      const record = await readOne(site, url.href);
      if (record.error && record.chain.length === 0)
        throw new UserError(`Could not read ${url.href}: ${record.error}.`);
      const at = record.final;

      f.facts['status'] = record.status;
      if (record.final !== url.href) f.facts['final address'] = record.final;
      if (record.chain.length > 1)
        f.facts['redirects'] = record.chain
          .slice(0, -1)
          .map((h) => `${h.status} ${h.url}`)
          .join(' → ');

      if (checkReachable(record, f, at)) {
        const facts = record.facts!;
        f.facts['title'] = facts.titles[0]
          ? `${quote(facts.titles[0])} (${length(facts.titles[0])} characters)`
          : null;
        f.facts['description'] = facts.descriptions[0]
          ? `${quote(facts.descriptions[0], 200)} (${length(facts.descriptions[0])})`
          : null;
        f.facts['H1'] =
          facts.headings
            .filter((h) => h.level === 1)
            .map((h) => quote(h.text, 80))
            .join(' | ') || null;
        f.facts['canonical'] = facts.canonicals[0] ?? null;
        f.facts['lang / dir'] = `${facts.lang ?? '(none)'} / ${facts.dir ?? '(none)'}`;
        f.facts['robots'] = record.robotsSaid.join(', ') || 'nothing said (index, follow)';
        f.facts['language versions'] = facts.hreflang.length
          ? facts.hreflang.map((h) => h.lang).join(', ')
          : null;
        f.facts['JSON-LD'] = jsonLdTypes(facts.jsonLd.map((b) => b.value)).join(', ') || null;
        f.facts['HTML'] =
          `${kb(record.bytes)}${record.encoding ? `, ${kb(record.wireBytes)} sent (${record.encoding})` : ' (not compressed)'}`;
        f.facts['first byte'] = record.ttfbMs !== null ? ms(record.ttfbMs) : null;
        f.facts['cache-control'] = record.headers['cache-control'] ?? '(none)';
        f.facts['links / images'] = `${facts.links.length} / ${facts.images.length}`;

        checkPageItself(record, f, at);
        await checkCanonical(site, record, f);
        ctx.progress(1, 4, 'reading the language versions');
        await checkAlternates(site, record, f);
        ctx.progress(2, 4, 'loading the share image');
        await checkShareImage(site, record, f);

        f.passIfNone(
          ['title-missing', 'title-long', 'title-several'],
          'The title is there, and within 60 characters.',
        );
        f.passIfNone(
          ['description-missing', 'description-long', 'description-several'],
          'The description is there, and within 155 characters.',
        );
        f.passIfNone(['h1-missing', 'h1-several'], 'One H1.');
        f.passIfNone(
          ['canonical-missing', 'canonical-several', 'canonical-broken'],
          'One canonical address, and it answers.',
        );
        if (facts.hreflang.length)
          f.passIfNone(
            ['hreflang-broken', 'hreflang-not-reciprocal', 'hreflang-no-self', 'hreflang-invalid'],
            'Every language version answers and points back.',
          );
        f.passIfNone(
          ['share-image-missing', 'share-image-broken', 'share-image-small'],
          'The share image loads and is big enough.',
        );
        f.passIfNone(
          ['viewport-missing', 'viewport-no-zoom'],
          'The viewport is set for phones and lets people zoom.',
        );
        f.passIfNone(['img-no-alt'], 'Every image has an alt attribute.');
        f.passIfNone(['not-compressed'], 'The HTML is compressed.');
        if (facts.hasMicrodata)
          f.notes.push('The page also has microdata (itemscope); only JSON-LD is checked.');
      }
      f.headline.push(...site.robotsHeadline());
      f.facts['requests made'] = site.requests;
      return f.report('check_page', url.href, site.ignoreRobots ? 'ignored' : 'followed', started);
    },
  });
}

export function jsonLdTypes(values: unknown[]): string[] {
  const types = new Set<string>();
  const visit = (v: unknown, depth: number) => {
    if (!v || typeof v !== 'object' || depth > 3) return;
    if (Array.isArray(v)) return v.forEach((x) => visit(x, depth));
    const o = v as Record<string, unknown>;
    if (o['@graph']) visit(o['@graph'], depth);
    const t = o['@type'];
    if (depth <= 1)
      for (const x of Array.isArray(t) ? t : t ? [t] : [])
        types.add(String(x).replace(/^https?:\/\/schema\.org\//, ''));
  };
  for (const v of values) visit(v, 0);
  return [...types];
}

async function checkCanonical(site: Site, record: PageRecord, f: Findings): Promise<void> {
  const canonical = record.facts?.canonicals[0];
  if (
    !canonical ||
    key(canonical) === key(record.final) ||
    (record.facts?.canonicals.length ?? 0) > 1
  )
    return;
  const target = await readOne(site, canonical);
  if (target.blockedBy || target.leftSiteTo) return;
  if (target.error || target.status !== 200 || target.chain.length > 1) {
    f.add(
      'canonical-broken',
      record.final,
      `${canonical} ${target.error ?? (target.chain.length > 1 ? `redirects to ${target.final}` : `answers ${target.status}`)}`,
    );
  }
}

async function checkAlternates(site: Site, record: PageRecord, f: Findings): Promise<void> {
  const alternates = (record.facts?.hreflang ?? []).filter(
    (h) => key(h.href) !== key(record.final),
  );
  const seen = new Set<string>();
  for (const alt of alternates.slice(0, 20)) {
    if (seen.has(key(alt.href))) continue;
    seen.add(key(alt.href));
    // The page names its own language versions: they are part of the site.
    try {
      site.addOrigin(new URL(alt.href).origin);
    } catch {
      continue;
    }
    const other = await readOne(site, alt.href);
    if (other.blockedBy) continue;
    if (other.error || other.status !== 200 || other.chain.length > 1) {
      f.add(
        'hreflang-broken',
        record.final,
        `${alt.lang} → ${alt.href}: ${other.error ?? (other.chain.length > 1 ? `redirects to ${other.final}` : `answers ${other.status}`)}`,
      );
      continue;
    }
    const back = (other.facts?.hreflang ?? []).some((h) => key(h.href) === key(record.final));
    if (!back)
      f.add(
        'hreflang-not-reciprocal',
        record.final,
        `${alt.lang} → ${alt.href} does not list this page`,
      );
  }
}

async function checkShareImage(site: Site, record: PageRecord, f: Findings): Promise<void> {
  const raw = record.facts?.meta['og:image'];
  if (!raw) return;
  let src: URL;
  try {
    src = new URL(raw, record.final);
  } catch {
    f.add('share-image-broken', record.final, `not an address: ${quote(raw)}`);
    return;
  }
  const res = await site.fetch(src, {
    kind: 'resource',
    accept: 'image/avif,image/webp,image/*;q=0.8',
    maxBytes: 16 * 1024 * 1024,
  });
  const r = res.response;
  if (!r || r.status !== 200) {
    f.add('share-image-broken', record.final, `${src.href} ${res.error ?? `answers ${r?.status}`}`);
    return;
  }
  const type = r.headers['content-type'] ?? '';
  if (!/^image\//i.test(type)) {
    f.add(
      'share-image-broken',
      record.final,
      `${src.href} is ${type || 'not labelled'}, not an image`,
    );
    return;
  }
  const size = imageSize(r.body);
  f.facts['share image'] =
    `${src.href} (${size ? `${size.width}×${size.height}, ` : ''}${kb(r.body.length)}, ${type})`;
  if (size && (size.width < 200 || size.height < 200))
    f.add('share-image-small', record.final, `${size.width}×${size.height}`);
  if (!/^https?:\/\//i.test(raw))
    f.notes.push(
      `og:image is written as a relative address (${raw}); some apps need a full https address.`,
    );
}
