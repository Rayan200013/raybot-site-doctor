// JSON-LD checked twice: against schema.org's own vocabulary (types and
// properties that exist, and belong together), and against Google's rules
// for the rich results it shows (developers.google.com/search/docs/appearance/structured-data).
import { readFileSync } from 'node:fs';
import type { Catalogue, Findings } from '../core/report.ts';
import type { JsonLdBlock } from '../core/page.ts';

interface Vocabulary {
  version: string;
  released: string;
  types: Record<string, string[]>;
  properties: Record<string, [string[], string[], string | 0]>;
}

let vocabulary: Vocabulary | null = null;
export function vocab(): Vocabulary {
  vocabulary ??= JSON.parse(
    readFileSync(new URL('../../data/schemaorg-vocabulary.json', import.meta.url), 'utf8'),
  ) as Vocabulary;
  return vocabulary;
}

export const SD_KINDS: Catalogue = {
  'sd-unparseable': {
    severity: 'fix-first',
    title: 'A JSON-LD block that is not valid JSON',
    advice:
      'Search engines skip the whole block. Fix the JSON (a trailing comma, an unescaped quote or a comment are usual).',
  },
  'sd-no-context': {
    severity: 'fix-first',
    title: 'A JSON-LD block without "@context": "https://schema.org"',
    advice:
      'Without the context its types mean nothing to a search engine. Add "@context": "https://schema.org" at the top of the block.',
  },
  'sd-unknown-type': {
    severity: 'fix-first',
    title: 'A type schema.org does not have',
    advice:
      'Check the spelling and capitals (LocalBusiness, not Localbusiness) against schema.org; an unknown type is ignored.',
  },
  'sd-unknown-property': {
    severity: 'worth-fixing',
    title: 'A property schema.org does not have',
    advice: 'Check the spelling and capitals against schema.org; an unknown property is ignored.',
  },
  'sd-wrong-property': {
    severity: 'worth-fixing',
    title: 'A property that does not belong to its type',
    advice:
      "Move it to the type it belongs to (schema.org lists each property's types), or change the type.",
  },
  'sd-superseded': {
    severity: 'note',
    title: 'A property schema.org has replaced',
    advice: 'Use the newer property named.',
  },
  'sd-no-type': {
    severity: 'worth-fixing',
    title: 'An object with properties but no @type',
    advice:
      'Give it a @type, or make it a bare reference {"@id": "…"} to a node defined elsewhere.',
  },
  'sd-missing-id': {
    severity: 'note',
    title: 'A reference to an @id this page does not define',
    advice:
      'Search engines read one page at a time: define the node on this page too (or drop the reference) so they can join it up.',
  },
  'google-required': {
    severity: 'fix-first',
    title: 'Missing what Google requires for this rich result',
    advice:
      'Add the property named; without it Google does not show the rich result (Search Console reports it as an error).',
  },
  'google-recommended': {
    severity: 'note',
    title: 'Missing what Google recommends for this rich result',
    advice: 'Add the property named if you have it; it can make the result fuller.',
  },
  'google-breadcrumb-order': {
    severity: 'worth-fixing',
    title: 'Breadcrumb positions out of order',
    advice: 'Number ListItem positions 1, 2, 3… in the order of the trail.',
  },
  'google-faq-limited': {
    severity: 'note',
    title: 'FAQ markup: Google shows FAQ results only for well-known government and health sites',
    advice:
      'Since August 2023. The markup is still valid and harmless; do not expect FAQ rich results from it.',
  },
};

