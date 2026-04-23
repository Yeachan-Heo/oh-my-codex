/**
 * Triage Heuristic
 *
 * Pure, synchronous classifier for a 3-lane prompt triage system.
 * Advisory-only — never activates workflows, never touches state or fs.
 *
 * Lanes:
 *   PASS  — trivial acknowledgements, explicit opt-out phrases, or ambiguous short prompts
 *   LIGHT — single-agent destination: explore | executor | designer | researcher
 *   HEAVY — autopilot; longer goal-shaped imperative prompts
 */

export type TriageLane = "HEAVY" | "LIGHT" | "PASS";
export type LightDestination = "explore" | "executor" | "designer" | "researcher";

export interface TriageDecision {
  lane: TriageLane;
  destination?: LightDestination | "autopilot";
  reason: string;
}

// ---------------------------------------------------------------------------
// Module-scope constants (precompiled once)
// ---------------------------------------------------------------------------

/** Prompts that are trivially empty acknowledgements */
const TRIVIAL_PATTERNS: RegExp[] = [
  /^(?:hi+|hey|hello|thanks?|thank\s+you|yes|no|ok(?:ay)?|sure|great|good|got\s+it|sounds?\s+good|yep|yup|nope|cool|awesome|perfect)\.?$/,
];

/** Explicit opt-out substrings — checked as case-insensitive includes */
const OPT_OUT_PHRASES: readonly string[] = [
  "just chat",
  "plain answer",
  "no workflow",
  "don't route",
  "do not route",
  "don't use a skill",
  "do not use a skill",
  "talk through",
  "explain only",
];

/** Starters that indicate an explanatory / question prompt → LIGHT/explore */
const EXPLORE_STARTERS: readonly string[] = [
  "explain ",
  "what ",
  "where ",
  "why ",
  "how does ",
  "how do ",
  "how is ",
  "tell me about ",
  "describe ",
  "show me how ",
  "can you explain ",
  "could you explain ",
];

/** External docs/reference lookup prompts → LIGHT/researcher */
const RESEARCHER_EXTERNAL_SIGNALS: RegExp[] = [
  /\b(?:official docs?|upstream docs?|vendor docs?|api docs?|reference docs?|release notes?|changelog|version(?:ing)?|compatib(?:ility|le)|documentation)\b/,
  /\b(?:web|internet|online|external sources?|external citations?|source-backed|in the wild)\b/,
  /\b(?:github|npm|pypi|crates\.io|mdn|stackoverflow)\b/,
  /(?:공식\s*(?:문서|docs?)|외부\s*(?:자료|문서|소스)|웹에서|인터넷에서|출처|레퍼런스|릴리즈\s*노트|버전\s*호환|호환성)/,
];

const RESEARCHER_LOOKUP_VERBS: RegExp[] = [
  /\b(?:find|look up|lookup|research|search|check|verify|read|consult|collect|gather)\b/,
  /(?:찾아줘|찾아봐|찾아|검색해|검색|조사해|조사|확인해|확인|알아봐|알아내)/,
];

const RESEARCHER_TECH_SUBJECTS: RegExp[] = [
  /\b(?:api|apis|sdk|sdks|framework|frameworks|library|libraries|package|packages|service|services|tool|tools|vendor|browser|runtime)\b/,
];

const RESEARCHER_TECH_NEEDS: RegExp[] = [
  /\b(?:behavior|best way|configuration|configure|example|examples|feature|features?|how(?:\s+do|\s+to)?|lifecycle|option|options|parameter|parameters|usage|what(?:\s+does|\s+is)|when(?:\s+does|\s+should)|why(?:\s+does)?)\b/,
];

const IMPLEMENTATION_ACTION_SIGNALS: RegExp[] = [
  /\b(?:add|build|change|create|delete|fix|implement|integrate|migrate|modify|patch|refactor|remove|replace|rewrite|scaffold|set up|update|wire)\b/,
  /(?:구현|추가|수정|변경|삭제|교체|마이그레이션|연동|적용)/,
];

const IMPLEMENTATION_CONNECTOR_SIGNALS: RegExp[] = [
  /\b(?:after|and|based on|then|using|with)\b/,
  /[,;].*\b(?:find|look up|lookup|research|search|check|verify|read|consult|collect|gather)\b/,
  /(?:기반으로|보고|읽고|찾고|확인하고|사용해서|써서|로\s*구현|로\s*수정)/,
];

