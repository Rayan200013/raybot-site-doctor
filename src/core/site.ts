// How every tool reaches a site: politely. One request at a time across the
// whole server, a pause between requests to the same host, robots.txt
// followed for pages (unless the caller explicitly passed ignore_robots_txt),
// redirects followed hop by hop and recorded, and pages read only on the
// site itself.
import { request, RequestError, type HttpResponse } from './http.ts';
import { parseRobots, rulesFor, isAllowed, type Robots, type Rule } from './robots.ts';
import { ROBOTS_TOKEN } from '../version.ts';

export const DEFAULT_DELAY_MS = 250;
const MAX_CRAWL_DELAY_MS = 30_000;
const MAX_HOPS = 10;

/** Turns what a person types ("example.com/page") into an address. */
export function toUrl(input: string): URL {
  let text = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = 'https://' + text;
  const url = new URL(text);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`only http and https addresses can be checked, not ${url.protocol}`);
  }
  url.hash = '';
  return url;
}

export interface RobotsState {
  origin: string;
  /** What reading robots.txt gave: rules, none (a 404), or "assume all disallowed" (a 5xx). */
  outcome: 'rules' | 'none' | 'unreachable';
  status: number | null;
  robots: Robots | null;
  rules: Rule[];
  agent: string;
  crawlDelayMs: number;
  error?: string;
}

export interface Hop {
  url: string;
  status: number;
  location?: string;
}

export interface Fetched {
  requested: string;
  /** The last address reached. */
  final: string;
  /** Every response on the way, redirects included. */
  chain: Hop[];
  response?: HttpResponse;
  error?: string;
  /** Set when robots.txt disallows the page and it was not read. */
  blockedBy?: Rule | 'unreachable-robots';
  /** Set when the page redirects off the site and was not followed. */
  leftSiteTo?: string;
}

export interface SiteOptions {
  ignoreRobots?: boolean;
  delayMs?: number;
  signal?: AbortSignal;
}

// One request at a time, process-wide, whatever tools run side by side.
let gate: Promise<unknown> = Promise.resolve();
const lastAt = new Map<string, number>();

async function politely<T>(
  origin: string,
  delayMs: number,
  signal: AbortSignal | undefined,
  task: () => Promise<T>,
): Promise<T> {
  const run = gate.then(async () => {
    if (signal?.aborted) throw new RequestError('cancelled', origin, 'CANCELLED');
    const wait = (lastAt.get(origin) ?? 0) + delayMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await task();
    } finally {
      lastAt.set(origin, Date.now());
    }
  });
  gate = run.catch(() => undefined);
  return run;
}

const robotsCache = new Map<string, { at: number; state: RobotsState }>();
const ROBOTS_TTL = 10 * 60 * 1000;

export class Site {
  readonly start: URL;
  readonly origins = new Set<string>();
  readonly ignoreRobots: boolean;
  readonly delayMs: number;
  readonly signal: AbortSignal | undefined;
  requests = 0;
  /** Pages read although robots.txt disallows them (only with ignore_robots_txt). */
  readDespiteRobots: string[] = [];
  /** Pages not read because robots.txt disallows them. */
  blocked: string[] = [];

  constructor(start: URL, options: SiteOptions = {}) {
    this.start = start;
    this.origins.add(start.origin);
    this.ignoreRobots = options.ignoreRobots ?? false;
    this.delayMs = Math.max(0, options.delayMs ?? DEFAULT_DELAY_MS);
    this.signal = options.signal;
  }

  /** Adds an address the site names as its own (a language version on another host). */
  addOrigin(origin: string): void {
    this.origins.add(origin);
  }

  isOnSite(url: URL | string): boolean {
    const u = typeof url === 'string' ? new URL(url) : url;
    return this.origins.has(u.origin);
  }

  async robotsFor(origin: string): Promise<RobotsState> {
    const cached = robotsCache.get(origin);
    if (cached && Date.now() - cached.at < ROBOTS_TTL) return cached.state;
    let state: RobotsState;
    try {
      let url = new URL('/robots.txt', origin);
      let res: HttpResponse | undefined;
      for (let hop = 0; hop <= 5; hop++) {
        const target = url;
        res = await politely(target.origin, this.delayMs, this.signal, () =>
          request(target, {
            accept: 'text/plain,*/*;q=0.5',
            maxBytes: 512 * 1024,
            signal: this.signal,
          }),
        );
        this.requests++;
        const location = res.headers['location'];
        if (res.status >= 300 && res.status < 400 && location) {
          url = new URL(location, url);
          continue;
        }
        break;
      }
      if (!res) throw new Error('no answer');
      if (res.status >= 200 && res.status < 300) {
        const robots = parseRobots(res.body.toString('utf8'));
        const chosen = rulesFor(robots, ROBOTS_TOKEN);
        state = {
          origin,
          outcome: 'rules',
          status: res.status,
          robots,
          rules: chosen.rules,
          agent: chosen.agent,
          crawlDelayMs: Math.min(MAX_CRAWL_DELAY_MS, (chosen.crawlDelay ?? 0) * 1000),
        };
      } else if (res.status >= 400 && res.status < 500) {
        state = {
          origin,
          outcome: 'none',
          status: res.status,
          robots: null,
          rules: [],
          agent: '*',
          crawlDelayMs: 0,
        };
      } else {
        state = {
          origin,
          outcome: 'unreachable',
          status: res.status,
          robots: null,
          rules: [],
          agent: '*',
          crawlDelayMs: 0,
        };
      }
    } catch (e) {
      if (e instanceof RequestError && e.code === 'CANCELLED') throw e;
      state = {
        origin,
        outcome: 'unreachable',
        status: null,
        robots: null,
        rules: [],
        agent: '*',
        crawlDelayMs: 0,
        error: (e as Error).message,
      };
    }
    robotsCache.set(origin, { at: Date.now(), state });
    return state;
  }

