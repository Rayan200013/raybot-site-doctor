// measure_speed: the page loaded as a mid-range phone on slow 4G sees it
// (Lighthouse's own throttling numbers, applied in the browser), three times
// from an empty cache, the middle run reported. Chrome's own paint, layout
// shift and long task entries, and every request with its size.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Page, CDPSession } from 'playwright-core';
import { defineTool, common, parseTarget } from '../core/tool.ts';
import { Findings, type Catalogue } from '../core/report.ts';
import { Site, toUrl } from '../core/site.ts';
import {
  withBrowser,
  newContext,
  throttle,
  PHONE,
  DESKTOP,
  SLOW_4G,
  SELECTOR_SOURCE,
  type Device,
} from '../core/browser.ts';
import { GATE_KINDS, mayLoad, pause } from '../checks/browser-gate.ts';
import { kb, ms, median, plural, quote, short } from '../core/text.ts';

const KINDS: Catalogue = {
  ...GATE_KINDS,
  'lcp-poor': {
    severity: 'fix-first',
    title: 'The largest paint comes after 4 s',
    advice:
      'The main picture or heading appears late. Start with the element named and its timeline: make it discoverable in the HTML, not lazy, with fetchpriority="high", smaller, and with nothing blocking the render before it.',
  },
  'lcp-slow': {
    severity: 'worth-fixing',
    title: 'The largest paint comes after 2.5 s',
    advice:
      'Google\'s "good" is within 2.5 s. Start with the element named and its timeline (when its file was found, how long it took, how long it waited to be drawn).',
  },
  'fcp-poor': {
    severity: 'fix-first',
    title: 'Nothing appears for more than 3 s',
    advice:
      'A visitor stares at a blank screen. Cut what blocks the first paint (the render-blocking files listed) and the server time.',
  },
  'fcp-slow': {
    severity: 'worth-fixing',
    title: 'The first paint comes after 1.8 s',
    advice:
      'Reduce what loads before anything can be drawn: render-blocking stylesheets and scripts, web fonts, the HTML itself.',
  },
  'cls-poor': {
    severity: 'fix-first',
    title: 'The page jumps as it loads (layout shift over 0.25)',
    advice:
      'Give pictures, embeds and ads their size before they load (width and height, or aspect-ratio), and do not insert content above what is already shown. The elements that moved are listed.',
  },
  'cls-some': {
    severity: 'worth-fixing',
    title: 'The page shifts as it loads (layout shift over 0.1)',
    advice:
      'Google\'s "good" is 0.1 or less. Reserve space for the elements listed before they load.',
  },
  'tbt-poor': {
    severity: 'fix-first',
    title: 'The page is unresponsive for over 600 ms while it loads',
    advice:
      'Long JavaScript tasks block taps and scrolling. Load less JavaScript, later (defer, split, remove unused libraries and third-party tags).',
  },
  'tbt-some': {
    severity: 'worth-fixing',
    title: 'The page is unresponsive for over 200 ms while it loads',
    advice: 'Long JavaScript tasks block taps. Defer or split the heaviest scripts.',
  },
  'lcp-lazy': {
    severity: 'fix-first',
    title: 'The largest picture is lazy-loaded',
    advice:
      'Remove loading="lazy" from the picture that paints largest (and add fetchpriority="high"): lazy loading makes the browser wait before even asking for it.',
  },
  'lcp-late-discovery': {
    severity: 'worth-fixing',
    title: "The largest picture isn't in the HTML",
    advice:
      'The browser finds it only after running scripts or reading CSS. Put it in the HTML as an <img> (or preload it with <link rel="preload" as="image">).',
  },
  'lcp-no-priority': {
    severity: 'note',
    title: 'The largest picture has no fetchpriority="high"',
    advice:
      'Add fetchpriority="high" to it, so the browser fetches it before less important files.',
  },
  'render-blocking': {
    severity: 'worth-fixing',
    title: 'Files that block the first paint',
    advice:
      'Nothing is drawn until these load. Inline the little CSS the first screen needs and load the rest later; give scripts defer or async; self-host and preload web fonts.',
  },
  'page-heavy': {
    severity: 'worth-fixing',
    title: 'The page downloads over 3 MB',
    advice:
      'On a phone plan this is slow and costly. The weight by kind shows where it goes; pictures and scripts are usual.',
  },
  'page-very-heavy': {
    severity: 'fix-first',
    title: 'The page downloads over 6 MB',
    advice:
      'Far heavier than most pages. The weight by kind shows where it goes; start with the largest files.',
  },
  'oversized-images': {
    severity: 'worth-fixing',
    title: 'Pictures far larger than they are drawn',
    advice:
      'Serve each picture at about the size it is shown (srcset and sizes, or an image service), in WebP or AVIF.',
  },
  'uncompressed-text': {
    severity: 'worth-fixing',
    title: 'Text files sent uncompressed',
    advice: 'Turn on gzip or Brotli for HTML, CSS, JavaScript, JSON and SVG on the server or CDN.',
  },
  'runs-unsteady': {
    severity: 'note',
    title: 'The three runs differ a lot',
    advice:
      'The timings moved by more than a quarter between runs: the computer may have been busy, or the site varies. Measure again with nothing else running (and on mains power).',
  },
};

