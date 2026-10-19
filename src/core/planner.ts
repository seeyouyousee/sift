/**
 * Intent planning: turn a question into a small, typed retrieval plan.
 *
 * This is the layer that keyword hacks kept standing in for. A regex can spot
 * "下载" and append `site:huggingface.co`; only a model can decide that
 * "DeepSeek 模型下载" wants a repository listing, while "怎么删重复行" wants
 * prose that names `drop_duplicates`.
 *
 * The output is deliberately tiny and closed: three actions, at most three
 * queries. Everything else is a parsing failure that the caller falls back on.
 */
export type PlanAction = 'answer' | 'repos' | 'compare';

export interface PlanQuery {
  q: string;
  why: string;
}

export interface PlannerPlan {
  intent: string;
  action: PlanAction;
  entities: string[];
  queries: PlanQuery[];
}

export const PLANNER_SYSTEM = [
  '你是搜索规划器。把用户问题转成检索计划，只输出 JSON，不要任何解释：',
  '{"intent":"一句话说明用户真正想要什么","action":"answer|repos|compare","entities":["关键实体"],"queries":[{"q":"检索式","why":"为什么搜这条"}]}',
  '规则：',
  '- 用户想找「下载地址 / 仓库 / 权重 / 安装包」→ action 填 repos，检索式必须带上 site:huggingface.co 或 site:modelscope.cn',
  '- 用户要「比较 / 区别 / 哪个好」→ action 填 compare',
  '- 其余 → action 填 answer；检索式必须用规范术语（函数名、库名、API 名、产品全名），不要照抄口语长句',
  '- 检索式 1-3 条，每条不超过 80 字，彼此不要重复',
].join('\n');

export const MAX_QUERIES = 3;
const MAX_QUERY_LENGTH = 120;

const ACTIONS: PlanAction[] = ['answer', 'repos', 'compare'];

/** Strip code fences, then take the outermost JSON object. */
function extractJson(raw: string): string | null {
  const text = (raw ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}

function asStringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
    .slice(0, limit);
}

/**
 * Parse a planner response.
 *
 * Returns null when there is nothing usable, so the caller can fall back to the
 * single-pass search instead of showing an empty page.
 */
export function parsePlan(raw: string): PlannerPlan | null {
  const json = extractJson(raw);
  if (!json) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;

  const record = payload as Record<string, unknown>;
  const intent = typeof record.intent === 'string' && record.intent.trim() ? record.intent.trim() : '';

  const seen = new Set<string>();
  const queries: PlanQuery[] = [];
  if (Array.isArray(record.queries)) {
    for (const item of record.queries) {
      const candidate = item as Record<string, unknown> | null;
      const q = typeof candidate?.q === 'string' ? candidate.q.trim() : '';
      if (!q || q.length > MAX_QUERY_LENGTH) continue;
      const key = q.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      queries.push({ q, why: typeof candidate?.why === 'string' ? candidate.why.trim() : '' });
      if (queries.length >= MAX_QUERIES) break;
    }
  }
  if (queries.length === 0) return null;

  const action = ACTIONS.includes(record.action as PlanAction) ? (record.action as PlanAction) : 'answer';

  return {
    intent: intent || queries[0]?.q || '',
    action,
    entities: asStringArray(record.entities, 6),
    queries,
  };
}

/** The user message sent to the planner. */
export function buildPlannerMessages(question: string): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    { role: 'system', content: PLANNER_SYSTEM },
    { role: 'user', content: question.trim() },
  ];
}
