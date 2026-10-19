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
    calls.push({ url: String(url), body });

    const json = (payload, status = 200) =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

    if (String(url).includes('/tools/fetch')) {
      return json({ title: 'Fetched page', content: '# 正文\n\n这是抓取到的正文。' });
    }
    if (String(body.query ?? '').includes('FAIL401')) {
      return json({ error: { message: 'Authentication Fails (test)' } }, 401);
    }

    const query = String(body.query ?? '');

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
  await waitFor(cdp.evaluate, `document.querySelectorAll('.col').length === 4`, 8000, 'four compare columns');
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