const LOCAL_RESEARCH_EXCLUSION_SIGNALS: RegExp[] = [
  /\b(?:repo|repository|codebase|local|in-repo|source tree|working tree)\b/,
  /\b(?:src|lib|test|spec|app|pages|components|hooks|utils|services|api|dist|build|scripts)\/[\w./\-]+/,
  /\b[\w./\-]+\.(?:ts|js|py|go|rs|java|tsx|jsx|vue|svelte|rb|c|cpp|h|css|scss|html|json|yaml|yml|toml)\b/,
  /(?:이\s*(?:레포|저장소|코드베이스)|레포에서|저장소에서|코드베이스에서|소스에서|파일에서)/,
];

/** Starters / keywords for visual / styling prompts → LIGHT/designer */
const DESIGNER_STARTERS: readonly string[] = [
  "make the button",
  "style ",
  "color ",
  "adjust spacing",
  "ui ",
  "change the color",
  "change the font",
  "change the style",
  "update the style",
  "update the design",
  "change the design",
  "change the layout",
  "update the layout",
];

/**
 * Terms that make broad design verbs visual/UI-specific enough for designer.
 * Keep these intentionally concrete so product, architecture, auth, and
 * deployment redesign prompts can continue to reach the safer HEAVY path.
 */
const VISUAL_DESIGN_TERMS: RegExp[] = [
  /\b(?:ui|ux|visual|style|styling|css|layout|spacing|color|font|typography)\b/,
  /\b(?:button|page|screen|panel|modal|form|navbar|sidebar|header|footer|card|component)\b/,
];

const BROAD_DESIGN_STARTERS: readonly string[] = [
  "redesign ",
];

const STRUCTURAL_REDESIGN_TERMS: RegExp[] = [
  /\b(?:auth|authentication|authorization|flow|pipeline|deployment|deploy|architecture|system|api|backend|database|data|schema|orm|infra|infrastructure)\b/,
];

/**
 * Patterns that indicate a short, anchored edit → LIGHT/executor
 * Anchors: file path (src/...), line reference, rename/fix-typo phrase.
 */
const EXECUTOR_ANCHOR_PATTERNS: RegExp[] = [
  // file path pattern: word chars / word chars . ext
  /\bsrc\/[\w./\-]+\.\w+\b/,
  /\blib\/[\w./\-]+\.\w+\b/,
  /\btest\/[\w./\-]+\.\w+\b/,
  /\bspec\/[\w./\-]+\.\w+\b/,
  // line number reference
  /\bline\s+\d+\b/,
  // rename in file
  /\brename\b.+\bin\b/,
  // fix typo in
  /\bfix\s+typo\s+in\b/,
  // add X to line / add null check to line
  /\badd\b.+\bto\s+line\s+\d+\b/,
];

/**
 * Imperative verbs that, combined with sufficient word count and no anchor,
 * signal a HEAVY goal-shaped prompt.
 */
const HEAVY_IMPERATIVE_VERBS: readonly string[] = [
  "add ",
  "implement ",
  "refactor ",
  "build ",
  "create ",
  "migrate ",
  "rewrite ",
  "redesign ",
  "integrate ",
  "set up ",
  "configure ",
  "extract ",
  "split ",
  "merge ",
  "update ",
  "remove ",
  "delete ",
  "replace ",
  "convert ",
  "generate ",
  "scaffold ",
  "deploy ",
  "automate ",
];

/**
 * Word count threshold: prompts with MORE than this many words that start with
 * an imperative verb are classified HEAVY. Set to 5 so that 6+ word imperative
 * prompts (e.g. "add dark mode toggle to the settings page" = 8 words) route
 * correctly while ultra-short imperatives (≤5 words) fall through to PASS.
 */
const HEAVY_WORD_THRESHOLD = 5;

/**
 * Upper bound (inclusive) on word count for a short "?"-ending prompt to still
 * count as an exploration question. Longer interrogative prompts fall through
 * to later rules (which may classify them as HEAVY or PASS).
 */
const SHORT_QUESTION_WORD_LIMIT = 10;

/**
 * Upper bound (inclusive) on word count for a prompt to still qualify as a
 * short anchored edit (LIGHT/executor). Longer anchored prompts are treated as
 * goal-shaped work and may be classified HEAVY by later rules instead.
 */
const ANCHORED_EDIT_WORD_LIMIT = 15;

// ---------------------------------------------------------------------------
// Main classifier
// ---------------------------------------------------------------------------

