#!/usr/bin/env node
/**
 * End-to-end smoke test, driven over the Chrome DevTools Protocol.
 *
 *   node e2e/run.mjs           # offline: window.fetch is stubbed, no money spent
 *   node e2e/run.mjs --live    # one real search; needs DEEPSEEK_API_KEY
 *
 * Why not Playwright: it is a ~250 MB dependency for eight assertions. Driving
 * a stock Chrome over CDP keeps the project dependency-free while still testing
 * the real bundle in a real browser.
 */
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = new Set(process.argv.slice(2));
const LIVE = args.has('--live');
const PORT = 8848;
const BASE = `http://127.0.0.1:${PORT}/`;

/**
 * A fixed debugging port is a trap: a crashed earlier run keeps Chrome alive,
 * the next run silently attaches to *that* browser (with its old profile and
 * its old localStorage), and the test starts failing in inexplicable ways.
 */
function pickPort() {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once('error', () => resolve(pickPort()));
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/home/yibo/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) if (existsSync(candidate)) return candidate;
  throw new Error('no Chrome found; set CHROME_PATH');
}

async function waitForPort(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error(`server did not start at ${url}`);
}

/* ---------------------------------------------------------------- */
/* CDP plumbing                                                      */
/* ---------------------------------------------------------------- */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let nextId = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) {
      events.push(msg);
    }
  };

  const send = (method, params = {}) => {
    const id = ++nextId;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve) => pending.set(id, resolve));
  };

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.result?.exceptionDetails) {
      throw new Error(`page threw: ${res.result.exceptionDetails.exception?.description ?? 'unknown'}`);
    }
    return res.result?.result?.value;
  };

  return { ws, send, evaluate, events };
}

/**
 * An evaluate issued while a navigation is in flight can land in a destroyed
 * context and never settle. Race it so the poll loop always makes progress.
 */
