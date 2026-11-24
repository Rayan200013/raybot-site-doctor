// Small helpers for the words in a report.

/** Text copied from a site, made safe to quote: one line, no control characters, bounded. */
export function quote(value: string | null | undefined, max = 120): string {
  if (value == null) return '(none)';
  const clean = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...clean];
  const cut = chars.length > max ? chars.slice(0, max - 1).join('') + '…' : clean;
  return `"${cut.replace(/"/g, '”')}"`;
}

/** The number of characters as a reader counts them (an emoji is one). */
export function length(value: string | null | undefined): number {
  return value ? [...value].length : 0;
}

export function plural(n: number, one: string, many = one + 's'): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

export function kb(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function ms(value: number): string {
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(value < 10000 ? 2 : 1)} s`;
}

export function duration(msValue: number): string {
  const s = Math.round(msValue / 1000);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** A URL shown relative to the site when it is on the site. */
export function short(url: string, origin?: string): string {
  if (origin && url.startsWith(origin)) return url.slice(origin.length) || '/';
  return url;
}

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
