/**
 * Query composition and inspection.
 *
 * The provider accepts search operators inline (`site:`, `lang:`, `after:`, …).
 * The UI exposes them as separate controls, so this module is the single place
 * that turns "text + filters" into the string actually sent upstream — and the
 * mirror operation, parsing operator tokens back out for highlighting.
 */
export type TimePreset = 'any' | 'day' | 'week' | 'month' | 'year';

export interface Filters {
  /** Comma- or space-separated hosts to include; empty means unrestricted. */
  site: string;
  /** Hosts to exclude. */
  excludeSites: string;
  /** BCP-47-ish language list, e.g. `zh` or `zh,en`. */
  lang: string;
  time: TimePreset;
}

export const EMPTY_FILTERS: Filters = { site: '', excludeSites: '', lang: '', time: 'any' };

export function hasFilters(f: Filters): boolean {
  return Boolean(f.site.trim() || f.excludeSites.trim() || f.lang.trim() || f.time !== 'any');
}

/**
 * Reduce user-pasted input to a bare host.
 *
 * Accepts `https://www.zhihu.com/question/123`, `zhihu.com`, ` www.zhihu.com/ `
 * and yields `zhihu.com`. Returns '' when nothing host-like remains.
 */
export function sanitizeSite(input: string): string {
  let value = (input ?? '').trim().toLowerCase();
  if (!value) return '';
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  value = value.replace(/[/?#].*$/, '');
  value = value.replace(/^www\./, '');
  value = value.replace(/[^a-z0-9.-]/g, '');
  if (!value || !value.includes('.')) return '';
  if (value.startsWith('.') || value.endsWith('.') || value.includes('..')) return '';
  return value;
}

/** Split a user-entered site list into sanitized hosts, preserving order. */
export function parseSiteList(input: string): string[] {
  return (input ?? '')
    .split(/[\s,;]+/)
    .map(sanitizeSite)
    .filter((s, i, all) => s.length > 0 && all.indexOf(s) === i);
}

/** ISO date (UTC, YYYY-MM-DD) marking the start of a time preset. */
export function timePresetToDate(preset: TimePreset, now: Date = new Date()): string {
  const d = new Date(now.getTime());
  switch (preset) {
    case 'day':
      d.setUTCDate(d.getUTCDate() - 1);
      break;
    case 'week':
      d.setUTCDate(d.getUTCDate() - 7);
      break;
    case 'month':
      d.setUTCMonth(d.getUTCMonth() - 1);
      break;
    case 'year':
      d.setUTCFullYear(d.getUTCFullYear() - 1);
      break;
    default:
      return '';
  }
  return d.toISOString().slice(0, 10);
}

/**
 * Compose the upstream query string.
 *
 * Operators are appended in a stable order so that equivalent filter states
 * produce byte-identical queries (which keeps the cache keys stable).
 */
export function buildQuery(text: string, filters: Filters = EMPTY_FILTERS, now?: Date): string {
  const parts: string[] = [];
  const trimmed = (text ?? '').trim();
  if (trimmed) parts.push(trimmed);

  const sites = parseSiteList(filters.site);
  if (sites.length === 1) parts.push(`site:${sites[0]}`);
  else if (sites.length > 1) parts.push(sites.map((s) => `site:${s}`).join(' OR '));

  for (const host of parseSiteList(filters.excludeSites)) parts.push(`-site:${host}`);

  const lang = (filters.lang ?? '').trim();
  if (lang) parts.push(`lang:${lang}`);

  const after = filters.time === 'any' ? '' : timePresetToDate(filters.time, now);
  if (after) parts.push(`after:${after}`);

  return parts.join(' ');
}

const OPERATOR_RE = /^(site:|-site:|lang:|-lang:|after:|-after:|before:|-before:|or$)/i;
const TOKEN_RE = /-?"[^"]*"|-?'[^']*'|-?\S+/g;

/**
 * Tokens worth highlighting in a result.
 *
 * Three kinds are dropped because they are instructions, not text:
 *  - `site:` / `lang:` / `after:` / `before:` operators,
 *  - the boolean `OR`,
 *  - negated terms (`-广告`), which by definition should not appear.
 */
export function highlightTerms(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const matches = (raw ?? '').match(TOKEN_RE) ?? [];

  for (const token of matches) {
    if (token.startsWith('-')) continue; // negation
    if (OPERATOR_RE.test(token)) continue;
    const quoted = /^["'](.*)["']$/.test(token);
    const value = quoted ? token.slice(1, -1).trim() : token.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  // Longest first: avoids a short term splitting a longer one during replacement.
  return out.sort((a, b) => b.length - a.length);
}
