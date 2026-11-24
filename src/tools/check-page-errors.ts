// check_page_errors: what breaks while a page loads in a real browser.
// JavaScript errors, requests that fail, insecure content on a secure page,
// and the other sites the page calls, with their weight.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { defineTool, common, parseTarget } from '../core/tool.ts';
import { Findings, type Catalogue } from '../core/report.ts';
import { Site, toUrl } from '../core/site.ts';
import { withBrowser, newContext, scrollThrough, PHONE, DESKTOP } from '../core/browser.ts';
import { GATE_KINDS, mayLoad, pause } from '../checks/browser-gate.ts';
import { kb, quote, short } from '../core/text.ts';

const KINDS: Catalogue = {
  ...GATE_KINDS,
  'js-error': {
    severity: 'fix-first',
    title: 'JavaScript errors while the page loads',
    advice:
      'An uncaught error can stop a menu, a form or a whole page from working. The message and where it came from are listed; reproduce it in the browser console.',
  },
  'console-error': {
    severity: 'worth-fixing',
    title: "Errors the page writes to the browser's console",
    advice:
      'Often a failed request or a blocked script (Content Security Policy). Each one listed is worth a look in the browser console.',
  },
  'request-failed': {
    severity: 'fix-first',
    title: 'Files the page asks for that fail',
    advice:
      'A missing script, stylesheet, font or picture. Fix the address in the page or put the file back.',
  },
  'request-error-status': {
    severity: 'worth-fixing',
    title: 'Files that answer an error status',
    advice:
      'The page asks for these and the server answers 4xx or 5xx. Fix the address, or stop asking for them.',
  },
  'mixed-content': {
    severity: 'fix-first',
    title: 'Insecure (http://) files on a secure page',
    advice: 'Browsers block or warn about them. Load every file over https://.',
  },
  'third-party-heavy': {
    severity: 'worth-fixing',
    title: 'Other sites the page loads over 500 KB from',
    advice:
      'Third-party scripts (chat, analytics, ads, embeds) slow the page and are outside your control. Keep the ones that earn their weight; load the others later or on demand.',
  },
};

/** The site part of a host name: "cdn.example.co.uk" → "example.co.uk". */
export function siteOf(host: string): string {
  const parts = host.replace(/^\[|\]$/g, '').split('.');
  if (parts.length <= 2 || /^\d+$/.test(parts[parts.length - 1]!)) return host;
  const two = parts.slice(-2).join('.');
  // Second-level suffixes where a site is three labels: example.co.uk, example.com.lb.
  if (/^(co|com|net|org|gov|edu|ac|or|ne|go)\.[a-z]{2}$/.test(two))
    return parts.slice(-3).join('.');
  return two;
}

