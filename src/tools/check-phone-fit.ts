// check_phone_fit: the page at phone sizes from 320×568 to 430×932. What is
// wider than the screen, text cut off or on top of other text, targets too
// small to tap, text too small to read, what the first screen holds, and bars
// that stay on screen.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Browser } from 'playwright-core';
import { defineTool, common, parseTarget, UserError } from '../core/tool.ts';
import { Findings, type Catalogue } from '../core/report.ts';
import { Site, toUrl } from '../core/site.ts';
import {
  withBrowser,
  newContext,
  load,
  scrollThrough,
  SELECTOR_SOURCE,
  type Device,
} from '../core/browser.ts';
import { GATE_KINDS, mayLoad, pause } from '../checks/browser-gate.ts';
import { quote } from '../core/text.ts';

export const PHONE_SIZES = ['320x568', '360x640', '375x667', '390x844', '412x915', '430x932'];

const KINDS: Catalogue = {
  ...GATE_KINDS,
  'wider-than-screen': {
    severity: 'fix-first',
    title: 'Something is wider than the screen (the page scrolls sideways)',
    advice:
      'Find the element named and let it shrink: max-width: 100% on pictures and tables, no fixed widths wider than a phone, long words and addresses allowed to break (overflow-wrap: anywhere), wide tables in their own scrolling box.',
  },
  'text-overlap': {
    severity: 'fix-first',
    title: 'Text drawn on top of other text',
    advice:
      'Two pieces of text overlap at this size: usually a fixed height, a negative margin or absolute positioning that assumed a wider screen. Let the box grow with its text.',
  },
  'text-cut': {
    severity: 'worth-fixing',
    title: 'Text cut off by its box',
    advice:
      'The box hides part of its text at this size (overflow: hidden with a fixed width or height). Let it wrap or grow, or shorten the words.',
  },
  'tap-target-small': {
    severity: 'worth-fixing',
    title: 'Targets smaller than 24×24 px without room around them (WCAG 2.5.8)',
    advice:
      'Make links and buttons at least 24×24 px, or keep 24 px between them; 44×44 px is comfortable for a thumb.',
  },
  'tap-target-under-44': {
    severity: 'note',
    title: 'Targets under 44×44 px',
    advice:
      'Allowed by WCAG AA, but Apple and Google both recommend 44–48 px for thumbs. Worth enlarging the ones people use most.',
  },
  'text-tiny': {
    severity: 'worth-fixing',
    title: 'Text smaller than 12 px',
    advice: 'Hard to read on a phone. Use at least 12 px for small print and 16 px for body text.',
  },
  'h1-below-fold': {
    severity: 'worth-fixing',
    title: "The page's main heading is not on the first screen",
    advice:
      'A visitor sees no heading saying what the page is until they scroll. Shrink what sits above it (a tall picture, a banner) at phone sizes.',
  },
  'no-action-first-screen': {
    severity: 'note',
    title: 'No button on the first screen',
    advice:
      'Nothing that looks like a button (a link or button with a background or border) is visible before scrolling. If the page asks visitors to do something, show it on the first screen.',
  },
  'bars-cover': {
    severity: 'worth-fixing',
    title: 'Bars that stay on screen cover much of it',
    advice:
      'Fixed or sticky bars (a header, a cookie notice, a chat button) take this share of a small phone screen. Make them shorter on phones, or let the header hide on scroll.',
  },
};

interface FitResult {
  screenW: number;
  docW: number;
  wide: { sel: string; left: number; right: number; width: number }[];
  cut: { sel: string; text: string; how: string }[];
  overlaps: { a: string; b: string; textA: string; textB: string }[];
  small: { sel: string; w: number; h: number; text: string }[];
  under44: number;
  targets: number;
  tiny: { sel: string; px: number; text: string }[];
  h1: { top: number; text: string } | null;
  action: { top: number; text: string } | null;
  bars: { sel: string; share: number }[];
  barsShare: number;
}

