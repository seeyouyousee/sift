import { describe, expect, it } from 'vitest';
import { escapeHtml, highlight } from '../src/core/highlight.js';
import { clampText, fmtCount, fmtDate, fmtDuration, fmtMoney, hostOf } from '../src/core/format.js';

describe('escapeHtml', () => {
  it('neutralises tags and quotes', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe(
      '&lt;img src=x onerror=alert(1)&gt;',
    );
    expect(escapeHtml(`a & b "c" 'd'`)).toBe('a &amp; b &quot;c&quot; &#39;d&#39;');
  });
});

describe('highlight', () => {
  it('escapes result text before marking', () => {
    const out = highlight('<script>alert(1)</script> deepseek', ['deepseek']);
    expect(out).toContain('&lt;script&gt;');
    expect(out).not.toContain('<script>');
    expect(out).toContain('<mark>deepseek</mark>');
  });

  it('is case-insensitive', () => {
    expect(highlight('DeepSeek 发布了', ['deepseek'])).toBe('<mark>DeepSeek</mark> 发布了');
  });

  it('marks every occurrence of every term', () => {
    const out = highlight('a b a b', ['a', 'b']);
    expect(out.match(/<mark>/g)).toHaveLength(4);
  });

  it('handles regex metacharacters in terms', () => {
    const out = highlight('price is $5.00 (usd)', ['$5.00', '(usd)']);
    expect(out).toContain('<mark>$5.00</mark>');
    expect(out).toContain('<mark>(usd)</mark>');
  });

  it('returns plain escaped text for an empty term list', () => {
    expect(highlight('<b>x</b>', [])).toBe('&lt;b&gt;x&lt;/b&gt;');
  });

  it('does not double-escape an ampersand inside a term', () => {
    // The term is escaped for the haystack; the output must stay valid HTML.
    expect(highlight('AT&T 与 AT&T', ['AT&T'])).toBe(
      '<mark>AT&amp;T</mark> 与 <mark>AT&amp;T</mark>',
    );
  });
});

describe('format helpers', () => {
  it('hostOf strips scheme and www, tolerates junk', () => {
    expect(hostOf('https://www.zhihu.com/a/b?c=1')).toBe('zhihu.com');
    expect(hostOf('not a url')).toBe('not a url');
  });

  it('fmtDate renders ISO dates and blanks bad input', () => {
    expect(fmtDate('2026-10-18T16:00:00+00:00')).toBe('2026-10-18');
    expect(fmtDate(null)).toBe('');
    expect(fmtDate('nope')).toBe('');
  });

  it('fmtDuration switches unit at one second', () => {
    expect(fmtDuration(820)).toBe('820ms');
    expect(fmtDuration(1620)).toBe('1.6s');
    expect(fmtDuration(-1)).toBe('—');
  });

  it('fmtMoney keeps sub-cent precision visible', () => {
    expect(fmtMoney(0.005)).toBe('¥0.005');
    expect(fmtMoney(0.25)).toBe('¥0.25');
    expect(fmtMoney(0)).toBe('¥0');
  });

  it('clampText truncates with an ellipsis', () => {
    expect(clampText('abcdef', 4)).toBe('abc…');
    expect(clampText('ab', 4)).toBe('ab');
  });

  it('fmtCount compacts thousands', () => {
    expect(fmtCount(999)).toBe('999');
    expect(fmtCount(1200)).toBe('1.2k');
    expect(fmtCount(20_000)).toBe('20k');
  });
});
