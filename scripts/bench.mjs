#!/usr/bin/env node
/**
 * Quality benchmark for the local re-ranking layer.
 *
 *   DEEPSEEK_API_KEY=sk-... node scripts/bench.mjs [--count 20]
 *
 * Runs a fixed query set once (one paid request each — the "before" and "after"
 * views come from the SAME response, so the comparison itself costs nothing
 * extra), then reports what `rankResults()` changed in the first ten hits.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const COUNT = Number(process.argv[process.argv.indexOf('--count') + 1]) || 20;

const QUERIES = [
  ['口语长句', '怎么用 Python 把 Excel 里的重复行删掉'],
  ['口语长句', '为什么我的电池冬天掉电特别快'],
  ['口语长句', '外贸客户开发信怎么写才不会被拉黑'],
  ['商业长尾', '外贸 获客 自动化'],
  ['商业长尾', '铅酸电池 回收 设备 厂家'],
  ['技术', 'postgres jsonb 索引 怎么建'],
  ['技术', 'rust tokio 任务取消 最佳实践'],
  ['事实', 'DeepSeek V4 发布时间'],
  ['事实', '欧盟 电池护照 要求'],
  ['对比', 'searxng 和 whoogle 区别'],
];

const KEY = process.env.DEEPSEEK_API_KEY;
if (!KEY) {
  console.error('need DEEPSEEK_API_KEY');
  process.exit(1);
}

// Bundle the TS module once so the script stays runnable without a build step.
const dir = mkdtempSync(join(tmpdir(), 'sift-bench-'));
const bundle = join(dir, 'rank.mjs');
execFileSync(
  join(process.cwd(), 'node_modules/.bin/esbuild'),
  ['src/core/rank.ts', '--bundle', '--format=esm', '--platform=node', `--outfile=${bundle}`],
  { stdio: 'ignore' },
);
const { rankResults, hostnameOf } = await import(bundle);

const median = (xs) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const metrics = (results) => {
  const top = results.slice(0, 10);
  const hosts = top.map((r) => hostnameOf(r.url));
  const counts = new Map();
  for (const h of hosts) counts.set(h, (counts.get(h) ?? 0) + 1);
  return {
    uniqueHosts: new Set(hosts).size,
    maxSameHost: Math.max(0, ...counts.values()),
    medRerank: median(top.map((r) => r.rerank_score ?? 0)),
  };
};

const rows = [];
let beforeSum = { uniqueHosts: 0, maxSameHost: 0, medRerank: 0 };
let afterSum = { uniqueHosts: 0, maxSameHost: 0, medRerank: 0 };
let removedTotal = 0;

for (const [category, query] of QUERIES) {
  const res = await fetch('https://api.deepseek.com/v1/tools/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ query, count: COUNT }),
  });
  if (!res.ok) {
    rows.push({ category, query, error: `HTTP ${res.status}` });
    continue;
  }
  const data = await res.json();
  const raw = data.results ?? [];
  const { results: ranked, stats } = rankResults(raw);
  const before = metrics(raw);
  const after = metrics(ranked);
  const removed = stats.blocklisted + stats.duplicateUrl + stats.duplicateTitle;
  removedTotal += removed;
  for (const k of Object.keys(beforeSum)) {
    beforeSum[k] += before[k];
    afterSum[k] += after[k];
  }
  rows.push({ category, query, before, after, removed, demoted: stats.demoted, raws: raw.length });
  process.stdout.write('.');
}
console.log('\n');

const pad = (s, n) => String(s).padEnd(n);
const num = (x, d = 1) => Number(x).toFixed(d);

console.log(pad('类别', 10) + pad('查询', 34) + pad('唯一域', 12) + pad('同域最多', 12) + pad('中位分', 14) + '去重');
console.log('-'.repeat(96));
for (const r of rows) {
  if (r.error) {
    console.log(pad(r.category, 10) + pad(r.query.slice(0, 16), 34) + r.error);
    continue;
  }
  const hostCell = `${r.before.uniqueHosts}→${r.after.uniqueHosts}`;
  const dupCell = `${r.before.maxSameHost}→${r.after.maxSameHost}`;
  const scoreCell = `${num(r.before.medRerank, 2)}→${num(r.after.medRerank, 2)}`;
  console.log(
    pad(r.category, 10) +
      pad(r.query.length > 16 ? `${r.query.slice(0, 15)}…` : r.query, 34) +
      pad(hostCell, 12) +
      pad(dupCell, 12) +
      pad(scoreCell, 14) +
      `${r.removed}`,
  );
}

const n = rows.filter((r) => !r.error).length || 1;
console.log('-'.repeat(96));
console.log(
  `平均：唯一域 ${num(beforeSum.uniqueHosts / n)} → ${num(afterSum.uniqueHosts / n)} · ` +
    `同域最多 ${num(beforeSum.maxSameHost / n)} → ${num(afterSum.maxSameHost / n)} · ` +
    `中位分 ${num(beforeSum.medRerank / n, 2)} → ${num(afterSum.medRerank / n, 2)}`,
);
console.log(`共去掉重复/屏蔽 ${removedTotal} 条（${QUERIES.length} 次请求，约 ¥${(QUERIES.length * 0.005).toFixed(3)}）`);

rmSync(dir, { recursive: true, force: true });