export function registerCheckPhoneFit(server: McpServer): void {
  defineTool(server, {
    name: 'check_phone_fit',
    title: 'Check the page on phone sizes',
    description:
      'Loads one page at phone sizes from 320×568 to 430×932 (or the sizes given) in the Chrome or Edge on this computer, as a touch phone, and reports: anything wider than the screen (the page scrolls sideways) and which element; text cut off or drawn over other text; tap targets under 24×24 px without room around them (WCAG 2.5.8) and how many are under 44×44 px; text under 12 px; whether the main heading and a first button are on the first screen; fixed or sticky bars covering much of the screen.',
    input: {
      url: z.string().describe('The page to check, for example https://example.com'),
      sizes: z
        .array(
          z
            .string()
            .regex(/^\d{3,4}x\d{3,4}$/, 'a size is written WIDTHxHEIGHT, for example 390x844'),
        )
        .max(12)
        .optional()
        .describe(`Phone sizes as WIDTHxHEIGHT in CSS pixels. Default: ${PHONE_SIZES.join(', ')}.`),
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
      const sizes = (args.sizes?.length ? args.sizes : PHONE_SIZES).map((s) => {
        const [w, h] = s.split('x').map(Number) as [number, number];
        if (w < 240 || w > 1024 || h < 320 || h > 1600)
          throw new UserError(`${s} is not a phone size (240–1024 wide, 320–1600 tall).`);
        return {
          name: s,
          width: w,
          height: h,
          scale: w >= 400 ? 3 : 2,
          mobile: true,
        } satisfies Device;
      });
      if (await mayLoad(site, url, f)) {
        await withBrowser(async (browser, label) => {
          f.facts['browser'] = label;
          f.facts['sizes'] = sizes.map((s) => s.name).join(', ');
          const seen = new Map<string, string[]>();
          const add = (kind: string, sel: string, size: string, detail?: string) => {
            const k = `${kind} ${sel}`;
            const sizesSeen = seen.get(k);
            if (sizesSeen) {
              sizesSeen.push(size);
              return;
            }
            seen.set(k, [size]);
            f.add(kind, `${sel} (${size})`, detail);
          };
          let i = 0;
          let worstUnder44 = 0;
          let targetCount = 0;
          for (const device of sizes) {
            ctx.progress(i++, sizes.length, `loading at ${device.name}`);
            await pause(url.origin, Math.max(args.delay_ms, 1000));
            const r = await fitAt(browser, device, url.href);
            if (!r) {
              f.add('page-error', url.href, `did not load at ${device.name}`);
              continue;
            }
            if (r.docW > r.screenW + 1) {
              const culprits = r.wide.slice(0, 3);
              if (culprits.length === 0)
                add(
                  'wider-than-screen',
                  'the page',
                  device.name,
                  `${r.docW}px wide on a ${r.screenW}px screen`,
                );
              for (const w of culprits)
                add(
                  'wider-than-screen',
                  w.sel,
                  device.name,
                  `${Math.round(w.width)}px wide, reaching ${Math.round(w.right)}px on a ${r.screenW}px screen (the page is ${r.docW}px)`,
                );
            }
            for (const c of r.overlaps.slice(0, 10))
              add(
                'text-overlap',
                `${c.a} over ${c.b}`,
                device.name,
                `${quote(c.textA, 40)} and ${quote(c.textB, 40)}`,
              );
            for (const c of r.cut.slice(0, 10))
              add('text-cut', c.sel, device.name, `${c.how}: ${quote(c.text, 50)}`);
            for (const s of r.small.slice(0, 15))
              add(
                'tap-target-small',
                s.sel,
                device.name,
                `${Math.round(s.w)}×${Math.round(s.h)} px ${quote(s.text, 30)}`,
              );
            worstUnder44 = Math.max(worstUnder44, r.under44);
            for (const t of r.tiny.slice(0, 10))
              add('text-tiny', t.sel, device.name, `${t.px}px ${quote(t.text, 40)}`);
            if (!r.h1) {
              // No visible H1 at all is check_page's to report.
            } else if (r.h1.top >= device.height)
              add(
                'h1-below-fold',
                'h1',
                device.name,
                `starts ${Math.round(r.h1.top)}px down a ${device.height}px screen: ${quote(r.h1.text, 50)}`,
              );
            if (!r.action) add('no-action-first-screen', 'the first screen', device.name);
            if (r.barsShare > 0.3)
              add(
                'bars-cover',
                r.bars.map((b) => b.sel).join(' + '),
                device.name,
                `${Math.round(r.barsShare * 100)}% of the screen's height`,
              );
            targetCount = Math.max(targetCount, r.targets);
          }
          f.facts['tap targets'] = `${targetCount}, of which up to ${worstUnder44} under 44×44 px`;
          if (worstUnder44)
            f.add(
              'tap-target-under-44',
              'the page',
              `up to ${worstUnder44} of ${targetCount} targets at one size`,
            );
          // Sizes a problem was seen at, after the first.
          for (const finding of f.list()) {
            for (const e of finding.examples) {
              const k = `${finding.kind} ${e.at.replace(/ \(\d+x\d+\)$/, '')}`;
              const at = seen.get(k);
              if (at && at.length > 1) e.at = e.at.replace(/\(\d+x\d+\)$/, `(${at.join(', ')})`);
            }
          }
        });
        f.passIfNone(['wider-than-screen'], 'Nothing is wider than the screen at any size.');
        f.passIfNone(['text-overlap', 'text-cut'], 'No text is cut off or drawn over other text.');
        f.passIfNone(
          ['tap-target-small'],
          'Every tap target is at least 24×24 px or has room around it.',
        );
        f.passIfNone(['text-tiny'], 'No text under 12 px.');
        f.passIfNone(['h1-below-fold'], 'The main heading is on the first screen at every size.');
        f.passIfNone(['bars-cover'], 'Bars that stay on screen leave most of it free.');
      }
      f.headline.push(...site.robotsHeadline());
      return f.report(
        'check_phone_fit',
        url.href,
        site.ignoreRobots ? 'ignored' : 'followed',
        started,
      );
    },
  });
}

