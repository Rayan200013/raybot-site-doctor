// The checks one page's HTML can answer by itself, shared by check_page (one
// address) and check_site (every page). Lengths follow what search results
// usually show: titles of 30 to 60 characters, descriptions of 70 to 155.
import type { Catalogue, Findings } from '../core/report.ts';
import type { PageRecord } from '../core/crawl.ts';
import { primaryLanguage, RTL_LANGUAGES, key } from '../core/page.ts';
import { length, quote, kb } from '../core/text.ts';

export const LIMITS = { titleMin: 30, titleMax: 60, descMin: 70, descMax: 155 };

export const PAGE_KINDS: Catalogue = {
  'page-error': {
    severity: 'fix-first',
    title: 'The page answers an error',
    advice:
      'A visitor and a search engine get an error instead of the page. Fix the page, or remove links and sitemap entries that lead to it.',
  },
  'robots-blocked': {
    severity: 'worth-fixing',
    title: 'robots.txt tells crawlers not to read the page',
    advice:
      "If the page should be found in search, remove or narrow the robots.txt rule quoted. If the site is the user's own and they want it checked anyway, ask them before calling again with ignore_robots_txt: true.",
  },
  'redirect-chain': {
    severity: 'worth-fixing',
    title: 'The address goes through two or more redirects',
    advice:
      'Point links and the sitemap straight at the final address, and make the first redirect go there in one step.',
  },
  'left-site': {
    severity: 'note',
    title: 'The address redirects to another site',
    advice:
      'The doctor reads only the site it was given, so it stopped there. Check the target on its own if it matters.',
  },
  'not-html': {
    severity: 'note',
    title: 'The address is not an HTML page',
    advice: 'Nothing to check as a page. If it should be a page, check its Content-Type header.',
  },
  noindex: {
    severity: 'note',
    title: 'The page asks search engines not to index it',
    advice:
      'If the page should appear in search, remove "noindex" from its robots meta tag or X-Robots-Tag header. If it is meant to stay out, nothing to do.',
  },
  'title-missing': {
    severity: 'fix-first',
    title: 'No title',
    advice:
      'Give the page a <title>: what the page is, in the words people search with, within 60 characters.',
  },
  'title-several': {
    severity: 'worth-fixing',
    title: 'More than one <title>',
    advice: 'Keep one <title> in the head; search engines may pick either.',
  },
  'title-long': {
    severity: 'worth-fixing',
    title: 'Title longer than 60 characters (search results cut it)',
    advice:
      'Shorten the title so its important words come first and fit; results show about 60 characters.',
  },
  'title-short': {
    severity: 'note',
    title: 'Title shorter than 30 characters',
    advice:
      'A short title can be fine; consider adding what the page offers and where, if it helps searchers.',
  },
  'description-missing': {
    severity: 'worth-fixing',
    title: 'No meta description',
    advice:
      'Add <meta name="description"> with one or two sentences (70 to 155 characters) saying what the page gives the reader; search engines and share previews use it.',
  },
  'description-several': {
    severity: 'worth-fixing',
    title: 'More than one meta description',
    advice: 'Keep one; search engines may pick either.',
  },
  'description-long': {
    severity: 'note',
    title: 'Description longer than 155 characters (results cut it)',
    advice: 'Put what matters first, or shorten it to about 155 characters.',
  },
  'description-short': {
    severity: 'note',
    title: 'Description shorter than 70 characters',
    advice: 'A fuller sentence (70 to 155 characters) gives searchers a reason to click.',
  },
  'h1-missing': {
    severity: 'worth-fixing',
    title: 'No H1 heading',
    advice:
      "Give the page one <h1> saying what it is about; screen readers and search engines use it as the page's heading.",
  },
  'h1-several': {
    severity: 'note',
    title: 'More than one H1',
    advice: 'Allowed by HTML, but one H1 per page is clearer: make the others H2.',
  },
  'canonical-missing': {
    severity: 'worth-fixing',
    title: 'No canonical address',
    advice:
      'Add <link rel="canonical" href="..."> with the page\'s own full address, so copies (with tracking parameters, with or without www) count as this one.',
  },
  'canonical-several': {
    severity: 'fix-first',
    title: 'More than one canonical address',
    advice: 'Keep exactly one rel="canonical"; with two, search engines ignore both.',
  },
  'canonical-elsewhere': {
    severity: 'note',
    title: 'The canonical address points at another page',
    advice:
      'This page asks search engines to index the other address instead. Right for a copy; wrong for a page that should appear in search on its own.',
  },
  'lang-missing': {
    severity: 'worth-fixing',
    title: 'The page does not say its language',
    advice:
      'Add lang to <html> (for example lang="en" or lang="ar"): screen readers choose their voice from it, and browsers their translation offer.',
  },
  'dir-missing': {
    severity: 'worth-fixing',
    title: 'A right-to-left language without dir="rtl"',
    advice:
      'Add dir="rtl" to <html> on Arabic, Hebrew, Persian and Urdu pages, so text, punctuation and layout run the right way.',
  },
  'hreflang-invalid': {
    severity: 'worth-fixing',
    title: 'An hreflang value search engines do not understand',
    advice:
      'Use a language code, optionally with a region: "en", "fr-LB", "ar", or "x-default". "en-UK" is wrong ("en-GB"), and a region alone ("LB") is not a language.',
  },
  'hreflang-no-self': {
    severity: 'worth-fixing',
    title: 'The language alternates leave out the page itself',
    advice:
      "List the page's own address among its hreflang alternates, in its own language; Google expects every version to name every version, itself included.",
  },
  'hreflang-no-x-default': {
    severity: 'note',
    title: 'Language alternates without an x-default',
    advice:
      'Add hreflang="x-default" pointing at the version for everyone else (usually the main language or a language chooser).',
  },
  'share-image-missing': {
    severity: 'worth-fixing',
    title: 'No share image (og:image)',
    advice:
      'Add <meta property="og:image"> with a full address of a picture about 1200×630: WhatsApp, Facebook and LinkedIn show it when the link is shared.',
  },
  'share-title-missing': {
    severity: 'note',
    title: 'No og:title',
    advice:
      'Add <meta property="og:title">; without it apps fall back to the <title>, or show nothing.',
  },
  'viewport-missing': {
    severity: 'fix-first',
    title: 'No viewport meta tag: phones show the desktop layout, shrunk',
    advice: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to the head.',
  },
  'viewport-no-zoom': {
    severity: 'worth-fixing',
    title: 'The viewport stops people zooming',
    advice:
      'Remove user-scalable=no and any maximum-scale below 2 from the viewport tag: people with low vision need to zoom (WCAG 1.4.4).',
  },
  'img-no-alt': {
    severity: 'worth-fixing',
    title: 'Images without an alt attribute',
    advice:
      'Give each image alt text saying what it shows, or alt="" when it is decoration; screen readers otherwise read the file name.',
  },
  'json-ld-unparseable': {
    severity: 'fix-first',
    title: 'Structured data (JSON-LD) that is not valid JSON',
    advice:
      'Search engines skip the whole block. Fix the JSON (a trailing comma or an unescaped quote is usual); check_structured_data says more.',
  },
  'not-compressed': {
    severity: 'worth-fixing',
    title: 'The HTML is sent uncompressed',
    advice:
      'Turn on gzip or Brotli for HTML on the server or CDN; it usually makes the page several times smaller to download.',
  },
  'html-heavy': {
    severity: 'worth-fixing',
    title: 'The HTML itself is over 1 MB',
    advice:
      'Look for inlined data, pictures or repeated markup; a phone has to download and parse all of it before the page is ready.',
  },
  'slow-server': {
    severity: 'worth-fixing',
    title: 'The server took over 0.8 s to start answering',
    advice:
      'A first byte after 0.8 s delays everything else. Cache the page (a CDN, static rendering), or find what the server does before answering.',
  },
  'very-slow-server': {
    severity: 'fix-first',
    title: 'The server took over 1.8 s to start answering',
    advice:
      'Everything waits on this. Cache the page (a CDN, static rendering), or find what the server does before answering.',
  },
  'meta-refresh': {
    severity: 'worth-fixing',
    title: 'The page redirects with a meta refresh',
    advice:
      'Use an HTTP redirect (301) instead; a meta refresh is slower and search engines treat it less reliably.',
  },
  'not-https': {
    severity: 'fix-first',
    title: 'The page is served over plain HTTP',
    advice:
      'Serve it over HTTPS and redirect http:// to https://; browsers mark plain HTTP pages "Not secure".',
  },
};

