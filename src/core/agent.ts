/**
 * Plan → collect → hand over.
 *
 * The orchestration is kept pure by taking the planner and the searcher as
 * dependencies: the tests assert the merge and the caps without a network, and
 * the UI wires in the rate-limited client.
 */
import type { SearchResult } from './types.js';
import { urlIdentity } from './dedupe.js';
import type { PlannerPlan } from './planner.js';

export interface AgentDeps {
  plan: (question: string) => Promise<PlannerPlan>;
  search: (query: string, count: number) => Promise<SearchResult[]>;
}

export interface EvidenceGroup {
  query: string;
  why: string;
  results: SearchResult[];
}

export interface AgentRun {
  plan: PlannerPlan;
  groups: EvidenceGroup[];
  /** Interleaved, de-duplicated evidence — the order the user should see. */
  evidence: SearchResult[];
  searched: number;
}

const RRF_K = 60;

/**
 * Fuse the planned queries with Reciprocal Rank Fusion.
 *
 * Plain concatenation lets one query's tail bury another query's best hit;
 * plain interleaving still treats "rank 1 of a narrow query" and "rank 1 of a
 * broad one" as equal. RRF sums `1/(k + rank)` per query, so a page returned by
 * several queries wins over one that only a single query liked.
 */
export async function collectEvidence(
  plan: PlannerPlan,
  deps: Pick<AgentDeps, 'search'>,
  countPerQuery = 8,
): Promise<{ groups: EvidenceGroup[]; evidence: SearchResult[] }> {
  const groups: EvidenceGroup[] = await Promise.all(
    plan.queries.map(async (item) => ({
      query: item.q,
      why: item.why,
      results: await deps.search(item.q, countPerQuery).catch(() => [] as SearchResult[]),
    })),
  );

  const fused = new Map<string, { result: SearchResult; score: number; seenAt: number }>();
  let seenAt = 0;

  for (const group of groups) {
    group.results.forEach((result, rank) => {
      const key = urlIdentity(result.url) || result.url;
      const existing = fused.get(key);
      if (existing) {
        existing.score += 1 / (RRF_K + rank + 1);
        return;
      }
      fused.set(key, { result, score: 1 / (RRF_K + rank + 1), seenAt: seenAt++ });
    });
  }

  const evidence = [...fused.values()]
    .sort((a, b) => b.score - a.score || a.seenAt - b.seenAt)
    .map((entry) => entry.result);

  return { groups, evidence };
}

/** One call that a UI can await. */
export async function runAgent(question: string, deps: AgentDeps, countPerQuery = 8): Promise<AgentRun> {
  const plan = await deps.plan(question);
  const { groups, evidence } = await collectEvidence(plan, deps, countPerQuery);
  return { plan, groups, evidence, searched: plan.queries.length };
}