async function fitAt(browser: Browser, device: Device, url: string): Promise<FitResult | null> {
  const context = await newContext(browser, device, { bypassCSP: true });
  try {
    const page = await context.newPage();
    try {
      await load(page, url);
    } catch {
      return null;
    }
    await page.evaluate(SELECTOR_SOURCE);
    await page.waitForTimeout(600);
    // The first screen, as it is before any scrolling.
    const first = await page.evaluate(firstScreen);
    await scrollThrough(page);
    await page.evaluate(() => {
      const style = document.createElement('style');
      style.textContent = '*{content-visibility:visible!important}';
      document.head.append(style);
    });
    await page.waitForTimeout(300);
    const rest = await page.evaluate(analyse);
    // Bars, half way down the page, where sticky ones have stuck.
    const bars = await page.evaluate(barsAtMiddle);
    return { ...rest, ...first, ...bars };
  } finally {
    await context.close().catch(() => undefined);
  }
}

function firstScreen(): Pick<FitResult, 'h1' | 'action'> {
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    return (
      r.width > 1 &&
      r.height > 1 &&
      el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
    );
  };
  const h1el = [...document.querySelectorAll('h1')].find(visible);
  const h1 = h1el
    ? { top: h1el.getBoundingClientRect().top + scrollY, text: (h1el.textContent ?? '').trim() }
    : null;
  const looksLikeButton = (el: Element) => {
    const cs = getComputedStyle(el);
    const bg = (cs.backgroundColor.match(/[\d.]+/g) ?? []).map(Number);
    const filled = bg.length >= 3 && (bg[3] === undefined || bg[3] > 0.1);
    const bordered = parseFloat(cs.borderTopWidth) >= 1 && cs.borderTopStyle !== 'none';
    return (filled || bordered) && cs.display !== 'inline' && parseFloat(cs.paddingLeft) >= 6;
  };
  const inChrome = (el: Element) =>
    !!el.closest('header, nav, footer, [role=banner], [role=navigation]');
  const candidates = [
    ...document.querySelectorAll('a[href], button, input[type=submit], [role=button]'),
  ].filter((el) => visible(el) && !inChrome(el) && looksLikeButton(el));
  const firstBtn = candidates.find((el) => el.getBoundingClientRect().top < innerHeight);
  const action = firstBtn
    ? { top: firstBtn.getBoundingClientRect().top, text: (firstBtn.textContent ?? '').trim() }
    : null;
  return { h1, action };
}

