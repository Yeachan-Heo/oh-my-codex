import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelToolUse,
} from './provider.js';
import { defaultFetch, httpPostJson, type FetchLike } from './http.js';

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  id?: string;
  baseUrl?: string;
  apiVersion?: string;
  fetcher?: FetchLike;
  maxTokensDefault?: number;
}

interface AnthropicMessageRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  tools?: unknown;
}

interface AnthropicMessageResponse {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; name: string; input: unknown }
  >;
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | string;
  usage: { input_tokens: number; output_tokens: number };
}

export class AnthropicProvider implements ModelProvider {
  readonly id: string;
  private readonly opts: AnthropicProviderOptions;
  private readonly fetcher: FetchLike;

  constructor(opts: AnthropicProviderOptions) {
    this.opts = opts;
    this.id = opts.id ?? `anthropic:${opts.model}`;
    this.fetcher = opts.fetcher ?? defaultFetch;
  }

  async call(req: ModelRequest): Promise<ModelResponse> {
    const baseUrl = this.opts.baseUrl ?? 'https://api.anthropic.com';
    const body: AnthropicMessageRequest = {
      model: this.opts.model,
      max_tokens: req.maxTokens ?? this.opts.maxTokensDefault ?? 4096,
      ...(req.system ? { system: req.system } : {}),
      messages: req.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      ...(req.tools ? { tools: req.tools } : {}),
    };

    const response = await httpPostJson<AnthropicMessageResponse>(
      `${baseUrl}/v1/messages`,
      {
        'x-api-key': this.opts.apiKey,
        'anthropic-version': this.opts.apiVersion ?? '2023-06-01',
      },
      body,
      this.fetcher,
    );

    const textBlocks = response.content.filter((c): c is { type: 'text'; text: string } => c.type === 'text');
    const toolUse: ModelToolUse[] = response.content
      .filter((c): c is { type: 'tool_use'; name: string; input: unknown } => c.type === 'tool_use')
      .map((c) => ({ name: c.name, input: c.input }));

    const stopReason: ModelResponse['stopReason'] =
      response.stop_reason === 'tool_use'
        ? 'tool_use'
        : response.stop_reason === 'max_tokens'
          ? 'max_tokens'
          : 'end_turn';

    const result: ModelResponse = {
      content: textBlocks.map((b) => b.text).join(''),
      stopReason,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
    if (toolUse.length > 0) result.toolUse = toolUse;
    return result;
  }
}
