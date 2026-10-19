/**
 * Application controller.
 *
 * Owns the only mutable state in the app and the only DOM writes. The layering
 * below it (core/*) is pure and unit-tested; this file is intentionally the
 * thin, imperative part.
 */
import { CONFIG } from './config.js';
import { SearchApi } from './core/api.js';
import { TtlLru } from './core/cache.js';
import { SingleFlight } from './core/singleflight.js';
import { TokenBucket } from './core/limiter.js';
import { ApiError, toApiError, type FetchResponse, type SearchResponse, type SearchResult } from './core/types.js';
import {
  EMPTY_FILTERS,
  buildQuery,
  hasFilters,
  highlightTerms,
  type Filters,
  type TimePreset,
} from './core/query.js';
import { compareQueries, type ComparePreset } from './core/compare.js';
import { dedupeResults, type DedupeStats } from './core/dedupe.js';
import { AnswerError, buildMessages, citationIndexes, streamAnswer, type AnswerUsage } from './core/answer.js';
import {
  extractOfficialSources,
  hasDownloadIntent,
  hasSiteOperator,
  officialQuery,
  type OfficialSource,
} from './core/source.js';
import { fmtDate, fmtDuration, fmtMoney, hostOf } from './core/format.js';
import { escapeHtml, highlight } from './core/highlight.js';
import { detectBackend, JsonStore } from './core/storage.js';
import { clear, copyText, debounce, h, must } from './ui/dom.js';

type SummaryMode = 'summary' | 'snippet';
type ThemeMode = 'auto' | 'dark' | 'light';
type ResultMode = 'single' | 'compare';

interface ColumnState {
  preset: ComparePreset;
  query: string;
  results: SearchResult[];
  error: ApiError | null;
  cached: boolean;
  elapsed: number;
}

interface Settings {
  pageSize: number;
  summary: SummaryMode;
  theme: ThemeMode;
  endpoint: string;
  mode: ResultMode;
  dedupe: boolean;
  answer: boolean;
  answerModel: string;
}

interface SessionStats {
  searches: number;
  cacheHits: number;
  spend: number;
}

const DEFAULT_SETTINGS: Settings = {
  pageSize: CONFIG.defaultPageSize,
  summary: 'summary',
  theme: 'auto',
  endpoint: '',
  mode: 'single',
  dedupe: true,
  answer: true,
  answerModel: '',
};

/* ------------------------------------------------------------------ */
/* bootstrap                                                          */
/* ------------------------------------------------------------------ */

