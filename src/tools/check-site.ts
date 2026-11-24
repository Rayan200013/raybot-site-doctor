// check_site: the crawl. Every page the sitemaps list (or the links reach),
// then what only a view across pages shows: duplicates, broken links, pages
// nothing links to, language versions that don't answer each other.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { defineTool, common, parseTarget, UserError } from '../core/tool.ts';
import { Findings, type Catalogue } from '../core/report.ts';
import { Site, toUrl } from '../core/site.ts';
import { crawl, discover, listedPages, uniquePages, type PageRecord } from '../core/crawl.ts';
import { key, primaryLanguage } from '../core/page.ts';
import { plural, short, duration, quote } from '../core/text.ts';
import { PAGE_KINDS, checkPageItself, checkReachable } from '../checks/page-rules.ts';
import { DEFAULT_PAGES, MAX_PAGES } from './check-sitemaps.ts';

const KINDS: Catalogue = {
  ...PAGE_KINDS,
  'broken-link': {
    severity: 'fix-first',
    title: 'Links between pages that lead to an error',
    advice:
      'Change each link to the page it meant, or bring the missing page back (or redirect its old address).',
  },
  'title-duplicate': {
    severity: 'worth-fixing',
    title: 'Pages in the same language sharing one title',
    advice:
      'Give each page its own title saying what is different about it; search engines show one of a set of look-alikes.',
  },
  'description-duplicate': {
    severity: 'worth-fixing',
    title: 'Pages in the same language sharing one description',
    advice:
      'Write a description for each page; a shared one reads as boilerplate and gets replaced in results.',
  },
  'noindex-listed': {
    severity: 'fix-first',
    title: 'Pages in the sitemap that say noindex',
    advice: 'A sitemap lists pages to index: remove these from it, or remove their noindex.',
  },
  'hreflang-target-error': {
    severity: 'fix-first',
    title: 'Language versions that point at a page that errors or redirects',
    advice: 'Point hreflang at the final, working address of each language version.',
  },
  'hreflang-not-reciprocal': {
    severity: 'worth-fixing',
    title: 'Language versions that do not point back',
    advice:
      'Each version must list every other version, itself included; one-way hreflang links are ignored.',
  },
  orphan: {
    severity: 'worth-fixing',
    title: 'Pages no other page links to',
    advice:
      'Link to each from a page people reach (a menu, a list, a related section). A page only the sitemap names is hard to find and ranks poorly.',
  },
  'not-in-sitemap': {
    severity: 'note',
    title: 'Pages reached by links but missing from the sitemaps',
    advice: 'Add them to the sitemap if they should be found in search; if not, consider noindex.',
  },
  'link-redirects': {
    severity: 'note',
    title: 'Links between pages that go through a redirect',
    advice:
      "Link straight to the final address: each redirect costs a phone a round trip. One exception is usually deliberate: a language menu whose link to the main language goes through its prefix (/en/page → /page) so the site can remember the visitor's choice (next-intl does this).",
  },
};

