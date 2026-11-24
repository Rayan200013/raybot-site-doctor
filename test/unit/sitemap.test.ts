import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { parseSitemap, validLastmod } from '../../src/core/sitemap.ts';

const NS =
  'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml"';

test('a urlset with language alternates', () => {
  const xml = `<?xml version="1.0"?><urlset ${NS}><url><loc>https://e.com/a?x=1&amp;y=2</loc><lastmod>2026-11-01</lastmod><xhtml:link rel="alternate" hreflang="fr" href="https://e.com/fr/a"/></url><url><loc><![CDATA[https://e.com/b]]></loc></url></urlset>`;
  const p = parseSitemap(Buffer.from(xml));
  assert.equal(p.type, 'urlset');
  assert.deepEqual(p.problems, []);
  assert.equal(p.entries[0]!.loc, 'https://e.com/a?x=1&y=2');
  assert.deepEqual(p.entries[0]!.alternates, [{ lang: 'fr', href: 'https://e.com/fr/a' }]);
  assert.equal(p.entries[1]!.loc, 'https://e.com/b');
});

test('an index, gzipped', () => {
  const xml =
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://e.com/s1.xml</loc></sitemap></sitemapindex>';
  const p = parseSitemap(gzipSync(xml));
  assert.equal(p.type, 'sitemapindex');
  assert.equal(p.sitemaps[0]!.loc, 'https://e.com/s1.xml');
});

test('problems: a bare &, a cut file, no namespace, not a sitemap', () => {
  const p = parseSitemap(
    Buffer.from(
      '<urlset><url><loc>https://e.com/?a=1&b=2</loc></url><url><loc>https://e.com/c</loc>',
    ),
  );
  assert.ok(p.problems.some((x) => /&amp;/.test(x)));
  assert.ok(p.problems.some((x) => /opened but/.test(x)));
  assert.ok(p.problems.some((x) => /namespace/.test(x)));
  assert.ok(parseSitemap(Buffer.from('<html><body>Not found</body></html>')).problems.length > 0);
});

test('a text sitemap', () => {
  const p = parseSitemap(Buffer.from('https://e.com/a\nhttps://e.com/b\n'));
  assert.equal(p.type, 'text');
  assert.equal(p.entries.length, 2);
});

test('lastmod dates', () => {
  for (const ok of [
    '2026',
    '2026-11',
    '2026-11-23',
    '2026-11-23T10:00:00+02:00',
    '2026-11-23T10:00Z',
  ])
    assert.equal(validLastmod(ok), true, ok);
  for (const bad of ['23/11/2026', '2026-11-23 10:00', 'yesterday', '2026-13-01'])
    assert.equal(validLastmod(bad), false, bad);
});
