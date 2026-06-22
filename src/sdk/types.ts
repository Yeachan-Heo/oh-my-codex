export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue | undefined }

export type OmxApiBackend = 'mock' | 'real-private';

export interface OmxDaemonState {
  pid: number;
  host: string;
  port: number;
  backend: OmxApiBackend;
  started_at_unix: number;
  local_bearer_token_file?: string;
}

export interface OmxHealth {
  status: 'ok' | string;
  backend: OmxApiBackend | string;
}

export interface OmxTelemetrySnapshot {
  requests_total: number;
  by_route: Record<string, number>;
}

export interface OmxModel {
  id: string;
  object: 'model' | string;
  owned_by?: string;
  [key: string]: unknown;
}

export interface OmxModelList {
  object: 'list' | string;
  data: OmxModel[];
}


export interface OmxTransportOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export interface OmxResponseRequest {
  model?: string;
  input: string | Array<Record<string, unknown>> | Record<string, unknown>;
  instructions?: string;
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  reasoning?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface OmxResponseResult {
  id?: string;
  object?: string;
  model?: string;
  backend?: string;
  output_text?: string;
  choices?: Array<{
    index?: number;
    message?: { role?: string; content?: string };
    finish_reason?: string | null;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export interface OmxChatCompletionRequest {
  model?: string;
  messages: Array<{ role: string; content: string | unknown[]; [key: string]: unknown }>;
  stream?: boolean;
  [key: string]: unknown;
}

export interface OmxChatCompletionResult {
  id?: string;
  object?: string;
  model?: string;
  backend?: string;
  choices?: Array<{
    index?: number;
    message?: { role?: string; content?: string };
    delta?: { content?: string; [key: string]: unknown };
    finish_reason?: string | null;
    [key: string]: unknown;
  }>;
  output_text?: string;
  [key: string]: unknown;
}

export interface OmxImageGenerationRequest {
  prompt: string;
  model?: string;
  n?: number;
  size?: string;
  stream?: boolean;
  quality?: string;
  response_format?: 'url' | 'b64_json' | string;
  style?: string;
  user?: string;
  [key: string]: unknown;
}

export interface OmxGeneratedImage {
  url?: string;
  b64_json?: string;
  revised_prompt?: string;
  [key: string]: unknown;
}

export interface OmxImageGenerationResult {
  created?: number;
  backend?: string;
  data: OmxGeneratedImage[];
  [key: string]: unknown;
}

export interface OmxApiErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface OmxSseEvent<T = unknown> {
  event?: string;
  data: T;
  raw: string;
}

export interface OmxSessionState {
  session_id: string;
  native_session_id?: string;
  cwd?: string;
  started_at?: string;
  pid?: number;
  tmux_pane_id?: string;
  tmux_session_name?: string;
  [key: string]: unknown;
}

export interface OmxHudState {
  last_turn_at?: string;
  turn_count?: number;
  last_agent_output?: string;
  [key: string]: unknown;
}

export interface OmxModeStateRef<T = unknown> {
  mode: string;
  path: string;
  scope: 'root' | 'session';
  state: T | null;
}
