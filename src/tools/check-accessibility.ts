// check_accessibility: axe (WCAG 2.2 AA) at phone and desktop widths, the
// whole page drawn first, then contrast measured on the real pixels for the
// text axe can't judge (over a photograph, a gradient, a video).
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Browser, Page } from 'playwright-core';
import { defineTool, common, parseTarget } from '../core/tool.ts';
import { Findings, type Catalogue, type Severity } from '../core/report.ts';
import { Site, toUrl } from '../core/site.ts';
import {
  withBrowser,
  newContext,
  load,
  scrollThrough,
  PHONE,
  DESKTOP,
  SELECTOR_SOURCE,
  type Device,
} from '../core/browser.ts';
import { GATE_KINDS, mayLoad, pause } from '../checks/browser-gate.ts';
import { decodePng, luminance, contrast } from '../core/png.ts';
import { quote } from '../core/text.ts';

const require = createRequire(import.meta.url);
let axeSource: string | null = null;
const axe = () => (axeSource ??= readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'));
const axeVersion = () => (require('axe-core/package.json') as { version: string }).version;

const KINDS: Catalogue = {
  ...GATE_KINDS,
  'contrast-on-pixels': {
    severity: 'fix-first',
    title: 'Text too pale against what is actually behind it',
    advice:
      'Measured on the real pixels (a photograph, a gradient or a video under the text). Darken the picture behind the text (a veil or a gradient), move the text onto a solid band, or change its colour; small text needs 4.5:1, large text 3:1 (WCAG 1.4.3).',
  },
};

const IMPACT: Record<string, Severity> = {
  critical: 'fix-first',
  serious: 'fix-first',
  moderate: 'worth-fixing',
  minor: 'note',
};
const MAX_PIXEL_CHECKS = 150;

interface AxeNode {
  target: unknown[];
  html: string;
  failureSummary?: string;
}
interface AxeRule {
  id: string;
  impact: string | null;
  help: string;
  description: string;
  helpUrl: string;
  nodes: AxeNode[];
}

export function registerCheckAccessibility(server: McpServer): void {
  defineTool(server, {
    name: 'check_accessibility',
    title: 'Check accessibility (WCAG 2.2 AA)',
    description:
      "Runs axe-core (WCAG 2.2 AA rules) on one page at phone and desktop widths, after scrolling through it so lazy and below-the-fold sections are drawn. Then measures contrast on the real pixels for every line of text axe leaves 'to review' (text over a photograph, a gradient or a video): each line against the worst of what is actually behind it. Reports each problem with the element, what is wrong and the WCAG rule. Uses the Chrome or Edge on this computer.",
    input: {
      url: z.string().describe('The page to check, for example https://example.com'),
      widths: z
        .enum(['both', 'phone', 'desktop'])
        .default('both')
        .describe('Check at phone width, desktop width, or both.'),
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
      const devices =
        args.widths === 'phone'
          ? [PHONE]
          : args.widths === 'desktop'
            ? [DESKTOP]
            : [PHONE, DESKTOP];
      if (await mayLoad(site, url, f)) {
        await withBrowser(async (browser, label) => {
          f.facts['browser'] = label;
          f.facts['rules'] = `axe-core ${axeVersion()}, WCAG 2.0/2.1/2.2 A and AA`;
          const seen = new Map<string, Set<string>>();
          let measured = 0;
          let i = 0;
          for (const device of devices) {
            ctx.progress(i++, devices.length, `checking at ${device.name} width`);
            await pause(url.origin, Math.max(args.delay_ms, 1000));
            const r = await checkAt(browser, device, url.href, f, seen);
            if (!r) {
              f.add('page-error', url.href, `did not load at ${device.name} width`);
              continue;
            }
            measured += r.measured;
            f.facts[`needs review (${device.name})`] = r.review || null;
          }
          f.facts['lines measured on pixels'] = measured;
          if (measured)
            f.passIfNone(
              ['contrast-on-pixels'],
              `Every line of text over a picture or gradient (${measured} measured) is readable against its real pixels.`,
            );
        });
        if (!f.list().some((x) => x.kind.startsWith('axe-')) && !f.has('page-error')) {
          f.passed.push('axe found no WCAG 2.2 AA violation.');
        }
        f.notes.push(
          'axe finds about half of the WCAG problems a page can have; keyboard use, the order of reading and the words themselves still need a person.',
        );
      }
      f.headline.push(...site.robotsHeadline());
      return f.report(
        'check_accessibility',
        url.href,
        site.ignoreRobots ? 'ignored' : 'followed',
        started,
      );
    },
  });
}

async function checkAt(
  browser: Browser,
  device: Device,
  url: string,
  f: Findings,
  seen: Map<string, Set<string>>,
): Promise<{ measured: number; review: string } | null> {
  const context = await newContext(browser, device, { reducedMotion: true, bypassCSP: true });
  try {
    const page = await context.newPage();
    try {
      await load(page, url);
    } catch {
      return null;
    }
    await scrollThrough(page);
    await drawEverything(page);
    await page.evaluate(SELECTOR_SOURCE);
    await page.evaluate(axe());
    const result = (await page.evaluate(async () => {
      const a = (
        window as unknown as {
          axe: {
            run: (
              ctx: Document,
              opts: unknown,
            ) => Promise<{ violations: unknown[]; incomplete: unknown[] }>;
          };
        }
      ).axe;
      const r = await a.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
        resultTypes: ['violations', 'incomplete'],
      });
      return { violations: r.violations, incomplete: r.incomplete };
    })) as { violations: AxeRule[]; incomplete: AxeRule[] };

    for (const rule of result.violations) {
      const kind = `axe-${rule.id}`;
      f.define(kind, {
        severity: IMPACT[rule.impact ?? 'moderate'] ?? 'worth-fixing',
        title: `${rule.help} (axe: ${rule.id})`,
        advice: `${rule.description} How to fix it: ${rule.helpUrl}`,
      });
      for (const node of rule.nodes) {
        const target = node.target.map(String).join(' ');
        const at = seen.get(`${kind} ${target}`);
        if (at) {
          at.add(device.name);
          continue;
        }
        seen.set(`${kind} ${target}`, new Set([device.name]));
        const summary = (node.failureSummary ?? '')
          .split('\n')
          .filter((l) => l.trim() && !/^Fix (any|all) of the following:?$/.test(l.trim()))[0]
          ?.trim();
        f.add(
          kind,
          `${target} (${device.name})`,
          [summary, `HTML ${quote(node.html, 100)}`].filter(Boolean).join('; '),
        );
      }
    }

    const review = result.incomplete
      .filter((r) => r.id !== 'color-contrast')
      .map((r) => `${r.id} ×${r.nodes.length}`)
      .join(', ');
    const contrastNodes = result.incomplete.find((r) => r.id === 'color-contrast')?.nodes ?? [];
    const targets = contrastNodes
      .map((n) => n.target)
      .filter((t) => t.length === 1 && typeof t[0] === 'string')
      .map((t) => t[0] as string)
      .slice(0, MAX_PIXEL_CHECKS);
    const pixels = await measureOnPixels(page, targets);
    for (const line of pixels.fails) {
      f.add(
        'contrast-on-pixels',
        `${line.selector} (${device.name})`,
        `${quote(line.text, 60)} ${line.ratio.toFixed(2)}:1, needs ${line.need}:1 (${line.large ? 'large' : 'small'} text, colour ${line.color})`,
      );
    }
    return { measured: pixels.measured, review };
  } finally {
    await context.close().catch(() => undefined);
  }
}

