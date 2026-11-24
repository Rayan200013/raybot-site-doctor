// robots.txt, read as RFC 9309 says: groups of user-agent lines with their
// allow and disallow rules, the longest matching rule winning (allow on a
// tie), `*` and `$` in paths, and the group for our own name used before `*`.

export interface Rule {
  allow: boolean;
  path: string;
  /** The rule's line in the file, for the report. */
  line: number;
}

export interface Group {
  agents: string[];
  rules: Rule[];
  crawlDelay?: number;
}

export interface Robots {
  groups: Group[];
  sitemaps: string[];
  /** Lines that are not rules (a typo, an unknown key), for the report. */
  unknown: { line: number; text: string }[];
  /** Rules that appear before any user-agent line, which apply to no one. */
  orphanRules: number;
}

export function parseRobots(text: string): Robots {
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  const unknown: Robots['unknown'] = [];
  let orphanRules = 0;
  let current: Group | null = null;
  let lastWasAgent = false;

  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  lines.forEach((raw, i) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    const colon = line.indexOf(':');
    if (colon < 0) {
      unknown.push({ line: i + 1, text: raw.trim() });
      return;
    }
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    switch (key) {
      case 'user-agent':
      case 'useragent':
      case 'user agent':
        if (!current || !lastWasAgent) {
          current = { agents: [], rules: [] };
          groups.push(current);
        }
        current.agents.push(value.toLowerCase());
        lastWasAgent = true;
        return;
      case 'allow':
      case 'disallow':
        lastWasAgent = false;
        if (!current) {
          orphanRules++;
          return;
        }
        // An empty disallow allows everything: it is no rule at all.
        if (value === '' && key === 'disallow') return;
        current.rules.push({ allow: key === 'allow', path: normalise(value), line: i + 1 });
        return;
      case 'crawl-delay':
        lastWasAgent = false;
        if (current) {
          const n = Number(value);
          if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
        }
        return;
      case 'sitemap':
        // Not part of any group; does not end one.
        if (value) sitemaps.push(value);
        return;
      default:
        unknown.push({ line: i + 1, text: raw.trim() });
        lastWasAgent = false;
    }
  });
  return { groups, sitemaps, unknown, orphanRules };
}

/** The rules that apply to a crawler of this name: its own groups, or else `*`. */
export function rulesFor(
  robots: Robots,
  token: string,
): { rules: Rule[]; crawlDelay?: number; agent: string } {
  const name = token.toLowerCase();
  const own = robots.groups.filter((g) =>
    g.agents.some((a) => a !== '*' && (a === name || name.startsWith(a))),
  );
  const chosen = own.length ? own : robots.groups.filter((g) => g.agents.includes('*'));
  const delays = chosen.map((g) => g.crawlDelay).filter((d): d is number => d !== undefined);
  return {
    rules: chosen.flatMap((g) => g.rules),
    ...(delays.length ? { crawlDelay: Math.max(...delays) } : {}),
    agent: own.length ? token : '*',
  };
}

export interface Verdict {
  allowed: boolean;
  rule?: Rule;
}

/** Whether a URL's path may be read under these rules. */
export function isAllowed(rules: Rule[], url: URL): Verdict {
  const target = normalise(url.pathname + url.search);
  if (url.pathname === '/robots.txt') return { allowed: true };
  let best: Rule | undefined;
  let bestLength = -1;
  for (const rule of rules) {
    if (!matches(rule.path, target)) continue;
    const len = rule.path.length;
    if (len > bestLength || (len === bestLength && rule.allow && best && !best.allow)) {
      best = rule;
      bestLength = len;
    }
  }
  return best ? { allowed: best.allow, rule: best } : { allowed: true };
}

function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp('^' + source + (anchored ? '$' : '')).test(path);
}

/** Percent-encodings written one way, so "/caf%c3%a9" and "/café" compare equal. */
function normalise(path: string): string {
  let out = path;
  try {
    out = encodeURI(decodeURI(path));
  } catch {
    // A malformed encoding: compare it as written.
  }
  return out.replace(/%[0-9a-f]{2}/gi, (m) => m.toUpperCase());
}