interface Run {
  ttfb: number;
  fcp: number | null;
  lcp: number | null;
  lcpElement: {
    tag: string;
    selector: string;
    text: string;
    url: string;
    size: number;
    lazy: boolean;
    priority: string | null;
  } | null;
  cls: number;
  shifts: { value: number; sources: string[] }[];
  tbt: number;
  longTasks: number;
  dcl: number;
  load: number;
  requests: RequestInfo[];
  resources: { name: string; start: number; end: number; blocking: boolean }[];
  html: string;
}

interface RequestInfo {
  id: string;
  url: string;
  type: string;
  status: number;
  bytes: number;
  encoding: string | null;
  mime: string;
  failed: boolean;
}

export function registerMeasureSpeed(server: McpServer): void {
  defineTool(server, {
    name: 'measure_speed',
    title: 'Measure how fast a page loads',
    description:
      "Loads one page three times from an empty cache in the Chrome or Edge on this computer, as a mid-range phone on slow 4G (Lighthouse's slow 4G as DevTools applies it: 562.5 ms per request, 1,475 Kbps down, the processor 4× slower), or as a desktop. Reports the middle run: first paint, largest paint and which element it is (with its timeline), layout shift and what moved, blocking time from long tasks, weight by kind, files that block the first paint, pictures far larger than drawn, text sent uncompressed. Then what to fix first, and a PageSpeed Insights link for real visitors' numbers. Takes about half a minute on a phone setting.",
    input: {
      url: z.string().describe('The page to measure, for example https://example.com'),
      device: z
        .enum(['phone', 'desktop'])
        .default('phone')
        .describe('phone (slow 4G, 4× slower processor) or desktop (no throttling)'),
      ignore_robots_txt: common.ignore_robots_txt,
      delay_ms: common.delay_ms,
      kind: common.kind,
    },
    async run(args, ctx) {
      const url = parseTarget(args.url, toUrl);
      const started = new Date();
      const site = new Site(url, {
        ignoreRobots: args.ignore_robots_txt,
        delayMs: args.delay_ms,
        signal: ctx.signal,
      });
      const f = new Findings(KINDS);
      const device = args.device === 'desktop' ? DESKTOP : PHONE;
      if (await mayLoad(site, url, f)) {
        await withBrowser(async (browser, label) => {
          const runs: Run[] = [];
          for (let i = 0; i < 3; i++) {
            if (ctx.signal.aborted) throw new Error('cancelled');
            ctx.progress(i, 4, `loading ${url.href} (run ${i + 1} of 3)`);
            await pause(url.origin, Math.max(args.delay_ms, 1000));
            const run = await measureOnce(browser, device, url.href);
            if (run) runs.push(run);
          }
          if (runs.length === 0) {
            f.add('page-error', url.href, 'it did not finish loading within 60 s, three times');
            return;
          }
          ctx.progress(3, 4, 'checking the pictures');
          runs.sort((a, b) => (a.lcp ?? a.load) - (b.lcp ?? b.load));
          const mid = runs[Math.floor(runs.length / 2)]!;
          report(f, mid, runs, device, label, url);
          // A fourth load, not slowed and scrolled to the end, for the pictures below the fold.
          await pause(url.origin, Math.max(args.delay_ms, 1000));
          await oversized(browser, device, url.href, mid, f);
        });
      }
      f.headline.push(...site.robotsHeadline());
      f.notes.push(
        `Measured in the lab, on this computer, with the network and processor slowed${device.mobile ? '' : ' (desktop: not slowed)'}; a busy computer reads slower. Real visitors' numbers (Chrome's field data, when the site has enough visitors): https://pagespeed.web.dev/report?url=${encodeURIComponent(url.href)}`,
      );
      return f.report(
        'measure_speed',
        url.href,
        site.ignoreRobots ? 'ignored' : 'followed',
        started,
      );
    },
  });
}

