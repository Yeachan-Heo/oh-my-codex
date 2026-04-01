declare module '*tmux-hook-engine.js' {
  export const DEFAULT_ALLOWED_MODES: string[];
  export const DEFAULT_MARKER: string;

  export interface NormalizedTmuxTarget {
    type: 'session' | 'pane';
    value: string;
  }

  export interface NormalizedTmuxHookConfig {
    enabled: boolean;
    valid: boolean;
    reason: string;
    target: NormalizedTmuxTarget | null;
    allowed_modes: string[];
    cooldown_ms: number;
    max_injections_per_session: number;
    prompt_template: string;
    marker: string;
    dry_run: boolean;
    skip_if_scrolling: boolean;
    log_level: 'error' | 'info' | 'debug';
  }

  export function normalizeTmuxHookConfig(raw: unknown): NormalizedTmuxHookConfig;
  export function pickActiveMode(activeModes: string[], allowedModes: string[]): string | null;
  export function buildDedupeKey(args: {
    threadId?: string;
    turnId?: string;
    mode?: string;
    prompt?: string;
  }): string;
  export function evaluateInjectionGuards(args: {
    config: NormalizedTmuxHookConfig;
    mode: string | null;
    sourceText?: string;
    assistantMessage?: string;
    threadId?: string;
    turnId?: string;
    paneKey?: string;
    sessionKey?: string;
    skipQuotaChecks?: boolean;
    now: number;
    state: Record<string, unknown>;
  }): { allow: boolean; reason: string; dedupeKey?: string };
  export function buildCapturePaneArgv(paneTarget: string, tailLines?: number): string[];
  export function buildVisibleCapturePaneArgv(paneTarget: string): string[];
  export function normalizeTmuxCapture(value: unknown): string;
  export function paneIsBootstrapping(lines: string[] | string): boolean;
  export function paneLooksReady(captured: string): boolean;
  export function paneShowsCodexViewport(captured: string): boolean;
  export function paneHasActiveTask(captured: string): boolean;
  export function buildPaneInModeArgv(paneTarget: string): string[];
  export function buildPaneCurrentCommandArgv(paneTarget: string): string[];
  export function resolveCodexPane(): string;
  export function isPaneRunningShell(paneCurrentCommand: string): boolean;
  export function buildSendKeysArgv(args: {
    paneTarget: string;
    prompt: string;
    dryRun: boolean;
    submitKeyPresses?: number;
  }): { typeArgv: string[]; submitArgv: string[][] } | null;
}