export function triagePrompt(prompt: string): TriageDecision {
  const normalized = prompt.trim().toLowerCase();
  const wordCount = normalized.length === 0 ? 0 : normalized.split(/\s+/).length;

  // ── Rule 1: Empty / trivial acknowledgements → PASS ──────────────────────
  if (normalized.length === 0) {
    return { lane: "PASS", reason: "empty_input" };
  }

  for (const pattern of TRIVIAL_PATTERNS) {
    if (pattern.test(normalized)) {
      return { lane: "PASS", reason: "trivial_acknowledgement" };
    }
  }

  // ── Rule 2: Explicit opt-out → PASS ──────────────────────────────────────
  for (const phrase of OPT_OUT_PHRASES) {
    if (normalized.includes(phrase)) {
      return { lane: "PASS", reason: "explicit_opt_out" };
    }
  }

  const hasLocalResearchAnchor = LOCAL_RESEARCH_EXCLUSION_SIGNALS.some((pattern) => pattern.test(normalized));
  const hasImplementationAction = IMPLEMENTATION_ACTION_SIGNALS.some((pattern) => pattern.test(normalized));
  const hasImplementationConnector = IMPLEMENTATION_CONNECTOR_SIGNALS.some((pattern) => pattern.test(normalized));

  // ── Rule 3: Short anchored edit → LIGHT/executor ─────────────────────────
  if (wordCount <= ANCHORED_EDIT_WORD_LIMIT) {
    for (const pattern of EXECUTOR_ANCHOR_PATTERNS) {
      if (pattern.test(normalized)) {
        return { lane: "LIGHT", destination: "executor", reason: "anchored_edit" };
      }
    }
  }

  // ── Rule 4: Implementation/planning-shaped research prompt → HEAVY ───────
  if (
    wordCount > HEAVY_WORD_THRESHOLD &&
    hasImplementationAction &&
    hasImplementationConnector &&
    (
      RESEARCHER_EXTERNAL_SIGNALS.some((pattern) => pattern.test(normalized)) ||
      RESEARCHER_LOOKUP_VERBS.some((pattern) => pattern.test(normalized))
    )
  ) {
    return { lane: "HEAVY", destination: "autopilot", reason: "implementation_research_goal" };
  }

  // ── Rule 5: External docs / source-backed lookup → LIGHT/researcher ──────
  if (
    !hasLocalResearchAnchor &&
    !hasImplementationAction &&
    RESEARCHER_LOOKUP_VERBS.some((pattern) => pattern.test(normalized)) &&
    (
      RESEARCHER_EXTERNAL_SIGNALS.some((pattern) => pattern.test(normalized)) ||
      (
        RESEARCHER_TECH_SUBJECTS.some((pattern) => pattern.test(normalized)) &&
        RESEARCHER_TECH_NEEDS.some((pattern) => pattern.test(normalized))
      )
    )
  ) {
    return { lane: "LIGHT", destination: "researcher", reason: "external_reference_research" };
  }

  // ── Rule 6: Obvious question / explanation → LIGHT/explore ───────────────
  for (const starter of EXPLORE_STARTERS) {
    if (normalized.startsWith(starter)) {
      return { lane: "LIGHT", destination: "explore", reason: "question_or_explanation" };
    }
  }
  // Short prompt ending with "?" is also an exploration signal
  if (wordCount <= SHORT_QUESTION_WORD_LIMIT && normalized.endsWith("?")) {
    return { lane: "LIGHT", destination: "explore", reason: "short_question" };
  }

  // ── Rule 7: Structural redesign goals → HEAVY ────────────────────────────
  if (
    BROAD_DESIGN_STARTERS.some((starter) => normalized.startsWith(starter)) &&
    STRUCTURAL_REDESIGN_TERMS.some((pattern) => pattern.test(normalized))
  ) {
    return { lane: "HEAVY", destination: "autopilot", reason: "structural_redesign_goal" };
  }

  // ── Rule 8: Obvious visual / styling → LIGHT/designer ────────────────────
  for (const starter of DESIGNER_STARTERS) {
    if (normalized.startsWith(starter)) {
      return { lane: "LIGHT", destination: "designer", reason: "visual_styling_prompt" };
    }
  }
  for (const starter of BROAD_DESIGN_STARTERS) {
    if (normalized.startsWith(starter) && VISUAL_DESIGN_TERMS.some((pattern) => pattern.test(normalized))) {
      return { lane: "LIGHT", destination: "designer", reason: "visual_styling_prompt" };
    }
  }

  // ── Rule 9: Longer goal-shaped imperative → HEAVY ────────────────────────
  if (wordCount > HEAVY_WORD_THRESHOLD) {
    for (const verb of HEAVY_IMPERATIVE_VERBS) {
      if (normalized.startsWith(verb)) {
        return { lane: "HEAVY", destination: "autopilot", reason: "long_imperative_goal" };
      }
    }
  }

  // ── Rule 10: Fallback → PASS ───────────────────────────────────────────────
  return { lane: "PASS", reason: "ambiguous_short_prompt" };
}
