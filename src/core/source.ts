/**
 * Official-source recall.
 *
 * "DeepSeek 模型下载" returns news articles that merely *mention* the model
 * page: a news page is dense text and reranks well, while a model card is
 * mostly a filename list and reranks badly. The engine has no notion of
 * "the canonical page for entity X", so we ask a second, source-restricted
 * question and keep only repository roots.
 */
export type SourceHost = 'huggingface.co' | 'modelscope.cn';

export interface OfficialSource {
  host: SourceHost;
  /** `owner/repo` */
  repo: string;
  url: string;
}

const SOURCE_HOSTS: SourceHost[] = ['huggingface.co', 'modelscope.cn'];

/** Non-repository paths that share the same host. */
const NON_REPO_SEGMENTS = new Set([
  'blog',
  'blog-zh',
  'datasets',
  'dataset',
  'papers',
  'paper',
  'spaces',
  'collections',
  'collection',
  'discussions',
  'docs',
  'pricing',
  'login',
  'join',
  'organizations',
  'buckets',
  'spaces',
  'models',
  'tasks',
  'search',
]);

const DOWNLOAD_INTENT =
  /(下载|权重|权重文件|模型文件|模型卡|checkpoint|weights?|safetensors|gguf|repo|仓库|开源地址|镜像)/i;

/** Whether this query is asking where to *get* something. */
export function hasDownloadIntent(query: string): boolean {
  return DOWNLOAD_INTENT.test(query ?? '');
}

/** Whether the query already restricts sites, in which case recall is user-driven. */
export function hasSiteOperator(query: string): boolean {
  return /(^|\s)-?site:/i.test(query ?? '');
}

function hostOf(url: string): SourceHost | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return SOURCE_HOSTS.find((candidate) => host === candidate || host.endsWith(`.${candidate}`)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Turn a deep link into its repository root.
 *
 * `huggingface.co/owner/repo/discussions/12` → `huggingface.co/owner/repo`,
 * `modelscope.cn/models/owner/repo` → `modelscope.cn/models/owner/repo`.
 */
export function repoOf(url: string): OfficialSource | null {
  const host = hostOf(url);
  if (!host) return null;

  let path: string;
  try {
    path = new URL(url).pathname.replace(/\/+$/, '');
  } catch {
    return null;
  }

  const segments = path.split('/').filter(Boolean);
  if (host === 'modelscope.cn' && segments[0] === 'models') segments.shift();
  if (segments.length < 2) return null;

  const [owner, repo] = segments;
  if (!owner || !repo) return null;
  if (NON_REPO_SEGMENTS.has(owner.toLowerCase())) return null;
  if (NON_REPO_SEGMENTS.has(repo.toLowerCase())) return null;

  const urlOut =
    host === 'modelscope.cn'
      ? `https://modelscope.cn/models/${owner}/${repo}`
      : `https://huggingface.co/${owner}/${repo}`;

  return { host, repo: `${owner}/${repo}`, url: urlOut };
}

/** Owners whose repositories are the canonical ones we want to surface first. */
const PREFERRED_OWNERS = new Set(['deepseek-ai', 'deepseek']);

/**
 * Unique repository roots, official owners first.
 *
 * Aggregate result pages are full of community quantisations and mirrors
 * (`unsloth/...`, `QuantTrio/...`). They are useful, but a question like
 * "where do I download DeepSeek" must see `deepseek-ai/...` first, or the answer
 * becomes a list of strangers' forks.
 */
export function extractOfficialSources(results: ReadonlyArray<{ url: string }>, limit = 6): OfficialSource[] {
  const seen = new Set<string>();
  const preferred: OfficialSource[] = [];
  const others: OfficialSource[] = [];

  for (const result of results) {
    const repo = repoOf(result.url);
    if (!repo) continue;
    const key = `${repo.host}/${repo.repo}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const owner = repo.repo.split('/')[0]?.toLowerCase() ?? '';
    (PREFERRED_OWNERS.has(owner) ? preferred : others).push(repo);
  }

  return [...preferred, ...others].slice(0, limit);
}

/** The restricted follow-up query used to find those pages. */
export function officialQuery(query: string): string {
  return `${query} site:huggingface.co OR site:modelscope.cn`;
}
