/**
 * HTML escaping and term highlighting.
 *
 * The rule here is boring and non-negotiable: search results are untrusted
 * third-party text, so everything is escaped *before* any markup is introduced.
 * Highlighting therefore operates on already-escaped text and only ever emits
 * `<mark>` around matches — no result byte can become a tag.
 */
const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(input: string): string {
  return String(input ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Escape `text` and wrap every occurrence of `terms` in `<mark>`.
 *
 * `terms` are expected longest-first (see `highlightTerms`); an empty list makes
 * this a plain escape.
 */
export function highlight(text: string, terms: string[]): string {
  const escaped = escapeHtml(text);
  const usable = terms.map((t) => t.trim()).filter((t) => t.length > 0);
  if (usable.length === 0) return escaped;

  // Escape each term for both regex syntax and the HTML-escaped haystack.
  const pattern = usable
    .map((t) => escapeRegExp(escapeHtml(t)))
    .sort((a, b) => b.length - a.length)
    .join('|');

  try {
    return escaped.replace(new RegExp(`(${pattern})`, 'gi'), '<mark>$1</mark>');
  } catch {
    // A pathological term must never break rendering; degrade to plain text.
    return escaped;
  }
}
