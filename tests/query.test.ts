import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILTERS,
  buildQuery,
  hasFilters,
  highlightTerms,
  parseSiteList,
  sanitizeSite,
  timePresetToDate,
} from '../src/core/query.js';

describe('sanitizeSite', () => {
  it.each([
    ['https://www.zhihu.com/question/123', 'zhihu.com'],
    ['zhihu.com', 'zhihu.com'],
    ['  WWW.Zhihu.COM/  ', 'zhihu.com'],
    ['sub.example.co.uk/path?q=1#frag', 'sub.example.co.uk'],
  ])('%s → %s', (input, expected) => {
    expect(sanitizeSite(input)).toBe(expected);
  });

  it.each(['', '   ', 'notahost', '.com', 'a..b', 'http://'])('rejects %s', (input) => {
    expect(sanitizeSite(input)).toBe('');
  });
});

describe('parseSiteList', () => {
  it('splits on whitespace/commas and dedupes', () => {
    expect(parseSiteList('a.com, b.com  https://a.com/x')).toEqual(['a.com', 'b.com']);
  });

  it('drops junk tokens', () => {
    expect(parseSiteList('a.com ??? c.com')).toEqual(['a.com', 'c.com']);
  });
});

describe('buildQuery', () => {
  it('returns bare text with no filters', () => {
    expect(buildQuery('  deepseek  ', EMPTY_FILTERS)).toBe('deepseek');
  });

  it('adds a single site operator', () => {
    expect(buildQuery('rust', { ...EMPTY_FILTERS, site: 'zhihu.com' })).toBe('rust site:zhihu.com');
  });

  it('joins multiple sites with OR', () => {
    expect(buildQuery('rust', { ...EMPTY_FILTERS, site: 'a.com b.com' })).toBe('rust site:a.com OR site:b.com');
  });

  it('adds exclusions, language, and date in a stable order', () => {
    const q = buildQuery(
      'rust',
      { site: 'a.com', excludeSites: 'b.com', lang: 'zh', time: 'week' },
      new Date('2026-03-15T00:00:00Z'),
    );
    expect(q).toBe('rust site:a.com -site:b.com lang:zh after:2026-03-08');
  });

  it('works with filters but empty text', () => {
    expect(buildQuery('', { ...EMPTY_FILTERS, lang: 'en' })).toBe('lang:en');
  });
});

describe('timePresetToDate', () => {
  const now = new Date('2026-03-15T12:00:00Z');
  it.each([
    ['day', '2026-03-14'],
    ['week', '2026-03-08'],
    ['year', '2025-03-15'],
  ])('%s → %s', (preset, expected) => {
    expect(timePresetToDate(preset as never, now)).toBe(expected);
  });

  it('returns empty for "any"', () => {
    expect(timePresetToDate('any', now)).toBe('');
  });

  it('handles month rollover', () => {
    expect(timePresetToDate('month', new Date('2026-03-31T00:00:00Z'))).toBe('2026-03-03');
  });
});

describe('hasFilters', () => {
  it('is false for the empty set and true otherwise', () => {
    expect(hasFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasFilters({ ...EMPTY_FILTERS, lang: 'zh' })).toBe(true);
    expect(hasFilters({ ...EMPTY_FILTERS, time: 'day' })).toBe(true);
  });
});

describe('highlightTerms', () => {
  it('drops operators and negated terms', () => {
    expect(highlightTerms('rust site:zhihu.com -广告 lang:zh after:2025-01-01')).toEqual(['rust']);
  });

  it('keeps a quoted phrase as one term and dedupes case-insensitively', () => {
    expect(highlightTerms('"Hello World" "hello world"') ).toEqual(['Hello World']);
  });

  it('keeps words alongside a quoted phrase', () => {
    expect(highlightTerms('"Hello World" hello')).toEqual(['Hello World', 'hello']);
  });

  it('sorts longest first to protect overlapping terms', () => {
    expect(highlightTerms('a ab abc')).toEqual(['abc', 'ab', 'a']);
  });

  it('returns nothing for operator-only input', () => {
    expect(highlightTerms('site:a.com OR -b')).toEqual([]);
  });
});
