// The four network-only tools against a site built to be wrong, and its fixed copy.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { serveFixture, type Served } from './helpers/fixture-server.ts';
import { connect } from './helpers/client.ts';

let broken: Served;
let fixed: Served;
let mcp: Awaited<ReturnType<typeof connect>>;
const fast = { delay_ms: 100 };

before(async () => {
  broken = await serveFixture('broken');
  fixed = await serveFixture('fixed');
  mcp = await connect();
});
after(async () => {
  await mcp.close();
  await broken.close();
  await fixed.close();
});

/** No finding the fixed copy should still have: nothing to fix first, nothing worth fixing. */
function clean(kinds: string[], label: string): void {
  assert.deepEqual(kinds, [], `${label} still reports: ${kinds.join(', ')}`);
}

test('check_page finds what is wrong with one page', async () => {
  const about = await mcp.call('check_page', { url: `${broken.origin}/about`, ...fast });
  assert.ok(about.kinds('fix-first').includes('json-ld-unparseable'), about.text);
  assert.ok(about.kinds().includes('not-compressed'), about.text);
  const home = await mcp.call('check_page', { url: broken.origin, ...fast });
  assert.equal(home.data.facts['status'], 200);
  assert.match(String(home.data.facts['share image']), /1200×630/);
});

test('check_page passes the fixed pages', async () => {
  for (const path of ['/', '/about', '/services', '/orphan', '/team']) {
    const r = await mcp.call('check_page', { url: fixed.origin + path, ...fast });
    clean([...r.kinds('fix-first'), ...r.kinds('worth-fixing')], `check_page ${path}`);
  }
});

test('check_page follows robots.txt, and says so at the top when told to ignore it', async () => {
  const blocked = await mcp.call('check_page', { url: `${broken.origin}/private/secret`, ...fast });
  assert.deepEqual(blocked.kinds(), ['robots-blocked']);
  assert.equal(blocked.data.robots_txt, 'followed');
  assert.ok(!broken.requests.includes('GET /private/secret'), 'the blocked page was requested');

  const read = await mcp.call('check_page', {
    url: `${broken.origin}/private/secret`,
    ignore_robots_txt: true,
    ...fast,
  });
  assert.equal(read.data.robots_txt, 'ignored');
  assert.match(read.text.split('\n')[1] ?? '', /robots\.txt was IGNORED/);
  assert.match(read.data.headline[0] ?? '', /1 of the pages read are disallowed/);
  assert.ok(broken.requests.includes('GET /private/secret'));
});

test('check_sitemaps finds listed addresses that error, redirect or are disallowed', async () => {
  const r = await mcp.call('check_sitemaps', { url: broken.origin, ...fast });
  for (const kind of ['listed-error', 'listed-blocked', 'listed-redirect'])
    assert.ok(r.kinds().includes(kind), `${kind} missing:\n${r.text}`);
  assert.equal(r.data.facts['addresses listed'], 7);
  const ok = await mcp.call('check_sitemaps', { url: fixed.origin, ...fast });
  clean([...ok.kinds('fix-first'), ...ok.kinds('worth-fixing')], 'check_sitemaps');
});

test('check_site finds duplicate titles, a broken link and an orphan', async () => {
  const r = await mcp.call('check_site', { url: broken.origin, ...fast });
  for (const kind of ['broken-link', 'title-duplicate', 'orphan', 'json-ld-unparseable']) {
    assert.ok(r.kinds().includes(kind), `${kind} missing:\n${r.text}`);
  }
  const link = r.data.findings.find((f) => f.kind === 'broken-link')!;
  assert.match(link.examples[0]!.detail ?? '', /linked from \//);
  const ok = await mcp.call('check_site', { url: fixed.origin, ...fast });
  clean([...ok.kinds('fix-first'), ...ok.kinds('worth-fixing')], 'check_site');
  assert.ok(
    ok.data.passed.some((p) => /linked from another page/.test(p)),
    ok.text,
  );
});

test('kind re-reads the earlier check, with every example', async () => {
  const before = broken.requests.length;
  const r = await mcp.call('check_site', { url: broken.origin, ...fast, kind: 'broken-link' });
  assert.equal(broken.requests.length, before, 'kind should not read the site again');
  assert.equal(r.data.from_earlier_check, true);
  assert.deepEqual(r.kinds(), ['broken-link']);
});

test('check_structured_data finds broken JSON-LD and unknown types', async () => {
  const r = await mcp.call('check_structured_data', {
    url: broken.origin,
    whole_site: true,
    ...fast,
  });
  assert.ok(r.kinds('fix-first').includes('sd-unparseable'), r.text);
  assert.ok(r.kinds('fix-first').includes('sd-unknown-type'), r.text);
  assert.match(String(r.data.facts['vocabulary']), /^schema\.org \d+\.\d+/);
  const ok = await mcp.call('check_structured_data', {
    url: fixed.origin,
    whole_site: true,
    ...fast,
  });
  clean([...ok.kinds('fix-first'), ...ok.kinds('worth-fixing')], 'check_structured_data');
});

test('an address that does not answer is a plain error, not a crash', async () => {
  const r = await mcp.call('check_page', { url: 'http://127.0.0.1:9/', ...fast });
  assert.equal(r.isError, true);
  assert.match(r.text, /Could not read/);
});