async function waitFor(evaluate, expression, timeoutMs = 8000, label = expression) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const verdict = await Promise.race([
        evaluate(expression),
        sleep(1200).then(() => {
          throw new Error('evaluate stalled (navigation in progress)');
        }),
      ]);
      if (verdict) return;
    } catch {
      /* retry */
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

/* ---------------------------------------------------------------- */
/* fetch stub (offline mode)                                         */
/* ---------------------------------------------------------------- */
const STUB = () => {
  const calls = [];
  window.__calls = calls;
  window.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : {};
    const target = String(url);
    if (target.includes('/v1/tools/')) calls.push({ url: target, body });

    const json = (payload, status = 200) =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

    if (target.includes('/chat/completions')) {
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const system = String(messages[0]?.content ?? '');
      if (system.includes('搜索规划器')) {
        return json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  intent: '找到 DeepSeek 模型的官方下载地址',
                  action: 'repos',
                  entities: ['DeepSeek'],
                  queries: [
                    { q: 'DeepSeek 模型 site:huggingface.co', why: '官方仓库' },
                    { q: 'DeepSeek 模型 site:modelscope.cn', why: '国内镜像' },
                  ],
                }),
              },
            },
          ],
        });
      }
      const encoder = new TextEncoder();
      const chunk = (text) =>
        encoder.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] }) + '\n\n');
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(chunk('根据资料，可以用 drop_duplicates 去重 [1]，'));
          controller.enqueue(chunk('也可以用 openpyxl 逐行写入 [2]。'));
          controller.enqueue(
            encoder.encode(
              'data: ' +
                JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 30 } }) +
                '\n\n',
            ),
          );
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }

    if (String(url).includes('/tools/fetch')) {
      if (String(body.url ?? '').includes('failfetch')) {
        return json({ error: { message: 'failed to fetch URL' } }, 404);
      }
      return json({ title: 'Fetched page', content: '# 正文\n\n这是抓取到的正文。' });
    }
    if (String(body.query ?? '').includes('FAIL401')) {
      return json({ error: { message: 'Authentication Fails (test)' } }, 401);
    }

    const query = String(body.query ?? '');

    if (query.includes('site:huggingface.co')) {
      const repo = (url) => ({
        title: url.split('/').slice(-2).join('/'),
        url,
        snippet: 's',
        summary: 's',
        content: '',
        site_name: 'Hugging Face',
        site_icon: null,
        date: '2026-10-01T00:00:00+00:00',
        authority: 3,
        rerank_score: 2,
      });
      return json({
        results: [
          repo('https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017'),
          repo('https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017/discussions/12'),
          repo('https://modelscope.cn/models/deepseek-ai/DeepSeek-V4.1-Flash-1017'),
          repo('https://huggingface.co/blog/COPU2004/second-review-of-deepseek'),
        ],
      });
    }

    if (query.includes('FAILFETCH')) {
      return json({
        results: Array.from({ length: 2 }, (_, i) => ({
          title: `抓取失败样例 ${i + 1}`,
          url: `https://failfetch.example.com/${i + 1}`,
          snippet: 's',
          summary: 's',
          content: '',
          site_name: 'Blocked',
          site_icon: null,
          date: '2026-10-01T00:00:00+00:00',
          authority: 2,
          rerank_score: 2,
        })),
      });
    }

    // Three locale clones of one page + two distinct pages: exercises dedupe.
    if (query.includes('DUPTEST')) {
      const clone = (path, title) => ({
        title,
        url: `https://farm.example.com${path}`,
        snippet: 's',
        summary: 's',
        content: '',
        site_name: 'Farm',
        site_icon: null,
        date: '2026-10-01T00:00:00+00:00',
        authority: 2,
        rerank_score: 2,
      });
      return json({
        results: [
          clone('/zh-cn/page', '删除重复行的三种方法'),
          clone('/ko/page', '중복 행 삭제'),
          clone('/page', 'Delete duplicate rows'),
          { ...clone('/other', '另一个页面'), url: 'https://other.example.com/other' },
          { ...clone('/x', '第三个页面'), url: 'https://third.example.com/x' },
        ],
      });
    }
    const results = Array.from({ length: Number(body.count) || 10 }, (_, i) => ({
      title: `结果 ${i + 1} · ${query}`,
      url: `https://d${i + 1}.example.com/p${i + 1}`,
      snippet: `摘要 ${i + 1}：关于 ${query} 的短摘要`,
      summary: `长摘要 ${i + 1}：这是关于 ${query} 的较长摘要，用于验证渲染。`,
      content: '',
      site_name: 'Example',
      site_icon: null,
      date: '2026-10-0' + ((i % 9) + 1),
      authority: i % 5,
      rerank_score: 2.5,
    }));
    return json({ results });
  };
};

/* ---------------------------------------------------------------- */
/* main                                                              */
/* ---------------------------------------------------------------- */
const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const server = spawn(process.execPath, ['scripts/serve.mjs', 'dist', String(PORT)], { stdio: 'ignore' });
const profile = mkdtempSync(join(tmpdir(), 'sift-e2e-'));
let chrome;
let cdp;