async function measureOnce(
  browser: import('playwright-core').Browser,
  device: Device,
  url: string,
): Promise<Run | null> {
  const context = await newContext(browser, device);
  try {
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const requests = await watchNetwork(cdp);
    if (device.mobile) await throttle(page, cdp);
    await page.addInitScript({ content: SELECTOR_SOURCE });
    await page.addInitScript(observe);
    let docId = '';
    cdp.on('Network.requestWillBeSent', (e: { requestId: string; type?: string }) => {
      if (!docId && e.type === 'Document') docId = e.requestId;
    });
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
    } catch {
      return null;
    }
    await settle(page);
    const m = (await page.evaluate(() => (window as unknown as { __sd: unknown }).__sd)) as Omit<
      Run,
      'requests' | 'html' | 'resources'
    > & {
      resources: Run['resources'];
    };
    let html = '';
    if (docId) {
      try {
        const body = (await cdp.send('Network.getResponseBody', { requestId: docId })) as {
          body: string;
          base64Encoded: boolean;
        };
        html = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
      } catch {
        // The body is not always kept; the late-discovery check then says nothing.
      }
    }
    return { ...m, requests: [...requests.values()], html };
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function watchNetwork(cdp: CDPSession): Promise<Map<string, RequestInfo>> {
  const requests = new Map<string, RequestInfo>();
  await cdp.send('Network.enable');
  cdp.on(
    'Network.requestWillBeSent',
    (e: { requestId: string; request: { url: string }; type?: string }) => {
      if (e.request.url.startsWith('data:')) return;
      requests.set(e.requestId, {
        id: e.requestId,
        url: e.request.url,
        type: e.type ?? 'Other',
        status: 0,
        bytes: 0,
        encoding: null,
        mime: '',
        failed: false,
      });
    },
  );
  cdp.on(
    'Network.responseReceived',
    (e: {
      requestId: string;
      type?: string;
      response: { status: number; mimeType: string; headers: Record<string, string> };
    }) => {
      const r = requests.get(e.requestId);
      if (!r) return;
      r.status = e.response.status;
      r.mime = e.response.mimeType;
      if (e.type) r.type = e.type;
      const h = Object.fromEntries(
        Object.entries(e.response.headers).map(([k, v]) => [k.toLowerCase(), v]),
      );
      r.encoding = h['content-encoding'] ?? null;
    },
  );
  cdp.on('Network.loadingFinished', (e: { requestId: string; encodedDataLength: number }) => {
    const r = requests.get(e.requestId);
    if (r) r.bytes = e.encodedDataLength;
  });
  cdp.on('Network.loadingFailed', (e: { requestId: string }) => {
    const r = requests.get(e.requestId);
    if (r) r.failed = true;
  });
  return requests;
}

/** Waits for a quiet page: the network idle and two seconds without a long task (at most ten more seconds). */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    const quiet = await page.evaluate(() => {
      const sd = (window as unknown as { __sd: { lastTaskEnd: number } }).__sd;
      return performance.now() - sd.lastTaskEnd > 2000;
    });
    if (quiet) break;
    await page.waitForTimeout(500);
  }
  await page.evaluate(() => (window as unknown as { __sdFinish: () => void }).__sdFinish());
}

