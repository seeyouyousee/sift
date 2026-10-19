#!/usr/bin/env node
/**
 * Quality benchmark for the local dedupe step.
 *
 *   DEEPSEEK_API_KEY=sk-... node scripts/bench.mjs [--count 20]
 *
 * One paid request per query; the "before" and "after" views come from the same
 * response, so measuring costs nothing beyond the searches themselves.
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

const dir = mkdtempSync(join(tmpdir(), 'sift-bench-'));
const bundle = join(dir, 'dedupe.mjs');
execFileSync(
  join(process.cwd(), 'node_modules/.bin/esbuild'),
  ['src/core/dedupe.ts', '--bundle', '--format=esm', '--platform=node', `--outfile=${bundle}`],
  { stdio: 'ignore' },
);
const { dedupeResults, hostnameOf } = await import(bundle);

const top10 = (results) => {
  const top = results.slice(0, 10);
  const hosts = top.map((r) => hostnameOf(r.url));
  return { n: results.length, uniqueHosts: new Set(hosts).size };
};

const rows = [];
let removedTotal = 0;
let beforeHosts = 0;
let afterHosts = 0;

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
  const raw = (await res.json()).results ?? [];
  const { results, stats } = dedupeResults(raw);
  const removed = stats.blocklisted + stats.duplicateUrl + stats.duplicateTitle;
  removedTotal += removed;
  const before = top10(raw);
  const after = top10(results);
  beforeHosts += before.uniqueHosts;
  afterHosts += after.uniqueHosts;
  rows.push({ category, query, before, after, removed });
  process.stdout.write('.');
}
console.log('\n');

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('类别', 10) + pad('查询', 36) + pad('条数', 12) + pad('前十唯一域', 12) + '去重');
console.log('-'.repeat(84));
for (const r of rows) {
  if (r.error) {
    console.log(pad(r.category, 10) + pad(r.query.slice(0, 18), 36) + r.error);
    continue;
  }
  const label = r.query.length > 18 ? `${r.query.slice(0, 17)}…` : r.query;
  console.log(
    pad(r.category, 10) +
      pad(label, 36) +
      pad(`${r.before.n}→${r.after.n}`, 12) +
      pad(`${r.before.uniqueHosts}→${r.after.uniqueHosts}`, 12) +
      r.removed,
  );
}

const ok = rows.filter((r) => !r.error).length || 1;
console.log('-'.repeat(84));
console.log(
  `平均：前十唯一域 ${(beforeHosts / ok).toFixed(1)} → ${(afterHosts / ok).toFixed(1)} · ` +
    `共合并 ${removedTotal} 条（${QUERIES.length} 次请求，约 ¥${(QUERIES.length * 0.005).toFixed(3)}）`,
);

rmSync(dir, { recursive: true, force: true });
