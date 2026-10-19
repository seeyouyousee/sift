import { describe, expect, it } from 'vitest';
import { MAX_QUERIES, buildPlannerMessages, parsePlan } from '../src/core/planner.js';

const valid = JSON.stringify({
  intent: '找到 DeepSeek 模型的官方下载地址',
  action: 'repos',
  entities: ['DeepSeek', 'HuggingFace'],
  queries: [
    { q: 'DeepSeek 模型 site:huggingface.co', why: '官方仓库' },
    { q: 'DeepSeek 模型 site:modelscope.cn', why: '国内镜像' },
  ],
});

describe('parsePlan', () => {
  it('parses a clean JSON plan', () => {
    const plan = parsePlan(valid);
    expect(plan?.action).toBe('repos');
    expect(plan?.queries.map((q) => q.q)).toHaveLength(2);
    expect(plan?.entities).toEqual(['DeepSeek', 'HuggingFace']);
  });

  it('tolerates ```json fences and surrounding prose', () => {
    const raw = `这是计划：\n\`\`\`json\n${valid}\n\`\`\`\n希望有帮助。`;
    expect(parsePlan(raw)?.action).toBe('repos');
  });

  it('returns null for unparseable output', () => {
    expect(parsePlan('抱歉，我无法完成')).toBeNull();
    expect(parsePlan('{"intent":"x","queries":[]}')).toBeNull();
    expect(parsePlan('{"queries":[{"q":""}]}')).toBeNull();
  });

  it('defaults an unknown action to answer', () => {
    const plan = parsePlan(JSON.stringify({ intent: 'x', action: 'browse', queries: [{ q: 'a' }] }));
    expect(plan?.action).toBe('answer');
  });

  it('caps the number of queries', () => {
    const queries = Array.from({ length: 6 }, (_, i) => ({ q: `q${i}` }));
    const plan = parsePlan(JSON.stringify({ intent: 'x', queries }));
    expect(plan?.queries).toHaveLength(MAX_QUERIES);
  });

  it('drops duplicates case-insensitively', () => {
    const plan = parsePlan(
      JSON.stringify({ intent: 'x', queries: [{ q: 'Pandas Drop' }, { q: 'pandas drop' }, { q: 'other' }] }),
    );
    expect(plan?.queries.map((q) => q.q)).toEqual(['Pandas Drop', 'other']);
  });

  it('drops absurdly long queries', () => {
    const plan = parsePlan(JSON.stringify({ intent: 'x', queries: [{ q: 'y'.repeat(200) }] }));
    expect(plan).toBeNull();
  });

  it('keeps entities as strings only', () => {
    const plan = parsePlan(JSON.stringify({ intent: 'x', entities: ['a', 2, null, 'b'], queries: [{ q: 'q' }] }));
    expect(plan?.entities).toEqual(['a', 'b']);
  });

  it('falls back to the first query when intent is missing', () => {
    const plan = parsePlan(JSON.stringify({ queries: [{ q: 'deepseek api' }] }));
    expect(plan?.intent).toBe('deepseek api');
  });
});

describe('buildPlannerMessages', () => {
  it('asks for closed-set JSON and safe practices', () => {
    const [system, user] = buildPlannerMessages('  DeepSeek 模型下载  ');
    expect(system?.content).toContain('只输出 JSON');
    expect(system?.content).toContain('site:huggingface.co');
    expect(user?.content).toBe('DeepSeek 模型下载');
  });
});
