/**
 * Answer synthesis: turn a paid result page into a cited answer.
 *
 * The retrieval API returns summaries meant "for the model to read" — so the
 * missing half of the product is a second call that reads them and writes the
 * answer. Everything here is provider-shaped but framework-free: message
 * building, SSE parsing, citation extraction. The network call is one function
 * so the UI can stream straight into the DOM.
 */
import type { SearchResult } from './types.js';

export type ChatRole = 'system' | 'user';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface AnswerUsage {
  promptTokens: number;
  completionTokens: number;
}

export type AnswerErrorKind = 'auth' | 'payment' | 'rate' | 'network' | 'timeout' | 'server' | 'aborted' | 'unknown';

export class AnswerError extends Error {
  readonly kind: AnswerErrorKind;
  readonly status: number;

  constructor(kind: AnswerErrorKind, message: string, status = 0) {
    super(message);
    this.name = 'AnswerError';
    this.kind = kind;
    this.status = status;
  }
}

const SYSTEM_PROMPT = [
  '你是一个中文搜索助手。只依据用户给出的资料回答，不要使用资料之外的知识，不要编造。',
  '每个事实性论断后面用方括号标注来源编号，例如 [1] 或 [2][3]。',
  '如果资料不足以回答，直接说「资料中没有足够信息」，并说明还缺什么。',
  '用 3～5 句话、200 字以内作答；纯文本，不要标题、不要列表、不要 markdown。',
].join('\n');

/** Trim a summary to a token-cheap excerpt while keeping the opening claim. */
export function excerpt(text: string, limit = 420): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit - 1)}…`;
}

/**
 * Build the chat messages for one answer.
 *
 * Only the first `maxSources` results are used: they are the ranked ones, and a
 * longer context buys little while costing tokens on every answer.
 */
export function buildMessages(query: string, results: readonly SearchResult[], maxSources = 8): ChatMessage[] {
  const sources = results.slice(0, maxSources);
  const blocks = sources.map((result, index) => {
    const lines = [
      `[${index + 1}] ${result.title || result.url}`,
      result.site_name ? `站点：${result.site_name}` : '',
      result.date ? `时间：${result.date.slice(0, 10)}` : '',
      excerpt(result.summary || result.snippet || ''),
    ].filter((line) => line.length > 0);
    return lines.join('\n');
  });

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `问题：${query}\n\n资料：\n${blocks.join('\n\n')}` },
  ];
}

/**
 * Incremental Server-Sent Events parser.
 *
 * Chunk boundaries never line up with event boundaries, so state is kept across
 * calls; `\r\n` is normalised because some proxies rewrite the stream.
 */
export class SseParser {
  private buffer = '';

  /** Feed a chunk; returns complete `data:` payloads in arrival order. */
  push(chunk: string): string[] {
    this.buffer = (this.buffer + chunk).replace(/\r\n/g, '\n');
    const payloads: string[] = [];

    for (;;) {
      const boundary = this.buffer.indexOf('\n\n');
      if (boundary < 0) break;
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      for (const line of block.split('\n')) {
        const match = /^data:\s?(.*)$/.exec(line);
        if (match && match[1] !== undefined) payloads.push(match[1]);
      }
    }
    return payloads;
  }
}

export interface StreamAnswerOptions {
  endpoint: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
  fetchImpl?: typeof fetch;
  onDelta: (delta: string) => void;
}

export interface StreamAnswerResult {
  text: string;
  usage: AnswerUsage | null;
  finishReason: string | null;
}

function mapStatus(status: number, message: string): AnswerError {
  if (status === 401) return new AnswerError('auth', message || 'API Key 无效', status);
  if (status === 402) return new AnswerError('payment', message || '余额不足', status);
  if (status === 429) return new AnswerError('rate', message || '触发限速', status);
  if (status >= 500) return new AnswerError('server', message || `服务端错误（HTTP ${status}）`, status);
  return new AnswerError('unknown', message || `HTTP ${status}`, status);
}

/** Stream one answer; resolves with the full text once the stream ends. */
export async function streamAnswer(options: StreamAnswerOptions): Promise<StreamAnswerResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  if (!options.apiKey) throw new AnswerError('auth', '尚未设置 API Key');

  const response = await fetchImpl(options.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({
      model: options.model,
      messages: options.messages,
      stream: true,
      stream_options: { include_usage: true },
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 600,
    }),
    signal: options.signal,
  }).catch((error: unknown) => {
    if (options.signal?.aborted) throw new AnswerError('aborted', '已取消');
    throw new AnswerError('network', `网络错误：${error instanceof Error ? error.message : String(error)}`);
  });

  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const payload = (await response.json()) as { error?: { message?: string } };
      if (payload?.error?.message) message = payload.error.message;
    } catch {
      /* non-JSON error body */
    }
    throw mapStatus(response.status, message);
  }
  if (!response.body) throw new AnswerError('server', '响应没有可读取的正文');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();

  let text = '';
  let usage: AnswerUsage | null = null;
  let finishReason: string | null = null;

  const handlePayload = (payload: string): boolean => {
    if (payload === '[DONE]') return true;
    let parsed: {
      choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
    };
    try {
      parsed = JSON.parse(payload);
    } catch {
      return false; // keep-alive or vendor comment
    }
    const choice = parsed.choices?.[0];
    const delta = choice?.delta?.content;
    if (typeof delta === 'string' && delta.length > 0) {
      text += delta;
      options.onDelta(delta);
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (parsed.usage && typeof parsed.usage.prompt_tokens === 'number') {
      usage = {
        promptTokens: parsed.usage.prompt_tokens ?? 0,
        completionTokens: parsed.usage.completion_tokens ?? 0,
      };
    }
    return false;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const payload of parser.push(decoder.decode(value, { stream: true }))) {
        if (handlePayload(payload)) return { text, usage, finishReason };
      }
    }
  } catch (error) {
    if (options.signal?.aborted) throw new AnswerError('aborted', '已取消');
    throw new AnswerError('network', `读取响应失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    reader.releaseLock?.();
  }

  return { text, usage, finishReason };
}

/**
 * Source numbers actually cited, in ascending order.
 *
 * Out-of-range numbers are ignored: a model that hallucinates `[9]` with eight
 * sources must not produce a dead link.
 */
export function citationIndexes(text: string, maxSources: number): number[] {
  const found = new Set<number>();
  for (const match of (text ?? '').matchAll(/\[(\d{1,2})\]/g)) {
    const index = Number(match[1]);
    if (Number.isInteger(index) && index >= 1 && index <= maxSources) found.add(index);
  }
  return [...found].sort((a, b) => a - b);
}