/** Draws sections that skip rendering until seen, and lets entrance animations finish. */
async function drawEverything(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const style = document.createElement('style');
    style.setAttribute('data-site-doctor', '');
    style.textContent = '*{content-visibility:visible!important}';
    document.head.append(style);
    const finite = document.getAnimations().filter((a) => {
      const t = a.effect?.getComputedTiming();
      return t && t.iterations !== Infinity && t.endTime !== Infinity;
    });
    await Promise.race([
      Promise.all(finite.map((a) => a.finished.catch(() => undefined))),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
  });
  await page.waitForTimeout(200);
}

interface Line {
  selector: string;
  text: string;
  ratio: number;
  need: number;
  large: boolean;
  color: string;
}

async function measureOnPixels(
  page: Page,
  targets: string[],
): Promise<{ measured: number; fails: Line[] }> {
  if (targets.length === 0) return { measured: 0, fails: [] };
  // First the words and their colours, while they are still visible.
  const items = (await page.evaluate((sels: string[]) => {
    const out: {
      i: number;
      selector: string;
      text: string;
      color: [number, number, number, number];
      large: boolean;
    }[] = [];
    sels.forEach((s, i) => {
      let el: Element | null = null;
      try {
        el = document.querySelector(s);
      } catch {
        return;
      }
      if (!el) return;
      const cs = getComputedStyle(el);
      const m = (cs.color.match(/[\d.]+/g) ?? []).map(Number);
      const px = parseFloat(cs.fontSize);
      const bold = Number(cs.fontWeight) >= 700;
      el.setAttribute('data-sd-measure', String(i));
      const text = [...el.childNodes]
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent ?? '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!text) return;
      out.push({
        i,
        selector: s,
        text,
        color: [m[0] ?? 0, m[1] ?? 0, m[2] ?? 0, m[3] ?? 1],
        large: px >= 24 || (bold && px >= 18.66),
      });
    });
    return out;
  }, targets)) as {
    i: number;
    selector: string;
    text: string;
    color: [number, number, number, number];
    large: boolean;
  }[];

  // Then every piece of text made transparent (shadows too, so a shadow's help is not counted).
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.setAttribute('data-site-doctor-hide', '');
    style.textContent =
      '*:not(input):not(textarea):not(select),*::before,*::after,*::marker,*::placeholder{color:transparent!important;text-shadow:none!important;-webkit-text-stroke:0!important;text-decoration-color:transparent!important;caret-color:transparent!important}';
    document.head.append(style);
  });
  await page.waitForTimeout(100);

  const fails: Line[] = [];
  let measured = 0;
  for (const item of items) {
    const rects = (await page.evaluate((i: number) => {
      const el = document.querySelector(`[data-sd-measure="${i}"]`);
      if (!el) return [];
      el.scrollIntoView({
        block: 'center',
        inline: 'nearest',
        behavior: 'instant' as ScrollBehavior,
      });
      const out: { x: number; y: number; w: number; h: number }[] = [];
      for (const node of el.childNodes) {
        if (node.nodeType !== 3 || !node.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const r of range.getClientRects()) {
          const x = Math.max(0, r.left);
          const y = Math.max(0, r.top);
          const w = Math.min(r.right, innerWidth) - x;
          const h = Math.min(r.bottom, innerHeight) - y;
          if (w > 2 && h > 2) out.push({ x, y, w, h });
        }
      }
      return out;
    }, item.i)) as { x: number; y: number; w: number; h: number }[];
    if (rects.length === 0) continue;
    await page.waitForTimeout(50);
    const minX = Math.min(...rects.map((r) => r.x));
    const minY = Math.min(...rects.map((r) => r.y));
    const maxX = Math.max(...rects.map((r) => r.x + r.w));
    const maxY = Math.max(...rects.map((r) => r.y + r.h));
    let shot: Buffer;
    try {
      shot = await page.screenshot({
        clip: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
        type: 'png',
        animations: 'disabled',
        caret: 'hide',
      });
    } catch {
      continue;
    }
    const img = decodePng(shot);
    const scale = img.width / (maxX - minX);
    let worstLine: Line | null = null;
    for (const r of rects) {
      const lums: number[] = [];
      const rgbSum = [0, 0, 0];
      const x0 = Math.floor((r.x - minX) * scale);
      const y0 = Math.floor((r.y - minY) * scale);
      const x1 = Math.min(img.width, Math.ceil((r.x + r.w - minX) * scale));
      const y1 = Math.min(img.height, Math.ceil((r.y + r.h - minY) * scale));
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const o = (y * img.width + x) * 3;
          const R = img.rgb[o]!;
          const G = img.rgb[o + 1]!;
          const B = img.rgb[o + 2]!;
          lums.push(luminance(R, G, B));
          rgbSum[0]! += R;
          rgbSum[1]! += G;
          rgbSum[2]! += B;
        }
      }
      if (lums.length === 0) continue;
      lums.sort((a, b) => a - b);
      // A partly transparent text colour shows the background through it.
      const [cr, cg, cb, ca] = item.color;
      const n = lums.length;
      const bg = rgbSum.map((v) => v / n) as [number, number, number];
      const text = luminance(
        cr * ca + bg[0] * (1 - ca),
        cg * ca + bg[1] * (1 - ca),
        cb * ca + bg[2] * (1 - ca),
      );
      const middle = lums[Math.floor(n / 2)]!;
      // The worst 5% of the background, on the text's side of the contrast.
      const worst = text > middle ? lums[Math.floor(n * 0.95)]! : lums[Math.floor(n * 0.05)]!;
      const ratio = contrast(text, worst);
      const need = item.large ? 3 : 4.5;
      if (ratio < need && (!worstLine || ratio < worstLine.ratio)) {
        worstLine = {
          selector: item.selector,
          text: item.text,
          ratio,
          need,
          large: item.large,
          color: `rgb(${cr}, ${cg}, ${cb}${ca < 1 ? `, ${ca}` : ''})`,
        };
      }
    }
    measured++;
    if (worstLine) fails.push(worstLine);
  }
  await page.evaluate(() => document.querySelector('[data-site-doctor-hide]')?.remove());
  return { measured, fails };
}
