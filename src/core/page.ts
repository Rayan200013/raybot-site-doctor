// What a page's HTML says about itself, read the way a search engine reads it
// (parse5 parses as browsers do): its head, its headings, its links, its
// images, its structured data.
import { parse } from 'parse5';

interface Node {
  nodeName: string;
  tagName?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: Node[];
  content?: Node;
  value?: string;
}

export interface Link {
  href: string;
  text: string;
  rel: string;
}

export interface Image {
  src: string | null;
  alt: string | null;
  loading: string | null;
  inLink: boolean;
}

export interface JsonLdBlock {
  raw: string;
  value?: unknown;
  error?: string;
}

export interface PageFacts {
  lang: string | null;
  dir: string | null;
  titles: string[];
  descriptions: string[];
  robots: string[];
  canonicals: string[];
  hreflang: { lang: string; href: string }[];
  meta: Record<string, string>;
  viewport: string | null;
  charset: string | null;
  refresh: string | null;
  headings: { level: number; text: string }[];
  links: Link[];
  images: Image[];
  jsonLd: JsonLdBlock[];
  hasMicrodata: boolean;
  bodyTextLength: number;
}

const attr = (node: Node, name: string): string | null =>
  node.attrs?.find((a) => a.name === name)?.value ?? null;

function textOf(node: Node): string {
  if (node.nodeName === '#text') return node.value ?? '';
  if (node.nodeName === 'script' || node.nodeName === 'style' || node.nodeName === 'template')
    return '';
  let out = '';
  for (const child of node.childNodes ?? []) out += textOf(child);
  // An image's alt text is the link's words when the link is a picture.
  if (node.nodeName === 'img') out += attr(node, 'alt') ?? '';
  return out;
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

function resolve(href: string | null, base: URL): string | null {
  if (href == null) return null;
  const trimmed = href.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed, base).href;
  } catch {
    return null;
  }
}

