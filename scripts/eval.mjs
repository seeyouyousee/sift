#!/usr/bin/env node
/**
 * A/B evaluation: single-pass retrieval vs planned retrieval.
 *
 *   DEEPSEEK_API_KEY=sk-... node scripts/eval.mjs
 *
 * Each question is answered twice; a judge sees both answers without knowing
 * which is which. That is the only way to decide whether the extra planner call
 * earns its cost — and the reason the re-ranker was deleted when it did not.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KEY = process.env.DEEPSEEK_API_KEY;
if (!KEY) {
  console.error('need DEEPSEEK_API_KEY');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'sift-eval-'));
const bundle = (entry, out) => {
  execFileSync('node_modules/.bin/esbuild', [entry, '--bundle', '--format=esm', '--platform=node', `--outfile=${join(dir, out)}`], { stdio: 'ignore' });
  return join(dir, out);
};
const { buildMessages, citationIndexes, completeChat } = await import(bundle('src/core/answer.ts', 'answer.mjs'));
const { buildPlannerMessages, parsePlan } = await import(bundle('src/core/planner.ts', 'planner.mjs'));
const { collectEvidence } = await import(bundle('src/core/agent.ts', 'agent.mjs'));
const { extractOfficialSources } = await import(bundle('src/core/source.ts', 'source.mjs'));

const QUESTIONS = [
  ['技术', 'python 怎么删除 excel 里的重复行'],
  ['技术', 'postgres jsonb 字段怎么建 GIN 索引'],
  ['技术', 'rust tokio 里怎么优雅地取消一个任务'],
  ['事实', 'DeepSeek 搜索 API 什么时候上线 怎么收费'],
  ['事实', '欧盟电池护照 2027 年要求什么'],
  ['事实', 'DeepSeek V4.1-Flash-1017 是什么时候发布的'],
  ['下载', 'DeepSeek 模型下载'],
  ['下载', 'DeepSeek-V3.2 权重在哪下'],
  ['下载', 'DeepSeek R1 模型 huggingface 地址'],
  ['对比', 'searxng 和 whoogle 有什么区别'],
  ['对比', 'pandas 和 polars 哪个快'],
  ['长尾', '铅酸电池回收设备有哪些厂家'],
];

const search = async (q, count = 8) => {
  const r = await fetch('https://api.deepseek.com/v1/tools/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ query: q, count }),
  });
  if (!r.ok) return [];
  return (await r.json()).results ?? [];
};

const answerWith = async (question, results) => {
  if (results.length === 0) return '（没有检索到结果）';
  const { text } = await completeChat({
    endpoint: 'https://api.deepseek.com/chat/completions',
    apiKey: KEY,
    model: 'deepseek-chat',
    messages: buildMessages(question, results, 8),
    maxTokens: 400,
  });
  return text.trim();
};

const plan = async (question) => {
  const { text } = await completeChat({
    endpoint: 'https://api.deepseek.com/chat/completions',
    apiKey: KEY,
    model: 'deepseek-chat',
    messages: buildPlannerMessages(question),
    maxTokens: 400,
  });
  return parsePlan(text);
};

const JUDGE = `你是严格的评审。给定问题和两个回答（A、B），判断哪个更有用。
只输出 JSON：{"winner":"A|B|tie","reason":"一句话"}
标准：是否直接回答问题 > 关键事实是否正确 > 是否有可核验的来源编号 > 是否啰嗦。
两个都错或都空就输出 tie。`;

async function judge(question, a, b) {
  const { text } = await completeChat({
    endpoint: 'https://api.deepseek.com/chat/completions',
    apiKey: KEY,
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: JUDGE },
      { role: 'user', content: `问题：${question}\n\nA：\n${a}\n\nB：\n${b}` },
    ],
    maxTokens: 200,
  });
  try {
    return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch {
    return { winner: 'tie', reason: 'judge 输出无法解析' };
  }
}

const rows = [];
let smartWins = 0;
let baseWins = 0;
let ties = 0;

for (const [category, question] of QUESTIONS) {
  // baseline: one query, one answer
  const baseResults = await search(question, 8);
  const baseAnswer = await answerWith(question, baseResults);

  // smart: plan → collect → (repos | answer)
  const planResult = await plan(question);
  let smartAnswer = '';
  let planLabel = '(规划失败, 回退)';
  if (planResult) {
    const { evidence } = await collectEvidence(planResult, { search }, 8);
    planLabel = `${planResult.action} · ${planResult.queries.length} 路`;
    if (planResult.action === 'repos') {
      const repos = extractOfficialSources(evidence, 6);
      smartAnswer = repos.length
        ? `官方仓库链接：\n${repos.map((r) => `- ${r.url}`).join('\n')}`
        : await answerWith(question, evidence);
    } else {
      smartAnswer = await answerWith(question, evidence);
    }
  } else {
    smartAnswer = baseAnswer;
  }

  // anonymise order per question to cancel position bias
  const swap = rows.length % 2 === 1;
  const verdict = await judge(question, swap ? smartAnswer : baseAnswer, swap ? baseAnswer : smartAnswer);
  let winner = verdict.winner;
  if (swap) winner = winner === 'A' ? 'B' : winner === 'B' ? 'A' : 'tie';
  if (winner === 'A') baseWins++;
  else if (winner === 'B') smartWins++;
  else ties++;

  rows.push({ category, question, planLabel, winner, reason: verdict.reason, answer: smartAnswer });
  process.stdout.write('.');
}

console.log('\n');
const pad = (s, n) => String(s).padEnd(n);
console.log(pad('类别', 8) + pad('问题', 34) + pad('规划', 16) + pad('判定', 8) + '理由');
console.log('-'.repeat(104));
for (const r of rows) {
  const label = r.question.length > 16 ? `${r.question.slice(0, 15)}…` : r.question;
  const verdict = r.winner === 'A' ? '基线优' : r.winner === 'B' ? '智能优' : '平';
  console.log(pad(r.category, 8) + pad(label, 34) + pad(r.planLabel, 16) + pad(verdict, 8) + (r.reason ?? '').slice(0, 44));
}

console.log('-'.repeat(104));
const n = rows.length;
console.log(`智能优 ${smartWins} · 基线优 ${baseWins} · 平 ${ties}  （共 ${n} 题）`);

console.log('\n智能检索的答案抽样：');
for (const r of rows.filter((x) => x.planLabel.startsWith('repos')).slice(0, 2)) {
  console.log(`\n[${r.question}]\n${r.answer.slice(0, 300)}`);
}

rmSync(dir, { recursive: true, force: true });
