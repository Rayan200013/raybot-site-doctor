// The browser checks use the Chrome or Edge already on the computer, started
// headless by playwright-core; nothing downloads a browser. One browser check
// runs at a time (a speed measurement must not share the processor with
// another page), and the browser closes a minute after the last one.
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type CDPSession,
} from 'playwright-core';
import { existsSync } from 'node:fs';
import { UserError } from './tool.ts';
import { NAME, VERSION, REPOSITORY } from '../version.ts';

export interface Device {
  name: string;
  width: number;
  height: number;
  scale: number;
  mobile: boolean;
}

/** Lighthouse's phone (a Moto G Power) and its desktop. */
export const PHONE: Device = { name: 'phone', width: 412, height: 823, scale: 1.75, mobile: true };
export const DESKTOP: Device = {
  name: 'desktop',
  width: 1350,
  height: 940,
  scale: 1,
  mobile: false,
};

/** Lighthouse's "slow 4G" with applied (DevTools) throttling, and its 4× slower processor. */
export const SLOW_4G = {
  latencyMs: 562.5,
  downloadKbps: 1474.56,
  uploadKbps: 675,
  cpuSlowdown: 4,
};

export class NoBrowserError extends UserError {}

interface Running {
  browser: Browser;
  label: string;
}

let running: Promise<Running> | null = null;
let idle: NodeJS.Timeout | null = null;
let queue: Promise<unknown> = Promise.resolve();

function candidates(): { label: string; options: Parameters<typeof chromium.launch>[0] }[] {
  const list: { label: string; options: Parameters<typeof chromium.launch>[0] }[] = [];
  const own = process.env['SITE_DOCTOR_BROWSER'];
  if (own) list.push({ label: own, options: { executablePath: own } });
  for (const channel of [
    'chrome',
    'msedge',
    'chrome-beta',
    'msedge-beta',
    'chrome-dev',
    'msedge-dev',
    'chrome-canary',
  ]) {
    list.push({
      label:
        channel === 'msedge' ? 'Microsoft Edge' : channel === 'chrome' ? 'Google Chrome' : channel,
      options: { channel },
    });
  }
  for (const path of [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ]) {
    if (existsSync(path)) list.push({ label: path, options: { executablePath: path } });
  }
  return list;
}

async function launch(): Promise<Running> {
  const tried: string[] = [];
  for (const c of candidates()) {
    try {
      const browser = await chromium.launch({
        ...c.options,
        headless: true,
        args: [
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-extensions',
          '--mute-audio',
        ],
      });
      return { browser, label: `${c.label} ${browser.version()}` };
    } catch (e) {
      tried.push(`${c.label}: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  throw new NoBrowserError(
    'This check needs Google Chrome, Microsoft Edge or Chromium on this computer, and none was found. ' +
      'Install Chrome or Edge, or set SITE_DOCTOR_BROWSER to the path of a Chromium-based browser. ' +
      'The other checks (check_page, check_sitemaps, check_site, check_structured_data) work without one.',
  );
}

/** Runs one browser check at a time, with the shared browser. */
export function withBrowser<T>(fn: (browser: Browser, label: string) => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    if (idle) {
      clearTimeout(idle);
      idle = null;
    }
    running ??= launch();
    let r: Running;
    try {
      r = await running;
    } catch (e) {
      running = null;
      throw e;
    }
    if (!r.browser.isConnected()) {
      running = launch();
      r = await running;
    }
    try {
      return await fn(r.browser, r.label);
    } finally {
      idle = setTimeout(() => {
        const closing = running;
        running = null;
        void closing?.then((x) => x.browser.close()).catch(() => undefined);
      }, 60_000);
      idle.unref();
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

export async function closeBrowser(): Promise<void> {
  if (idle) clearTimeout(idle);
  const closing = running;
  running = null;
  await closing?.then((x) => x.browser.close()).catch(() => undefined);
}

function userAgent(browser: Browser, device: Device): string {
  const major = browser.version().split('.')[0];
  const us = `${NAME}/${VERSION} (+${REPOSITORY})`;
  return device.mobile
    ? `Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36 ${us}`
    : `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36 ${us}`;
}

/** A fresh context (empty cache, no cookies) sized as a device. */
export async function newContext(
  browser: Browser,
  device: Device,
  options: { reducedMotion?: boolean; bypassCSP?: boolean } = {},
): Promise<BrowserContext> {
  return browser.newContext({
    // Only to add the check's own style rules (hiding text to read what is behind it).
    bypassCSP: options.bypassCSP ?? false,
    viewport: { width: device.width, height: device.height },
    screen: { width: device.width, height: device.height },
    deviceScaleFactor: device.scale,
    isMobile: device.mobile,
    hasTouch: device.mobile,
    userAgent: userAgent(browser, device),
    reducedMotion: options.reducedMotion ? 'reduce' : 'no-preference',
    serviceWorkers: 'block',
    acceptDownloads: false,
    javaScriptEnabled: true,
  });
}

export async function throttle(page: Page, cdp: CDPSession): Promise<void> {
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: SLOW_4G.latencyMs,
    downloadThroughput: (SLOW_4G.downloadKbps * 1024) / 8,
    uploadThroughput: (SLOW_4G.uploadKbps * 1024) / 8,
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: SLOW_4G.cpuSlowdown });
  void page;
}

/** Loads a page and waits until it settles: the load event, then a quiet network (at most a few seconds more). */
export async function load(
  page: Page,
  url: string,
  timeoutMs = 45_000,
): Promise<{ status: number | null; finalUrl: string }> {
  const res = await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
  return { status: res?.status() ?? null, finalUrl: page.url() };
}

/** Scrolls to the bottom and back, as a reader would, so lazy pictures and sections draw. */
export async function scrollThrough(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const step = Math.max(200, Math.floor(innerHeight * 0.8));
    for (let y = 0; y < document.documentElement.scrollHeight && y < 40_000; y += step) {
      scrollTo({ top: y, behavior: 'instant' as ScrollBehavior });
      await new Promise((r) => setTimeout(r, 120));
    }
    scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  });
  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => undefined);
}

/** A short CSS path to an element, for the report. Runs in the page. */
export const SELECTOR_SOURCE = `
window.__sdSelector = (el) => {
  if (!el || el.nodeType !== 1) return '';
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement && parts.length < 4) {
    let part = node.tagName.toLowerCase();
    if (node.id && /^[A-Za-z][\\w-]*$/.test(node.id)) { parts.unshift(part + '#' + node.id); break; }
    const cls = [...node.classList].filter((c) => /^[A-Za-z][\\w-]*$/.test(c) && c.length < 30).slice(0, parts.length ? 1 : 2);
    if (cls.length) part += '.' + cls.join('.');
    const parent = node.parentElement;
    if (parent) {
      const same = [...parent.children].filter((c) => c.tagName === node.tagName);
      if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(' > ');
};
`;
