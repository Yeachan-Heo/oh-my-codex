/**
 * Triage Heuristic
 *
 * Pure, synchronous classifier for a 3-lane prompt triage system.
 * Advisory-only — never activates workflows, never touches state or fs.
 *
 * Lanes:
 *   PASS  — trivial acknowledgements, explicit opt-out phrases, or ambiguous short prompts
 *   LIGHT — single-agent destination: explore | executor | designer
 *   HEAVY — autopilot; longer goal-shaped imperative prompts
 */

export type TriageLane = "HEAVY" | "LIGHT" | "PASS";
export type LightDestination = "explore" | "executor" | "designer";

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

  // ── Rule 3: Obvious question / explanation → LIGHT/explore ───────────────
  for (const starter of EXPLORE_STARTERS) {
    if (normalized.startsWith(starter)) {
      return { lane: "LIGHT", destination: "explore", reason: "question_or_explanation" };
    }
  }
  // Short prompt ending with "?" is also an exploration signal
  if (wordCount <= SHORT_QUESTION_WORD_LIMIT && normalized.endsWith("?")) {
    return { lane: "LIGHT", destination: "explore", reason: "short_question" };
  }

  // ── Rule 4: Structural redesign goals → HEAVY ────────────────────────────
  if (
    BROAD_DESIGN_STARTERS.some((starter) => normalized.startsWith(starter)) &&
    STRUCTURAL_REDESIGN_TERMS.some((pattern) => pattern.test(normalized))
  ) {
    return { lane: "HEAVY", destination: "autopilot", reason: "structural_redesign_goal" };
  }

  // ── Rule 5: Obvious visual / styling → LIGHT/designer ────────────────────
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

  // ── Rule 6: Short anchored edit → LIGHT/executor ─────────────────────────
  if (wordCount <= ANCHORED_EDIT_WORD_LIMIT) {
    for (const pattern of EXECUTOR_ANCHOR_PATTERNS) {
      if (pattern.test(normalized)) {
        return { lane: "LIGHT", destination: "executor", reason: "anchored_edit" };
      }
    }
  }

  // ── Rule 7: Longer goal-shaped imperative → HEAVY ────────────────────────
  if (wordCount > HEAVY_WORD_THRESHOLD) {
    for (const verb of HEAVY_IMPERATIVE_VERBS) {
      if (normalized.startsWith(verb)) {
        return { lane: "HEAVY", destination: "autopilot", reason: "long_imperative_goal" };
      }
    }
  }

  // ── Rule 8: Fallback → PASS ───────────────────────────────────────────────
  return { lane: "PASS", reason: "ambiguous_short_prompt" };
}
