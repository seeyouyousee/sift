/**
 * Result dedupe: the one post-processing step that measured as a clear win.
 *
 * An earlier version also re-scored (relevance/authority/recency) and demoted a
 * domain's 3rd+ hit. A 10-query benchmark showed that trade was a wash — unique
 * hosts 8.2 → 8.4, median provider score 1.86 → 1.84 — so the re-scoring was
 * deleted rather than kept as makeup. Dropping locale clones and duplicate
 * titles, on the other hand, removes pages that are literally the same article
 * and costs nothing.
 */
import type { SearchResult } from './types.js';

export interface DedupeOptions {
  /** Hostnames (or suffixes) to drop outright. Empty by default: opinion is opt-in. */
  blocklist?: string[];
}

export interface DedupeStats {
  blocklisted: number;
  duplicateUrl: number;
  duplicateTitle: number;
}

export interface DedupeOutcome {
  results: SearchResult[];
  stats: DedupeStats;
}

/** Locale segment that content farms put in front of the same page. */
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
 * `aspose.com/zh-cn/x` and `aspose.com/ko/x` collapse to `aspose.com/x`.
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

function blocked(host: string, blocklist: string[]): boolean {
  return blocklist.some((entry) => {
    const needle = entry.trim().toLowerCase();
    return needle.length > 0 && (host === needle || host.endsWith(`.${needle}`));
  });
}

/** Drop pages that are not distinct pages. Order is otherwise untouched. */
export function dedupeResults(input: readonly SearchResult[], options: DedupeOptions = {}): DedupeOutcome {
  const blocklist = options.blocklist ?? [];
  const stats: DedupeStats = { blocklisted: 0, duplicateUrl: 0, duplicateTitle: 0 };
  const seenUrls = new Set<string>();
  const seenTitles = new Set<string>();
  const results: SearchResult[] = [];

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
    results.push(result);
  }

  return { results, stats };
}
