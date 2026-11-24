// The four browser tools against the broken site and its fixed copy. Skipped,
// with a message, when no Chrome or Edge is installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { serveFixture, type Served } from './helpers/fixture-server.ts';
import { connect } from './helpers/client.ts';
import { closeBrowser } from '../src/core/browser.ts';

let broken: Served;
let fixed: Served;
let mcp: Awaited<ReturnType<typeof connect>>;
const fast = { delay_ms: 100 };

async function hasBrowser(): Promise<boolean> {
  if (process.env['SITE_DOCTOR_BROWSER']) return true;
  for (const channel of ['chrome', 'msedge']) {
    try {
      const b = await chromium.launch({ channel });
      await b.close();
      return true;
    } catch {
      // Try the next one.
    }
  }
  return false;
}
const browser = await hasBrowser();
const skip = browser ? false : 'no Chrome or Edge on this machine';

before(async () => {
  broken = await serveFixture('broken');
  fixed = await serveFixture('fixed');
  mcp = await connect();
});
after(async () => {
  await mcp.close();
  await closeBrowser();
  await broken.close();
  await fixed.close();
});

const serious = (r: { kinds: (s?: 'fix-first' | 'worth-fixing') => string[] }) => [
  ...r.kinds('fix-first'),
  ...r.kinds('worth-fixing'),
];

test('measure_speed reports the largest paint and finds it lazy-loaded', { skip }, async () => {
  const r = await mcp.call('measure_speed', { url: broken.origin, ...fast });
  assert.equal(r.isError, false, r.text);
  assert.match(String(r.data.facts['largest paint element']), /^img/, r.text);
  assert.ok(r.kinds('fix-first').includes('lcp-lazy'), r.text);
  assert.ok(r.kinds().includes('render-blocking'), r.text);
  assert.match(
    r.data.findings.find((f) => f.kind === 'render-blocking')!.examples[0]!.at,
    /style\.css/,
  );
  assert.match(r.text, /pagespeed\.web\.dev\/report\?url=/);
  const ok = await mcp.call('measure_speed', { url: fixed.origin, ...fast });
  assert.ok(!ok.kinds().includes('lcp-lazy'), ok.text);
  assert.deepEqual(
    serious(ok).filter((k) => k !== 'runs-unsteady'),
    [],
    ok.text,
  );
});

test(
  'check_accessibility finds axe violations and pale text on a photograph',
  { skip },
  async () => {
    const r = await mcp.call('check_accessibility', { url: `${broken.origin}/services`, ...fast });
    assert.ok(r.kinds('fix-first').includes('axe-image-alt'), r.text);
    assert.ok(r.kinds('fix-first').includes('contrast-on-pixels'), r.text);
    const ok = await mcp.call('check_accessibility', { url: `${fixed.origin}/services`, ...fast });
    assert.deepEqual(serious(ok), [], ok.text);
    assert.ok(Number(ok.data.facts['lines measured on pixels']) >= 1, ok.text);
  },
);

test(
  'check_phone_fit finds a row wider than a phone, tiny text and small targets',
  { skip },
  async () => {
    const r = await mcp.call('check_phone_fit', {
      url: `${broken.origin}/services`,
      sizes: ['320x568', '390x844'],
      ...fast,
    });
    for (const kind of ['wider-than-screen', 'text-tiny', 'tap-target-small'])
      assert.ok(r.kinds().includes(kind), `${kind} missing:\n${r.text}`);
    assert.match(
      r.data.findings.find((f) => f.kind === 'wider-than-screen')!.examples[0]!.at,
      /div\.row/,
    );
    const ok = await mcp.call('check_phone_fit', {
      url: `${fixed.origin}/services`,
      sizes: ['320x568', '390x844'],
      ...fast,
    });
    assert.deepEqual(serious(ok), [], ok.text);
  },
);

test('check_page_errors finds a JavaScript error and a missing file', { skip }, async () => {
  const r = await mcp.call('check_page_errors', { url: `${broken.origin}/services`, ...fast });
  assert.ok(r.kinds('fix-first').includes('js-error'), r.text);
  assert.ok(r.kinds().includes('request-error-status'), r.text);
  const ok = await mcp.call('check_page_errors', { url: `${fixed.origin}/services`, ...fast });
  assert.deepEqual(serious(ok), [], ok.text);
});

test('the browser tools follow robots.txt too', { skip }, async () => {
  const r = await mcp.call('check_page_errors', {
    url: `${broken.origin}/private/secret`,
    ...fast,
  });
  assert.deepEqual(r.kinds(), ['robots-blocked']);
  assert.ok(!broken.requests.includes('GET /private/secret'));
});