const list = (v: unknown): unknown[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const bare = (t: unknown) => String(t).replace(/^(https?:\/\/schema\.org\/|schema:)/, '');
const isSchemaContext = (c: unknown): boolean => {
  if (typeof c === 'string') return /^https?:\/\/schema\.org\/?$/.test(c.trim());
  if (Array.isArray(c)) return c.some(isSchemaContext);
  if (c && typeof c === 'object') {
    const vocabValue = (c as Record<string, unknown>)['@vocab'];
    return typeof vocabValue === 'string' && /^https?:\/\/schema\.org\/?$/.test(vocabValue.trim());
  }
  return false;
};

function lineage(type: string, seen = new Set<string>()): Set<string> {
  if (seen.has(type)) return seen;
  seen.add(type);
  for (const parent of vocab().types[type] ?? []) lineage(parent, seen);
  return seen;
}

function isA(types: string[], ancestor: string): boolean {
  return types.some((t) => lineage(t).has(ancestor));
}

interface Ctx {
  f: Findings;
  at: string;
  defined: Set<string>;
  referenced: Map<string, string>;
}

/** Checks every JSON-LD block of one page. `at` names the page. Returns the types found. */
export function checkJsonLd(blocks: JsonLdBlock[], f: Findings, at: string): string[] {
  const ctx: Ctx = { f, at, defined: new Set(), referenced: new Map() };
  const found: string[] = [];
  blocks.forEach((block, i) => {
    const where = `block ${i + 1}`;
    if (block.error) {
      f.add('sd-unparseable', at, `${where}: ${block.error}`);
      return;
    }
    for (const top of list(block.value)) {
      if (!top || typeof top !== 'object') continue;
      const o = top as Record<string, unknown>;
      if (!isSchemaContext(o['@context'])) {
        if (o['@context'] === undefined) f.add('sd-no-context', at, where);
        else continue; // Another vocabulary: not ours to judge.
      }
      collectIds(o, ctx);
      walk(o, `${where}`, ctx, found);
    }
  });
  for (const [id, where] of ctx.referenced) {
    if (!ctx.defined.has(id)) f.add('sd-missing-id', at, `${where} → ${id}`);
  }
  return found;
}

function collectIds(node: unknown, ctx: Ctx): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach((n) => collectIds(n, ctx));
  const o = node as Record<string, unknown>;
  const id = o['@id'];
  const keys = Object.keys(o).filter((k) => k !== '@id' && k !== '@context');
  if (typeof id === 'string' && keys.length > 0) ctx.defined.add(id);
  for (const [k, v] of Object.entries(o)) if (k !== '@context') collectIds(v, ctx);
}

