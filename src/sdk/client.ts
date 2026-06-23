import { lstat, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { homedir } from 'node:os';
import { OmxHttpTransport, parseSseStream, type OmxFetch } from './http.js';
import { daemonBaseUrl, daemonHostsMatch, isLoopbackHost, processIsAlive, tokenPathAllowedForState } from './internal.js';
import type {
  OmxChatCompletionRequest,
  OmxChatCompletionResult,
  OmxDaemonState,
  OmxGeneratedImage,
  OmxHealth,
  OmxImageGenerationRequest,
  OmxImageGenerationResult,
  OmxModelList,
  OmxResponseRequest,
  OmxResponseResult,
  OmxSseEvent,
  OmxTelemetrySnapshot,
  OmxTransportOptions,
} from './types.js';

export const DEFAULT_OMX_API_PORT = 14510;

export interface OmxClientOptions {
  baseUrl?: string;
  bearerToken?: string;
  fetchImpl?: OmxFetch;
  timeoutMs?: number;
}

export interface OmxClientDiscoveryOptions extends OmxClientOptions {
  stateFile?: string;
  env?: NodeJS.ProcessEnv;
}

export function defaultOmxApiStateFile(): string {
  return join(homedir(), '.omx', 'state', 'api', 'omx-api-daemon.json');
}

export function daemonTokenFileForState(stateFile: string): string {
  const extension = extname(stateFile);
  if (!extension) return `${stateFile}.token`;
  return `${stateFile.slice(0, -extension.length)}.token`;
}

export async function readOmxDaemonState(stateFile = defaultOmxApiStateFile()): Promise<OmxDaemonState | null> {
  try {
    const parsed = JSON.parse(await readFile(stateFile, 'utf-8')) as unknown;
    return isDaemonState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function readOmxDaemonToken(stateFile = defaultOmxApiStateFile()): Promise<string | undefined> {
  const state = await readOmxDaemonState(stateFile);
  if (!state) return undefined;
  return await readOmxDaemonTokenForState(state, stateFile);
}

async function readOmxDaemonTokenForState(state: OmxDaemonState, stateFile: string): Promise<string | undefined> {
  const tokenPath = state.local_bearer_token_file ?? daemonTokenFileForState(stateFile);
  if (!tokenPathAllowedForState(tokenPath, stateFile)) return undefined;
  try {
    if (!await tokenFileIsSafe(tokenPath)) return undefined;
    const token = (await readFile(tokenPath, 'utf-8')).trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

export async function resolveOmxApiClientOptions(options: OmxClientDiscoveryOptions = {}): Promise<Required<Pick<OmxClientOptions, 'baseUrl'>> & Pick<OmxClientOptions, 'bearerToken' | 'fetchImpl' | 'timeoutMs'>> {
  const env = options.env ?? process.env;
  const envStateFile = env.OMX_API_STATE_FILE?.trim();
  const stateFile = options.stateFile ?? (envStateFile || defaultOmxApiStateFile());
  const explicitToken = () => options.bearerToken;
  const localEnvToken = () => env.OMX_API_LOCAL_BEARER;
  const tokenForBaseUrl = async (baseUrl: string) => explicitToken() ?? await readOmxDaemonTokenForBaseUrl(baseUrl, stateFile);
  if (options.baseUrl) {
    return {
      baseUrl: options.baseUrl,
      bearerToken: await tokenForBaseUrl(options.baseUrl),
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    };
  }
  const envBaseUrl = env.OMX_API_BASE_URL?.trim();
  if (envBaseUrl) {
    return {
      baseUrl: envBaseUrl,
      bearerToken: await tokenForBaseUrl(envBaseUrl),
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    };
  }
  const state = await readLiveOmxDaemonState(stateFile);
  const fallbackPort = parseOmxApiPort(env.OMX_API_PORT);
  return {
    baseUrl: state ? daemonBaseUrl(state.host, state.port) : `http://127.0.0.1:${fallbackPort}`,
    bearerToken: state ? explicitToken() ?? localEnvToken() ?? await readOmxDaemonTokenForState(state, stateFile) : explicitToken() ?? localEnvToken(),
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  };
}

async function readOmxDaemonTokenForBaseUrl(baseUrl: string, stateFile: string): Promise<string | undefined> {
  const state = await readLiveOmxDaemonState(stateFile);
  if (!state || !baseUrlMatchesDaemonState(baseUrl, state)) return undefined;
  return await readOmxDaemonTokenForState(state, stateFile);
}

async function readLiveOmxDaemonState(stateFile: string): Promise<OmxDaemonState | null> {
  const state = await readOmxDaemonState(stateFile);
  return state && processIsAlive(state.pid) ? state : null;
}

function baseUrlMatchesDaemonState(baseUrl: string, state: OmxDaemonState): boolean {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:') return false;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return false;
    if (parsed.pathname.replace(/\/+$/, '') !== '') return false;
    const port = parsed.port ? Number(parsed.port) : 80;
    return daemonHostsMatch(parsed.hostname, state.host) && port === state.port;
  } catch {
    return false;
  }
}

async function tokenFileIsSafe(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) return false;
    if (!stats.isFile()) return false;
    if (process.platform !== 'win32') {
      if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) return false;
      if ((stats.mode & 0o077) !== 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function parseOmxApiPort(raw: string | undefined): number {
  if (!raw) return DEFAULT_OMX_API_PORT;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535
    ? parsed
    : DEFAULT_OMX_API_PORT;
}

function isDaemonState(value: unknown): value is OmxDaemonState {
  const port = (value as OmxDaemonState | undefined)?.port;
  const host = (value as OmxDaemonState | undefined)?.host;
  const backend = (value as OmxDaemonState | undefined)?.backend;
  const startedAt = (value as OmxDaemonState | undefined)?.started_at_unix;
  const tokenFile = (value as OmxDaemonState | undefined)?.local_bearer_token_file;
  return Boolean(
    value
      && typeof value === 'object'
      && !Array.isArray(value)
      && typeof (value as OmxDaemonState).pid === 'number'
      && Number.isInteger((value as OmxDaemonState).pid)
      && (value as OmxDaemonState).pid > 0
      && typeof host === 'string'
      && isLoopbackHost(host)
      && (backend === 'mock' || backend === 'real-private')
      && typeof startedAt === 'number'
      && Number.isFinite(startedAt)
      && typeof port === 'number'
      && Number.isInteger(port)
      && port > 0
      && port <= 65_535
      && (tokenFile === undefined || typeof tokenFile === 'string'),
  );
}

type RequestPayload = Record<string, unknown>;

function requestBody<T extends RequestPayload>(request: T, stream: boolean): RequestPayload {
  const {
    signal: _signal,
    timeoutMs: _timeoutMs,
    headers: _headers,
    method: _method,
    path: _path,
    accept: _accept,
    fetchImpl: _fetchImpl,
    ...payload
  } = request as T & {
    signal?: unknown;
    timeoutMs?: unknown;
    headers?: unknown;
    method?: unknown;
    path?: unknown;
    accept?: unknown;
    fetchImpl?: unknown;
  };
  return { ...payload, stream };
}

function requestOptions(options: OmxTransportOptions = {}, accept?: string): OmxTransportOptions & { accept?: string } {
  return {
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(typeof options.timeoutMs === 'number' ? { timeoutMs: options.timeoutMs } : {}),
    ...(accept ? { accept } : {}),
  };
}

function extractText(result: OmxResponseResult | OmxChatCompletionResult): string {
  const firstChoice = result.choices?.[0] as {
    message?: { content?: string };
    delta?: { content?: string };
  } | undefined;
  return result.output_text
    ?? firstChoice?.message?.content
    ?? firstChoice?.delta?.content
    ?? '';
}

export class OmxClient {
  private readonly transport: OmxHttpTransport;

  constructor(options: OmxClientOptions = {}) {
    this.transport = new OmxHttpTransport({
      baseUrl: options.baseUrl ?? `http://127.0.0.1:${DEFAULT_OMX_API_PORT}`,
      bearerToken: options.bearerToken,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    });
  }

  static async fromEnv(options: OmxClientDiscoveryOptions = {}): Promise<OmxClient> {
    return new OmxClient(await resolveOmxApiClientOptions(options));
  }

  health(): Promise<OmxHealth> {
    return this.transport.requestJson<OmxHealth>({ path: '/health' });
  }

  models(): Promise<OmxModelList> {
    return this.transport.requestJson<OmxModelList>({ path: '/v1/models' });
  }

  telemetry(): Promise<OmxTelemetrySnapshot> {
    return this.transport.requestJson<OmxTelemetrySnapshot>({ path: '/__admin/telemetry' });
  }

  async stop(): Promise<{ status: string; [key: string]: unknown }> {
    return await this.transport.requestJson<{ status: string; [key: string]: unknown }>({
      method: 'POST',
      path: '/__admin/stop',
      body: {},
    });
  }

  responses = {
    create: (request: OmxResponseRequest, options: OmxTransportOptions = {}): Promise<OmxResponseResult> => this.transport.requestJson<OmxResponseResult>({
      method: 'POST',
      path: '/v1/responses',
      body: requestBody(request, false),
      ...requestOptions(options),
    }),
    stream: async (request: OmxResponseRequest, options: OmxTransportOptions = {}): Promise<AsyncGenerator<OmxSseEvent>> => {
      const response = await this.transport.requestRaw({
        method: 'POST',
        path: '/v1/responses',
        body: requestBody(request, true),
        ...requestOptions(options, 'text/event-stream'),
      });
      return parseSseStream(response, { signal: options.signal });
    },
  };

  chat = {
    completions: {
      create: (request: OmxChatCompletionRequest, options: OmxTransportOptions = {}): Promise<OmxChatCompletionResult> => this.transport.requestJson<OmxChatCompletionResult>({
        method: 'POST',
        path: '/v1/chat/completions',
        body: requestBody(request, false),
        ...requestOptions(options),
      }),
      stream: async (request: OmxChatCompletionRequest, options: OmxTransportOptions = {}): Promise<AsyncGenerator<OmxSseEvent>> => {
        const response = await this.transport.requestRaw({
          method: 'POST',
          path: '/v1/chat/completions',
          body: requestBody(request, true),
          ...requestOptions(options, 'text/event-stream'),
        });
        return parseSseStream(response, { signal: options.signal });
      },
    },
  };

  images = {
    generate: (request: OmxImageGenerationRequest, options: OmxTransportOptions = {}): Promise<OmxImageGenerationResult> => this.transport.requestJson<OmxImageGenerationResult>({
      method: 'POST',
      path: '/v1/images/generations',
      body: requestBody(request, false),
      ...requestOptions(options),
    }),
    stream: async (request: OmxImageGenerationRequest, options: OmxTransportOptions = {}): Promise<AsyncGenerator<OmxSseEvent>> => {
      const response = await this.transport.requestRaw({
        method: 'POST',
        path: '/v1/images/generations',
        body: requestBody(request, true),
        ...requestOptions(options, 'text/event-stream'),
      });
      return parseSseStream(response, { signal: options.signal });
    },
  };

  async generateText(prompt: string, request: Omit<OmxResponseRequest, 'input'> = {}, options: OmxTransportOptions = {}): Promise<string> {
    return extractText(await this.responses.create({ ...request, input: prompt }, options));
  }

  async generateImage(prompt: string, request: Omit<OmxImageGenerationRequest, 'prompt'> = {}, options: OmxTransportOptions = {}): Promise<OmxGeneratedImage | undefined> {
    return (await this.images.generate({ ...request, prompt }, options)).data[0];
  }
}
