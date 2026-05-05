export const OMX_EXPLORE_CMD_ENV = 'USE_OMX_EXPLORE_CMD';

const DISABLED_VALUES = new Set(['0', 'false', 'no', 'off']);

const SIMPLE_EXPLORATION_PATTERNS: RegExp[] = [
  /\b(where|find|locate|search|grep|ripgrep)\b/i,
  /\b(file|files|path|paths|symbol|symbols|usage|usages|reference|references)\b/i,
  /\b(pattern|patterns|match|matches|matching)\b/i,
  /\bhow does\b/i,
  /\bwhich\b.*\b(contain|contains|define|defines|use|uses)\b/i,
  /\b(read[- ]only|explor(e|ation)|inspect|lookup|look up|map)\b/i,
  /(?:이\s*레포|현재\s*레포|로컬\s*코드베이스|어디\s*(?:있|구현)|찾아줘)/i,
];

const NON_EXPLORATION_PATTERNS: RegExp[] = [
  /\b(implement|write|edit|modify|change|refactor|fix|patch|add|remove|delete)\b/i,
  /\b(build|create)\b.*\b(feature|system|workflow|integration|module)\b/i,
  /\b(migrate|rewrite|overhaul|redesign)\b/i,
  /\b(test|lint|typecheck|compile|deploy)\b/i,
];

const EXTERNAL_REFERENCE_RESEARCH_PATTERNS: RegExp[] = [
  /\b(?:official docs?|api reference|release notes?|changelog|version compatibility)\b/i,
  /\b(?:github|oss|open[- ]source|similar projects?|reference implementation|implementation examples?|best implementation|production pattern|in the wild)\b/i,
  /(?:공식\s*문서|릴리즈\s*노트|변경로그|버전\s*호환|깃허브|GitHub|오픈소스|OSS|비슷한\s*(?:프로젝트|구현)|구현\s*사례|레퍼런스|참고\s*구현|좋은\s*구현)/i,
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
  if (isExternalReferenceResearchPrompt(trimmed)) return false;
  return SIMPLE_EXPLORATION_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function isExternalReferenceResearchPrompt(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (NON_EXPLORATION_PATTERNS.some((pattern) => pattern.test(trimmed))) return false;
  return EXTERNAL_REFERENCE_RESEARCH_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function buildExploreRoutingGuidance(env: NodeJS.ProcessEnv = process.env): string {
  if (!isExploreCommandRoutingEnabled(env)) return '';
  return [
    `**Explore Command Preference:** enabled via \`${OMX_EXPLORE_CMD_ENV}\` (default-on; opt out with \`0\`, \`false\`, \`no\`, or \`off\`)`,
    '- Advisory steering only: agents SHOULD treat `omx explore` as the default first stop for direct inspection and SHOULD reserve `omx sparkshell` for qualifying read-only shell-native tasks.',
    '- For simple file/symbol lookups, use `omx explore` FIRST before attempting full code analysis.',
    '- When the user asks for a simple read-only exploration task (file/symbol/pattern/relationship lookup), strongly prefer `omx explore` as the default surface.',
    '- When the user asks for official docs, release history, or GitHub/OSS implementation references, prefer the `researcher` role; GitHub/OSS precedent requests activate researcher Librarian Mode rather than repo-local `explore`.',
    '- Explore examples: `omx explore --prompt "which files define TeamPolicy"`, `omx explore --prompt "find usages of buildExploreRoutingGuidance"`.',
    '- SparkShell examples: use `omx sparkshell -- rg -n "TeamPolicy" src`, `omx sparkshell -- npm test`, or `omx sparkshell --tmux-pane %12` for noisy verification, bounded shell output, or tmux-pane summaries.',
    '- Keep `omx explore` prompts narrow and concrete; prefer a single lookup goal or a small related cluster, using `--prompt` for quick asks and `--prompt-file` for longer reusable briefs.',
    '- Treat `omx explore` as a shell-only allowlisted read-only path; keep edits, tests, diagnostics, MCP/web needs, and complex shell composition on the richer normal path.',
    '- Keep implementation, refactor, test, or ambiguous broad requests on the normal Codex path.',
    '- If `omx explore` is unavailable, stalls, or fails, retry with a narrower prompt or gracefully fall back to the normal path.',
  ].join("\n");
}