/** Runs in the page before anything else: Chrome's own timing entries, kept as they come. */
function observe(): void {
  type Sd = Record<string, unknown> & {
    lastTaskEnd: number;
    tasks: { start: number; duration: number }[];
    shiftsRaw: { value: number; time: number; sources: string[] }[];
  };
  const sd: Sd = {
    fcp: null,
    lcp: null,
    lcpElement: null,
    tasks: [],
    shiftsRaw: [],
    lastTaskEnd: 0,
  } as unknown as Sd;
  (window as unknown as { __sd: Sd }).__sd = sd;
  const sel = (el: Element | null) =>
    (window as unknown as { __sdSelector: (e: Element | null) => string }).__sdSelector(el);
  const safe = (fn: () => void) => {
    try {
      fn();
    } catch {
      // An entry type this browser lacks.
    }
  };
  safe(() =>
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        if (e.name === 'first-contentful-paint') sd['fcp'] = e.startTime;
    }).observe({ type: 'paint', buffered: true }),
  );
  safe(() =>
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as (PerformanceEntry & {
        element: Element | null;
        url: string;
        size: number;
        renderTime: number;
        loadTime: number;
      })[]) {
        sd['lcp'] = e.startTime;
        const el = e.element;
        const img = el instanceof HTMLImageElement ? el : null;
        sd['lcpElement'] = {
          tag: el ? el.tagName.toLowerCase() : '(removed)',
          selector: sel(el),
          text: el && !e.url ? (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) : '',
          url: e.url || '',
          size: e.size,
          lazy: img ? img.loading === 'lazy' : false,
          priority: img ? img.getAttribute('fetchpriority') : null,
        };
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true }),
  );
  safe(() =>
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as (PerformanceEntry & {
        value: number;
        hadRecentInput: boolean;
        sources?: {
          node: Node | null;
          previousRect: DOMRectReadOnly;
          currentRect: DOMRectReadOnly;
        }[];
      })[]) {
        if (e.hadRecentInput) continue;
        sd.shiftsRaw.push({
          value: e.value,
          time: e.startTime,
          sources: (e.sources ?? []).map((s) => {
            const n = s.node;
            const name = n && n.nodeType === 1 ? sel(n as Element) : n ? n.nodeName : '(removed)';
            return `${name} moved ${Math.round(s.previousRect.y)}→${Math.round(s.currentRect.y)} px`;
          }),
        });
      }
    }).observe({ type: 'layout-shift', buffered: true }),
  );
  safe(() =>
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        sd.tasks.push({ start: e.startTime, duration: e.duration });
        sd.lastTaskEnd = Math.max(sd.lastTaskEnd, e.startTime + e.duration);
      }
    }).observe({ type: 'longtask', buffered: true }),
  );
  (window as unknown as { __sdFinish: () => void }).__sdFinish = () => {
    const nav = performance.getEntriesByType('navigation')[0] as
      PerformanceNavigationTiming | undefined;
    sd['ttfb'] = nav ? nav.responseStart : 0;
    sd['dcl'] = nav ? nav.domContentLoadedEventEnd : 0;
    sd['load'] = nav ? nav.loadEventEnd : 0;
    // Layout shift as Google counts it: the worst burst (gaps under 1 s, at most 5 s long).
    let worst = 0;
    let sum = 0;
    let first = 0;
    let last = 0;
    let windowShifts: typeof sd.shiftsRaw = [];
    let worstShifts: typeof sd.shiftsRaw = [];
    for (const s of sd.shiftsRaw) {
      if (sum && (s.time - last > 1000 || s.time - first > 5000)) {
        sum = 0;
        windowShifts = [];
      }
      if (!sum) first = s.time;
      sum += s.value;
      last = s.time;
      windowShifts.push(s);
      if (sum > worst) {
        worst = sum;
        worstShifts = [...windowShifts];
      }
    }
    sd['cls'] = worst;
    sd['shifts'] = worstShifts.map((s) => ({ value: s.value, sources: s.sources }));
    // Blocking time as Lighthouse counts it: each long task's part over 50 ms, after the first paint.
    const fcp = (sd['fcp'] as number | null) ?? 0;
    sd['tbt'] = sd.tasks
      .filter((t) => t.start >= fcp)
      .reduce((a, t) => a + Math.max(0, t.duration - 50), 0);
    sd['longTasks'] = sd.tasks.length;
    sd['resources'] = (
      performance.getEntriesByType('resource') as (PerformanceResourceTiming & {
        renderBlockingStatus?: string;
      })[]
    ).map((r) => ({
      name: r.name,
      start: r.startTime,
      end: r.responseEnd,
      blocking: r.renderBlockingStatus === 'blocking',
    }));
  };
}

const KIND_NAMES: Record<string, string> = {
  Document: 'HTML',
  Stylesheet: 'CSS',
  Script: 'JavaScript',
  Image: 'pictures',
  Font: 'fonts',
  Media: 'video and audio',
  Fetch: 'data (fetch)',
  XHR: 'data (XHR)',
};