try {
  await waitForPort(BASE);

  const DEBUG_PORT = await pickPort();
  chrome = spawn(
    findChrome(),
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--hide-scrollbars',
      '--window-size=1280,1600',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    // detached: killed as a process group, so renderer children do not survive.
    { stdio: 'ignore', detached: true },
  );

  let wsUrl;
  const deadline = Date.now() + 20_000;
  while (!wsUrl && Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
    } catch {
      /* starting */
    }
    if (!wsUrl) await sleep(150);
  }
  if (!wsUrl) throw new Error('Chrome did not expose a debugging target');

  cdp = await connect(wsUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');

  if (!LIVE) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${STUB.toString()})()` });

  // --- first visit: the key gate --------------------------------------
  await cdp.send('Page.navigate', { url: BASE });
  await sleep(400);
  const gateVisible = await waitFor(cdp.evaluate, `!!document.querySelector('#gate') && !document.querySelector('#gate').hidden`, 8000, 'gate')
    .then(() => true)
    .catch(() => false);
  record('首次访问显示 Key 输入框', gateVisible);
  record('无 Key 时搜索框禁用', (await cdp.evaluate(`document.querySelector('#q')?.disabled === true`)) === true);

  if (LIVE) {
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key) throw new Error('--live needs DEEPSEEK_API_KEY');
    await cdp.evaluate(
      `localStorage.setItem('sift.key', JSON.stringify({ v: 1, d: ${JSON.stringify(key)} }))`,
    );
  } else {
    await cdp.evaluate(`localStorage.setItem('sift.key', JSON.stringify({ v: 1, d: 'sk-e2e-fake-key' }))`);
  }

  await cdp.send('Page.navigate', { url: BASE });
  await sleep(400);
  const gateGone = await waitFor(cdp.evaluate, `document.querySelector('#gate')?.hidden === true`, 8000, 'gate hidden')
    .then(() => true)
    .catch(() => false);
  record('填入 Key 后门消失', gateGone);
  record(
    '抽屉默认不可见（[hidden] 真正生效）',
    (await cdp.evaluate(`getComputedStyle(document.querySelector('#drawer')).display`)) === 'none',
  );
  record('筛选栏可见', (await cdp.evaluate(`!document.querySelector('#filters').hidden`)) === true);

  // --- search ---------------------------------------------------------
  await cdp.evaluate(`
    (() => {
      const q = document.querySelector('#q');
      q.value = 'deepseek 搜索';
      q.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#search-form').requestSubmit();
    })()
  `);
  await waitFor(cdp.evaluate, `document.querySelectorAll('.result').length > 0`, 8000, 'results to render');

  const rowCount = await cdp.evaluate(`document.querySelectorAll('.result').length`);
  record('结果渲染 10 条/页', rowCount === 10, `rows=${rowCount}`);
  const statusText = (await cdp.evaluate(`document.querySelector('#status').innerText`)).replace(/\s+/g, ' ');
  // Local re-ranking removes duplicates, so the count can be slightly under 50.
  record(
    '状态栏显示总数与分页',
    /\d+ 条结果/.test(statusText) && /共 \d+ 页/.test(statusText),
    statusText,
  );
  record('关键词高亮生效', (await cdp.evaluate(`document.querySelectorAll('mark').length`)) > 0);
  record('标题不可信内容被转义', (await cdp.evaluate(`document.querySelectorAll('.result-title script').length`)) === 0);

  const callsAfterFirst = await cdp.evaluate(`window.__calls ? window.__calls.length : null`);
  if (!LIVE) record('一次搜索只打一次上游', callsAfterFirst === 1, `calls=${callsAfterFirst}`);

  // --- AI answer ------------------------------------------------------
  const answerReady = LIVE
    ? `document.querySelector('#answer-body')?.innerText.trim().length > 12`
    : `/drop_duplicates/.test(document.querySelector('#answer-body').innerText)`;
  await waitFor(cdp.evaluate, answerReady, LIVE ? 30000 : 8000, 'answer text');
  const answerText = await cdp.evaluate(`document.querySelector('#answer-body').innerText`);
  record('AI 摘要渲染出答案', answerText.trim().length > 12, answerText.slice(0, 40).replace(/\s+/g, ' '));
  record(
    '摘要标注 AI 生成身份',
    (await cdp.evaluate(`document.querySelector('.answer-badge')?.innerText`)) === 'AI 摘要',
  );
  if (!LIVE) {
    record('引用编号变成可点击来源', (await cdp.evaluate(`document.querySelectorAll('#answer-body .cite').length`)) === 2);
    record('来源 chips 只保留被引用项', (await cdp.evaluate(`document.querySelectorAll('#answer-foot .cite-chip').length`)) === 2);
  }

  // --- pagination is local -------------------------------------------
  const firstTitlePage1 = await cdp.evaluate(`document.querySelector('.result-title').innerText`);
  await cdp.evaluate(
    `[...document.querySelectorAll('#pager .btn.page')].find((b) => b.textContent.trim() === '2').click()`,
  );
  await sleep(250);
  const firstTitlePage2 = await cdp.evaluate(`document.querySelector('.result-title').innerText`);
  record('翻页改变结果', firstTitlePage1 !== firstTitlePage2);
  if (!LIVE) {
    const callsAfterPaging = await cdp.evaluate(`window.__calls.length`);
    record('翻页不再请求上游', callsAfterPaging === callsAfterFirst, `calls=${callsAfterPaging}`);
  }

  // --- cache hit on repeat -------------------------------------------
  await cdp.evaluate(`document.querySelector('#search-form').requestSubmit()`);
  await waitFor(cdp.evaluate, `document.querySelector('#status').innerText.includes('缓存命中')`, 5000, 'cache hit label');
  record('重复搜索命中缓存', true);
  if (!LIVE) {
    const callsAfterRepeat = await cdp.evaluate(`window.__calls.length`);
    record('缓存命中不发请求', callsAfterRepeat === callsAfterFirst, `calls=${callsAfterRepeat}`);
  }

  // --- local re-rank / dedupe (fixture: needs the stub) -----------------
  if (!LIVE) {
  await cdp.evaluate(`
    (() => {
      const q = document.querySelector('#q');
      q.value = 'DUPTEST';
      document.querySelector('#search-form').requestSubmit();
    })()
  `);
  await waitFor(cdp.evaluate, `/合并重复/.test(document.querySelector('#status').innerText)`, 6000, 'dedupe note');
  const dedupedRows = await cdp.evaluate(`document.querySelectorAll('#results .result').length`);
  record('同页多语言克隆被合并', dedupedRows === 3, `rows=${dedupedRows}`);
  record(
    '状态栏如实显示合并条数',
    /合并重复 2/.test((await cdp.evaluate(`document.querySelector('#status').innerText`)).replace(/\s+/g, ' ')),
    (await cdp.evaluate(`document.querySelector('#status').innerText`)).replace(/\s+/g, ' '),
  );
  }

  // --- official sources (download intent) ------------------------------
  await cdp.evaluate(`
    (() => {
      const q = document.querySelector('#q');
      q.value = 'DeepSeek 模型下载';
      document.querySelector('#search-form').requestSubmit();
    })()
  `);
  await waitFor(cdp.evaluate, `!document.querySelector('#official').hidden`, 10000, 'official strip');
  const officialChips = await cdp.evaluate(
    `[...document.querySelectorAll('#official .official-chip')].map((a) => a.getAttribute('href'))`,
  );
  record(
    '下载意图触发官方源召回',
    LIVE ? officialChips.length >= 1 : officialChips.length === 2,
    officialChips.map((u) => u.split('/').slice(-2).join('/')).join(' | ') || '(none)',
  );
  const repoRoot = /^https:\/\/(huggingface\.co\/[^/]+\/[^/]+|modelscope\.cn\/models\/[^/]+\/[^/]+)$/;
  record('把深链归一到仓库根', officialChips.length > 0 && officialChips.every((u) => repoRoot.test(u)));
  record(
    '过滤掉 blog/datasets 等非仓库页',
    officialChips.every((u) => !u.includes('/blog/')),
  );

  // --- smart retrieval (plan → collect → repos) -------------------------
  await cdp.evaluate(`
    (() => {
      document.querySelector('#q').value = '';
      document.querySelector('#btn-settings').click();
      const select = document.querySelector('#set-smart');
      select.value = 'on';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#drawer-close').click();
    })()
  `);
  await sleep(300);
  await cdp.evaluate(`
    (() => {
      const q = document.querySelector('#q');
      q.value = 'DeepSeek 模型下载';
      document.querySelector('#search-form').requestSubmit();
    })()
  `);
  await waitFor(cdp.evaluate, `!document.querySelector('#plan').hidden`, 12000, 'plan strip');
  const intentText = await cdp.evaluate(`document.querySelector('#plan-intent').textContent`);
  record('意图规划显示出来', intentText.trim().length > 3, intentText.trim().slice(0, 60));
  record(
    '规划出的检索式逐条可见',
    (await cdp.evaluate(`document.querySelectorAll('#plan .plan-q').length`)) === 2,
  );
  record(
    '链接型意图跳过 AI 摘要',
    (await cdp.evaluate(`document.querySelector('#answer').hidden`)) === true,
  );
  await waitFor(
    cdp.evaluate,
    `document.querySelector('#status').innerText.includes('链接型') || document.querySelectorAll('#results .result').length > 0`,
    20000,
    'smart run settled',
  );
  record(
    '规划结果为仓库页合并去重',
    (await cdp.evaluate(`document.querySelectorAll('#results .result').length`)) >= 2,
  );
  record(
    '状态栏标明链接型与路数',
    /链接型 · 2 路/.test((await cdp.evaluate(`document.querySelector('#status').innerText`)).replace(/\s+/g, ' ')),
  );
  await cdp.evaluate(`
    (() => {
      document.querySelector('#btn-settings').click();
      const select = document.querySelector('#set-smart');
      select.value = 'off';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#drawer-close').click();
    })()
  `);
  await sleep(300);

  // --- compare mode ---------------------------------------------------
  // Back to the normal query: DUPTEST is a fixed 5-result fixture, not a
  // realistic four-column input.
  await cdp.evaluate(`
    (() => {
      const q = document.querySelector('#q');
      q.value = 'deepseek 搜索';
      document.querySelector('#search-form').requestSubmit();
    })()
  `);
  await waitFor(cdp.evaluate, `document.querySelectorAll('#results .result').length === 10`, 6000, 'restore query');
  await cdp.evaluate(`document.querySelector('.seg[data-mode="compare"]').click()`);
  await waitFor(
    cdp.evaluate,
    `document.querySelectorAll('.col').length === 4 && !document.querySelector('#status').innerText.includes('查询中')`,
    20000,
    'four compare columns settled',
  );
  const colLabels = await cdp.evaluate(
    `[...document.querySelectorAll('.col-head .col-label')].map((n) => n.innerText).join(' / ')`,
  );
  record('对比模式渲染 4 栏', (await cdp.evaluate(`document.querySelectorAll('.col').length`)) === 4, colLabels);
  record(
    '对比模式下分页隐藏',
    (await cdp.evaluate(`getComputedStyle(document.querySelector('#pager')).display`)) === 'none',
  );
  if (!LIVE) {
    record(
      '每栏都有结果',
      (await cdp.evaluate(`document.querySelectorAll('.col-body .result').length`)) === 40,
      `rows=${await cdp.evaluate(`document.querySelectorAll('.col-body .result').length`)}`,
    );
    record(
      '状态栏按请求次数计费',
      /4 次请求/.test((await cdp.evaluate(`document.querySelector('#status').innerText`)).replace(/\s+/g, ' ')),
      (await cdp.evaluate(`document.querySelector('#status').innerText`)).replace(/\s+/g, ' '),
    );
  }
  await cdp.evaluate(`document.querySelector('.seg[data-mode="single"]').click()`);
  await waitFor(
    cdp.evaluate,
    `document.querySelector('#compare').hidden === true && document.querySelectorAll('#results .result').length > 0`,
    8000,
    'back to single mode',
  );
  record('切回单栏恢复结果列表', (await cdp.evaluate(`document.querySelectorAll('#results .result').length`)) === 10);

  // --- read panel -----------------------------------------------------
  // Some real pages cannot be extracted (404/403/no markdown), so try a few
  // results before calling it a failure.
  let panelOpened = false;
  for (let attempt = 0; attempt < 3 && !panelOpened; attempt++) {
    const clicked = await cdp.evaluate(`
      (() => {
        const rows = [...document.querySelectorAll('#results .result')];
        const btn = rows[${attempt}]?.querySelector('.link-btn');
        if (!btn) return false;
        btn.click();
        return true;
      })()
    `);
    if (!clicked) break;
    panelOpened = await waitFor(cdp.evaluate, `!!document.querySelector('.read-panel')`, LIVE ? 15000 : 5000, 'read panel')
      .then(() => true)
      .catch(() => false);
  }
  record('阅读正文面板可展开', panelOpened);
  if (!LIVE) {
    record(
      '正文请求打到 fetch 端点',
      await cdp.evaluate(`window.__calls.some((c) => c.url.includes('/tools/fetch'))`),
    );
  }

  // --- unreadable page: inline error, not a silent toast ------------------
  if (!LIVE) {
    await cdp.evaluate(`
      (() => {
        const q = document.querySelector('#q');
        q.value = 'FAILFETCH';
        document.querySelector('#search-form').requestSubmit();
      })()
    `);
    await waitFor(cdp.evaluate, `document.querySelectorAll('#results .result').length === 2`, 8000, 'fetch fixture');
    await cdp.evaluate(`document.querySelector('#results .result .link-btn').click()`);
    await waitFor(cdp.evaluate, `!!document.querySelector('.read-panel.read-error')`, 8000, 'read error panel');
    record(
      '抓不到正文时行内给出原因',
      /在新标签打开原链接/.test(await cdp.evaluate(`document.querySelector('.read-panel.read-error').innerText`)),
    );
  }

  // --- error mapping (needs the stub: a live search never returns 401) ---
  if (!LIVE) {
    await cdp.evaluate(`
      (() => {
        const q = document.querySelector('#q');
        q.value = 'FAIL401';
        document.querySelector('#search-form').requestSubmit();
      })()
    `);
    await waitFor(cdp.evaluate, `document.querySelector('#status').className.includes('error')`, 6000, '401 error state');
    record(
      '401 映射为可操作提示',
      /API Key 无效/.test(await cdp.evaluate(`document.querySelector('#status').innerText`)),
      await cdp.evaluate(`document.querySelector('#status').innerText`).then((t) => t.split('\n')[0]),
    );
  }

  // --- theme ----------------------------------------------------------
  await cdp.evaluate(`document.querySelector('#btn-settings').click()`);
  await sleep(150);
  await cdp.evaluate(`
    (() => {
      const select = document.querySelector('#set-theme');
      select.value = 'light';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  await sleep(150);
  record('主题切换写入 html[data-theme]', (await cdp.evaluate(`document.documentElement.dataset.theme`)) === 'light');
  await cdp.evaluate(`document.querySelector('#drawer-close').click()`);

  // --- console hygiene ------------------------------------------------
  const consoleErrors = cdp.events
    .filter((e) => e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error')
    .map((e) => e.params.entry.text)
    // 4xx/5xx responses are reported as "Failed to load resource"; a page that
    // cannot be fetched for reading (HTTP 404 from /v1/tools/fetch) is expected
    // behaviour, not an app error. Only genuine JS errors fail this check.
    .filter((text) => !/favicon/i.test(text) && !/Failed to load resource/i.test(text));
  record('无 console 错误', consoleErrors.length === 0, consoleErrors.join(' | '));

  // --- screenshot -----------------------------------------------------
  await cdp.evaluate(`window.scrollTo(0, 0)`);
  await sleep(200);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync('e2e/last-run.png', Buffer.from(shot.result.data, 'base64'));
} finally {
  try {
    cdp?.ws.close();
  } catch {
    /* ignore */
  }
  try {
    if (chrome?.pid) process.kill(-chrome.pid, 'SIGKILL');
  } catch {
    chrome?.kill('SIGKILL');
  }
  server.kill();
  // Chrome flushes its profile on exit; deleting too early throws ENOTEMPTY.
  await sleep(300);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${LIVE ? ' (live)' : ' (offline stub)'}`);
process.exit(failed.length === 0 ? 0 : 1);
