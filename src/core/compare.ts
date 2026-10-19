/**
 * Compare mode: one query, N site-scoped variants.
 *
 * Each column is an independent billable request, so this module is deliberately
 * small and pure — the *cost* of the feature is decided by the caller (number of
 * presets), and the UI is responsible for saying so out loud.
 */
import { buildQuery, type Filters } from './query.js';

export interface ComparePreset {
  id: string;
  label: string;
  site: string;
}

export interface CompareQuery {
  preset: ComparePreset;
  /** Upstream query string, e.g. `rust site:github.com lang:zh`. */
  query: string;
}

/**
 * Build one query per preset.
 *
 * The user's own `site:` filter is replaced by the preset's site — comparing
 * "only zhihu.com" against four sites would be four identical searches.
 * Exclusions, language and time range still apply to every column.
 */
export function compareQueries(
  text: string,
  filters: Filters,
  presets: readonly ComparePreset[],
  now?: Date,
): CompareQuery[] {
  return presets.map((preset) => ({
    preset,
    query: buildQuery(text, { ...filters, site: preset.site }, now),
  }));
}
