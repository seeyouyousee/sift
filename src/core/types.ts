/** Wire types for the DeepSeek Search / Fetch APIs. */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  summary: string;
  content: string;
  site_name: string | null;
  site_icon: string | null;
  date: string | null;
  authority: number;
  rerank_score: number;
}

export interface SearchResponse {
  results: SearchResult[];
}

export interface FetchResponse {
  title: string;
  content: string;
}

/**
 * Coarse failure classes. The UI maps each to one actionable sentence, so adding
 * a class here is the only place error copy needs to change.
 */
export type ApiErrorKind =
  | 'auth'
  | 'payment'
  | 'forbidden'
  | 'rate'
  | 'timeout'
  | 'aborted'
  | 'network'
  | 'server'
  | 'bad-request'
  /** The fetch endpoint could not extract the page (404): blocked, paywalled, JS-only. */
  | 'unfetchable'
  | 'unknown';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number;
  readonly code: string | undefined;

  constructor(kind: ApiErrorKind, message: string, status = 0, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.code = code;
  }

  /** Whether retrying the same request could plausibly succeed. */
  get retriable(): boolean {
    return this.kind === 'rate' || this.kind === 'server' || this.kind === 'network';
  }
}

/** Normalise an unknown thrown value into an ApiError. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof Error) return new ApiError('unknown', error.message);
  return new ApiError('unknown', String(error));
}
