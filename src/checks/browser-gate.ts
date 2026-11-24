// Before a browser check loads a page: robots.txt, said the same way as for
// the HTTP checks, and a pause between page loads on the same site.
import type { Findings } from '../core/report.ts';
import type { Site } from '../core/site.ts';

export const GATE_KINDS = {
  'robots-blocked': {
    severity: 'worth-fixing' as const,
    title: 'robots.txt tells crawlers not to read the page',
    advice:
      "If the page should be found in search, remove or narrow the robots.txt rule quoted. If the site is the user's own and they want it checked anyway, ask them before calling again with ignore_robots_txt: true.",
  },
  'page-error': {
    severity: 'fix-first' as const,
    title: 'The page does not load',
    advice: 'A visitor gets an error instead of the page. Fix the page or its address.',
  },
};

/** True when the page may be loaded; otherwise says why in the findings. */
export async function mayLoad(site: Site, url: URL, f: Findings): Promise<boolean> {
  const v = await site.verdict(url);
  if (v.allowed) return true;
  if (site.ignoreRobots) {
    site.readDespiteRobots.push(url.href);
    return true;
  }
  site.blocked.push(url.href);
  f.add(
    'robots-blocked',
    url.href,
    v.rule === 'unreachable-robots'
      ? 'robots.txt itself answers an error, so crawlers must assume everything is disallowed'
      : v.rule
        ? `rule "Disallow: ${v.rule.path}" (robots.txt line ${v.rule.line})`
        : undefined,
  );
  return false;
}

const lastLoad = new Map<string, number>();

/** Waits until the pause since the last page load on this site has passed. */
export async function pause(origin: string, delayMs: number): Promise<void> {
  const wait = (lastLoad.get(origin) ?? 0) + delayMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastLoad.set(origin, Date.now());
}

export function markLoaded(origin: string): void {
  lastLoad.set(origin, Date.now());
}