const HREFLANG = /^(x-default|[a-z]{2,3}(-[a-z]{4})?(-([a-z]{2}|\d{3}))?)$/i;
const WRONG_REGIONS: Record<string, string> = { uk: 'gb' };

/** Every check the page's own HTML and headers can answer. `at` names the page in examples. */
export function checkPageItself(record: PageRecord, f: Findings, at: string): void {
  const facts = record.facts;
  if (!facts) return;
  const url = new URL(record.final);

  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    f.add('not-https', at);

  if (record.noindex) f.add('noindex', at, `says ${quote(record.robotsSaid.join(', '))}`);
  const canonicals = new Set(facts.canonicals);
  const elsewhere = canonicals.size === 1 && key(facts.canonicals[0]!) !== key(record.final);
  if (elsewhere) f.add('canonical-elsewhere', at, `→ ${facts.canonicals[0]}`);
  // A page kept out of search, or a copy pointing at its original, is judged on
  // what visitors meet (language, viewport, pictures, errors), not on search.
  if (!record.noindex && !elsewhere) searchChecks(record, facts, f, at);

  if (!facts.lang) f.add('lang-missing', at);
  else if (
    RTL_LANGUAGES.has(primaryLanguage(facts.lang)) &&
    (facts.dir ?? '').toLowerCase() !== 'rtl'
  ) {
    f.add('dir-missing', at, `lang="${facts.lang}"${facts.dir ? `, dir="${facts.dir}"` : ''}`);
  }

  if (!facts.viewport) f.add('viewport-missing', at);
  else {
    const v = facts.viewport.toLowerCase().replace(/\s/g, '');
    const max = /maximum-scale=([\d.]+)/.exec(v)?.[1];
    if (/user-scalable=(no|0)/.test(v) || (max && Number(max) < 2))
      f.add('viewport-no-zoom', at, quote(facts.viewport));
  }

  const noAlt = facts.images.filter((i) => i.alt === null);
  if (noAlt.length) {
    f.add(
      'img-no-alt',
      at,
      `${noAlt.length} of ${facts.images.length}: ${noAlt
        .slice(0, 3)
        .map((i) => (i.src ? i.src.replace(/^https?:\/\/[^/]+/, '').slice(0, 80) : '(no src)'))
        .join(', ')}`,
    );
  }

  const broken = facts.jsonLd.filter((b) => b.error);
  if (broken.length)
    f.add('json-ld-unparseable', at, `${broken.length} block(s): ${broken[0]!.error}`);

  if (facts.refresh) f.add('meta-refresh', at, quote(facts.refresh));

  if (record.bytes > 1024 && !record.encoding)
    f.add('not-compressed', at, `${kb(record.bytes)} sent as is`);
  if (record.bytes > 1024 * 1024) f.add('html-heavy', at, kb(record.bytes));
  if (record.ttfbMs !== null) {
    if (record.ttfbMs > 1800)
      f.add('very-slow-server', at, `${Math.round(record.ttfbMs)} ms to the first byte`);
    else if (record.ttfbMs > 800)
      f.add('slow-server', at, `${Math.round(record.ttfbMs)} ms to the first byte`);
  }
}

