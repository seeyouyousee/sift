/** Small pure formatting helpers shared by the UI and tests. */

/** `https://www.zhihu.com/x` → `zhihu.com`. Falls back to the raw string. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** RFC-3339 timestamp → `YYYY-MM-DD`, or '' when absent/unparseable. */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/** `1620` → `1.6s`; `820` → `820ms`. */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Money with enough precision to show a single search's cost. */
export function fmtMoney(yuan: number): string {
  if (!Number.isFinite(yuan) || yuan <= 0) return '¥0';
  if (yuan < 0.01) return `¥${yuan.toFixed(3)}`;
  if (yuan < 1) return `¥${yuan.toFixed(2)}`;
  return `¥${yuan.toFixed(2)}`;
}

/** Clamp a string to `max` characters on a code-point boundary. */
export function clampText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Compact number for counters: 1200 → 1.2k. */
export function fmtCount(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
}
