import { OmxHttpError, OmxSdkError, OmxTimeoutError, parseErrorBody } from './errors.js';
import type { OmxSseEvent } from './types.js';

export type OmxFetch = typeof fetch;

export interface OmxRequestOptions {
  method?: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  accept?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface OmxHttpTransportOptions {
  baseUrl: string;
  bearerToken?: string;
  fetchImpl?: OmxFetch;
  timeoutMs?: number;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function joinUrl(baseUrl: string, path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${trimTrailingSlash(baseUrl)}${normalizedPath}`;
}

function createTimeoutSignal(timeoutMs: number | undefined, signal?: AbortSignal): {
  signal?: AbortSignal;
  cleanup: () => void;
  timedOut: () => boolean;
} {
  if (!timeoutMs || timeoutMs <= 0) return { signal, cleanup: () => {}, timedOut: () => false };
  const controller = new AbortController();
  let didTimeout = false;
  const timeout = setTimeout(() => {
    didTimeout = true;
    controller.abort(new OmxTimeoutError());
  }, timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    cleanup: () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

async function assertOk(response: Response): Promise<void> {
  if (response.ok) return;
  const bodyText = await response.text();
  throw new OmxHttpError({
    status: response.status,
    statusText: response.statusText,
    bodyText,
    body: parseErrorBody(bodyText),
  });
}

export class OmxHttpTransport {
  readonly baseUrl: string;
  readonly bearerToken?: string;
  readonly timeoutMs?: number;
  private readonly fetchImpl: OmxFetch;

  constructor(options: OmxHttpTransportOptions) {
    this.baseUrl = trimTrailingSlash(options.baseUrl || 'http://127.0.0.1:14510');
    this.bearerToken = options.bearerToken;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async requestRaw(options: OmxRequestOptions): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: options.accept ?? 'application/json',
      ...options.headers,
    };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] ??= 'application/json';
      body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    }
    if (this.bearerToken) headers.Authorization = `Bearer ${this.bearerToken}`;

    const timeout = createTimeoutSignal(options.timeoutMs ?? this.timeoutMs, options.signal);
    try {
      const response = await this.fetchImpl(joinUrl(this.baseUrl, options.path), {
        method: options.method ?? (body === undefined ? 'GET' : 'POST'),
        headers,
        body,
        signal: timeout.signal,
      });
      await assertOk(response);
      return response;
    } catch (error) {
      if (error instanceof OmxTimeoutError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') {
        if (timeout.timedOut()) throw new OmxTimeoutError('OMX SDK request timed out', { cause: error });
        if (options.signal?.reason instanceof Error) throw options.signal.reason;
        throw new OmxSdkError('OMX SDK request was aborted', { cause: error });
      }
      throw error;
    } finally {
      timeout.cleanup();
    }
  }

  async requestJson<T>(options: OmxRequestOptions): Promise<T> {
    const response = await this.requestRaw(options);
    return await response.json() as T;
  }
}

export async function* parseSseStream<T = unknown>(response: Response): AsyncGenerator<OmxSseEvent<T>> {
  if (!response.body) return;
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of responseBodyChunks(response.body)) {
    buffer += decoder.decode(chunk, { stream: true });
    let separator = findSseFrameSeparator(buffer);
    while (separator) {
      const frame = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator.length);
      const event = parseSseFrame<T>(frame);
      if (event) yield event;
      separator = findSseFrameSeparator(buffer);
    }
  }
  buffer += decoder.decode();
  const trailing = parseSseFrame<T>(buffer.trim());
  if (trailing) yield trailing;
}

interface ReadableStreamReaderLike {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>;
  releaseLock?: () => void;
}

interface ReadableStreamLike {
  getReader: () => ReadableStreamReaderLike;
}

function hasReader(body: unknown): body is ReadableStreamLike {
  return Boolean(body && typeof body === 'object' && 'getReader' in body && typeof (body as ReadableStreamLike).getReader === 'function');
}

async function* responseBodyChunks(body: Response['body']): AsyncGenerator<Uint8Array> {
  if (hasReader(body)) {
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) yield value;
      }
    } finally {
      reader.releaseLock?.();
    }
    return;
  }

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    yield chunk;
  }
}

function findSseFrameSeparator(buffer: string): { index: number; length: number } | null {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return null;
  if (lf !== -1 && (crlf === -1 || lf < crlf)) return { index: lf, length: 2 };
  return { index: crlf, length: 4 };
}

export function parseSseFrame<T = unknown>(frame: string): OmxSseEvent<T> | null {
  const trimmed = frame.trim();
  if (!trimmed) return null;
  let eventName: string | undefined;
  const dataLines: string[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith('event:')) eventName = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trimStart());
  }
  const rawData = dataLines.join('\n');
  if (!rawData || rawData === '[DONE]') return null;
  let data: T;
  try {
    data = JSON.parse(rawData) as T;
  } catch {
    data = rawData as T;
  }
  return { event: eventName, data, raw: trimmed };
}
