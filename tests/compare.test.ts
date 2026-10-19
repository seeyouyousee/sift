import { describe, expect, it } from 'vitest';
import { compareQueries, type ComparePreset } from '../src/core/compare.js';
import { EMPTY_FILTERS } from '../src/core/query.js';

const PRESETS: ComparePreset[] = [
  { id: 'a', label: 'A', site: 'a.com' },
  { id: 'b', label: 'B', site: 'b.com' },
];

describe('compareQueries', () => {
  it('produces one site-scoped query per preset', () => {
    const out = compareQueries('rust', EMPTY_FILTERS, PRESETS);
    expect(out.map((q) => q.query)).toEqual(['rust site:a.com', 'rust site:b.com']);
    expect(out.map((q) => q.preset.id)).toEqual(['a', 'b']);
  });

  it('replaces the user site filter instead of stacking it', () => {
    const out = compareQueries('rust', { ...EMPTY_FILTERS, site: 'zhihu.com' }, PRESETS);
    expect(out[0]?.query).toBe('rust site:a.com');
    expect(out[0]?.query).not.toContain('zhihu.com');
  });

  it('keeps exclusions, language and time on every column', () => {
    const out = compareQueries(
      'rust',
      { site: '', excludeSites: 'spam.com', lang: 'zh', time: 'week' },
      PRESETS,
      new Date('2026-03-15T00:00:00Z'),
    );
    for (const item of out) {
      expect(item.query).toContain('-site:spam.com');
      expect(item.query).toContain('lang:zh');
      expect(item.query).toContain('after:2026-03-08');
    }
  });

  it('supports an empty text with filters only', () => {
    const out = compareQueries('', { ...EMPTY_FILTERS, lang: 'en' }, [PRESETS[0] as ComparePreset]);
    expect(out[0]?.query).toBe('site:a.com lang:en');
  });

  it('returns an empty list for no presets', () => {
    expect(compareQueries('x', EMPTY_FILTERS, [])).toEqual([]);
  });
});
