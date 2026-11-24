// check_sitemaps: robots.txt and every sitemap it names, and whether each
// address they list is a page a search engine can index.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { defineTool, common, parseTarget, UserError } from '../core/tool.ts';
import { Findings, type Catalogue } from '../core/report.ts';
import { Site, toUrl } from '../core/site.ts';
import { discover, listedPages, readOne } from '../core/crawl.ts';
import { isAllowed } from '../core/robots.ts';
import { key } from '../core/page.ts';
import { validLastmod } from '../core/sitemap.ts';
import { plural, short, duration, quote } from '../core/text.ts';

export const MAX_PAGES = 1000;
export const DEFAULT_PAGES = 200;

const KINDS: Catalogue = {
  'robots-unreachable': {
    severity: 'fix-first',
    title: 'robots.txt answers a server error or does not answer',
    advice:
      'Crawlers must then assume the whole site is disallowed and stop. Make /robots.txt answer 200 (or 404 if there are no rules).',
  },
  'robots-blocks-home': {
    severity: 'fix-first',
    title: "robots.txt disallows the site's home page",
    advice:
      'Search engines will not read the site. If that is not meant (a rule left from staging is usual), remove the rule quoted.',
  },
  'robots-rules-without-agent': {
    severity: 'worth-fixing',
    title: 'robots.txt has rules before any User-agent line',
    advice:
      'Rules apply only after a "User-agent:" line; these apply to no one. Put "User-agent: *" above them.',
  },
  'robots-unknown-line': {
    severity: 'note',
    title: 'Lines in robots.txt that crawlers will ignore',
    advice:
      'Check the spelling ("Disallow:", "Allow:", "User-agent:", "Sitemap:"); unknown lines are skipped.',
  },
  'robots-no-sitemap': {
    severity: 'note',
    title: 'robots.txt does not name the sitemap',
    advice:
      'Add "Sitemap: https://…/sitemap.xml" to robots.txt, so every search engine finds it without being told.',
  },
  'robots-missing': {
    severity: 'note',
    title: 'No robots.txt (it answers 404)',
    advice:
      'Allowed: every crawler may read everything. Add one if you want to name the sitemap or keep crawlers out of some paths.',
  },
  'sitemap-missing': {
    severity: 'worth-fixing',
    title: 'No sitemap found',
    advice:
      'Publish /sitemap.xml listing every page that should be found in search, and name it in robots.txt.',
  },
  'sitemap-error': {
    severity: 'fix-first',
    title: 'A sitemap does not load',
    advice:
      'Search engines skip it, and every page it lists. Make it answer 200 at the address robots.txt or the index gives.',
  },
  'sitemap-invalid': {
    severity: 'fix-first',
    title: 'A sitemap is not valid',
    advice:
      'Fix the problem quoted; a sitemap that does not parse may be read only in part, or not at all.',
  },
  'sitemap-wrong-type': {
    severity: 'note',
    title: 'A sitemap is not served as XML',
    advice:
      'Serve it as application/xml or text/xml; text/html often means an error page answered instead.',
  },
  'sitemap-other-host': {
    severity: 'worth-fixing',
    title: 'A sitemap lists addresses on another host',
    advice:
      "A sitemap may list only its own host's addresses (unless robots.txt on the other host names it). Move them to that host's sitemap.",
  },
  'sitemap-lastmod-invalid': {
    severity: 'worth-fixing',
    title: '<lastmod> dates that are not W3C dates',
    advice: 'Write dates as 2026-11-23 or 2026-11-23T10:00:00+02:00; others are ignored.',
  },
  'sitemap-lastmod-future': {
    severity: 'worth-fixing',
    title: '<lastmod> dates in the future',
    advice: 'Use the date the page last really changed.',
  },
  'sitemap-lastmod-same': {
    severity: 'note',
    title: 'Every <lastmod> is the same day',
    advice:
      'Usually the build date written on every page. Google uses lastmod only when it is consistently right: write the date each page last really changed, or leave it out.',
  },
  'listed-duplicate': {
    severity: 'note',
    title: 'The same address listed more than once',
    advice: 'List each address once.',
  },
  'listed-error': {
    severity: 'fix-first',
    title: 'Listed addresses that answer an error',
    advice: 'Remove them from the sitemap, or fix the pages.',
  },
  'listed-blocked': {
    severity: 'fix-first',
    title: 'Listed addresses that robots.txt disallows',
    advice:
      'The sitemap asks search engines to read pages robots.txt forbids. Remove one or the other.',
  },
  'listed-redirect': {
    severity: 'worth-fixing',
    title: 'Listed addresses that redirect',
    advice: 'List the final address instead, the one the redirect lands on.',
  },
  'listed-noindex': {
    severity: 'fix-first',
    title: 'Listed pages that say noindex',
    advice: 'A sitemap lists pages to index. Remove these from it, or remove their noindex.',
  },
  'listed-canonical-elsewhere': {
    severity: 'worth-fixing',
    title: 'Listed pages whose canonical address is another page',
    advice: 'List the canonical address instead, or make the page canonical to itself.',
  },
  'listed-not-html': {
    severity: 'note',
    title: 'Listed addresses that are not HTML pages',
    advice: 'Fine for PDFs and the like; otherwise check the address.',
  },
  'alternates-disagree': {
    severity: 'worth-fixing',
    title: "The sitemap's language versions differ from the page's own hreflang",
    advice:
      'Search engines may ignore both sets. Make the sitemap and the page name the same versions.',
  },
};