function analyse(): Omit<FitResult, 'h1' | 'action' | 'bars' | 'barsShare'> {
  const sel = (el: Element) =>
    (window as unknown as { __sdSelector: (e: Element) => string }).__sdSelector(el);
  const screenW = screen.width;
  const docW = document.documentElement.scrollWidth;
  const shown = (el: Element) =>
    el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  const scrolls = (el: Element) => {
    const o = getComputedStyle(el).overflowX;
    return o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip';
  };

  // Wider than the screen: the outermost elements that overflow it, outside any box that scrolls or clips.
  const wide: FitResult['wide'] = [];
  if (docW > screenW + 1) {
    const all = [...document.body.querySelectorAll('*')];
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right <= screenW + 1 && r.left >= -1) continue;
      if (!shown(el)) continue;
      let clipped = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        if (scrolls(p) && p.getBoundingClientRect().right <= screenW + 1) {
          clipped = true;
          break;
        }
      }
      if (clipped) continue;
      const parent = el.parentElement;
      const pr = parent?.getBoundingClientRect();
      if (parent && parent !== document.body && pr && (pr.right > screenW + 1 || pr.left < -1))
        continue;
      wide.push({ sel: sel(el), left: r.left, right: r.right + scrollX, width: r.width });
      if (wide.length >= 10) break;
    }
  }

  // Text: line boxes of every visible run of text.
  type Box = { x: number; y: number; w: number; h: number; el: Element; text: string };
  const boxes: Box[] = [];
  const tiny: FitResult['tiny'] = [];
  const cut: FitResult['cut'] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const tinySeen = new Set<Element>();
  const cutSeen = new Set<Element>();
  // Text in a fixed or sticky bar passes over the page as it scrolls: that is
  // the bars check, not text drawn over text.
  const onBar = new Map<Element, boolean>();
  const inBar = (el: Element | null): boolean => {
    if (!el || el === document.body) return false;
    const known = onBar.get(el);
    if (known !== undefined) return known;
    const position = getComputedStyle(el).position;
    const value = position === 'fixed' || position === 'sticky' || inBar(el.parentElement);
    onBar.set(el, value);
    return value;
  };
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const text = (node.textContent ?? '').trim();
    if (!text) continue;
    const el = node.parentElement;
    if (!el || el.closest('script, style, noscript, template, svg, [aria-hidden=true]')) continue;
    if (!shown(el)) continue;
    const cs = getComputedStyle(el);
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1);
    if (rects.length === 0) continue;
    // Visually hidden text (the usual screen-reader-only pattern) is not drawn.
    const er = el.getBoundingClientRect();
    if (er.width <= 2 || er.height <= 2) continue;
    const px = parseFloat(cs.fontSize);
    if (px < 12 && !tinySeen.has(el)) {
      tinySeen.add(el);
      tiny.push({ sel: sel(el), px: Math.round(px * 10) / 10, text });
    }
    if (!inBar(el))
      for (const r of rects)
        boxes.push({ x: r.left, y: r.top + scrollY, w: r.width, h: r.height, el, text });
    // Cut off: the text's own box hides part of it.
    if (!cutSeen.has(el)) {
      cutSeen.add(el);
      const ox = cs.overflowX;
      const oy = cs.overflowY;
      if (
        (ox === 'hidden' || ox === 'clip') &&
        el.scrollWidth > el.clientWidth + 2 &&
        cs.textOverflow !== 'ellipsis'
      ) {
        cut.push({
          sel: sel(el),
          text,
          how: `${el.scrollWidth - el.clientWidth}px cut on the side`,
        });
      } else if (
        (oy === 'hidden' || oy === 'clip') &&
        el.scrollHeight > el.clientHeight + 4 &&
        (cs.webkitLineClamp === 'none' || !cs.webkitLineClamp)
      ) {
        // A line clamp ("…" after three lines) is a choice, not a fault.
        cut.push({
          sel: sel(el),
          text,
          how: `${el.scrollHeight - el.clientHeight}px cut at the bottom`,
        });
      }
    }
  }

  // Overlaps: the middle of one line over the middle of another, from different elements.
  const overlaps: FitResult['overlaps'] = [];
  const rows = new Map<number, Box[]>();
  const core = (b: Box) => ({ x: b.x + 1, y: b.y + b.h * 0.2, w: b.w - 2, h: b.h * 0.6 });
  for (const b of boxes) {
    const c = core(b);
    for (let row = Math.floor(c.y / 40); row <= Math.floor((c.y + c.h) / 40); row++) {
      if (!rows.has(row)) rows.set(row, []);
      rows.get(row)!.push(b);
    }
  }
  const pairSeen = new Set<string>();
  for (const list of rows.values()) {
    for (let i = 0; i < list.length && overlaps.length < 20; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const ca = core(a);
        const cb = core(b);
        const ix = Math.min(ca.x + ca.w, cb.x + cb.w) - Math.max(ca.x, cb.x);
        const iy = Math.min(ca.y + ca.h, cb.y + cb.h) - Math.max(ca.y, cb.y);
        if (ix <= 0 || iy <= 0) continue;
        const small = Math.min(ca.w * ca.h, cb.w * cb.h);
        if ((ix * iy) / small < 0.25) continue;
        const sa = sel(a.el);
        const sb = sel(b.el);
        const key = `${sa}|${sb}`;
        if (pairSeen.has(key)) continue;
        pairSeen.add(key);
        overlaps.push({ a: sa, b: sb, textA: a.text, textB: b.text });
      }
    }
  }

  // Tap targets, with WCAG 2.5.8's exceptions: inline links in a sentence, and room around.
  const targets = [
    ...document.querySelectorAll(
      'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=switch]',
    ),
  ].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && shown(el) && !(el as HTMLInputElement).disabled;
  });
  const centres = targets.map((el) => {
    const r = el.getBoundingClientRect();
    return { el, r, cx: r.left + r.width / 2, cy: r.top + scrollY + r.height / 2 };
  });
  const small: FitResult['small'] = [];
  let under44 = 0;
  for (const t of centres) {
    const { r, el } = t;
    if (r.width < 44 || r.height < 44) under44++;
    if (r.width >= 24 && r.height >= 24) continue;
    const cs = getComputedStyle(el);
    const parent = el.parentElement;
    if (cs.display === 'inline' && parent) {
      const words = (parent.textContent ?? '').replace(el.textContent ?? '', '').trim();
      if (words.length > 20) continue; // A link inside a sentence.
    }
    const crowded = centres.some(
      (o) =>
        o !== t &&
        !o.el.contains(el) &&
        !el.contains(o.el) &&
        Math.hypot(o.cx - t.cx, o.cy - t.cy) < 24,
    );
    if (!crowded) continue;
    small.push({
      sel: sel(el),
      w: r.width,
      h: r.height,
      text: (el.textContent ?? '').trim() || el.getAttribute('aria-label') || '',
    });
  }
  return { screenW, docW, wide, cut, overlaps, small, under44, targets: targets.length, tiny };
}

