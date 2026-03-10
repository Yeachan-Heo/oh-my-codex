export const OMX_EXPLORE_CMD_ENV = 'USE_OMX_EXPLORE_CMD';

const ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);

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
  return ENABLED_VALUES.has(raw.trim().toLowerCase());
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
    `**Explore Command Preference:** enabled via \`${OMX_EXPLORE_CMD_ENV}\``,
    '- When the user asks for a simple read-only exploration task (file/symbol/pattern/relationship lookup), strongly prefer `omx explore`.',
    '- Treat this as advisory steering in current OMX sessions unless a true prompt interception surface is available.',
    '- Keep implementation, refactor, test, or ambiguous broad requests on the normal Codex path.',
    '- If `omx explore` is unavailable or fails, gracefully fall back to the normal path.',
  ].join('\n');
}