  /** Whether robots.txt lets a page be read, and why not. */
  async verdict(url: URL): Promise<{ allowed: boolean; rule?: Rule | 'unreachable-robots' }> {
    const state = await this.robotsFor(url.origin);
    // A server that doesn't answer at all: the page read fails too, and says why.
    if (state.outcome === 'unreachable' && state.status === null) return { allowed: true };
    // A robots.txt answering 5xx: crawlers must assume everything is disallowed (RFC 9309).
    if (state.outcome === 'unreachable') return { allowed: false, rule: 'unreachable-robots' };
    const v = isAllowed(state.rules, url);
    return v.rule ? { allowed: v.allowed, rule: v.rule } : { allowed: v.allowed };
  }

  private async delayFor(origin: string): Promise<number> {
    if (!this.origins.has(origin)) return this.delayMs;
    const state = await this.robotsFor(origin);
    return Math.max(this.delayMs, state.crawlDelayMs);
  }

  /**
   * Reads an address. A page is read only on the site and only if robots.txt
   * allows it (or the caller said to ignore it); a resource (a share image, a
   * sitemap) is read wherever the site's pages say it is.
   */
  async fetch(
    input: URL | string,
    options: {
      kind?: 'page' | 'resource';
      method?: 'GET' | 'HEAD';
      accept?: string;
      maxBytes?: number;
      follow?: boolean;
    } = {},
  ): Promise<Fetched> {
    const { kind = 'page', method = 'GET', follow = true } = options;
    let url = typeof input === 'string' ? new URL(input) : new URL(input.href);
    url.hash = '';
    const requested = url.href;
    const chain: Hop[] = [];
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      if (kind === 'page') {
        if (!this.isOnSite(url)) {
          // The site's other half (http → https, example.com → www.) is the same site.
          const twin = [...this.origins].some((o) => sameSiteTwin(new URL(o), url));
          if (!twin) return { requested, final: url.href, chain, leftSiteTo: url.href };
          this.addOrigin(url.origin);
        }
        const v = await this.verdict(url);
        if (!v.allowed) {
          if (!this.ignoreRobots) {
            this.blocked.push(url.href);
            return { requested, final: url.href, chain, ...(v.rule ? { blockedBy: v.rule } : {}) };
          }
          this.readDespiteRobots.push(url.href);
        }
      }
      const target = url;
      const delay = await this.delayFor(target.origin);
      let res: HttpResponse;
      try {
        res = await politely(target.origin, delay, this.signal, () =>
          request(target, {
            method,
            signal: this.signal,
            ...(options.accept ? { accept: options.accept } : {}),
            ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}),
          }),
        );
      } catch (e) {
        if (e instanceof RequestError && e.code === 'CANCELLED') throw e;
        return { requested, final: url.href, chain, error: (e as Error).message };
      }
      this.requests++;
      const location = res.headers['location'];
      if (follow && res.status >= 300 && res.status < 400 && location) {
        chain.push({ url: url.href, status: res.status, location });
        try {
          url = new URL(location, url);
        } catch {
          return {
            requested,
            final: url.href,
            chain,
            error: `a redirect to an invalid address: ${location}`,
          };
        }
        url.hash = '';
        if (chain.some((h) => h.url === url.href)) {
          return { requested, final: url.href, chain, error: 'a redirect loop' };
        }
        continue;
      }
      chain.push({ url: url.href, status: res.status });
      return { requested, final: url.href, chain, response: res };
    }
    return { requested, final: url.href, chain, error: `more than ${MAX_HOPS} redirects` };
  }

  /** The words said first in a report when robots.txt was ignored. */
  robotsHeadline(): string[] {
    if (!this.ignoreRobots) return [];
    const n = new Set(this.readDespiteRobots).size;
    return [
      `robots.txt was IGNORED at the caller's request (ignore_robots_txt: true). ` +
        (n
          ? `${n} of the pages read are disallowed for crawlers by the site's robots.txt; a search engine would not read them.`
          : `No page read here is disallowed by the site's robots.txt, so ignoring it changed nothing.`),
    ];
  }
}

/** The same site, written another way: http/https, with or without "www.". */
export function sameSiteTwin(a: URL, b: URL): boolean {
  const host = (u: URL) => u.host.replace(/^www\./, '');
  return host(a) === host(b);
}