/** What only matters for a page meant to appear in search on its own. */
function searchChecks(
  record: PageRecord,
  facts: NonNullable<PageRecord['facts']>,
  f: Findings,
  at: string,
): void {
  const titles = facts.titles.filter(Boolean);
  if (titles.length === 0) f.add('title-missing', at);
  else {
    if (titles.length > 1)
      f.add('title-several', at, titles.map((t) => quote(t, 60)).join(' and '));
    const t = titles[0]!;
    if (length(t) > LIMITS.titleMax)
      f.add('title-long', at, `${length(t)} characters: ${quote(t)}`);
    else if (length(t) < LIMITS.titleMin)
      f.add('title-short', at, `${length(t)} characters: ${quote(t)}`);
  }

  const descs = facts.descriptions.filter(Boolean);
  if (descs.length === 0) f.add('description-missing', at);
  else {
    if (descs.length > 1) f.add('description-several', at);
    const d = descs[0]!;
    if (length(d) > LIMITS.descMax)
      f.add('description-long', at, `${length(d)} characters: ${quote(d, 200)}`);
    else if (length(d) < LIMITS.descMin)
      f.add('description-short', at, `${length(d)} characters: ${quote(d)}`);
  }

  const h1s = facts.headings.filter((h) => h.level === 1);
  if (h1s.length === 0) f.add('h1-missing', at);
  else if (h1s.length > 1) f.add('h1-several', at, h1s.map((h) => quote(h.text, 50)).join(', '));

  if (facts.canonicals.length === 0) f.add('canonical-missing', at);
  else if (new Set(facts.canonicals).size > 1)
    f.add('canonical-several', at, facts.canonicals.join(' and '));

  if (facts.hreflang.length) {
    for (const h of facts.hreflang) {
      const [, region] = h.lang.split('-');
      if (!HREFLANG.test(h.lang)) f.add('hreflang-invalid', at, `hreflang="${h.lang}"`);
      else if (region && WRONG_REGIONS[region])
        f.add(
          'hreflang-invalid',
          at,
          `hreflang="${h.lang}" (the code is ${h.lang.split('-')[0]}-${WRONG_REGIONS[region]!.toUpperCase()})`,
        );
    }
    const self = facts.hreflang.some(
      (h) => h.lang !== 'x-default' && key(h.href) === key(record.final),
    );
    // A page whose canonical is elsewhere is not one of the versions.
    const canonicalSelf =
      facts.canonicals.length === 0 || key(facts.canonicals[0]!) === key(record.final);
    if (!self && canonicalSelf) f.add('hreflang-no-self', at);
    if (!facts.hreflang.some((h) => h.lang === 'x-default')) f.add('hreflang-no-x-default', at);
  }

  if (!facts.meta['og:image']) f.add('share-image-missing', at);
  if (!facts.meta['og:title']) f.add('share-title-missing', at);
}

