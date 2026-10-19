import { describe, expect, it } from 'vitest';
import {
  extractOfficialSources,
  hasDownloadIntent,
  hasSiteOperator,
  officialQuery,
  repoOf,
} from '../src/core/source.js';

describe('hasDownloadIntent', () => {
  it.each(['DeepSeek 模型下载', '权重文件在哪', 'download model weights', 'GGUF 镜像'])('detects %s', (q) => {
    expect(hasDownloadIntent(q)).toBe(true);
  });

  it.each(['DeepSeek 是什么', '外贸 获客'])('ignores %s', (q) => {
    expect(hasDownloadIntent(q)).toBe(false);
  });
});

describe('hasSiteOperator', () => {
  it('spots an existing restriction', () => {
    expect(hasSiteOperator('x site:github.com')).toBe(true);
    expect(hasSiteOperator('x -site:a.com')).toBe(true);
    expect(hasSiteOperator('x')).toBe(false);
  });
});

describe('repoOf', () => {
  it('normalises HuggingFace repository roots', () => {
    expect(repoOf('https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017')?.url).toBe(
      'https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017',
    );
    expect(repoOf('https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017/discussions/12')?.url).toBe(
      'https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017',
    );
    expect(repoOf('https://www.huggingface.co/deepseek-ai/DeepSeek-V3.2/tree/main')?.repo).toBe(
      'deepseek-ai/DeepSeek-V3.2',
    );
  });

  it('normalises ModelScope repository roots', () => {
    expect(repoOf('https://modelscope.cn/models/deepseek-ai/DeepSeek-V3.2')?.url).toBe(
      'https://modelscope.cn/models/deepseek-ai/DeepSeek-V3.2',
    );
  });

  it('rejects non-repository pages on the same hosts', () => {
    for (const url of [
      'https://huggingface.co/blog/COPU2004/second-review-of-deepseek',
      'https://huggingface.co/datasets/guicybercode/china-ai-dataset',
      'https://huggingface.co/papers/2512.02556',
      'https://huggingface.co/collections/deepseek-ai/deepseek-llm',
      'https://modelscope.cn/models',
    ]) {
      expect(repoOf(url)).toBeNull();
    }
  });

  it('ignores other hosts', () => {
    expect(repoOf('https://tech.ifeng.com/c/8xIZufSArx4')).toBeNull();
    expect(repoOf('not a url')).toBeNull();
  });
});

describe('extractOfficialSources', () => {
  it('dedupes deep links to the same repository', () => {
    const out = extractOfficialSources([
      { url: 'https://huggingface.co/deepseek-ai/X/blob/main/a.gguf' },
      { url: 'https://huggingface.co/deepseek-ai/X/discussions/3' },
      { url: 'https://modelscope.cn/models/deepseek-ai/X' },
    ]);
    expect(out.map((s) => s.url)).toEqual([
      'https://huggingface.co/deepseek-ai/X',
      'https://modelscope.cn/models/deepseek-ai/X',
    ]);
  });

  it('respects the limit and keeps order', () => {
    const results = ['A', 'B', 'C'].map((r) => ({ url: `https://huggingface.co/o/${r}` }));
    expect(extractOfficialSources(results, 2).map((s) => s.repo)).toEqual(['o/A', 'o/B']);
  });

  it('returns nothing when there are no repositories', () => {
    expect(extractOfficialSources([{ url: 'https://ifeng.com/a' }])).toEqual([]);
  });
});

describe('officialQuery', () => {
  it('appends host restrictions', () => {
    expect(officialQuery('DeepSeek 下载')).toBe('DeepSeek 下载 site:huggingface.co OR site:modelscope.cn');
  });
});