function walk(node: unknown, where: string, ctx: Ctx, found: string[]): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${where}[${i}]`, ctx, found));
  const o = node as Record<string, unknown>;
  if (o['@graph']) return walk(o['@graph'], `${where} @graph`, ctx, found);
  const own = Object.keys(o).filter((k) => !k.startsWith('@'));
  const types = list(o['@type']).map(bare);
  if (types.length === 0) {
    const id = o['@id'];
    if (own.length === 0) {
      if (typeof id === 'string') ctx.referenced.set(id, where);
      return;
    }
    // A value object ({"@value": …}) or a node without a type.
    if (o['@value'] === undefined)
      ctx.f.add('sd-no-type', ctx.at, `${where}: ${own.slice(0, 4).join(', ')}`);
    return;
  }
  const v = vocab();
  const known = types.filter((t) => v.types[t]);
  for (const t of types) if (!v.types[t]) ctx.f.add('sd-unknown-type', ctx.at, `${where}: ${t}`);
  found.push(...types);
  const label = types.join('+');
  const family = new Set<string>();
  for (const t of known) lineage(t).forEach((a) => family.add(a));
  for (const k of own) {
    const prop = v.properties[k];
    if (!prop) {
      ctx.f.add('sd-unknown-property', ctx.at, `${where} ${label}: ${k}`);
      continue;
    }
    const [domain, , supersededBy] = prop;
    if (supersededBy)
      ctx.f.add('sd-superseded', ctx.at, `${where} ${label}: ${k} → use ${supersededBy}`);
    if (known.length && !domain.some((d) => family.has(d)))
      ctx.f.add(
        'sd-wrong-property',
        ctx.at,
        `${where} ${label}: ${k} (belongs to ${domain.slice(0, 4).join(', ')})`,
      );
    for (const value of list(o[k]))
      if (value && typeof value === 'object') walk(value, `${where}.${k}`, ctx, found);
  }
  if (known.length) google(o, known, where, ctx);
}

const has = (o: Record<string, unknown>, k: string) => {
  const v = o[k];
  return v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);
};

function google(o: Record<string, unknown>, types: string[], where: string, ctx: Ctx): void {
  // Google's rules are for the thing a page is about: a node at the top of a
  // block or of its @graph, not an author or a publisher nested inside one.
  if (where.includes('.')) return;
  const { f, at } = ctx;
  const need = (k: string, what: string) => {
    if (!has(o, k)) f.add('google-required', at, `${where} ${what}: ${k}`);
  };
  const want = (k: string, what: string) => {
    if (!has(o, k)) f.add('google-recommended', at, `${where} ${what}: ${k}`);
  };

  if (types.includes('BreadcrumbList')) {
    const items = list(o['itemListElement']) as Record<string, unknown>[];
    if (items.length === 0)
      f.add('google-required', at, `${where} BreadcrumbList: itemListElement`);
    items.forEach((item, i) => {
      if (!item || typeof item !== 'object') return;
      if (Number(item['position']) !== i + 1)
        f.add(
          'google-breadcrumb-order',
          at,
          `${where} item ${i + 1} has position ${String(item['position'])}`,
        );
      const named =
        has(item, 'name') ||
        (item['item'] &&
          typeof item['item'] === 'object' &&
          has(item['item'] as Record<string, unknown>, 'name'));
      if (!named) f.add('google-required', at, `${where} BreadcrumbList item ${i + 1}: name`);
      if (!has(item, 'item') && i < items.length - 1)
        f.add(
          'google-required',
          at,
          `${where} BreadcrumbList item ${i + 1}: item (only the last may leave it out)`,
        );
    });
  }
  if (types.includes('FAQPage')) {
    f.add('google-faq-limited', at, where);
    for (const q of list(o['mainEntity']) as Record<string, unknown>[]) {
      if (!q || typeof q !== 'object') continue;
      const answer = q['acceptedAnswer'] as Record<string, unknown> | undefined;
      if (!has(q, 'name')) f.add('google-required', at, `${where} FAQ Question: name`);
      if (!answer || !has(answer, 'text'))
        f.add(
          'google-required',
          at,
          `${where} FAQ Question ${JSON.stringify(String(q['name'] ?? '')).slice(0, 50)}: acceptedAnswer.text`,
        );
    }
  }
  if (types.includes('Product') || isA(types, 'Product')) {
    need('name', 'Product');
    if (!has(o, 'offers') && !has(o, 'review') && !has(o, 'aggregateRating'))
      f.add(
        'google-required',
        at,
        `${where} Product: offers, review or aggregateRating (one of them)`,
      );
    want('image', 'Product');
    for (const offer of list(o['offers']) as Record<string, unknown>[]) {
      if (!offer || typeof offer !== 'object') continue;
      const t = list(offer['@type']).map(bare);
      if (t.includes('AggregateOffer')) {
        if (!has(offer, 'lowPrice'))
          f.add('google-required', at, `${where} AggregateOffer: lowPrice`);
        if (!has(offer, 'priceCurrency'))
          f.add('google-required', at, `${where} AggregateOffer: priceCurrency`);
      } else if (t.includes('Offer')) {
        const spec = offer['priceSpecification'] as Record<string, unknown> | undefined;
        if (!has(offer, 'price') && !(spec && has(spec, 'price')))
          f.add('google-required', at, `${where} Offer: price`);
        if (!has(offer, 'priceCurrency') && !(spec && has(spec, 'priceCurrency')))
          f.add('google-recommended', at, `${where} Offer: priceCurrency`);
        if (!has(offer, 'availability'))
          f.add('google-recommended', at, `${where} Offer: availability`);
      }
    }
  }
  if (types.some((t) => ['Article', 'NewsArticle', 'BlogPosting'].includes(t))) {
    for (const k of ['headline', 'image', 'datePublished', 'author']) want(k, types[0]!);
  }
  if (isA(types, 'LocalBusiness')) {
    need('name', types[0]!);
    need('address', types[0]!);
    for (const k of ['telephone', 'url', 'openingHoursSpecification', 'geo']) want(k, types[0]!);
  } else if (isA(types, 'Organization') && !isA(types, 'LocalBusiness')) {
    for (const k of ['name', 'url', 'logo']) want(k, types[0]!);
  }
  if (isA(types, 'Event')) {
    need('name', types[0]!);
    need('startDate', types[0]!);
    need('location', types[0]!);
  }
}