/** Says why a page could not be checked, as a finding. Returns false when there is nothing to check. */
export function checkReachable(record: PageRecord, f: Findings, at: string): boolean {
  if (record.blockedBy) {
    f.add(
      'robots-blocked',
      at,
      record.blockedBy === 'unreachable-robots'
        ? 'robots.txt itself answers an error, so crawlers must assume everything is disallowed'
        : `rule "${record.blockedBy.allow ? 'Allow' : 'Disallow'}: ${record.blockedBy.path}" (robots.txt line ${record.blockedBy.line})`,
    );
    return false;
  }
  if (record.error) {
    f.add('page-error', at, record.error);
    return false;
  }
  if (record.leftSiteTo) {
    f.add('left-site', at, `redirects to ${record.leftSiteTo}`);
    return false;
  }
  if (record.chain.length > 2) {
    f.add('redirect-chain', at, record.chain.map((h) => `${h.url} (${h.status})`).join(' → '));
  }
  if (record.status !== null && record.status >= 400) {
    f.add('page-error', at, `answers ${record.status}`);
    return false;
  }
  if (!record.facts) {
    if (record.status !== null && record.status >= 200 && record.status < 300) {
      f.add('not-html', at, record.contentType ?? 'no Content-Type');
    }
    return false;
  }
  return true;
}
