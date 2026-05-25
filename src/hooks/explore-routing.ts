export const OMX_EXPLORE_CMD_ENV = 'USE_OMX_EXPLORE_CMD';

const DISABLED_VALUES = new Set(['0', 'false', 'no', 'off']);

const SIMPLE_EXPLORATION_PATTERNS: RegExp[] = [
  /\b(where|find|locate|search|grep|ripgrep)\b/i,
  /\b(file|files|path|paths|symbol|symbols|usage|usages|reference|references)\b/i,
  /\b(pattern|patterns|match|matches|matching)\b/i,
  /\bhow does\b/i,
  /\bwhich\b.*\b(contain|contains|define|defines|use|uses)\b/i,
  /\b(read[- ]only|explor(e|ation)|inspect|lookup|look up|map)\b/i,
];

const NON_EXPLORATION_PATTERNS: RegExp[] = [
  /\b(implement|write|edit|modify|change|refactor|fix|patch|add|remove|delete)\b/i,
  /\b(build|create)\b.*\b(feature|system|workflow|integration|module)\b/i,
  /\b(migrate|rewrite|overhaul|redesign)\b/i,
  /\b(test|lint|typecheck|compile|deploy)\b/i,
];

export function isExploreCommandRoutingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[OMX_EXPLORE_CMD_ENV];
  if (typeof raw !== 'string') return true;
  return !DISABLED_VALUES.has(raw.trim().toLowerCase());
}

export function isSimpleExplorationPrompt(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (NON_EXPLORATION_PATTERNS.some((pattern) => pattern.test(trimmed))) return false;
  return SIMPLE_EXPLORATION_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function buildExploreRoutingGuidance(env: NodeJS.ProcessEnv = process.env): string {
  if (!isExploreCommandRoutingEnabled(env)) return '';
  return [
    'Syntax: omx explore --prompt "<prompt>" or omx explore --prompt-file <file>. Never use omx explore "<prompt>".',
    `**Explore Command Preference:** enabled via \`${OMX_EXPLORE_CMD_ENV}\` (default-on; opt out with \`0\`, \`false\`, \`no\`, or \`off\`)`,
    '- Advisory steering only: agents SHOULD treat `omx explore` as the default first stop for direct inspection and SHOULD reserve `omx sparkshell` for qualifying read-only shell-native tasks.',
    '- For simple file/symbol lookups, use `omx explore` FIRST before attempting full code analysis.',
    '- When the user asks for a simple read-only exploration task (file/symbol/pattern/relationship lookup), strongly prefer `omx explore` as the default surface.',
    '- Explore examples: `omx explore --prompt "which files define TeamPolicy"`, `omx explore --prompt "find usages of buildExploreRoutingGuidance"`.',
    '- SparkShell examples: use `omx sparkshell -- rg -n "TeamPolicy" src`, `omx sparkshell -- npm test`, or `omx sparkshell --tmux-pane %12` for noisy verification, bounded shell output, or tmux-pane summaries.',
    '- Keep `omx explore` prompts narrow and concrete; prefer a single lookup goal or a small related cluster, using `--prompt` for quick asks and `--prompt-file` for longer reusable briefs.',
    '- Treat `omx explore` as a shell-only allowlisted read-only path; keep edits, tests, diagnostics, MCP/web needs, and complex shell composition on the richer normal path.',
    '- Keep implementation, refactor, test, or ambiguous broad requests on the normal Codex path.',
    '- If `omx explore` is unavailable, stalls, or fails, retry with a narrower prompt or gracefully fall back to the normal path.',
  ].join("\n");
}
