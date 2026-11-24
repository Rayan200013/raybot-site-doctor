import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRobots, rulesFor, isAllowed } from '../../src/core/robots.ts';

const allowed = (text: string, path: string, token = 'raybot-site-doctor') =>
  isAllowed(rulesFor(parseRobots(text), token).rules, new URL(path, 'https://example.com')).allowed;

test('the longest matching rule wins, and allow wins a tie', () => {
  const txt = 'User-agent: *\nDisallow: /shop/\nAllow: /shop/public/\nDisallow: /a\nAllow: /a';
  assert.equal(allowed(txt, '/shop/cart'), false);
  assert.equal(allowed(txt, '/shop/public/x'), true);
  assert.equal(allowed(txt, '/a'), true);
  assert.equal(allowed(txt, '/about'), true);
});

test('wildcards and the end anchor', () => {
  const txt = 'User-agent: *\nDisallow: /*.pdf$\nDisallow: /search?*q=';
  assert.equal(allowed(txt, '/files/a.pdf'), false);
  assert.equal(allowed(txt, '/files/a.pdf?x=1'), true);
  assert.equal(allowed(txt, '/search?lang=en&q=x'), false);
});

test('our own group is used before *, and an empty Disallow allows everything', () => {
  const txt = 'User-agent: *\nDisallow: /\n\nUser-agent: raybot-site-doctor\nDisallow:';
  assert.equal(allowed(txt, '/page'), true);
  assert.equal(allowed('User-agent: *\nDisallow: /', '/page'), false);
  assert.equal(allowed('User-agent: *\nDisallow: /', '/robots.txt'), true);
});

test('groups with several agents, sitemaps, unknown lines, rules before any agent, crawl-delay', () => {
  const r = parseRobots(
    'Disallow: /early\nUser-agent: a\nUser-agent: *\nCrawl-delay: 2\nDisalow: /typo\nDisallow: /x\nSitemap: https://example.com/s.xml\n',
  );
  assert.equal(r.orphanRules, 1);
  assert.deepEqual(r.sitemaps, ['https://example.com/s.xml']);
  assert.equal(r.unknown[0]?.text, 'Disalow: /typo');
  const chosen = rulesFor(r, 'raybot-site-doctor');
  assert.equal(chosen.crawlDelay, 2);
  assert.equal(chosen.rules.length, 1);
});

test('percent-encoded and plain paths compare equal', () => {
  assert.equal(allowed('User-agent: *\nDisallow: /café', '/caf%C3%A9'), false);
});