function report(
  f: Findings,
  run: Run,
  runs: Run[],
  device: Device,
  browserLabel: string,
  url: URL,
): void {
  const origin = url.origin;
  const total = run.requests.reduce((a, r) => a + r.bytes, 0);
  const byKind = new Map<string, { n: number; bytes: number }>();
  for (const r of run.requests) {
    const k = KIND_NAMES[r.type] ?? 'other';
    const v = byKind.get(k) ?? { n: 0, bytes: 0 };
    v.n++;
    v.bytes += r.bytes;
    byKind.set(k, v);
  }
  f.facts['device'] = device.mobile
    ? `phone ${device.width}×${device.height} at ${device.scale}×, Lighthouse's slow 4G (${SLOW_4G.latencyMs} ms per request, ${Math.round(SLOW_4G.downloadKbps).toLocaleString('en-US')} Kbps down), processor ${SLOW_4G.cpuSlowdown}× slower`
    : `desktop ${device.width}×${device.height}, no throttling`;
  f.facts['browser'] = browserLabel;
  f.facts['runs (largest paint)'] =
    runs.map((r) => (r.lcp !== null ? ms(r.lcp) : 'none')).join(', ') +
    ' (the middle one reported)';
  f.facts['first byte'] = ms(run.ttfb);
  f.facts['first paint'] = run.fcp !== null ? ms(run.fcp) : 'none';
  f.facts['largest paint'] = run.lcp !== null ? ms(run.lcp) : 'none';
  if (run.lcpElement) {
    const e = run.lcpElement;
    f.facts['largest paint element'] =
      `${e.tag}${e.selector ? ` (${e.selector})` : ''}${e.url ? ` ${short(e.url, origin)}` : ''}${e.text ? ` ${quote(e.text, 60)}` : ''}`;
  }
  f.facts['layout shift'] = run.cls.toFixed(3);
  f.facts['blocking time'] = `${ms(run.tbt)} (${plural(run.longTasks, 'long task')})`;
  f.facts['load event'] = ms(run.load);
  f.facts['requests'] = run.requests.length;
  f.facts['weight'] = `${kb(total)}: ${[...byKind]
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .map(([k, v]) => `${k} ${kb(v.bytes)} (${v.n})`)
    .join(', ')}`;

  // Before the first paint.
  if (run.fcp !== null) {
    const before = run.resources.filter((r) => r.end <= run.fcp!);
    f.facts['loaded before the first paint'] = `${before.length} files`;
  }

  const lcp = run.lcp;
  if (lcp !== null) {
    const timeline = lcpTimeline(run);
    if (lcp > 4000) f.add('lcp-poor', url.href, `${ms(lcp)}; ${timeline}`);
    else if (lcp > 2500) f.add('lcp-slow', url.href, `${ms(lcp)}; ${timeline}`);
    else f.passed.push(`The largest paint comes at ${ms(lcp)} (within 2.5 s).`);
    if (timeline) f.facts['largest paint timeline'] = timeline;
  }
  if (run.fcp !== null) {
    if (run.fcp > 3000) f.add('fcp-poor', url.href, ms(run.fcp));
    else if (run.fcp > 1800) f.add('fcp-slow', url.href, ms(run.fcp));
    else f.passed.push(`The first paint comes at ${ms(run.fcp)} (within 1.8 s).`);
  }
  const shiftDetail = run.shifts
    .flatMap((s) => s.sources.map((src) => `${src} (${s.value.toFixed(3)})`))
    .slice(0, 6)
    .join('; ');
  if (run.cls > 0.25) f.add('cls-poor', url.href, `${run.cls.toFixed(3)}: ${shiftDetail}`);
  else if (run.cls > 0.1) f.add('cls-some', url.href, `${run.cls.toFixed(3)}: ${shiftDetail}`);
  else f.passed.push(`Layout shift ${run.cls.toFixed(3)} (0.1 or less is good).`);
  if (run.tbt > 600)
    f.add('tbt-poor', url.href, `${ms(run.tbt)} over ${plural(run.longTasks, 'long task')}`);
  else if (run.tbt > 200)
    f.add('tbt-some', url.href, `${ms(run.tbt)} over ${plural(run.longTasks, 'long task')}`);
  else f.passed.push(`Blocking time ${ms(run.tbt)} (200 ms or less is good).`);

  const el = run.lcpElement;
  if (el?.url && !el.url.startsWith('data:')) {
    if (el.lazy) f.add('lcp-lazy', short(el.url, origin), el.selector);
    const path = (() => {
      try {
        return new URL(el.url).pathname;
      } catch {
        return el.url;
      }
    })();
    if (run.html && !run.html.includes(path) && !run.html.includes(path.replace(/&/g, '&amp;'))) {
      f.add(
        'lcp-late-discovery',
        short(el.url, origin),
        'its address is not in the HTML the server sent',
      );
    }
    if (el.tag === 'img' && el.priority !== 'high' && !el.lazy)
      f.add('lcp-no-priority', short(el.url, origin), el.selector);
  }

  for (const r of run.resources.filter((x) => x.blocking)) {
    const req = run.requests.find((q) => q.url === r.name);
    f.add(
      'render-blocking',
      short(r.name, origin),
      `${ms(r.end - r.start)}${req ? `, ${kb(req.bytes)}` : ''}`,
    );
  }
  if (total > 6 * 1024 * 1024) f.add('page-very-heavy', url.href, kb(total));
  else if (total > 3 * 1024 * 1024) f.add('page-heavy', url.href, kb(total));

  for (const r of run.requests) {
    const textual =
      /^(text\/|application\/(javascript|json|xml|x-javascript|ld\+json|manifest\+json)|image\/svg)/i.test(
        r.mime,
      );
    if (textual && r.bytes > 2048 && !r.encoding && r.status === 200)
      f.add('uncompressed-text', short(r.url, origin), `${kb(r.bytes)} ${r.mime}`);
  }

  const values = runs.map((r) => r.lcp ?? r.load);
  const mid = median(values);
  if (mid > 0 && (Math.max(...values) - Math.min(...values)) / mid > 0.25) {
    f.add('runs-unsteady', url.href, values.map((v) => ms(v)).join(', '));
  }
  f.passIfNone(['render-blocking'], 'No file blocks the first paint.');
  f.passIfNone(['uncompressed-text'], 'Every text file is compressed.');
}