export function readPage(html: string, pageUrl: string): PageFacts {
  const doc = parse(html) as unknown as Node;
  const facts: PageFacts = {
    lang: null,
    dir: null,
    titles: [],
    descriptions: [],
    robots: [],
    canonicals: [],
    hreflang: [],
    meta: {},
    viewport: null,
    charset: null,
    refresh: null,
    headings: [],
    links: [],
    images: [],
    jsonLd: [],
    hasMicrodata: false,
    bodyTextLength: 0,
  };

  // The base address first: every relative link resolves against it.
  let base = new URL(pageUrl);
  const findBase = (node: Node): void => {
    if (node.nodeName === 'base') {
      const href = attr(node, 'href');
      if (href) {
        try {
          base = new URL(href, pageUrl);
        } catch {
          // An invalid base is ignored, as browsers do.
        }
      }
      return;
    }
    for (const child of node.childNodes ?? []) findBase(child);
  };
  findBase(doc);

  let inBody = false;
  let inSvg = false;
  const walk = (node: Node, inLink: boolean): void => {
    const name = node.nodeName;
    if (name === 'html') {
      facts.lang = attr(node, 'lang');
      facts.dir = attr(node, 'dir');
    }
    if (name === 'body') inBody = true;
    if (name === 'svg') inSvg = true;
    if (node.attrs?.some((a) => a.name === 'itemscope' || a.name === 'itemtype'))
      facts.hasMicrodata = true;

    switch (name) {
      case 'title':
        // A <title> inside an inline SVG is the drawing's, not the page's.
        if (!inSvg) facts.titles.push(squash(textOf(node)));
        break;
      case 'meta': {
        const key = (attr(node, 'name') ?? attr(node, 'property') ?? '').toLowerCase();
        const content = attr(node, 'content') ?? '';
        const equiv = (attr(node, 'http-equiv') ?? '').toLowerCase();
        if (attr(node, 'charset')) facts.charset = attr(node, 'charset');
        if (equiv === 'content-type' && /charset=/i.test(content))
          facts.charset = content.replace(/.*charset=/i, '');
        if (equiv === 'refresh') facts.refresh = content;
        if (key === 'description') facts.descriptions.push(squash(content));
        else if (key === 'robots' || key === 'googlebot') facts.robots.push(content.toLowerCase());
        else if (key === 'viewport') facts.viewport = content;
        else if (key && !(key in facts.meta)) facts.meta[key] = content;
        break;
      }
      case 'link': {
        const rel = (attr(node, 'rel') ?? '').toLowerCase().split(/\s+/);
        const href = resolve(attr(node, 'href'), base);
        if (rel.includes('canonical') && href) facts.canonicals.push(href);
        const hl = attr(node, 'hreflang');
        if (rel.includes('alternate') && hl && href)
          facts.hreflang.push({ lang: hl.toLowerCase(), href });
        break;
      }
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        facts.headings.push({ level: Number(name[1]), text: squash(textOf(node)) });
        break;
      case 'a': {
        const raw = attr(node, 'href');
        if (
          raw !== null &&
          !/^\s*(javascript|mailto|tel|sms|data):/i.test(raw) &&
          !/^\s*#/.test(raw)
        ) {
          const href = resolve(raw, base);
          if (href)
            facts.links.push({
              href,
              text: squash(textOf(node)),
              rel: (attr(node, 'rel') ?? '').toLowerCase(),
            });
        }
        for (const child of node.childNodes ?? []) walk(child, true);
        return;
      }
      case 'img':
        if (inBody) {
          facts.images.push({
            src: resolve(attr(node, 'src') ?? attr(node, 'data-src'), base),
            alt: attr(node, 'alt'),
            loading: attr(node, 'loading'),
            inLink,
          });
        }
        break;
      case 'script': {
        const type = (attr(node, 'type') ?? '').toLowerCase().split(';')[0]!.trim();
        if (type === 'application/ld+json') {
          const raw = (node.childNodes ?? []).map((c) => c.value ?? '').join('');
          try {
            facts.jsonLd.push({ raw, value: JSON.parse(raw) });
          } catch (e) {
            facts.jsonLd.push({ raw, error: (e as Error).message });
          }
        }
        return;
      }
      case 'noscript':
      case 'style':
        return;
      case 'template':
        return;
    }
    for (const child of node.childNodes ?? []) walk(child, inLink);
    if (name === 'svg') inSvg = false;
  };
  walk(doc, false);

  const body = findFirst(doc, 'body');
  facts.bodyTextLength = body ? squash(textOf(body)).length : 0;
  return facts;
}

function findFirst(node: Node, name: string): Node | null {
  if (node.nodeName === name) return node;
  for (const child of node.childNodes ?? []) {
    const found = findFirst(child, name);
    if (found) return found;
  }
  return null;
}

/** An address as the crawl compares them: no fragment, no trailing slash (but the root's). */
export function key(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    let path = u.pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.replace(/\/+$/, '') || '/';
    return u.origin + path + u.search;
  } catch {
    return url;
  }
}

/** The primary language of a lang value ("fr-LB" → "fr"). */
export function primaryLanguage(lang: string | null | undefined): string {
  return (lang ?? '').trim().toLowerCase().split(/[-_]/)[0] || 'unknown';
}

/** Languages written right to left. */
export const RTL_LANGUAGES = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'ug', 'yi', 'dv', 'ckb']);

/** Is this response an HTML page? */
export function isHtml(contentType: string | undefined): boolean {
  return /text\/html|application\/xhtml\+xml/i.test(contentType ?? '');
}

/** The robots directives of a page: its meta tags and its X-Robots-Tag header. */
export function robotsDirectives(
  facts: PageFacts,
  header: string | undefined,
): { noindex: boolean; nofollow: boolean; said: string[] } {
  const said = [...facts.robots];
  if (header) {
    // "googlebot: noindex" names a crawler; a plain value applies to all.
    for (const part of header.split(/,(?=\s*[a-z-]+\s*:)/i)) said.push(part.trim().toLowerCase());
  }
  const all = said.join(',');
  return {
    noindex: /\b(noindex|none)\b/.test(all),
    nofollow: /\b(nofollow|none)\b/.test(all),
    said,
  };
}