export function createApp(): void {
  const backend = detectBackend();
  const store = new JsonStore(CONFIG.storageNamespace, CONFIG.storageVersion, backend);

  const settings: Settings = { ...DEFAULT_SETTINGS, ...store.get<Partial<Settings>>('settings', {}) };
  const history = store.get<string[]>('history', []);

  const state = {
    key: store.get<string>('key', ''),
    query: '',
    /** The exact string sent upstream, with operators applied. */
    built: '',
    filters: { ...EMPTY_FILTERS } as Filters,
    results: [] as SearchResult[],
    page: 1,
    loading: false,
    elapsed: 0,
    cached: false,
    error: null as ApiError | null,
    mode: settings.mode,
    columns: [] as ColumnState[],
    dedupe: { blocklisted: 0, duplicateUrl: 0, duplicateTitle: 0 } as DedupeStats,
    official: [] as OfficialSource[],
    answer: {
      text: '',
      sources: [] as SearchResult[],
      citations: [] as number[],
      running: false,
      error: null as AnswerError | null,
      usage: null as AnswerUsage | null,
      elapsed: 0,
      visible: false,
    },
  };

  const stats: SessionStats = { searches: 0, cacheHits: 0, spend: 0 };
  const pageCache = new Map<string, FetchResponse>();
  const cache = new TtlLru<string, SearchResponse>({
    ttlMs: CONFIG.cacheTtlMs,
    maxEntries: CONFIG.cacheMaxEntries,
  });
  const flight = new SingleFlight();
  const bucket = new TokenBucket({ rate: CONFIG.qps });

  const buildApi = (): SearchApi =>
    new SearchApi({
      searchEndpoint: settings.endpoint || CONFIG.searchEndpoint,
      fetchEndpoint: CONFIG.fetchEndpoint,
      getKey: () => state.key,
      bucket,
      timeoutMs: CONFIG.requestTimeoutMs,
      retry: { attempts: CONFIG.retryAttempts, baseMs: CONFIG.retryBaseMs },
    });

  let api = buildApi();

  /* ---------------------------------------------------------------- */
  /* elements                                                          */
  /* ---------------------------------------------------------------- */
  const el = {
    q: must<HTMLInputElement>('#q'),
    form: must<HTMLFormElement>('#search-form'),
    go: must<HTMLButtonElement>('#go'),
    suggestions: must<HTMLUListElement>('#suggestions'),
    filters: must<HTMLDivElement>('#filters'),
    fSite: must<HTMLInputElement>('#f-site'),
    fExclude: must<HTMLInputElement>('#f-exclude'),
    fLang: must<HTMLSelectElement>('#f-lang'),
    fTime: must<HTMLSelectElement>('#f-time'),
    fNote: must<HTMLSpanElement>('#filters-note'),
    gate: must<HTMLElement>('#gate'),
    keyInput: must<HTMLInputElement>('#key-input'),
    keySave: must<HTMLButtonElement>('#key-save'),
    empty: must<HTMLElement>('#empty'),
    history: must<HTMLElement>('#history'),
    status: must<HTMLElement>('#status'),
    results: must<HTMLOListElement>('#results'),
    pager: must<HTMLElement>('#pager'),
    drawer: must<HTMLElement>('#drawer'),
    scrim: must<HTMLElement>('#scrim'),
    toast: must<HTMLElement>('#toast'),
    stats: must<HTMLElement>('#stats'),
    footStats: must<HTMLElement>('#foot-stats'),
    settingsBtn: must<HTMLButtonElement>('#btn-settings'),
    setPageSize: must<HTMLSelectElement>('#set-page-size'),
    setSummary: must<HTMLSelectElement>('#set-summary'),
    setTheme: must<HTMLSelectElement>('#set-theme'),
    setEndpoint: must<HTMLInputElement>('#set-endpoint'),
    setDedupe: must<HTMLSelectElement>('#set-dedupe'),
    compare: must<HTMLElement>('#compare'),
    modeSwitch: must<HTMLElement>('.mode-switch'),
    answer: must<HTMLElement>('#answer'),
    answerBody: must<HTMLElement>('#answer-body'),
    answerMeta: must<HTMLElement>('#answer-meta'),
    answerFoot: must<HTMLElement>('#answer-foot'),
    answerStop: must<HTMLButtonElement>('#answer-stop'),
    answerCopy: must<HTMLButtonElement>('#answer-copy'),
    answerHide: must<HTMLButtonElement>('#answer-hide'),
    setAnswer: must<HTMLSelectElement>('#set-answer'),
    setAnswerModel: must<HTMLInputElement>('#set-answer-model'),
    official: must<HTMLElement>('#official'),
    officialList: must<HTMLElement>('#official-list'),
  };

  /* ---------------------------------------------------------------- */
  /* toast                                                             */
  /* ---------------------------------------------------------------- */
  let toastTimer: number | undefined;
  function toast(message: string): void {
    el.toast.textContent = message;
    el.toast.classList.add('show');
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => el.toast.classList.remove('show'), 2200);
  }

  /* ---------------------------------------------------------------- */
  /* theme                                                             */
  /* ---------------------------------------------------------------- */
  const darkQuery = window.matchMedia?.('(prefers-color-scheme: dark)');

  function resolvedTheme(): 'dark' | 'light' {
    if (settings.theme !== 'auto') return settings.theme;
    return darkQuery?.matches ? 'dark' : 'light';
  }

  function applyTheme(): void {
    document.documentElement.dataset.theme = resolvedTheme();
  }

  darkQuery?.addEventListener?.('change', () => {
    if (settings.theme === 'auto') applyTheme();
  });

  /* ---------------------------------------------------------------- */
  /* persistence                                                       */
  /* ---------------------------------------------------------------- */
  const persistSettings = debounce(() => store.set('settings', settings), 200);

  function applyKey(key: string): void {
    state.key = key;
    el.gate.hidden = Boolean(key);
    el.q.disabled = !key;
    el.go.disabled = !key;
    el.filters.hidden = !key;
    if (key) window.setTimeout(() => el.q.focus(), 30);
  }

  function pushHistory(query: string): void {
    const next = [query, ...history.filter((q) => q !== query)].slice(0, 10);
    history.length = 0;
    history.push(...next);
    store.set('history', history);
    renderHistory();
  }

  /* ---------------------------------------------------------------- */
  /* URL                                                               */
  /* ---------------------------------------------------------------- */
  function syncUrl(): void {
    const url = new URL(window.location.href);
    if (state.query) url.searchParams.set('q', state.query);
    else url.searchParams.delete('q');
    const set = (k: string, v: string) => {
      if (v) url.searchParams.set(k, v);
      else url.searchParams.delete(k);
    };
    set('site', state.filters.site);
    set('exclude', state.filters.excludeSites);
    set('lang', state.filters.lang);
    set('time', state.filters.time === 'any' ? '' : state.filters.time);
    set('mode', state.mode === 'compare' ? 'compare' : '');
    window.history.replaceState(null, '', url);
  }

  function readUrl(): string {
    const params = new URLSearchParams(window.location.search);
    state.filters = {
      site: params.get('site') ?? '',
      excludeSites: params.get('exclude') ?? '',
      lang: params.get('lang') ?? '',
      time: (params.get('time') as TimePreset) ?? 'any',
    };
    const mode = params.get('mode');
    if (mode === 'compare' || mode === 'single') {
      state.mode = mode;
      settings.mode = mode;
    }
    syncFilterInputs();
    return params.get('q') ?? '';
  }

  function syncFilterInputs(): void {
    el.fSite.value = state.filters.site;
    el.fExclude.value = state.filters.excludeSites;
    el.fLang.value = state.filters.lang;
    el.fTime.value = state.filters.time;
    const active = hasFilters(state.filters);
    el.fNote.textContent = active ? '已附加筛选条件' : '';
    el.filters.classList.toggle('active', active);
  }

  /* ---------------------------------------------------------------- */
  /* status                                                            */
  /* ---------------------------------------------------------------- */
  /** Merge duplicate pages; a no-op when the user turned it off. */
  function applyDedupe(results: SearchResult[]): { results: SearchResult[]; dedupe: DedupeStats } {
    if (!settings.dedupe) {
      return { results, dedupe: { blocklisted: 0, duplicateUrl: 0, duplicateTitle: 0 } };
    }
    const outcome = dedupeResults(results, { blocklist: CONFIG.dedupeBlocklist });
    return { results: outcome.results, dedupe: outcome.stats };
  }

  function renderStatus(): void {
    if (state.loading) {
      el.status.className = 'status loading';
      el.status.innerHTML = '<span class="spinner" aria-hidden="true"></span>查询中…';
      return;
    }
    if (state.error) {
      const { title, hint } = describeError(state.error);
      el.status.className = 'status error';
      el.status.innerHTML = `<strong>${escapeHtml(title)}</strong><span class="hint">${escapeHtml(hint)}</span>`;
      return;
    }
    if (state.mode === 'compare') {
      if (state.columns.length === 0) {
        el.status.className = 'status';
        el.status.textContent = '';
        return;
      }
      const rows = state.columns.reduce((n, column) => n + column.results.length, 0);
      const paid = state.columns.filter((column) => !column.cached && !column.error).length;
      const failed = state.columns.filter((column) => column.error).length;
      el.status.className = 'status';
      el.status.innerHTML =
        `<span class="dot" aria-hidden="true"></span>${state.columns.length} 栏` +
        `<span class="sep">·</span>${rows} 条` +
        `<span class="sep">·</span>${fmtDuration(state.elapsed)}` +
        (paid > 0
          ? `<span class="sep">·</span>本次 ${fmtMoney(paid * CONFIG.pricePerSuccessfulSearch)}（${paid} 次请求）`
          : `<span class="sep">·</span><span class="ok">全部命中缓存，未计费</span>`) +
        (failed > 0 ? `<span class="sep">·</span><span class="err-count">${failed} 栏失败</span>` : '');
      return;
    }

    if (state.results.length === 0) {
      if (state.built) {
        el.status.className = 'status warn';
        el.status.innerHTML =
          '没有找到结果——换个说法，或去掉过窄的 <code>site:</code> 限定。';
      } else {
        el.status.className = 'status';
        el.status.textContent = '';
      }
      return;
    }
    const total = state.results.length;
    const pages = Math.max(1, Math.ceil(total / settings.pageSize));
    const from = (state.page - 1) * settings.pageSize + 1;
    const to = Math.min(state.page * settings.pageSize, total);
    el.status.className = 'status';
    el.status.innerHTML =
      `<span class="dot" aria-hidden="true"></span>${total} 条结果` +
      `<span class="sep">·</span>第 ${from}–${to} 条` +
      `<span class="sep">·</span>共 ${pages} 页` +
      `<span class="sep">·</span>${fmtDuration(state.elapsed)}` +
      (state.cached
        ? `<span class="sep">·</span><span class="ok">缓存命中，未计费</span>`
        : `<span class="sep">·</span>本次 ${fmtMoney(CONFIG.pricePerSuccessfulSearch)}`) +
      dedupeNote(state.dedupe);
  }

  /** One-line, honest note about local post-processing. */
  function dedupeNote(dedupe: DedupeStats): string {
    const removed = dedupe.blocklisted + dedupe.duplicateUrl + dedupe.duplicateTitle;
    if (removed === 0) return '';
    return `<span class="sep">·</span><span class="muted">合并重复 ${removed}</span>`;
  }

  function describeError(error: ApiError): { title: string; hint: string } {
    switch (error.kind) {
      case 'auth':
        return { title: 'API Key 无效或已失效', hint: '点右上角 ⚙ → 删除本机 API Key，然后重新填写。' };
      case 'payment':
        return { title: '账号余额不足', hint: '到 platform.deepseek.com 充值后再试。' };
      case 'rate':
        return { title: '触发限速（5 次/秒，按账号）', hint: '本页也会自动排队重试；连续失败请稍候再搜。' };
      case 'forbidden':
        return { title: '请求被安全策略拒绝', hint: '换个链接或稍后再试。' };
      case 'timeout':
        return { title: '请求超时', hint: '网络不稳定；降低每页条数或稍后重试。' };
      case 'network':
        return { title: '网络错误', hint: '检查网络或代理设置；接口域名为 api.deepseek.com。' };
      case 'server':
        return { title: '服务端错误', hint: '已自动重试仍失败，稍后再试。' };
      case 'bad-request':
        return { title: '请求不合法', hint: error.message };
      case 'unfetchable':
        return {
          title: '抓不到正文',
          hint: '浏览器也打不开，说明是网络层就访问不到（被墙 / DNS 被污染 / 站点屏蔽了此地）；也可能需要登录或做了反爬。正文抓取失败不影响上面的搜索结果。',
        };
      case 'aborted':
        return { title: '已取消', hint: '' };
      default:
        return { title: '搜索失败', hint: error.message };
    }
  }

  /* ---------------------------------------------------------------- */
  /* rendering: results                                                */
  /* ---------------------------------------------------------------- */
  function renderResults(): void {
    clear(el.results);
    const terms = highlightTerms(state.built || state.query);
    const start = (state.page - 1) * settings.pageSize;
    const slice = state.results.slice(start, start + settings.pageSize);

    slice.forEach((result, offset) => {
      const row = renderResult(result, terms);
      row.id = `result-${start + offset + 1}`;
      el.results.appendChild(row);
    });
  }

  function renderResult(result: SearchResult, terms: string[], options: { compact?: boolean } = {}): HTMLElement {
    const title = h('a', {
      class: 'result-title',
      href: result.url,
      target: '_blank',
      rel: 'noopener noreferrer',
      html: highlight(result.title || result.url, terms),
    });

    const url = h('div', { class: 'result-url', text: hostOf(result.url) });

    const showSummary = settings.summary === 'summary';
    const bodyText = showSummary ? result.summary || result.snippet : result.snippet || result.summary;
    const snippet = h('p', {
      class: `result-snippet${showSummary ? ' clampable' : ''}`,
      html: highlight(bodyText || '', terms),
      title: showSummary ? '点击展开 / 收起' : '',
    });
    if (showSummary) {
      snippet.addEventListener('click', () => snippet.classList.toggle('clamped'));
      snippet.classList.add('clamped');
    }

    const meta = h('div', { class: 'result-meta' });
    if (result.site_name) meta.appendChild(h('span', { class: 'site', text: result.site_name }));
    const date = fmtDate(result.date);
    if (date) meta.appendChild(h('span', { text: date }));
    if (typeof result.authority === 'number' && result.authority >= 0) {
      const high = result.authority >= 3;
      meta.appendChild(h('span', { class: `badge${high ? ' high' : ''}`, text: high ? '高权威' : `权威 ${result.authority}/4` }));
    }

    const actions = h('div', { class: 'result-actions' });
    if (!options.compact) {
      const readBtn = h('button', { class: 'link-btn', type: 'button', text: '阅读正文' });
      readBtn.addEventListener('click', () => void toggleRead(host, result, readBtn));
      actions.appendChild(readBtn);

      const site = hostOf(result.url);
      if (site) {
        const siteBtn = h('button', { class: 'link-btn', type: 'button', text: '只搜本站' });
        siteBtn.addEventListener('click', () => {
          state.filters.site = site;
          syncFilterInputs();
          void runSearch({ pushUrl: true });
        });
        actions.appendChild(siteBtn);
      }
    }

    const copyBtn = h('button', { class: 'link-btn', type: 'button', text: '复制链接' });
    copyBtn.addEventListener('click', async () => {
      const ok = await copyText(result.url);
      toast(ok ? '链接已复制' : '复制失败，请手动选择');
    });
    actions.appendChild(copyBtn);

    const host = h('li', { class: `result${options.compact ? ' compact' : ''}` }, title, url, snippet, meta);
    meta.appendChild(actions);
    return host;
  }

  async function toggleRead(host: HTMLElement, result: SearchResult, button: HTMLElement): Promise<void> {
    const existing = host.querySelector('.read-panel');
    if (existing) {
      existing.remove();
      button.textContent = '阅读正文';
      return;
    }

    button.textContent = '抓取中…';
    (button as HTMLButtonElement).disabled = true;
    try {
      let page = pageCache.get(result.url);
      if (!page) {
        page = await api.fetchPage(result.url);
        pageCache.set(result.url, page);
      }
      const panel = h('div', { class: 'read-panel' });
      const head = h('div', { class: 'read-head' });
      head.appendChild(h('span', { text: page.title || hostOf(result.url) }));
      const close = h('button', { class: 'link-btn', type: 'button', text: '收起' });
      close.addEventListener('click', () => {
        panel.remove();
        button.textContent = '阅读正文';
      });
      head.appendChild(close);
      panel.appendChild(head);
      panel.appendChild(h('pre', { class: 'read-body', text: page.content || '（无正文）' }));
      host.appendChild(panel);
      button.textContent = '已展开';
    } catch (error) {
      const err = toApiError(error);
      const { title, hint } = describeError(err);

      const panel = h('div', { class: 'read-panel read-error' });
      const head = h('div', { class: 'read-head' });
      head.appendChild(h('span', { text: `无法抓取正文 · ${title}` }));
      const close = h('button', { class: 'link-btn', type: 'button', text: '收起' });
      close.addEventListener('click', () => {
        panel.remove();
        button.textContent = '阅读正文';
      });
      head.appendChild(close);
      panel.appendChild(head);

      const body = h('div', { class: 'read-body' });
      body.appendChild(h('p', { text: hint }));
      const actions = h('div', { class: 'read-actions' });
      actions.appendChild(
        h('a', {
          class: 'link-btn',
          href: result.url,
          target: '_blank',
          rel: 'noopener noreferrer',
          text: '在新标签打开原链接',
        }),
      );
      const retry = h('button', { class: 'link-btn', type: 'button', text: '重试' });
      retry.addEventListener('click', () => {
        panel.remove();
        button.textContent = '阅读正文';
        void toggleRead(host, result, button);
      });
      actions.appendChild(retry);
      body.appendChild(actions);
      panel.appendChild(body);
      host.appendChild(panel);

      button.textContent = '阅读正文';
    } finally {
      (button as HTMLButtonElement).disabled = false;
    }
  }

  /* ---------------------------------------------------------------- */
  /* rendering: pager / history / stats                                */
  /* ---------------------------------------------------------------- */
  function renderPager(): void {
    clear(el.pager);
    const pages = Math.ceil(state.results.length / settings.pageSize);
    if (pages <= 1) return;

    const goTo = (page: number) => {
      state.page = Math.min(Math.max(1, page), pages);
      renderResults();
      renderPager();
      renderStatus();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    if (state.page > 1) {
      const prev = h('button', { class: 'btn page', type: 'button', text: '上一页' });
      prev.addEventListener('click', () => goTo(state.page - 1));
      el.pager.appendChild(prev);
    }
    for (let page = 1; page <= pages; page++) {
      const btn = h('button', {
        class: `btn page${page === state.page ? ' current' : ''}`,
        type: 'button',
        text: String(page),
        'aria-current': page === state.page ? 'page' : 'false',
      });
      btn.addEventListener('click', () => goTo(page));
      el.pager.appendChild(btn);
    }
    if (state.page < pages) {
      const next = h('button', { class: 'btn page', type: 'button', text: '下一页' });
      next.addEventListener('click', () => goTo(state.page + 1));
      el.pager.appendChild(next);
    }
  }

  function renderHistory(): void {
    clear(el.history);
    for (const query of history.slice(0, 8)) {
      const chip = h('button', { class: 'chip', type: 'button', text: query });
      chip.addEventListener('click', () => {
        el.q.value = query;
        void runSearch({ pushUrl: true });
      });
      el.history.appendChild(chip);
    }
  }

  function renderStats(): void {
    const cacheStats = cache.stats;
    const lines = [
      `本次会话：${stats.searches} 次真实请求 · ${stats.cacheHits} 次缓存命中 · 约 ${fmtMoney(stats.spend)}`,
      `缓存：${cacheStats.size} 条 · TTL ${Math.round(CONFIG.cacheTtlMs / 60000)} 分钟`,
      `存储：${backend ? 'localStorage（持久）' : '内存（刷新即失效）'}`,
      `队列：${bucket.queued} 个请求在等待令牌`,
    ];
    el.stats.innerHTML = lines.map((line) => `<div>${escapeHtml(line)}</div>`).join('');
    el.footStats.textContent = `${stats.searches} 次请求 · ${fmtMoney(stats.spend)}`;
  }

  /* ---------------------------------------------------------------- */
  /* suggestions                                                       */
  /* ---------------------------------------------------------------- */
  let suggestionItems: string[] = [];
  let suggestionIndex = -1;

  function closeSuggestions(): void {
    el.suggestions.hidden = true;
    el.suggestions.replaceChildren();
    el.q.setAttribute('aria-expanded', 'false');
    suggestionItems = [];
    suggestionIndex = -1;
  }

  function updateSuggestions(): void {
    const prefix = el.q.value.trim();
    if (!prefix) {
      closeSuggestions();
      return;
    }
    const matches = history.filter((q) => q.toLowerCase().includes(prefix.toLowerCase()) && q !== prefix).slice(0, 6);
    if (matches.length === 0) {
      closeSuggestions();
      return;
    }
    suggestionItems = matches;
    suggestionIndex = -1;
    clear(el.suggestions);
    matches.forEach((text, index) => {
      const item = h('li', { class: 'suggestion', role: 'option', text });
      item.addEventListener('mousedown', (event) => {
        event.preventDefault();
        el.q.value = text;
        closeSuggestions();
        void runSearch({ pushUrl: true });
      });
      el.suggestions.appendChild(item);
    });
    el.suggestions.hidden = false;
    el.q.setAttribute('aria-expanded', 'true');
  }

  function moveSuggestion(delta: number): void {
    if (el.suggestions.hidden || suggestionItems.length === 0) return;
    suggestionIndex = (suggestionIndex + delta + suggestionItems.length) % suggestionItems.length;
    Array.from(el.suggestions.children).forEach((child, index) => {
      child.classList.toggle('active', index === suggestionIndex);
    });
  }

  /* ---------------------------------------------------------------- */
  /* search                                                            */
  /* ---------------------------------------------------------------- */
  let inflightController: AbortController | null = null;

  async function runSearch(options: { pushUrl?: boolean } = {}): Promise<void> {
    const text = el.q.value.trim();
    if (!text) {
      el.q.focus();
      return;
    }
    if (!state.key) {
      showGate();
      return;
    }

    state.filters = {
      site: el.fSite.value,
      excludeSites: el.fExclude.value,
      lang: el.fLang.value,
      time: el.fTime.value as TimePreset,
    };

    if (state.mode === 'compare') {
      await runCompare(text);
      return;
    }

    const built = buildQuery(text, state.filters);
    state.query = text;
    state.built = built;
    state.error = null;
    state.loading = true;
    state.page = 1;
    state.results = [];
    el.empty.hidden = true;
    clear(el.results);
    clear(el.pager);
    renderStatus();

    resetAnswer();
    resetOfficial();
    inflightController?.abort();
    const controller = new AbortController();
    inflightController = controller;

    const cacheKey = `${built}|${CONFIG.maxCount}`;
    const started = performance.now();

    if (hasDownloadIntent(built)) void fetchOfficial(text);

    try {
      const cached = cache.get(cacheKey);
      if (cached) {
        stats.cacheHits++;
        state.cached = true;
        state.elapsed = performance.now() - started;
        const deduped = applyDedupe(cached.results);
        state.results = deduped.results;
        state.dedupe = deduped.dedupe;
        state.loading = false;
        finishSearch(text, options);
      } else {
        const response = await flight.run(cacheKey, async () => {
          const data = await api.search(built, { count: CONFIG.maxCount, signal: controller.signal });
          return data;
        });
        if (response.results.length > 0) cache.set(cacheKey, response);
        stats.searches++;
        stats.spend += CONFIG.pricePerSuccessfulSearch;
        state.cached = false;
        state.elapsed = performance.now() - started;
        const deduped = applyDedupe(response.results);
        state.results = deduped.results;
        state.dedupe = deduped.dedupe;
        state.loading = false;
        finishSearch(text, options);
      }
    } catch (error) {
      const apiError = toApiError(error);
      state.loading = false;
      if (apiError.kind === 'aborted') return;
      state.error = apiError;
      state.results = [];
      el.empty.hidden = false;
      renderStatus();
      renderStats();
    }
  }

  function finishSearch(text: string, options: { pushUrl?: boolean }): void {
    if (state.results.length === 0) el.empty.hidden = false;
    mergeOfficial(extractOfficialSources(state.results));
    renderResults();
    renderPager();
    renderStatus();
    renderStats();
    if (options.pushUrl !== false) {
      pushHistory(text);
      syncUrl();
    }
    void startAnswer(text);
  }

  /* ---------------------------------------------------------------- */
  /* compare mode                                                      */
  /* ---------------------------------------------------------------- */
  function renderCompare(): void {
    clear(el.compare);
    const terms = highlightTerms(state.query);
    for (const column of state.columns) el.compare.appendChild(renderColumn(column, terms));
  }

  function renderColumn(column: ColumnState, terms: string[]): HTMLElement {
    const meta = column.error
      ? '失败'
      : `${column.results.length} 条${column.cached ? ' · 缓存' : ''} · ${fmtDuration(column.elapsed)}`;
    const head = h(
      'div',
      { class: 'col-head' },
      h('span', { class: 'col-label', text: column.preset.label }),
      h('span', { class: 'col-meta', text: meta }),
    );

    const body = h('div', { class: 'col-body' });
    if (column.error) {
      const { title, hint } = describeError(column.error);
      body.appendChild(h('div', { class: 'col-error', text: title }));
      body.appendChild(h('div', { class: 'col-empty', text: hint }));
    } else if (column.results.length === 0) {
      body.appendChild(h('div', { class: 'col-empty', text: state.loading ? '查询中…' : '没有结果' }));
    } else {
      const list = h('ol');
      for (const result of column.results) list.appendChild(renderResult(result, terms, { compact: true }));
      body.appendChild(list);
    }

    const foot = h('div', { class: 'col-foot' });
    const focus = h('button', { class: 'link-btn', type: 'button', text: `只看 ${column.preset.site}` });
    focus.addEventListener('click', () => {
      state.filters.site = column.preset.site;
      state.mode = 'single';
      settings.mode = 'single';
      persistSettings();
      syncFilterInputs();
      applyMode();
      void runSearch({ pushUrl: true });
    });
    foot.appendChild(focus);

    return h('section', { class: 'col' }, head, body, foot);
  }

  function applyMode(): void {
    const comparing = state.mode === 'compare';
    el.results.hidden = comparing;
    el.pager.hidden = comparing;
    el.compare.hidden = !comparing;
    document.body.dataset.mode = state.mode;
    for (const btn of Array.from(el.modeSwitch.querySelectorAll<HTMLButtonElement>('.seg'))) {
      btn.setAttribute('aria-pressed', String(btn.dataset.mode === state.mode));
    }
    if (!comparing) clear(el.compare);
  }

  function setMode(mode: ResultMode): void {
    if (state.mode === mode) return;
    state.mode = mode;
    settings.mode = mode;
    persistSettings();
    applyMode();
    if (el.q.value.trim() && state.key) void runSearch({ pushUrl: true });
    else renderStatus();
  }

  async function runCompare(text: string): Promise<void> {
    resetAnswer();
    resetOfficial();
    const jobs = compareQueries(text, state.filters, CONFIG.comparePresets);
    state.query = text;
    state.built = '';
    state.error = null;
    state.loading = true;
    state.page = 1;
    state.results = [];
    state.columns = jobs.map((job) => ({
      preset: job.preset,
      query: job.query,
      results: [],
      error: null,
      cached: false,
      elapsed: 0,
    }));
    el.empty.hidden = true;
    renderCompare();
    renderStatus();

    inflightController?.abort();
    const controller = new AbortController();
    inflightController = controller;

    const started = performance.now();
    let paid = 0;
    let hits = 0;

    await Promise.all(
      jobs.map(async (job, index) => {
        const column = state.columns[index];
        if (!column) return;
        const cacheKey = `${job.query}|${CONFIG.compareCount}`;
        const t0 = performance.now();
        try {
          const cached = cache.get(cacheKey);
          if (cached) {
            column.results = applyDedupe(cached.results).results;
            column.cached = true;
            hits++;
          } else {
            const response = await flight.run(cacheKey, () =>
              api.search(job.query, { count: CONFIG.compareCount, signal: controller.signal }),
            );
            if (response.results.length > 0) cache.set(cacheKey, response);
            column.results = applyDedupe(response.results).results;
            paid++;
          }
        } catch (error) {
          const apiError = toApiError(error);
          if (apiError.kind !== 'aborted') column.error = apiError;
        }
        column.elapsed = performance.now() - t0;
        renderCompare();
      }),
    );

    state.loading = false;
    state.elapsed = performance.now() - started;
    state.cached = paid === 0;
    stats.searches += paid;
    stats.spend += paid * CONFIG.pricePerSuccessfulSearch;
    stats.cacheHits += hits;
    renderCompare();
    renderStatus();
    renderStats();
    pushHistory(text);
    syncUrl();
  }

  /* ---------------------------------------------------------------- */
  /* answer synthesis                                                  */
  /* ---------------------------------------------------------------- */
  let answerController: AbortController | null = null;
  let answerFrame = 0;

  function scheduleAnswerRender(): void {
    if (answerFrame) return;
    answerFrame = window.requestAnimationFrame(() => {
      answerFrame = 0;
      renderAnswer();
    });
  }

  /** Escape first, then turn [n] into a link that scrolls to source n. */
  function formatAnswerText(text: string): string {
    const escaped = escapeHtml(text);
    const withCitations = escaped.replace(/\[(\d{1,2})\]/g, (match, digits: string) => {
      const index = Number(digits);
      const cited = state.answer.citations.includes(index) || index <= state.answer.sources.length;
      if (!cited || index < 1) return match;
      return `<a class="cite" href="#result-${index}" data-idx="${index}">${index}</a>`;
    });
    return withCitations
      .split(/\n{2,}/)
      .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`)
      .join('');
  }

  function renderAnswer(): void {
    const answer = state.answer;
    if (!answer.visible) {
      el.answer.hidden = true;
      return;
    }
    el.answer.hidden = false;
    el.answer.classList.toggle('running', answer.running);
    el.answerStop.hidden = !answer.running;

    if (answer.error) {
      const { title, hint } = describeAnswerError(answer.error);
      el.answerBody.innerHTML = `<p class="answer-error">${escapeHtml(title)}</p><p class="answer-hint">${escapeHtml(hint)}</p>`;
      el.answerMeta.textContent = '';
      el.answerFoot.replaceChildren();
      return;
    }

    const body = formatAnswerText(answer.text);
    el.answerBody.innerHTML = answer.text
      ? body
      : '<p class="answer-placeholder"><span class="spinner"></span>正在阅读来源并组织答案…</p>';

    const meta: string[] = [];
    if (answer.running) meta.push('生成中…');
    else if (answer.text) meta.push(`基于 ${answer.sources.length} 条来源`);
    if (answer.elapsed > 0 && !answer.running) meta.push(fmtDuration(answer.elapsed));
    if (answer.usage) meta.push(`${answer.usage.promptTokens + answer.usage.completionTokens} tokens`);
    el.answerMeta.textContent = meta.join(' · ');

    // Source chips: only those the answer actually cited.
    el.answerFoot.replaceChildren();
    for (const index of answer.citations) {
      const source = answer.sources[index - 1];
      if (!source) continue;
      const chip = h('a', {
        class: 'cite-chip',
        href: source.url,
        target: '_blank',
        rel: 'noopener noreferrer',
        title: source.title,
      });
      chip.appendChild(h('span', { class: 'cite-num', text: String(index) }));
      chip.appendChild(h('span', { class: 'cite-site', text: source.site_name || hostOf(source.url) }));
      el.answerFoot.appendChild(chip);
    }
    if (answer.citations.length === 0 && answer.text && !answer.running) {
      el.answerFoot.appendChild(h('span', { class: 'cite-empty', text: '该答案没有标注来源，请以链接结果为准' }));
    }
  }

  function describeAnswerError(error: AnswerError): { title: string; hint: string } {
    switch (error.kind) {
      case 'auth':
        return { title: '摘要生成失败：API Key 无效', hint: '搜索结果不受影响；点 ⚙ 换一个 Key。' };
      case 'payment':
        return { title: '摘要生成失败：余额不足', hint: '搜索结果不受影响。' };
      case 'rate':
        return { title: '摘要生成失败：触发限速', hint: '稍后重试，或关闭 AI 摘要只看链接。' };
      case 'network':
      case 'timeout':
        return { title: '摘要生成失败：网络问题', hint: '搜索结果不受影响。' };
      default:
        return { title: '摘要生成失败', hint: error.message };
    }
  }

  function resetAnswer(): void {
    answerController?.abort();
    answerController = null;
    if (answerFrame) {
      window.cancelAnimationFrame(answerFrame);
      answerFrame = 0;
    }
    state.answer = {
      text: '',
      sources: [],
      citations: [],
      running: false,
      error: null,
      usage: null,
      elapsed: 0,
      visible: false,
    };
    renderAnswer();
  }

  async function startAnswer(query: string): Promise<void> {
    resetAnswer();
    if (!settings.answer || state.mode !== 'single' || state.results.length === 0 || !state.key) return;

    const sources = state.results.slice(0, CONFIG.answerMaxSources);
    state.answer.sources = sources;
    state.answer.visible = true;
    state.answer.running = true;
    renderAnswer();

    const controller = new AbortController();
    answerController = controller;
    const started = performance.now();

    try {
      const result = await streamAnswer({
        endpoint: CONFIG.answerEndpoint,
        apiKey: state.key,
        model: settings.answerModel || CONFIG.answerModel,
        messages: buildMessages(query, sources, CONFIG.answerMaxSources),
        signal: controller.signal,
        maxTokens: CONFIG.answerMaxTokens,
        onDelta: (delta) => {
          state.answer.text += delta;
          scheduleAnswerRender();
        },
      });
      state.answer.citations = citationIndexes(result.text, sources.length);
      state.answer.usage = result.usage;
      state.answer.elapsed = performance.now() - started;
      state.answer.running = false;
      renderAnswer();
    } catch (error) {
      const answerError = error instanceof AnswerError ? error : new AnswerError('unknown', String(error));
      if (answerError.kind === 'aborted') {
        state.answer.running = false;
        if (!state.answer.text) state.answer.visible = false;
        renderAnswer();
        return;
      }
      state.answer.error = answerError;
      state.answer.running = false;
      state.answer.elapsed = performance.now() - started;
      renderAnswer();
    }
  }

  /* ---------------------------------------------------------------- */
  /* official sources ("where do I actually download this")            */
  /* ---------------------------------------------------------------- */
  let officialController: AbortController | null = null;

  function renderOfficial(): void {
    el.official.hidden = state.official.length === 0;
    el.officialList.replaceChildren();
    for (const source of state.official) {
      const chip = h('a', {
        class: 'official-chip',
        href: source.url,
        target: '_blank',
        rel: 'noopener noreferrer',
        title: source.url,
      });
      chip.appendChild(h('span', { class: 'official-host', text: source.host === 'huggingface.co' ? 'HF' : '魔搭' }));
      chip.appendChild(h('span', { class: 'official-repo', text: source.repo }));
      el.officialList.appendChild(chip);
    }
  }

  function mergeOfficial(sources: OfficialSource[]): void {
    if (sources.length === 0) return;
    const seen = new Set(state.official.map((source) => `${source.host}/${source.repo}`));
    const added = sources.filter((source) => !seen.has(`${source.host}/${source.repo}`));
    if (added.length === 0) return;
    state.official = [...state.official, ...added];
    renderOfficial();
  }

  function resetOfficial(): void {
    officialController?.abort();
    officialController = null;
    state.official = [];
    renderOfficial();
  }

  /**
   * One extra, source-restricted query so repository pages can outrank the news
   * articles that merely mention them. Best effort: failures stay silent.
   */
  async function fetchOfficial(text: string): Promise<void> {
    if (hasSiteOperator(text)) return;
    const query = officialQuery(text);
    const cacheKey = `${query}|${CONFIG.officialCount}`;
    const controller = new AbortController();
    officialController = controller;

    try {
      let results = cache.get(cacheKey)?.results;
      if (!results) {
        const response = await flight.run(cacheKey, () =>
          api.search(query, { count: CONFIG.officialCount, signal: controller.signal }),
        );
        if (response.results.length > 0) cache.set(cacheKey, response);
        stats.searches++;
        stats.spend += CONFIG.pricePerSuccessfulSearch;
        results = response.results;
      }
      mergeOfficial(extractOfficialSources(results));
      renderStats();
    } catch {
      /* a bonus section must never break the page */
    }
  }

  /* ---------------------------------------------------------------- */
  /* gate / drawer                                                     */
  /* ---------------------------------------------------------------- */
  function showGate(): void {
    el.gate.hidden = false;
    el.keyInput.value = '';
    el.keyInput.focus();
    el.gate.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function openDrawer(): void {
    el.drawer.hidden = false;
    el.scrim.hidden = false;
    el.setPageSize.value = String(settings.pageSize);
    el.setSummary.value = settings.summary;
    el.setTheme.value = settings.theme;
    el.setEndpoint.value = settings.endpoint;
    el.setDedupe.value = settings.dedupe ? 'on' : 'off';
    el.setAnswer.value = settings.answer ? 'on' : 'off';
    el.setAnswerModel.value = settings.answerModel;
    renderStats();
    el.setPageSize.focus();
  }

  function closeDrawer(): void {
    el.drawer.hidden = true;
    el.scrim.hidden = true;
    el.settingsBtn.focus();
  }

  /* ---------------------------------------------------------------- */
  /* wiring                                                            */
  /* ---------------------------------------------------------------- */
  el.form.addEventListener('submit', (event) => {
    event.preventDefault();
    closeSuggestions();
    void runSearch({ pushUrl: true });
  });

  el.q.addEventListener('input', updateSuggestions);
  el.q.addEventListener('focus', updateSuggestions);
  el.q.addEventListener('blur', () => window.setTimeout(closeSuggestions, 120));
  el.q.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveSuggestion(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveSuggestion(-1);
    } else if (event.key === 'Enter' && suggestionIndex >= 0) {
      event.preventDefault();
      el.q.value = suggestionItems[suggestionIndex] ?? el.q.value;
      closeSuggestions();
      void runSearch({ pushUrl: true });
    } else if (event.key === 'Escape') {
      closeSuggestions();
    }
  });

  for (const control of [el.fSite, el.fExclude]) {
    control.addEventListener(
      'change',
      debounce(() => {
        if (el.q.value.trim()) void runSearch({ pushUrl: true });
      }, 250),
    );
  }
  for (const control of [el.fLang, el.fTime]) {
    control.addEventListener('change', () => {
      if (el.q.value.trim()) void runSearch({ pushUrl: true });
    });
  }

  must<HTMLButtonElement>('#btn-filters-clear').addEventListener('click', () => {
    state.filters = { ...EMPTY_FILTERS };
    syncFilterInputs();
    if (el.q.value.trim()) void runSearch({ pushUrl: true });
  });

  function saveKey(): void {
    const key = el.keyInput.value.trim();
    if (!key) {
      toast('先粘贴一个 key');
      return;
    }
    if (!/^sk-[A-Za-z0-9_-]{8,}$/.test(key)) toast('看起来不像 DeepSeek key（通常以 sk- 开头），仍然保存');
    store.set('key', key);
    applyKey(key);
    toast('已保存到本浏览器');
    if (el.q.value.trim()) void runSearch({ pushUrl: true });
  }

  must<HTMLFormElement>('#key-form').addEventListener('submit', (event) => {
    event.preventDefault();
    saveKey();
  });

  el.modeSwitch.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('.seg');
    const mode = target?.dataset.mode;
    if (mode === 'single' || mode === 'compare') setMode(mode);
  });

  el.answerBody.addEventListener('click', (event) => {
    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('.cite');
    if (!link) return;
    event.preventDefault();
    const index = Number(link.dataset.idx);
    const target = document.getElementById(`result-${index}`);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('flash');
    window.setTimeout(() => target.classList.remove('flash'), 1200);
  });

  el.answerStop.addEventListener('click', () => {
    answerController?.abort();
    state.answer.running = false;
    state.answer.citations = citationIndexes(state.answer.text, state.answer.sources.length);
    renderAnswer();
  });

  el.answerHide.addEventListener('click', () => {
    answerController?.abort();
    state.answer.visible = false;
    renderAnswer();
  });

  el.answerCopy.addEventListener('click', async () => {
    const ok = await copyText(`${state.answer.text}

来源：${state.query}`);
    toast(ok ? '摘要已复制' : '复制失败');
  });

  el.setAnswer.addEventListener('change', () => {
    settings.answer = el.setAnswer.value === 'on';
    persistSettings();
    if (!settings.answer) resetAnswer();
    else if (el.q.value.trim()) void runSearch({ pushUrl: false });
  });

  el.setAnswerModel.addEventListener('change', () => {
    settings.answerModel = el.setAnswerModel.value.trim();
    persistSettings();
    toast(settings.answerModel ? `摘要模型：${settings.answerModel}` : '已恢复默认摘要模型');
  });

  el.settingsBtn.addEventListener('click', openDrawer);
  must<HTMLButtonElement>('#drawer-close').addEventListener('click', closeDrawer);
  el.scrim.addEventListener('click', closeDrawer);

  el.setPageSize.addEventListener('change', () => {
    settings.pageSize = Number(el.setPageSize.value) || CONFIG.defaultPageSize;
    persistSettings();
    if (state.results.length) {
      state.page = 1;
      renderResults();
      renderPager();
      renderStatus();
    }
  });

  el.setSummary.addEventListener('change', () => {
    settings.summary = el.setSummary.value as SummaryMode;
    persistSettings();
    if (state.results.length) renderResults();
  });

  el.setTheme.addEventListener('change', () => {
    settings.theme = el.setTheme.value as ThemeMode;
    persistSettings();
    applyTheme();
  });

  el.setDedupe.addEventListener('change', () => {
    settings.dedupe = el.setDedupe.value === 'on';
    persistSettings();
    if (el.q.value.trim()) void runSearch({ pushUrl: false });
    else toast(settings.dedupe ? '已开启合并重复' : '已关闭，显示原始结果');
  });

  el.setEndpoint.addEventListener('change', () => {
    settings.endpoint = el.setEndpoint.value.trim();
    persistSettings();
    api = buildApi();
    toast(settings.endpoint ? '端点已更新（下次搜索生效）' : '已恢复默认端点');
  });

  must<HTMLButtonElement>('#btn-clear-cache').addEventListener('click', () => {
    cache.clear();
    pageCache.clear();
    renderStats();
    toast('搜索缓存已清空');
  });

  must<HTMLButtonElement>('#btn-clear-history').addEventListener('click', () => {
    history.length = 0;
    store.set('history', history);
    renderHistory();
    toast('搜索历史已清空');
  });

  must<HTMLButtonElement>('#btn-clear-key').addEventListener('click', () => {
    store.remove('key');
    applyKey('');
    closeDrawer();
    showGate();
  });

  must<HTMLButtonElement>('#btn-export').addEventListener('click', async () => {
    const payload = JSON.stringify(
      { settings, history, exportedAt: new Date().toISOString(), version: CONFIG.storageVersion },
      null,
      2,
    );
    const ok = await copyText(payload);
    toast(ok ? '设置 JSON 已复制到剪贴板' : '复制失败');
  });

  document.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null;
    const typing = target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
    if (event.key === '/' && !typing) {
      event.preventDefault();
      el.q.focus();
      el.q.select();
    }
    if (event.key === 'Escape' && !el.drawer.hidden) closeDrawer();
    if (!typing && state.results.length && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      const pages = Math.ceil(state.results.length / settings.pageSize);
      if (pages <= 1) return;
      const next = event.key === 'ArrowLeft' ? state.page - 1 : state.page + 1;
      if (next >= 1 && next <= pages) {
        state.page = next;
        renderResults();
        renderPager();
        renderStatus();
      }
    }
  });

  /* ---------------------------------------------------------------- */
  /* start                                                             */
  /* ---------------------------------------------------------------- */
  applyTheme();
  el.setPageSize.value = String(settings.pageSize);
  el.setSummary.value = settings.summary;
  el.setTheme.value = settings.theme;
  el.setEndpoint.value = settings.endpoint;
  el.setDedupe.value = settings.dedupe ? 'on' : 'off';
  el.setAnswer.value = settings.answer ? 'on' : 'off';
  el.setAnswerModel.value = settings.answerModel;
  document.title = `${CONFIG.brand} · 一个搜索壳子`;
  renderHistory();
  renderStats();
  applyKey(state.key);
  applyMode();

  const initial = readUrl();
  if (state.key && initial) {
    el.q.value = initial;
    void runSearch({ pushUrl: false });
  } else if (!state.key) {
    el.gate.hidden = false;
  }
}
