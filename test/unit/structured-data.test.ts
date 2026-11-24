import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkJsonLd, SD_KINDS } from '../../src/checks/structured-data.ts';
import { Findings } from '../../src/core/report.ts';

function kinds(values: unknown[]): string[] {
  const f = new Findings(SD_KINDS);
  checkJsonLd(
    values.map((value) => ({ raw: '', value })),
    f,
    '/',
  );
  return f.list().map((x) => `${x.kind}: ${x.examples.map((e) => e.detail).join(' | ')}`);
}

test('a valid graph passes', () => {
  const out = kinds([
    {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'Organization',
          '@id': 'https://e.com/#org',
          name: 'E',
          url: 'https://e.com',
          logo: 'https://e.com/l.png',
        },
        {
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://e.com/' },
            { '@type': 'ListItem', position: 2, name: 'Page' },
          ],
        },
        { '@type': 'Service', name: 'S', provider: { '@id': 'https://e.com/#org' } },
      ],
    },
  ]);
  assert.deepEqual(out, []);
});

test('unknown types and properties, properties on the wrong type, superseded ones', () => {
  const out = kinds([
    { '@context': 'https://schema.org', '@type': 'Organisation', name: 'x' },
    {
      '@context': 'https://schema.org',
      '@type': 'Person',
      nmae: 'x',
      price: 3,
      serviceArea: 'Beirut',
    },
  ]);
  assert.ok(
    out.some((k) => k.startsWith('sd-unknown-type: block 1: Organisation')),
    out.join('\n'),
  );
  assert.ok(
    out.some((k) => k.startsWith('sd-unknown-property') && k.includes('nmae')),
    out.join('\n'),
  );
  assert.ok(
    out.some((k) => k.startsWith('sd-wrong-property') && k.includes('price')),
    out.join('\n'),
  );
});

test("Google's rules: a Product without offers, an Event without a date, breadcrumbs out of order, a missing @id", () => {
  const out = kinds([
    { '@context': 'https://schema.org', '@type': 'Product', name: 'P' },
    { '@context': 'https://schema.org', '@type': 'Event', name: 'E', location: 'Beirut' },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 2, name: 'A', item: 'https://e.com/a' },
        { '@type': 'ListItem', position: 1, name: 'B' },
      ],
    },
    {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: 'W',
      publisher: { '@id': 'https://e.com/#nowhere' },
    },
  ]);
  const text = out.join('\n');
  assert.match(text, /google-required: .*Product: offers, review or aggregateRating/);
  assert.match(text, /google-required: .*Event: startDate/);
  assert.match(text, /google-breadcrumb-order/);
  assert.match(text, /sd-missing-id: .*#nowhere/);
});

test('a block without a context, and another vocabulary left alone', () => {
  const out = kinds([
    { '@type': 'Thing', name: 'x' },
    { '@context': 'https://example.org/vocab', '@type': 'Widget' },
  ]);
  assert.ok(out.some((k) => k.startsWith('sd-no-context')));
  assert.ok(!out.some((k) => k.includes('Widget')));
});