export function registerCheckSitemaps(server: McpServer): void {
  defineTool(server, {
    name: 'check_sitemaps',
    title: 'Check robots.txt and the sitemaps',
    description:
      "Reads a site's robots.txt and every sitemap it names (or /sitemap.xml), sitemap indexes included, then each address listed. Reports: robots.txt rules that block the site or are ignored; sitemaps that don't load or don't parse; how many addresses each lists; listed addresses that answer an error, redirect, are disallowed by robots.txt, say noindex or name another page as canonical; lastmod dates that are invalid, in the future or all the same day; language alternates that disagree with the pages. Read-only, one request at a time.",
    input: {
      url: z.string().describe("The site's address, for example https://example.com"),
      max_pages: z
        .number()
        .int()
        .min(1)
        .max(MAX_PAGES)
        .default(DEFAULT_PAGES)
        .describe(`How many listed addresses to read (at most ${MAX_PAGES}).`),
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

      // The site's real address first: http → https, example.com → www.
      const home = await site.fetch(new URL('/', url), { kind: 'page' });
      if (home.error && home.chain.length === 0)
        throw new UserError(`Could not reach ${url.origin}: ${home.error}.`);
      const origin = new URL(home.final).origin;

      const found = await discover(site, origin, ctx.progress);
      const robots = found.robots;
      const robotsAt = `${origin}/robots.txt`;
      if (robots.outcome === 'unreachable') {
        f.add('robots-unreachable', robotsAt, robots.error ?? `answers ${robots.status}`);
      } else if (robots.outcome === 'none') {
        f.add('robots-missing', robotsAt, `answers ${robots.status}`);
      } else if (robots.robots) {
        const verdict = isAllowed(robots.rules, new URL('/', origin));
        if (!verdict.allowed && verdict.rule) {
          f.add(
            'robots-blocks-home',
            robotsAt,
            `line ${verdict.rule.line}: Disallow: ${verdict.rule.path} (for User-agent: ${robots.agent})`,
          );
        }
        if (robots.robots.orphanRules)
          f.add('robots-rules-without-agent', robotsAt, plural(robots.robots.orphanRules, 'rule'));
        for (const u of robots.robots.unknown) {
          const name = u.text.split(':')[0]!.trim().toLowerCase();
          const known = [
            'host',
            'clean-param',
            'request-rate',
            'visit-time',
            'noindex',
            'nofollow',
          ].includes(name);
          f.add(
            'robots-unknown-line',
            robotsAt,
            `line ${u.line}: ${quote(u.text)}${known ? ` (${name === 'host' ? "Yandex's old Host directive; Google ignores it" : 'not a standard rule; Google ignores it'})` : ''}`,
          );
        }
        if (robots.robots.sitemaps.length === 0) f.add('robots-no-sitemap', robotsAt);
        f.facts['robots.txt'] =
          `${robots.robots.groups.length} group(s); rules for ${robots.agent}: ${robots.rules.length}${robots.crawlDelayMs ? `; crawl-delay ${robots.crawlDelayMs / 1000} s (followed)` : ''}`;
      }

      const loaded = found.sitemaps.filter((s) => s.status === 200);
      if (loaded.length === 0) {
        const tried = found.sitemaps.map((s) => `${s.url} (${s.error ?? s.status})`).join(', ');
        if (found.sitemaps.some((s) => s.from === 'robots.txt')) f.add('sitemap-error', tried);
        else f.add('sitemap-missing', origin, tried ? `tried ${tried}` : undefined);
      }
      const now = Date.now() + 24 * 3600 * 1000;
      for (const s of found.sitemaps) {
        if (s.status !== 200) {
          if (loaded.length > 0 || s.from === 'robots.txt')
            f.add('sitemap-error', s.url, s.error ?? `answers ${s.status}`);
          continue;
        }
        const p = s.parsed!;
        for (const problem of p.problems) f.add('sitemap-invalid', s.url, problem);
        if (s.contentType && !/xml|text\/plain|gzip|octet-stream/i.test(s.contentType))
          f.add('sitemap-wrong-type', s.url, s.contentType);
        const host = new URL(s.redirectedTo ?? s.url).host;
        const other = p.entries.filter((e) => {
          try {
            return new URL(e.loc).host !== host;
          } catch {
            return true;
          }
        });
        if (other.length)
          f.add(
            'sitemap-other-host',
            s.url,
            `${other.length} of ${p.entries.length}, e.g. ${other[0]!.loc}`,
          );
        const mods = p.entries.map((e) => e.lastmod).filter((m): m is string => !!m);
        const bad = mods.filter((m) => !validLastmod(m));
        if (bad.length)
          f.add('sitemap-lastmod-invalid', s.url, `${bad.length}, e.g. ${quote(bad[0]!)}`);
        const future = mods.filter((m) => validLastmod(m) && Date.parse(m) > now);
        if (future.length)
          f.add('sitemap-lastmod-future', s.url, `${future.length}, e.g. ${future[0]}`);
        const days = new Set(mods.filter(validLastmod).map((m) => m.slice(0, 10)));
        if (mods.length >= 10 && days.size === 1 && mods.length === p.entries.length)
          f.add('sitemap-lastmod-same', s.url, `all ${mods.length} say ${[...days][0]}`);
        if (p.type === 'sitemapindex')
          f.notes.push(
            `${short(s.url, origin)} is an index of ${plural(p.sitemaps.length, 'sitemap')}.`,
          );
      }
      f.facts['sitemaps'] = found.sitemaps.length
        ? found.sitemaps
            .map(
              (s) =>
                `${short(s.url, origin)} (${s.status === 200 ? plural(s.parsed!.type === 'sitemapindex' ? s.parsed!.sitemaps.length : s.parsed!.entries.length, s.parsed!.type === 'sitemapindex' ? 'sitemap' : 'address', s.parsed!.type === 'sitemapindex' ? 'sitemaps' : 'addresses') : (s.error ?? s.status)}, from ${s.from})`,
            )
            .join('; ')
        : 'none';

      // Duplicates, within and across sitemaps.
      const count = new Map<string, number>();
      for (const e of found.entries) count.set(e.loc, (count.get(e.loc) ?? 0) + 1);
      for (const [loc, n] of count) if (n > 1) f.add('listed-duplicate', loc, `${n} times`);

      // Every listed address, as a search engine reads it.
      const pages = listedPages(site, found);
      const toRead = pages.slice(0, args.max_pages);
      const alternatesOf = new Map<string, Map<string, string>>();
      for (const e of found.entries) {
        if (e.alternates.length)
          alternatesOf.set(key(e.loc), new Map(e.alternates.map((a) => [a.lang, key(a.href)])));
      }
      let i = 0;
      for (const p of toRead) {
        ctx.progress(i++, toRead.length, `reading ${p.url}`);
        const r = await readOne(site, p.url);
        const at = short(p.url, origin);
        if (r.blockedBy) {
          f.add(
            'listed-blocked',
            at,
            r.blockedBy === 'unreachable-robots'
              ? 'robots.txt does not answer'
              : `Disallow: ${r.blockedBy.path} (line ${r.blockedBy.line})`,
          );
          continue;
        }
        if (r.error) {
          f.add('listed-error', at, r.error);
          continue;
        }
        if (r.chain.length > 1) {
          f.add('listed-redirect', at, `→ ${short(r.final, origin)} (${r.chain[0]!.status})`);
        }
        if (r.status !== null && r.status >= 400) {
          f.add('listed-error', at, `answers ${r.status}`);
          continue;
        }
        if (r.noindex) f.add('listed-noindex', at, quote(r.robotsSaid.join(', ')));
        if (!r.facts) {
          if (r.status === 200) f.add('listed-not-html', at, r.contentType ?? '');
          continue;
        }
        const canonical = r.facts.canonicals[0];
        if (canonical && key(canonical) !== key(r.final) && r.chain.length === 1)
          f.add('listed-canonical-elsewhere', at, `→ ${short(canonical, origin)}`);
        const fromSitemap = alternatesOf.get(key(p.url));
        if (fromSitemap) {
          const onPage = new Map(r.facts.hreflang.map((h) => [h.lang, key(h.href)]));
          const differ = [...fromSitemap].filter(([lang, href]) => onPage.get(lang) !== href);
          const extra = [...onPage.keys()].filter((lang) => !fromSitemap.has(lang));
          if (differ.length || extra.length) {
            f.add(
              'alternates-disagree',
              at,
              [
                ...differ.map(
                  ([lang, href]) =>
                    `${lang}: sitemap ${short(href, origin)}, page ${onPage.get(lang) ? short(onPage.get(lang)!, origin) : '(none)'}`,
                ),
                ...extra.map((lang) => `${lang}: only on the page`),
              ].join('; '),
            );
          }
        }
      }
      f.facts['addresses listed'] = pages.length;
      f.facts['addresses read'] = toRead.length;
      if (toRead.length < pages.length) {
        f.notes.push(
          `Read ${toRead.length} of the ${pages.length} listed addresses (max_pages). Pass a larger max_pages (up to ${MAX_PAGES}) to read them all.`,
        );
      }
      f.facts['time'] = duration(Date.now() - t0);
      f.facts['requests made'] = site.requests;

      f.passIfNone(
        ['robots-unreachable', 'robots-blocks-home', 'robots-rules-without-agent'],
        'robots.txt lets search engines read the site.',
      );
      f.passIfNone(
        ['sitemap-missing', 'sitemap-error', 'sitemap-invalid'],
        'Every sitemap loads and parses.',
      );
      if (toRead.length) {
        f.passIfNone(
          [
            'listed-error',
            'listed-blocked',
            'listed-redirect',
            'listed-noindex',
            'listed-canonical-elsewhere',
          ],
          `Every listed address read (${toRead.length}) answers 200, is indexable and canonical to itself.`,
        );
        if (alternatesOf.size)
          f.passIfNone(
            ['alternates-disagree'],
            "The sitemap's language versions match the pages'.",
          );
      }
      f.headline.push(...site.robotsHeadline());
      return f.report(
        'check_sitemaps',
        origin,
        site.ignoreRobots ? 'ignored' : 'followed',
        started,
      );
    },
  });
}
