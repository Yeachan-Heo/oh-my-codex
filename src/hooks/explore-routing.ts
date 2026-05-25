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
  if (typeof raw !== 'string') return false;
  return !DISABLED_VALUES.has(raw.trim().toLowerCase());
}

export function isSimpleExplorationPrompt(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (NON_EXPLORATION_PATTERNS.some((pattern) => pattern.test(trimmed))) return false;
  return SIMPLE_EXPLORATION_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function buildExploreRoutingGuidance(env: NodeJS.ProcessEnv = process.env): string {
  const explicitlyEnabled = isExploreCommandRoutingEnabled(env);
  return [
    '**Explore Command Deprecated:** `omx explore` is deprecated and MUST NOT be recommended for new repository lookup work.',
    `- \`${OMX_EXPLORE_CMD_ENV}\` is compatibility-only; unset/default is disabled. Truthy values keep legacy callers working but do not make \`omx explore\` preferred.`,
    '- Replacement path: use normal Codex repository inspection tools/subagents; use `omx sparkshell -- <command>` only for explicit shell-native read-only evidence or `--tmux-pane` summaries.',
    explicitlyEnabled
      ? '- Compatibility routing is explicitly enabled; still prefer the replacement path.'
      : '- Compatibility routing is not enabled; do not route simple lookups to `omx explore`.',
  ].join("\n");
}