export function registerCheckPageErrors(server: McpServer): void {
  defineTool(server, {
    name: 'check_page_errors',
    title: 'Check what breaks while a page loads',
    description:
      'Loads one page in the Chrome or Edge on this computer (as a phone by default), scrolls through it, and reports what breaks: uncaught JavaScript errors, console errors, requests that fail (a missing script, font or picture) or answer an error status, insecure http:// content on an https page, and the other sites the page calls, with how many requests and how many bytes each.',
    input: {
      url: z.string().describe('The page to check, for example https://example.com'),
      device: z.enum(['phone', 'desktop']).default('phone'),
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
          f.facts['browser'] = label;
          await pause(url.origin, Math.max(args.delay_ms, 1000));
          ctx.progress(0, 2, `loading ${url.href}`);
          const context = await newContext(browser, device);
          try {
            const page = await context.newPage();
            const cdp = await context.newCDPSession(page);
            await cdp.send('Network.enable');
            const bytes = new Map<string, number>();
            const urls = new Map<string, string>();
            cdp.on(
              'Network.requestWillBeSent',
              (e: { requestId: string; request: { url: string } }) =>
                urls.set(e.requestId, e.request.url),
            );
            cdp.on(
              'Network.loadingFinished',
              (e: { requestId: string; encodedDataLength: number }) =>
                bytes.set(e.requestId, e.encodedDataLength),
            );
            const origin = url.origin;
            page.on('pageerror', (e) => {
              const where =
                (e.stack ?? '')
                  .split('\n')
                  .find((l) => /https?:\/\//.test(l))
                  ?.trim() ?? '';
              f.add(
                'js-error',
                short(page.url(), origin),
                `${quote(e.message, 160)}${where ? ` ${where.replace(/^at\s+/, 'at ').slice(0, 160)}` : ''}`,
              );
            });
            page.on('console', (m) => {
              if (m.type() !== 'error') return;
              // A file that failed is already listed with its status.
              if (/^Failed to load resource/.test(m.text())) return;
              const loc = m.location();
              f.add(
                'console-error',
                loc.url ? `${short(loc.url, origin)}:${loc.lineNumber}` : short(page.url(), origin),
                quote(m.text(), 200),
              );
            });
            page.on('requestfailed', (r) => {
              const why = r.failure()?.errorText ?? 'failed';
              // A request the page itself cancelled (navigation, a closed stream) is not a fault.
              if (/ERR_ABORTED/.test(why)) return;
              f.add('request-failed', short(r.url(), origin), `${r.resourceType()}: ${why}`);
            });
            page.on('response', (r) => {
              if (r.status() >= 400)
                f.add(
                  'request-error-status',
                  short(r.url(), origin),
                  `${r.status()} (${r.request().resourceType()})`,
                );
            });
            page.on('request', (r) => {
              if (url.protocol === 'https:' && r.url().startsWith('http://'))
                f.add('mixed-content', r.url(), r.resourceType());
            });
            let status: number | null = null;
            try {
              const res = await page.goto(url.href, { waitUntil: 'load', timeout: 45_000 });
              status = res?.status() ?? null;
            } catch (e) {
              f.add('page-error', url.href, (e as Error).message.split('\n')[0]);
            }
            if (status !== null && status >= 400)
              f.add('page-error', url.href, `answers ${status}`);
            await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
            ctx.progress(1, 2, 'scrolling through the page');
            await scrollThrough(page).catch(() => undefined);
            await page.waitForTimeout(1500);

            // Other sites, by how much they send.
            const own = siteOf(new URL(page.url()).hostname);
            const hosts = new Map<string, { n: number; bytes: number }>();
            let firstParty = 0;
            for (const [id, u] of urls) {
              let host: string;
              try {
                const parsed = new URL(u);
                if (!/^https?:$/.test(parsed.protocol)) continue;
                host = parsed.hostname;
              } catch {
                continue;
              }
              const b = bytes.get(id) ?? 0;
              if (siteOf(host) === own) {
                firstParty += b;
                continue;
              }
              const v = hosts.get(host) ?? { n: 0, bytes: 0 };
              v.n++;
              v.bytes += b;
              hosts.set(host, v);
            }
            const third = [...hosts].sort((a, b) => b[1].bytes - a[1].bytes);
            const thirdTotal = third.reduce((a, [, v]) => a + v.bytes, 0);
            f.facts['requests'] = urls.size;
            f.facts['from the site itself'] = kb(firstParty);
            f.facts['from other sites'] = third.length
              ? `${kb(thirdTotal)} from ${third.length} hosts: ${third
                  .slice(0, 8)
                  .map(([h, v]) => `${h} ${kb(v.bytes)} (${v.n})`)
                  .join(', ')}`
              : 'none';
            const bySite = new Map<string, number>();
            for (const [h, v] of third)
              bySite.set(siteOf(h), (bySite.get(siteOf(h)) ?? 0) + v.bytes);
            for (const [s, b] of bySite) if (b > 500 * 1024) f.add('third-party-heavy', s, kb(b));
          } finally {
            await context.close().catch(() => undefined);
          }
        });
        f.passIfNone(['js-error'], 'No uncaught JavaScript error.');
        f.passIfNone(['console-error'], 'Nothing written to the console as an error.');
        f.passIfNone(
          ['request-failed', 'request-error-status'],
          'Every file the page asks for loads.',
        );
        if (url.protocol === 'https:')
          f.passIfNone(['mixed-content'], 'No insecure http:// content.');
      }
      f.headline.push(...site.robotsHeadline());
      return f.report(
        'check_page_errors',
        url.href,
        site.ignoreRobots ? 'ignored' : 'followed',
        started,
      );
    },
  });
}