function lcpTimeline(run: Run): string {
  const el = run.lcpElement;
  if (!el || run.lcp === null) return '';
  if (!el.url) return `text: server ${ms(run.ttfb)}, then drawn ${ms(run.lcp - run.ttfb)} later`;
  const res = run.resources.find((r) => r.name === el.url);
  if (!res) return `picture ${el.url.startsWith('data:') ? '(inline)' : ''}`.trim();
  return `server ${ms(run.ttfb)}, picture asked for at ${ms(res.start)} (${ms(Math.max(0, res.start - run.ttfb))} after the first byte), loaded in ${ms(res.end - res.start)}, drawn ${ms(Math.max(0, run.lcp - res.end))} after it arrived`;
}

/** Pictures far larger than they are drawn, read after scrolling through the page once. */
async function oversized(
  browser: import('playwright-core').Browser,
  device: Device,
  url: string,
  run: Run,
  f: Findings,
): Promise<void> {
  const context = await newContext(browser, device);
  try {
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const requests = await watchNetwork(cdp);
    await page.addInitScript({ content: SELECTOR_SOURCE });
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
    } catch {
      return;
    }
    await page.evaluate(async () => {
      for (
        let y = 0;
        y < document.documentElement.scrollHeight && y < 30_000;
        y += innerHeight * 0.8
      ) {
        scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 150));
      }
      scrollTo(0, 0);
    });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
    const images = await page.evaluate(() =>
      [...document.images]
        .filter(
          (i) =>
            i.complete && i.naturalWidth > 0 && i.currentSrc && !i.currentSrc.startsWith('data:'),
        )
        .map((i) => {
          const r = i.getBoundingClientRect();
          return {
            src: i.currentSrc,
            nw: i.naturalWidth,
            nh: i.naturalHeight,
            w: r.width,
            h: r.height,
            dpr: devicePixelRatio,
            sel: (window as unknown as { __sdSelector: (e: Element) => string }).__sdSelector(i),
          };
        }),
    );
    // Sizes as they came over the wire in this load (lazy pictures included).
    const sizes = new Map(run.requests.map((r) => [r.url, r.bytes]));
    for (const r of requests.values()) if (r.bytes) sizes.set(r.url, r.bytes);
    const seen = new Set<string>();
    for (const i of images) {
      if (seen.has(i.src) || i.w < 1 || i.h < 1) continue;
      seen.add(i.src);
      const need = i.w * i.dpr * (i.h * i.dpr);
      const have = i.nw * i.nh;
      const bytes = sizes.get(i.src) ?? 0;
      const wasted = bytes * (1 - need / have);
      if (have > need * 2 && wasted > 20 * 1024) {
        f.add(
          'oversized-images',
          i.src.replace(/^https?:\/\/[^/]+/, ''),
          `${i.nw}×${i.nh} drawn at ${Math.round(i.w)}×${Math.round(i.h)} (×${i.dpr}); about ${Math.round(wasted / 1024)} KB more than needed`,
        );
      }
    }
  } finally {
    await context.close().catch(() => undefined);
  }
}
