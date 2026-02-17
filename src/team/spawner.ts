/**
 * Configuration passed to a WorkerSpawner to build the CLI launch command.
 */
export interface SpawnConfig {
  teamName: string;
  workerName: string;
  workerIndex: number;
  modelInstructionsFile?: string;
  model?: string;
  workingDirectory?: string;
  shell: string;
  rcFile: string | null;
  /** Extra CLI arguments resolved by the caller (bypass flags, model overrides, etc.) */
  launchArgs: string[];
}

/**
 * Abstraction over CLI-specific worker spawning behavior.
 *
 * Each implementation knows how to:
 *  - Build the shell command for a tmux pane
 *  - Detect when the CLI looks ready (from captured pane content)
 *  - Provide environment variables for the worker process
 */
export interface WorkerSpawner {
  /** Build the shell command string to launch the CLI inside a tmux pane. */
  buildCommand(config: SpawnConfig): string;
  /** Return true if the captured tmux pane content indicates the CLI is ready for input. */
  isReady(paneContent: string): boolean;
  /** Build extra environment variables for the worker process. */
  buildEnv(config: SpawnConfig): Record<string, string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shellQuoteSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// CodexSpawner — extracted from the original buildWorkerStartupCommand logic
// ---------------------------------------------------------------------------

export class CodexSpawner implements WorkerSpawner {
  buildCommand(config: SpawnConfig): string {
    const codexArgs = config.launchArgs.map(shellQuoteSingle).join(' ');
    const codexInvocation = codexArgs.length > 0 ? `exec codex ${codexArgs}` : 'exec codex';
    const rcPrefix = config.rcFile ? `if [ -f ${config.rcFile} ]; then source ${config.rcFile}; fi; ` : '';
    const inner = `${rcPrefix}${codexInvocation}`;

    return `env OMX_TEAM_WORKER=${config.teamName}/worker-${config.workerIndex} ${shellQuoteSingle(config.shell)} -lc ${shellQuoteSingle(inner)}`;
  }

  isReady(paneContent: string): boolean {
    const content = paneContent.trimEnd();
    if (content === '') return false;

    const lines = content
      .split('\n')
      .map(l => l.replace(/\r/g, ''))
      .map(l => l.trimEnd())
      .filter(l => l.trim() !== '');

    const lastLine = lines.length > 0 ? lines[lines.length - 1] : '';
    if (/^\s*[>\u203a]\s*/.test(lastLine)) return true;

    // Codex TUI often renders a status bar/footer instead of a raw shell prompt.
    const hasCodexPromptLine = lines.some((line) => /^\s*\u203a\s*/u.test(line));
    const hasCodexStatus = lines.some((line) => /\bgpt-[\w.-]+\b/i.test(line) || /\b\d+% left\b/i.test(line));
    if (hasCodexPromptLine || hasCodexStatus) return true;

    return false;
  }

  buildEnv(config: SpawnConfig): Record<string, string> {
    return {
      OMX_TEAM_WORKER: `${config.teamName}/worker-${config.workerIndex}`,
    };
  }
}

// ---------------------------------------------------------------------------
// ClaudeCodeSpawner — new implementation for Claude Code workers
// ---------------------------------------------------------------------------

export class ClaudeCodeSpawner implements WorkerSpawner {
  buildCommand(config: SpawnConfig): string {
    const claudeArgs: string[] = ['--dangerously-skip-permissions'];

    // Pass model instructions via --system-prompt if a file is available
    if (config.modelInstructionsFile) {
      claudeArgs.push('--system-prompt', config.modelInstructionsFile);
    }

    // Forward any extra launch args (e.g. --model)
    for (const arg of config.launchArgs) {
      claudeArgs.push(arg);
    }

    const argsStr = claudeArgs.map(shellQuoteSingle).join(' ');
    const claudeInvocation = `exec claude ${argsStr}`;
    const rcPrefix = config.rcFile ? `if [ -f ${config.rcFile} ]; then source ${config.rcFile}; fi; ` : '';
    const inner = `${rcPrefix}${claudeInvocation}`;

    return `env OMX_TEAM_WORKER=${config.teamName}/worker-${config.workerIndex} CLAUDECODE=1 ${shellQuoteSingle(config.shell)} -lc ${shellQuoteSingle(inner)}`;
  }

  isReady(paneContent: string): boolean {
    const content = paneContent.trimEnd();
    if (content === '') return false;

    const lines = content
      .split('\n')
      .map(l => l.replace(/\r/g, ''))
      .map(l => l.trimEnd())
      .filter(l => l.trim() !== '');

    const lastLine = lines.length > 0 ? lines[lines.length - 1] : '';

    // Claude Code prompt markers: ">" at start, or "claude>" style prompt
    if (/^\s*>/.test(lastLine)) return true;
    if (/claude\s*>/i.test(lastLine)) return true;

    // Claude Code may show a prompt with a blinking cursor line
    // Look for typical ready indicators in the tail
    const tail = lines.slice(-10);
    const hasPromptIndicator = tail.some(
      (line) => /^\s*[>\u276f\u2771\u25b6]\s*$/u.test(line) || /^\s*\$\s*$/u.test(line),
    );
    if (hasPromptIndicator) return true;

    // If we see "Claude Code" branding without loading indicators, treat as ready
    const hasBranding = tail.some((line) => /claude\s*code/i.test(line));
    const hasLoading = tail.some(
      (line) => /loading|starting|initializing|connecting/i.test(line),
    );
    if (hasBranding && !hasLoading) return true;

    return false;
  }

  buildEnv(config: SpawnConfig): Record<string, string> {
    return {
      OMX_TEAM_WORKER: `${config.teamName}/worker-${config.workerIndex}`,
      CLAUDECODE: '1',
    };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const spawnerInstances: Record<string, WorkerSpawner> = {
  codex: new CodexSpawner(),
  claude: new ClaudeCodeSpawner(),
};

/**
 * Get the WorkerSpawner for a given provider name.
 * Defaults to "codex" for backward compatibility.
 */
export function getSpawner(provider?: string): WorkerSpawner {
  const key = (provider || 'codex').toLowerCase();
  const spawner = spawnerInstances[key];
  if (!spawner) {
    throw new Error(`Unknown worker provider: ${provider}`);
  }
  return spawner;
}
