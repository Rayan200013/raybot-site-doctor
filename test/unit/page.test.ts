import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPage, key, robotsDirectives, primaryLanguage } from '../../src/core/page.ts';

const html = `<!doctype html><html lang="ar" dir="rtl"><head>
<base href="https://e.com/sub/">
<title>Page title</title>
<meta name="description" content="A description">
<meta name="robots" content="noindex, follow">
<meta property="og:image" content="/share.png">
<link rel="canonical" href="https://e.com/sub/page">
<link rel="alternate" hreflang="en" href="/en/page">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Thing"}</script>
<script type="application/ld+json">{ broken </script>
</head><body>
<svg><title>Not the page's title</title></svg>
<h1>Main <span>heading</span></h1><h2>Second</h2>
<a href="next">Next</a><a href="#top">Top</a><a href="mailto:x@e.com">Mail</a><a href="/pic"><img src="p.png" alt="A picture"></a>
<img src="q.png">
<template><a href="/hidden">Hidden</a></template>
</body></html>`;

test('reads the head and body the way a crawler does', () => {
  const p = readPage(html, 'https://e.com/sub/page');
  assert.equal(p.lang, 'ar');
  assert.equal(p.dir, 'rtl');
  assert.deepEqual(p.titles, ['Page title']);
  assert.deepEqual(p.descriptions, ['A description']);
  assert.deepEqual(p.canonicals, ['https://e.com/sub/page']);
  assert.deepEqual(p.hreflang, [{ lang: 'en', href: 'https://e.com/en/page' }]);
  assert.equal(p.meta['og:image'], '/share.png');
  assert.deepEqual(p.headings, [
    { level: 1, text: 'Main heading' },
    { level: 2, text: 'Second' },
  ]);
  assert.deepEqual(
    p.links.map((l) => [l.href, l.text]),
    [
      ['https://e.com/sub/next', 'Next'],
      ['https://e.com/pic', 'A picture'],
    ],
  );
  assert.equal(p.images.length, 2);
  assert.equal(p.images[1]!.alt, null);
  assert.equal(p.jsonLd.length, 2);
  assert.ok(p.jsonLd[1]!.error);
  assert.equal(robotsDirectives(p, 'googlebot: nofollow').noindex, true);
});

test('addresses compare without fragments or trailing slashes', () => {
  assert.equal(key('https://e.com/a/#x'), 'https://e.com/a');
  assert.equal(key('https://e.com/'), 'https://e.com/');
  assert.equal(key('https://e.com/a?b=1'), 'https://e.com/a?b=1');
  assert.equal(primaryLanguage('fr-LB'), 'fr');
});
