import type { IncomingMessage, Server, ServerResponse } from 'node:http';

export interface ProxyOptions {
  upstream?: string;
  apiKey?: string;
  qps?: number;
  maxWaitMs?: number;
  allowOrigin?: string;
  maxBodyBytes?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function createProxy(options?: ProxyOptions): Server;

export type { IncomingMessage, ServerResponse };