function barsAtMiddle(): Pick<FitResult, 'bars' | 'barsShare'> {
  scrollTo({
    top: document.documentElement.scrollHeight / 2,
    behavior: 'instant' as ScrollBehavior,
  });
  const sel = (el: Element) =>
    (window as unknown as { __sdSelector: (e: Element) => string }).__sdSelector(el);
  const bars: FitResult['bars'] = [];
  const spans: [number, number][] = [];
  for (const el of document.body.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
    const r = el.getBoundingClientRect();
    if (r.height < 30 || r.width < innerWidth * 0.5) continue;
    if (r.bottom <= 0 || r.top >= innerHeight) continue;
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    // A sticky element is a bar only where it has stuck to an edge.
    if (cs.position === 'sticky' && r.top > 1 && r.bottom < innerHeight - 1) continue;
    if (bars.some((b) => document.querySelector(b.sel)?.contains(el))) continue;
    const top = Math.max(0, r.top);
    const bottom = Math.min(innerHeight, r.bottom);
    spans.push([top, bottom]);
    bars.push({ sel: sel(el), share: (bottom - top) / innerHeight });
  }
  spans.sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let end = -1;
  for (const [a, b] of spans) {
    if (a > end) {
      covered += b - a;
      end = b;
    } else if (b > end) {
      covered += b - end;
      end = b;
    }
  }
  scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  return { bars, barsShare: covered / innerHeight };
}
