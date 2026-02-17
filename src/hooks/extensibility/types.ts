export type HookSchemaVersion = '1';
export type HookEventSource = 'native' | 'derived';

export type HookEventName =
  | 'session-start'
  | 'session-end'
  | 'session-idle'
  | 'turn-complete'
  | 'needs-input'
  | 'pre-tool-use'
  | 'post-tool-use'
  | (string & {});

export interface HookEventEnvelope {
  schema_version: HookSchemaVersion;
  event: HookEventName;
  timestamp: string;
  source: HookEventSource;
  context: Record<string, unknown>;
  session_id?: string;
  thread_id?: string;
  turn_id?: string;
  mode?: string;
  confidence?: number;
  parser_reason?: string;
}

export interface HookPluginDescriptor {
  id: string;
  name: string;
  file: string;
  path: string;
  filePath: string;
  fileName: string;
  valid: boolean;
  reason?: string;
}

export interface HookPluginLogContext {
  timestamp?: string;
  event: string;
  plugin_id?: string;
  status?: string;
  reason?: string;
  source?: HookEventSource;
  [key: string]: unknown;
}

export interface HookPluginTmuxSendKeysOptions {
  paneId?: string;
  sessionName?: string;
  text: string;
  submit?: boolean;
  cooldownMs?: number;
}

export interface HookPluginTmuxSendKeysResult {
  ok: boolean;
  reason: string;
  target?: string;
  paneId?: string;
  error?: string;
}

// Backward-compatible aliases
export type HookPluginSendKeysOptions = HookPluginTmuxSendKeysOptions;
export type HookPluginSendKeysResult = HookPluginTmuxSendKeysResult;

export interface HookPluginSdk {
  tmux: {
    sendKeys: (options: HookPluginTmuxSendKeysOptions) => Promise<HookPluginTmuxSendKeysResult>;
  };
  log: {
    info: (message: string, meta?: Record<string, unknown>) => Promise<void>;
    warn: (message: string, meta?: Record<string, unknown>) => Promise<void>;
    error: (message: string, meta?: Record<string, unknown>) => Promise<void>;
  };
  state: {
    read: <T = unknown>(key: string, fallback?: T) => Promise<T | undefined>;
    write: (key: string, value: unknown) => Promise<void>;
    delete: (key: string) => Promise<void>;
    all: <T extends Record<string, unknown> = Record<string, unknown>>() => Promise<T>;
  };
}

export interface HookPluginModule {
  onHookEvent?: (event: HookEventEnvelope, sdk: HookPluginSdk) => unknown | Promise<unknown>;
}

export type HookPluginDispatchStatus =
  | 'ok'
  | 'timeout'
  | 'error'
  | 'invalid_export'
  | 'runner_error'
  | 'spawn_failed'
  | 'runner_missing'
  | 'skipped_team_worker'
  | 'skipped';

export interface HookPluginDispatchResult {
  plugin_id?: string;
  file?: string;
  status?: HookPluginDispatchStatus;
  duration_ms?: number;
  reason?: string;
  output?: unknown;
  error?: string;

  // Preferred rich result fields
  plugin: string;
  path: string;
  ok: boolean;
  durationMs: number;
  exitCode?: number | null;
  skipped?: boolean;
}

export interface HookDispatchResult {
  enabled: boolean;
  event: string;
  source?: HookEventSource;
  plugin_count?: number;
  reason?: string;
  results: HookPluginDispatchResult[];
}

export type HookDispatchSummary = HookDispatchResult;

export interface HookDispatchOptions {
  cwd?: string;
  event?: HookEventEnvelope;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  allowInTeamWorker?: boolean;
  allowTeamWorkerSideEffects?: boolean;
  sideEffectsEnabled?: boolean;
  enabled?: boolean;
}

export interface HookValidateOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface HookRuntimeDispatchInput {
  cwd: string;
  event: HookEventEnvelope;
  allowTeamWorkerSideEffects?: boolean;
  sideEffectsEnabled?: boolean;
}

export interface HookRuntimeDispatchResult {
  dispatched: boolean;
  reason: string;
  result: HookDispatchResult;
}
