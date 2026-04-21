import {
  hashRequest,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from './provider.js';

export class UnrecordedPromptError extends Error {
  readonly hash: string;
  readonly request: ModelRequest;
  constructor(hash: string, request: ModelRequest) {
    super(
      `no recording found for prompt hash ${hash}. ` +
        `Run \`npm run record-fixtures\` to re-record. ` +
        `Messages: ${JSON.stringify(request.messages).slice(0, 200)}...`,
    );
    this.name = 'UnrecordedPromptError';
    this.hash = hash;
    this.request = request;
  }
}

export interface RecordingEntry {
  hash: string;
  response: ModelResponse;
  meta?: { recordedAt?: string; label?: string };
}

export interface FixtureProviderOptions {
  id?: string;
  recordings: ReadonlyArray<RecordingEntry>;
  onUnrecorded?: (hash: string, req: ModelRequest) => ModelResponse | undefined;
}

export class FixtureModelProvider implements ModelProvider {
  readonly id: string;
  private readonly byHash: Map<string, ModelResponse>;
  private readonly onUnrecorded:
    | ((hash: string, req: ModelRequest) => ModelResponse | undefined)
    | undefined;
  private readonly callLog: Array<{ hash: string; request: ModelRequest }> = [];

  constructor(options: FixtureProviderOptions) {
    this.id = options.id ?? 'fixture';
    this.byHash = new Map(options.recordings.map((r) => [r.hash, r.response]));
    this.onUnrecorded = options.onUnrecorded;
  }

  async call(request: ModelRequest): Promise<ModelResponse> {
    const hash = hashRequest(request);
    this.callLog.push({ hash, request });
    const hit = this.byHash.get(hash);
    if (hit) return hit;
    const fallback = this.onUnrecorded?.(hash, request);
    if (fallback) return fallback;
    throw new UnrecordedPromptError(hash, request);
  }

  calls(): ReadonlyArray<{ hash: string; request: ModelRequest }> {
    return this.callLog;
  }
}

export function recordEntry(request: ModelRequest, response: ModelResponse): RecordingEntry {
  return { hash: hashRequest(request), response };
}
