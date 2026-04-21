import type { ModelProvider, ModelRequest, ModelResponse } from './provider.js';
import { defaultFetch, httpPostJson, type FetchLike } from './http.js';

export interface OpenAICompatibleOptions {
  apiKey: string;
  model: string;
  id?: string;
  baseUrl: string;
  fetcher?: FetchLike;
  maxTokensDefault?: number;
}

interface ChatCompletionRequest {
  model: string;
  max_tokens?: number;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
}

interface ChatCompletionResponse {
  choices: Array<{
    message: { content: string };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  private readonly opts: OpenAICompatibleOptions;
  private readonly fetcher: FetchLike;

  constructor(opts: OpenAICompatibleOptions) {
    this.opts = opts;
    this.id = opts.id ?? `openai-compat:${opts.baseUrl}:${opts.model}`;
    this.fetcher = opts.fetcher ?? defaultFetch;
  }

  async call(req: ModelRequest): Promise<ModelResponse> {
    const messages: ChatCompletionRequest['messages'] = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    for (const m of req.messages) {
      messages.push({ role: m.role, content: m.content });
    }

    const body: ChatCompletionRequest = {
      model: this.opts.model,
      messages,
      ...(req.maxTokens || this.opts.maxTokensDefault
        ? { max_tokens: req.maxTokens ?? this.opts.maxTokensDefault }
        : {}),
    };

    const response = await httpPostJson<ChatCompletionResponse>(
      `${this.opts.baseUrl}/chat/completions`,
      { authorization: `Bearer ${this.opts.apiKey}` },
      body,
      this.fetcher,
    );

    const choice = response.choices[0];
    if (!choice) throw new Error('openai-compatible response has no choices');

    const stopReason: ModelResponse['stopReason'] =
      choice.finish_reason === 'length'
        ? 'max_tokens'
        : choice.finish_reason === 'tool_calls'
          ? 'tool_use'
          : 'end_turn';

    return {
      content: choice.message.content,
      stopReason,
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    };
  }
}

export function groqProvider(opts: { apiKey: string; model: string; fetcher?: FetchLike; id?: string }): ModelProvider {
  const { apiKey, model, fetcher, id } = opts;
  const providerOpts: OpenAICompatibleOptions = {
    apiKey,
    model,
    baseUrl: 'https://api.groq.com/openai/v1',
    ...(fetcher ? { fetcher } : {}),
    id: id ?? `groq:${model}`,
  };
  return new OpenAICompatibleProvider(providerOpts);
}

export function fireworksProvider(opts: { apiKey: string; model: string; fetcher?: FetchLike; id?: string }): ModelProvider {
  const { apiKey, model, fetcher, id } = opts;
  const providerOpts: OpenAICompatibleOptions = {
    apiKey,
    model,
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    ...(fetcher ? { fetcher } : {}),
    id: id ?? `fireworks:${model}`,
  };
  return new OpenAICompatibleProvider(providerOpts);
}

export function togetherProvider(opts: { apiKey: string; model: string; fetcher?: FetchLike; id?: string }): ModelProvider {
  const { apiKey, model, fetcher, id } = opts;
  const providerOpts: OpenAICompatibleOptions = {
    apiKey,
    model,
    baseUrl: 'https://api.together.xyz/v1',
    ...(fetcher ? { fetcher } : {}),
    id: id ?? `together:${model}`,
  };
  return new OpenAICompatibleProvider(providerOpts);
}

export function openaiProvider(opts: { apiKey: string; model: string; fetcher?: FetchLike; id?: string }): ModelProvider {
  const { apiKey, model, fetcher, id } = opts;
  const providerOpts: OpenAICompatibleOptions = {
    apiKey,
    model,
    baseUrl: 'https://api.openai.com/v1',
    ...(fetcher ? { fetcher } : {}),
    id: id ?? `openai:${model}`,
  };
  return new OpenAICompatibleProvider(providerOpts);
}
