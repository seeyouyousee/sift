import { describe, expect, it, vi } from 'vitest';
import {
  AnswerError,
  SseParser,
  buildMessages,
  citationIndexes,
  excerpt,
  streamAnswer,
} from '../src/core/answer.js';
import type { SearchResult } from '../src/core/types.js';

function result(partial: Partial<SearchResult> = {}): SearchResult {
  return {
    title: '标题',
    url: 'https://example.com/1',
    snippet: '短摘要',
    summary: '这是一段长摘要，用来验证提示词拼接。',
    content: '',
    site_name: '示例站点',
    site_icon: null,
    date: '2026-10-01T00:00:00+00:00',
    authority: 3,
    rerank_score: 2.2,
    ...partial,
  };
}

describe('excerpt', () => {
  it('keeps short text intact and collapses whitespace', () => {
    expect(excerpt('a  b\n\nc', 100)).toBe('a b c');
  });

  it('truncates with an ellipsis at the limit', () => {
    const out = excerpt('x'.repeat(500), 20);
    expect(out).toHaveLength(20);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('buildMessages', () => {
  it('includes the question and numbered sources', () => {
    const messages = buildMessages('怎么删重复行', [result(), result({ title: '第二个' })]);
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('不要编造');
    expect(messages[1]?.content).toContain('问题：怎么删重复行');
    expect(messages[1]?.content).toContain('[1] 标题');
    expect(messages[1]?.content).toContain('[2] 第二个');
    expect(messages[1]?.content).toContain('站点：示例站点');
    expect(messages[1]?.content).toContain('时间：2026-10-01');
  });

  it('caps the number of sources', () => {
    const many = Array.from({ length: 12 }, (_, i) => result({ title: `t${i}` }));
    const content = buildMessages('q', many, 3)[1]?.content ?? '';
    expect(content).toContain('[3] t2');
    expect(content).not.toContain('[4]');
  });

  it('falls back to snippet when summary is empty', () => {
    const content = buildMessages('q', [result({ summary: '', snippet: '只有短摘要' })])[1]?.content ?? '';
    expect(content).toContain('只有短摘要');
  });

  it('handles zero results without crashing', () => {
    const content = buildMessages('q', [])[1]?.content ?? '';
    expect(content).toContain('问题：q');
  });
});

describe('SseParser', () => {
  it('parses one payload per event', () => {
    const parser = new SseParser();
    expect(parser.push('data: {"a":1}\n\n')).toEqual(['{"a":1}']);
  });

  it('survives arbitrary chunk boundaries', () => {
    const parser = new SseParser();
    const chunks = ['data: {"a":', '1}\n\ndata: {"b"', ':2}\n\n'];
    const out = chunks.flatMap((chunk) => parser.push(chunk));
    expect(out).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('normalises CRLF line endings', () => {
    const parser = new SseParser();
    expect(parser.push('data: x\r\n\r\n')).toEqual(['x']);
  });

  it('ignores events without a data line', () => {
    const parser = new SseParser();
    expect(parser.push(': keep-alive\n\n')).toEqual([]);
  });

  it('handles [DONE] like any other payload', () => {
    const parser = new SseParser();
    expect(parser.push('data: [DONE]\n\n')).toEqual(['[DONE]']);
  });
});

function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
}

const delta = (text: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`;

describe('streamAnswer', () => {
  const base = { endpoint: 'https://api.test/chat/completions', apiKey: 'sk-x', model: 'deepseek-chat', messages: [] };

  it('accumulates deltas and reports usage', async () => {
    const body = [
      delta('答案'),
      delta('在这里'),
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 15 } })}\n\n`,
      'data: [DONE]\n\n',
    ];
    const fetchImpl = vi.fn(async () => sseResponse(body));
    const seen: string[] = [];

    const out = await streamAnswer({
      ...base,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onDelta: (d) => seen.push(d),
    });

    expect(out.text).toBe('答案在这里');
    expect(out.usage).toEqual({ promptTokens: 120, completionTokens: 15 });
    expect(out.finishReason).toBe('stop');
    expect(seen).toEqual(['答案', '在这里']);
  });

  it('stops at [DONE] without waiting for the stream to close', async () => {
    const fetchImpl = vi.fn(async () => sseResponse([delta('a'), 'data: [DONE]\n\n', delta('ignored')]));
    const out = await streamAnswer({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch, onDelta: () => {} });
    expect(out.text).toBe('a');
  });

  it('maps HTTP errors', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 }),
    );
    await expect(
      streamAnswer({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch, onDelta: () => {} }),
    ).rejects.toMatchObject({ kind: 'auth' });
  });

  it('rejects without a key before calling the network', async () => {
    const fetchImpl = vi.fn();
    await expect(
      streamAnswer({ ...base, apiKey: '', fetchImpl: fetchImpl as unknown as typeof fetch, onDelta: () => {} }),
    ).rejects.toBeInstanceOf(AnswerError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps a network failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(
      streamAnswer({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch, onDelta: () => {} }),
    ).rejects.toMatchObject({ kind: 'network' });
  });

  it('tolerates malformed payloads mid-stream', async () => {
    const fetchImpl = vi.fn(async () => sseResponse(['data: {not json}\n\n', delta('ok'), 'data: [DONE]\n\n']));
    const out = await streamAnswer({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch, onDelta: () => {} });
    expect(out.text).toBe('ok');
  });
});

describe('citationIndexes', () => {
  it('returns cited sources in ascending order, unique', () => {
    expect(citationIndexes('依据 [2] 与 [1][2]，还有 [3]', 5)).toEqual([1, 2, 3]);
  });

  it('drops out-of-range citations', () => {
    expect(citationIndexes('见 [1] 和 [9]', 3)).toEqual([1]);
  });

  it('returns nothing when there are no citations', () => {
    expect(citationIndexes('没有引用', 5)).toEqual([]);
  });
});
