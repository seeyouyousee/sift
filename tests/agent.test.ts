import { describe, expect, it, vi } from 'vitest';
import { collectEvidence, runAgent } from '../src/core/agent.js';
import type { PlannerPlan } from '../src/core/planner.js';
import type { SearchResult } from '../src/core/types.js';

function result(url: string, title = url): SearchResult {
  return {
    title,
    url,
    snippet: '',
    summary: '',
    content: '',
    site_name: null,
    site_icon: null,
    date: null,
    authority: 2,
    rerank_score: 2,
  };
}

const plan = (queries: string[]): PlannerPlan => ({
  intent: 'x',
  action: 'answer',
  entities: [],
  queries: queries.map((q) => ({ q, why: '' })),
});

describe('collectEvidence', () => {
  it('interleaves results across queries', async () => {
    const search = vi.fn(async (q: string) =>
      q === 'a' ? [result('https://a/1', 'a1'), result('https://a/2', 'a2')] : [result('https://b/1', 'b1')],
    );
    const { evidence } = await collectEvidence(plan(['a', 'b']), { search });
    expect(evidence.map((r) => r.title)).toEqual(['a1', 'b1', 'a2']);
  });

  it('dedupes the same page returned by several queries', async () => {
    const search = vi.fn(async () => [
      result('https://x.com/p'),
      result('https://x.com/p/'),
      result('https://y.com/q'),
    ]);
    const { evidence } = await collectEvidence(plan(['a', 'b']), { search });
    expect(evidence.map((r) => r.url)).toEqual(['https://x.com/p', 'https://y.com/q']);
  });

  it('passes the per-query count through', async () => {
    const search = vi.fn(async () => []);
    await collectEvidence(plan(['a']), { search }, 5);
    expect(search).toHaveBeenCalledWith('a', 5);
  });

  it('keeps going when one query fails', async () => {
    const search = vi.fn(async (q: string) => {
      if (q === 'bad') throw new Error('boom');
      return [result('https://ok/1')];
    });
    const { groups, evidence } = await collectEvidence(plan(['bad', 'good']), { search });
    expect(groups[0]?.results).toEqual([]);
    expect(evidence).toHaveLength(1);
  });
});

describe('runAgent', () => {
  it('returns the plan, the groups and the evidence count', async () => {
    const deps = {
      plan: vi.fn(async () => plan(['a', 'b'])),
      search: vi.fn(async () => [result('https://x/1')]),
    };
    const run = await runAgent('question', deps);
    expect(run.plan.queries).toHaveLength(2);
    expect(run.searched).toBe(2);
    expect(run.groups).toHaveLength(2);
    expect(run.evidence).toHaveLength(1);
    expect(deps.plan).toHaveBeenCalledWith('question');
  });
});
