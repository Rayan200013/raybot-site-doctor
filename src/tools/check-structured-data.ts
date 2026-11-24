// check_structured_data: JSON-LD on one page, or on every page of a site.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { defineTool, common, parseTarget, UserError } from '../core/tool.ts';
import { Findings, type Catalogue } from '../core/report.ts';
import { Site, toUrl } from '../core/site.ts';
import {
  crawl,
  discover,
  listedPages,
  readOne,
  uniquePages,
  type PageRecord,
} from '../core/crawl.ts';
import { plural, short, duration } from '../core/text.ts';
import { SD_KINDS, checkJsonLd, vocab } from '../checks/structured-data.ts';
import { PAGE_KINDS, checkReachable } from '../checks/page-rules.ts';
import { DEFAULT_PAGES, MAX_PAGES } from './check-sitemaps.ts';

const KINDS: Catalogue = {
  ...SD_KINDS,
  'page-error': PAGE_KINDS['page-error']!,
  'robots-blocked': PAGE_KINDS['robots-blocked']!,
  'redirect-chain': PAGE_KINDS['redirect-chain']!,
  'left-site': PAGE_KINDS['left-site']!,
  'not-html': PAGE_KINDS['not-html']!,
  'sd-none': {
    severity: 'note',
    title: 'Pages with no JSON-LD at all',
    advice:
      'Not an error. Structured data (an Organization on the home page, BreadcrumbList on inner pages, Product, Event or LocalBusiness where they apply) helps search engines show richer results.',
  },
};

const RULES_CHECKED =
  'Google rules checked: BreadcrumbList, FAQPage, Product and Offer, Article, Organization, LocalBusiness, Event.';

export function registerCheckStructuredData(server: McpServer): void {
  defineTool(server, {
    name: 'check_structured_data',
    title: 'Check structured data (JSON-LD)',
    description:
      "Checks the JSON-LD structured data on one page, or on every page of a site (whole_site: true, found through its sitemaps). Against schema.org's own vocabulary (shipped with the server, its version named): types and properties that don't exist, properties on a type they don't belong to, superseded properties. Against Google's rules for the rich results it shows: breadcrumbs, FAQ, product and offer, article, organization, local business, event. And @id references that point at nothing on the page. Read-only; robots.txt followed.",
    input: {
      url: z
        .string()
        .describe('A page, or (with whole_site) the site, for example https://example.com'),
      whole_site: z
        .boolean()
        .default(false)
        .describe('Check every page the sitemaps list, not just this one.'),
      max_pages: z
        .number()
        .int()
        .min(1)
        .max(MAX_PAGES)
        .default(DEFAULT_PAGES)
        .describe(`With whole_site: how many pages to read at most (at most ${MAX_PAGES}).`),
      ignore_robots_txt: common.ignore_robots_txt,
      delay_ms: common.delay_ms,
      kind: common.kind,
    },
    async run(args, ctx) {
      const url = parseTarget(args.url, toUrl);
      const started = new Date();
      const t0 = Date.now();
      const site = new Site(url, {
        ignoreRobots: args.ignore_robots_txt,
        delayMs: args.delay_ms,
        signal: ctx.signal,
      });
      const f = new Findings(KINDS);
      let pages: PageRecord[];
      let target = url.href;
      if (args.whole_site) {
        const first = await site.fetch(url, { kind: 'page' });
        if (first.error && first.chain.length === 0)
          throw new UserError(`Could not reach ${url.href}: ${first.error}.`);
        const origin = new URL(first.final).origin;
        target = origin;
        const found = await discover(site, origin, ctx.progress);
        const listed = listedPages(site, found).map((p) => p.url);
        const result = await crawl(site, first.final, listed, args.max_pages, ctx.progress);
        pages = result.pages;
        if (result.stoppedEarly)
          f.notes.push(
            `Read ${pages.length} pages (max_pages); ${result.leftUnread} more were found.`,
          );
      } else {
        const one = await readOne(site, url.href);
        if (one.error && one.chain.length === 0)
          throw new UserError(`Could not read ${url.href}: ${one.error}.`);
        pages = [one];
      }

      const origin = new URL(target).origin;
      const typeCount = new Map<string, number>();
      let blocks = 0;
      let withData = 0;
      let unread = 0;
      for (const p of uniquePages(pages)) {
        const at = short(p.final, origin);
        if (args.whole_site && (p.error || p.blockedBy || (p.status !== null && p.status >= 400))) {
          // Across a site, pages that can't be read are check_site's to report.
          unread++;
          continue;
        }
        if (!checkReachable(p, f, at)) continue;
        const facts = p.facts!;
        if (facts.jsonLd.length === 0) {
          f.add('sd-none', at);
          continue;
        }
        withData++;
        blocks += facts.jsonLd.length;
        for (const t of checkJsonLd(facts.jsonLd, f, at))
          typeCount.set(t, (typeCount.get(t) ?? 0) + 1);
        if (facts.hasMicrodata)
          f.notes.push(`${at} also has microdata (itemscope); only JSON-LD is checked.`);
      }
      const v = vocab();
      f.facts['pages read'] = pages.length;
      f.facts['pages with JSON-LD'] = withData;
      f.facts['JSON-LD blocks'] = blocks;
      f.facts['types found'] =
        [...typeCount]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20)
          .map(([t, n]) => `${t} ×${n}`)
          .join(', ') || null;
      f.facts['vocabulary'] = `schema.org ${v.version} (released ${v.released})`;
      f.facts['time'] = duration(Date.now() - t0);
      f.notes.push(RULES_CHECKED);
      if (unread)
        f.notes.push(
          `${plural(unread, 'page')} could not be read (an error, or robots.txt disallows them); check_site lists them.`,
        );

      if (blocks) {
        f.passIfNone(
          ['sd-unparseable', 'sd-no-context'],
          'Every JSON-LD block parses and names schema.org.',
        );
        f.passIfNone(
          ['sd-unknown-type', 'sd-unknown-property', 'sd-wrong-property'],
          'Every type and property exists in schema.org and belongs where it is used.',
        );
        f.passIfNone(
          ['google-required', 'google-breadcrumb-order'],
          'Nothing Google requires for its rich results is missing.',
        );
        f.passIfNone(['sd-missing-id'], 'Every @id reference points at a node on the same page.');
      }
      f.headline.push(...site.robotsHeadline());
      return f.report(
        'check_structured_data',
        target,
        site.ignoreRobots ? 'ignored' : 'followed',
        started,
      );
    },
  });
}
