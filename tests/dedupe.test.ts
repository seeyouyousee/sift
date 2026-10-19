import { describe, expect, it } from 'vitest';
import { dedupeResults, titleIdentity, urlIdentity } from '../src/core/dedupe.js';
import type { SearchResult } from '../src/core/types.js';

let seq = 0;
function make(partial: Partial<SearchResult> = {}): SearchResult {
  seq++;
  return {
    title: `result ${seq}`,
    url: `https://site${seq}.example.com/page`,
    snippet: 's',
    summary: 's',
    content: '',
    site_name: null,
    site_icon: null,
    date: '2026-10-01T00:00:00+00:00',
    authority: 2,
    rerank_score: 2,
    ...partial,
  };
}

describe('urlIdentity', () => {
  it('collapses locale-prefixed clones of the same page', () => {
    const a = urlIdentity('https://www.aspose.com/zh-cn/python/excel/remove-rows');
    const b = urlIdentity('https://aspose.com/ko/python/excel/remove-rows');
    const c = urlIdentity('https://aspose.com/python/excel/remove-rows');
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).toBe('aspose.com/python/excel/remove-rows');
  });

  it('ignores query strings and trailing slashes', () => {
    expect(urlIdentity('https://a.com/x/?utm=1')).toBe('a.com/x');
  });

  it('keeps genuinely different paths distinct', () => {
    expect(urlIdentity('https://a.com/x')).not.toBe(urlIdentity('https://a.com/y'));
  });

  it('falls back to the raw string for junk', () => {
    expect(urlIdentity('not a url')).toBe('not a url');
  });
});

describe('titleIdentity', () => {
  it('ignores case, spaces and punctuation', () => {
    expect(titleIdentity('使用 Python 删除 Excel 中的重复行')).toBe(
      titleIdentity('使用Python删除Excel中的重复行'),
    );
  });
});

describe('dedupeResults', () => {
  it('drops locale clones and reports it', () => {
    const base = 'https://aspose.com';
    const input = [
      make({ url: `${base}/zh-cn/x`, title: 'A' }),
      make({ url: `${base}/ko/x`, title: 'B' }),
      make({ url: `${base}/x`, title: 'C' }),
    ];
    const { results, stats } = dedupeResults(input);
    expect(results).toHaveLength(1);
    expect(stats.duplicateUrl).toBe(2);
  });

  it('drops an exact duplicate title from another host', () => {
    const input = [
      make({ url: 'https://a.com/1', title: 'Same Title' }),
      make({ url: 'https://b.com/2', title: 'same   title!' }),
    ];
    const { results, stats } = dedupeResults(input);
    expect(results).toHaveLength(1);
    expect(stats.duplicateTitle).toBe(1);
  });

  it('drops blocklisted hosts and their subdomains', () => {
    const input = [
      make({ url: 'https://farm.example/1', title: 'a' }),
      make({ url: 'https://sub.farm.example/2', title: 'b' }),
      make({ url: 'https://good.com/3', title: 'c' }),
    ];
    const { results, stats } = dedupeResults(input, { blocklist: ['farm.example'] });
    expect(results).toHaveLength(1);
    expect(stats.blocklisted).toBe(2);
  });

  it('never reorders what survives', () => {
    const input = [
      make({ url: 'https://a.com/1', title: 'one' }),
      make({ url: 'https://b.com/2', title: 'two' }),
      make({ url: 'https://a.com/3', title: 'three' }),
    ];
    expect(dedupeResults(input).results.map((r) => r.title)).toEqual(['one', 'two', 'three']);
  });

  it('keeps multiple hits from one host (no domain cap)', () => {
    const input = [
      make({ url: 'https://dup.com/1', title: 'one' }),
      make({ url: 'https://dup.com/2', title: 'two' }),
      make({ url: 'https://dup.com/3', title: 'three' }),
    ];
    expect(dedupeResults(input).results).toHaveLength(3);
  });

  it('does not mutate the input', () => {
    const input = [make({ title: 'x' })];
    const snapshot = JSON.stringify(input);
    dedupeResults(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('handles an empty list', () => {
    expect(dedupeResults([])).toEqual({
      results: [],
      stats: { blocklisted: 0, duplicateUrl: 0, duplicateTitle: 0 },
    });
  });

  it('ignores an empty blocklist', () => {
    const input = [make({ url: 'https://a.com/1' }), make({ url: 'https://b.com/2' })];
    expect(dedupeResults(input, { blocklist: [] }).results).toHaveLength(2);
  });
});