export function registerCheckSite(server: McpServer): void {
  defineTool(server, {
    name: 'check_site',
    title: 'Crawl the whole site',
    description:
      "Crawls a site: every page its sitemaps list (or, without sitemaps, the pages its links reach from the first page), up to a page cap, one request at a time. Reports, across pages: titles and descriptions duplicated within a language, too long or missing; missing or several H1s; canonical addresses pointing elsewhere; hreflang versions that don't answer back or have no x-default; noindex pages in the sitemap; pages nothing links to (a page's own language versions don't count); broken internal links with the page they sit on; redirect chains; missing share images; slow or uncompressed HTML. Read-only; robots.txt followed.",
    input: {
      url: z.string().describe("The site's address, for example https://example.com"),
      max_pages: z
        .number()
        .int()
        .min(1)
        .max(MAX_PAGES)
        .default(DEFAULT_PAGES)
        .describe(
          `How many pages to read at most (${DEFAULT_PAGES} by default, ${MAX_PAGES} at most).`,
        ),
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

      const first = await site.fetch(url, { kind: 'page' });
      if (first.error && first.chain.length === 0)
        throw new UserError(`Could not reach ${url.href}: ${first.error}.`);
      const origin = new URL(first.final).origin;
      const found = await discover(site, origin, ctx.progress);
      const listed = listedPages(site, found).map((p) => p.url);
      const result = await crawl(site, first.final, listed, args.max_pages, ctx.progress);
      const pages = result.pages;
      const listedKeys = new Set(listed.map(key));

      // Every address read, by what was asked, then by where it landed.
      const byKey = new Map<string, PageRecord>();
      for (const p of pages) byKey.set(key(p.url), p);
      for (const p of pages) if (!byKey.has(p.key)) byKey.set(p.key, p);

      const healthy: PageRecord[] = [];
      for (const p of uniquePages(pages)) {
        const at = short(p.final, origin);
        // A page reached only by a link that errors is a broken link, said once, below.
        const failed = !!p.error || (p.status !== null && p.status >= 400);
        if (failed && result.linkedOnly.has(key(p.url))) continue;
        if (!checkReachable(p, f, at)) continue;
        healthy.push(p);
        checkPageItself(p, f, at);
        if (p.noindex && listedKeys.has(key(p.url)))
          f.add('noindex-listed', at, quote(p.robotsSaid.join(', ')));
      }

      // Duplicates, within one language: the same title in two languages is a translation.
      for (const field of ['title', 'description'] as const) {
        const groups = new Map<string, string[]>();
        for (const p of healthy) {
          if (p.noindex) continue;
          const canonical = p.facts!.canonicals[0];
          if (canonical && key(canonical) !== p.key) continue;
          const value = field === 'title' ? p.facts!.titles[0] : p.facts!.descriptions[0];
          if (!value) continue;
          const k = `${primaryLanguage(p.facts!.lang)}\u0000${value}`;
          groups.set(k, [...(groups.get(k) ?? []), short(p.final, origin)]);
        }
        for (const [k, list] of groups) {
          if (list.length < 2) continue;
          const [lang, value] = k.split('\u0000') as [string, string];
          f.add(
            `${field}-duplicate`,
            `${quote(value, 80)} (${lang})`,
            `${list.length} pages: ${list.slice(0, 6).join(', ')}${list.length > 6 ? ', …' : ''}`,
          );
        }
      }

      // Links: broken, redirected, and who links to whom.
      const inbound = new Map<string, Set<string>>();
      const brokenSeen = new Set<string>();
      for (const p of healthy) {
        const family = new Set(p.facts!.hreflang.map((h) => key(h.href)));
        for (const link of p.facts!.links) {
          let target: string;
          try {
            target = key(link.href);
          } catch {
            continue;
          }
          if (target === p.key) continue;
          const t = byKey.get(target);
          if (!t) continue;
          if (!family.has(target)) {
            const real = t.key;
            if (!inbound.has(real)) inbound.set(real, new Set());
            inbound.get(real)!.add(p.key);
          }
          const pair = `${p.key} ${target}`;
          if (brokenSeen.has(pair)) continue;
          brokenSeen.add(pair);
          const status = t.status;
          if (t.error || (status !== null && status >= 400)) {
            f.add(
              'broken-link',
              short(link.href, origin),
              `${t.error ?? `answers ${status}`}; linked from ${short(p.final, origin)}${link.text ? ` (${quote(link.text, 40)})` : ''}`,
            );
          } else if (t.chain.length > 1 && !t.blockedBy) {
            f.add(
              'link-redirects',
              short(link.href, origin),
              `→ ${short(t.final, origin)}; linked from ${short(p.final, origin)}`,
            );
          }
        }
      }

      // Language versions: each answers, and each points back. A copy that names
      // another page as canonical is not one of the versions.
      const canonicalSelf = (p: PageRecord) => {
        const c = p.facts?.canonicals[0];
        return !c || key(c) === p.key;
      };
      for (const p of healthy) {
        if (!canonicalSelf(p) || p.noindex) continue;
        for (const h of p.facts!.hreflang) {
          if (h.lang === 'x-default' || key(h.href) === p.key) continue;
          const other = byKey.get(key(h.href));
          if (!other) continue;
          if (
            other.error ||
            (other.status !== null && other.status >= 400) ||
            other.chain.length > 1
          ) {
            f.add(
              'hreflang-target-error',
              short(p.final, origin),
              `${h.lang} → ${short(h.href, origin)} ${other.error ?? (other.chain.length > 1 ? `redirects to ${short(other.final, origin)}` : `answers ${other.status}`)}`,
            );
            continue;
          }
          if (!other.facts) continue;
          const back = other.facts.hreflang.some((x) => key(x.href) === p.key);
          if (!back)
            f.add(
              'hreflang-not-reciprocal',
              short(p.final, origin),
              `${h.lang} → ${short(h.href, origin)} does not list it`,
            );
        }
      }

      // Orphans: judged only when every listed page was read.
      if (result.source === 'sitemaps' && !result.stoppedEarly) {
        for (const p of healthy) {
          if (!listedKeys.has(key(p.url)) || p.noindex) continue;
          if (p.key === key(origin + '/')) continue;
          if (!inbound.get(p.key)?.size) f.add('orphan', short(p.final, origin));
        }
      } else if (result.source === 'sitemaps') {
        f.notes.push(
          'Pages nothing links to are judged only when every page is read; raise max_pages to read them all.',
        );
      }
      if (result.source === 'sitemaps') {
        for (const p of healthy) {
          if (
            result.linkedOnly.has(key(p.url)) &&
            !p.noindex &&
            canonicalSelf(p) &&
            p.chain.length === 1
          )
            f.add('not-in-sitemap', short(p.final, origin));
        }
        if (result.queryLinksSkipped) {
          f.notes.push(
            `${plural(result.queryLinksSkipped, 'link')} with a query string (filters, sorting, tracking) were not followed: the sitemaps name the pages.`,
          );
        }
      }

      f.facts['pages found by'] =
        result.source === 'sitemaps'
          ? `the sitemaps (${plural(result.listed, 'address', 'addresses')}), then the links between pages`
          : 'following links from the first page (no sitemap found)';
      f.facts['pages read'] = pages.length;
      f.facts['pages left unread'] = result.leftUnread || null;
      f.facts['languages'] =
        [...new Set(healthy.map((p) => primaryLanguage(p.facts!.lang)))].join(', ') || null;
      f.facts['time'] = duration(Date.now() - t0);
      f.facts['requests made'] = site.requests;
      if (result.stoppedEarly) {
        f.notes.push(
          `Stopped at ${pages.length} pages (max_pages); ${result.leftUnread} more were found. Pass a larger max_pages (up to ${MAX_PAGES}) to read them.`,
        );
      }
      if (site.blocked.length)
        f.notes.push(
          `${plural(new Set(site.blocked).size, 'page')} not read because robots.txt disallows them (they count as robots-blocked).`,
        );

      f.passIfNone(['broken-link'], 'No link between pages leads to an error.');
      f.passIfNone(['title-duplicate', 'title-missing'], 'Every page has its own title.');
      f.passIfNone(
        ['description-duplicate', 'description-missing'],
        'Every page has its own description.',
      );
      f.passIfNone(['h1-missing'], 'Every page has an H1.');
      f.passIfNone(
        ['canonical-missing', 'canonical-several'],
        'Every page names one canonical address.',
      );
      if (healthy.some((p) => p.facts!.hreflang.length))
        f.passIfNone(
          ['hreflang-not-reciprocal', 'hreflang-target-error', 'hreflang-no-self'],
          'Every language version points back to the others.',
        );
      if (result.source === 'sitemaps' && !result.stoppedEarly)
        f.passIfNone(['orphan'], 'Every listed page is linked from another page.');
      f.passIfNone(['noindex-listed'], 'No page in the sitemaps says noindex.');
      f.headline.push(...site.robotsHeadline());
      return f.report('check_site', origin, site.ignoreRobots ? 'ignored' : 'followed', started);
    },
  });
}
