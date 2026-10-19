/**
 * Post-retrieval ranking: the part the provider does not do for you.
 *
 * The upstream order optimises "relevant + authoritative + fresh for an LLM to
 * quote". That is not the same as "good list for a human": the same article
 * appears once per language, one content farm can take four of the first five
 * slots, and a government notice outscores the answer. Everything here is local
 * post-processing on one paid response — zero extra requests.
 *
 * Three moves, in order:
 *   1. drop what is not a distinct page (locale-prefixed clones, same title);
 *   2. score = relevance + authority + recency, re-sorted;
 *   3. demote — never delete — a domain's 3rd+ hit, so the list keeps its length
 *      and a bad first page does not silently become a short page.
 */
import type { SearchResult } from './types.js';

export interface RankWeights {
  relevance: number;
  authority: number;
  recency: number;
}

export interface RankOptions {
  /** Hits kept in place per hostname; the rest are demoted to the tail. */
  maxPerDomain?: number;
  /** Hostnames (or suffixes) to drop outright. Empty by default: opinion is opt-in. */
  blocklist?: string[];
  weights?: RankWeights;
  now?: () => number;
}

export interface RankStats {
  blocklisted: number;
  duplicateUrl: number;
  duplicateTitle: number;
  demoted: number;
}

export interface RankOutcome {
  results: SearchResult[];
  stats: RankStats;
}

const DEFAULT_WEIGHTS: RankWeights = { relevance: 0.6, authority: 0.25, recency: 0.15 };
const DEFAULT_MAX_PER_DOMAIN = 2;

/** Locale segment that clouds many content farms put in front of the same page. */
const LOCALE_SEGMENT =
  /^\/(?:zh|zh-cn|zh-tw|zh-hk|zh-hans|zh-hant|en|en-us|en-gb|ja|jp|ko|kr|de|fr|es|pt|ru|ar|it|nl|pl|tr|vi|th|id|hi)(?:[-_][a-z]{2})?(?=\/|$)/i;

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Identity of a page, ignoring locale prefixes and query strings.
 *
 * `aspose.com/zh-cn/x` and `aspose.com/ko/x` collapse to `aspose.com/x`, which
 * is exactly the clone pattern seen in the wild.
 */
export function urlIdentity(url: string): string {
  try {
    const parsed = new URL(url);
    let path = parsed.pathname.replace(/\/+$/, '');
    for (;;) {
      const stripped = path.replace(LOCALE_SEGMENT, '');
      if (stripped === path) break;
      path = stripped;
    }
    return `${parsed.hostname.replace(/^www\./, '').toLowerCase()}${path}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

/** Title identity: case/punctuation/whitespace insensitive. */
export function titleIdentity(title: string): string {
  return (title ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[.,:;!?'"“”‘’()\[\]{}<>《》·—–\-_/\\|]/g, '');
}

function daysOld(iso: string | null, now: number): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (now - t) / 86_400_000);
}

function recencyScore(iso: string | null, now: number): number {
  const days = daysOld(iso, now);
  if (!Number.isFinite(days)) return 0.5; // unknown age is neutral, not stale
  if (days <= 7) return 1;
  return Math.max(0, 1 - days / 365);
}

function authorityScore(authority: number): number {
  if (!Number.isFinite(authority) || authority < 0) return 0.5;
  return Math.min(1, authority / 4);
}

function relevanceScore(rerank: number): number {
  if (!Number.isFinite(rerank) || rerank <= 0) return 0;
  return Math.min(1, rerank / 3);
}

function blocked(host: string, blocklist: string[]): boolean {
  return blocklist.some((entry) => {
    const needle = entry.trim().toLowerCase();
    return needle.length > 0 && (host === needle || host.endsWith(`.${needle}`));
  });
}

/**
 * Re-rank one paid response for human consumption.
 *
 * The output preserves every surviving result object untouched (the UI needs the
 * original fields) and only changes order/length.
 */
export function rankResults(input: readonly SearchResult[], options: RankOptions = {}): RankOutcome {
  const weights = options.weights ?? DEFAULT_WEIGHTS;
  const maxPerDomain = options.maxPerDomain ?? DEFAULT_MAX_PER_DOMAIN;
  const blocklist = options.blocklist ?? [];
  const now = options.now?.() ?? Date.now();

  const stats: RankStats = { blocklisted: 0, duplicateUrl: 0, duplicateTitle: 0, demoted: 0 };
  const seenUrls = new Set<string>();
  const seenTitles = new Set<string>();
  const kept: SearchResult[] = [];

  for (const result of input) {
    const host = hostnameOf(result.url);
    if (host && blocked(host, blocklist)) {
      stats.blocklisted++;
      continue;
    }

    const urlKey = urlIdentity(result.url);
    if (seenUrls.has(urlKey)) {
      stats.duplicateUrl++;
      continue;
    }

    const titleKey = titleIdentity(result.title);
    if (titleKey && seenTitles.has(titleKey)) {
      stats.duplicateTitle++;
      continue;
    }

    seenUrls.add(urlKey);
    if (titleKey) seenTitles.add(titleKey);
    kept.push(result);
  }

  const scoreOf = (result: SearchResult): number =>
    weights.relevance * relevanceScore(result.rerank_score) +
    weights.authority * authorityScore(result.authority) +
    weights.recency * recencyScore(result.date, now);

  const scored = kept
    .map((result, index) => ({ result, index, score: scoreOf(result) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const inPlace: SearchResult[] = [];
  const demoted: SearchResult[] = [];
  const perDomain = new Map<string, number>();

  for (const { result } of scored) {
    const host = hostnameOf(result.url);
    const count = perDomain.get(host) ?? 0;
    if (maxPerDomain > 0 && count >= maxPerDomain) {
      demoted.push(result);
      stats.demoted++;
      continue;
    }
    perDomain.set(host, count + 1);
    inPlace.push(result);
  }

  return { results: [...inPlace, ...demoted], stats };
}
