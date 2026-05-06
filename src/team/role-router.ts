/**
 * Role Router for team orchestration.
 *
 * Layer 1: Prompt loading utilities (loadRolePrompt, isKnownRole, listAvailableRoles)
 * Layer 2: Heuristic role routing (routeTaskToRole, computeWorkerRoleAssignments)
 */

import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import type { TeamPhase } from './orchestrator.js';

// ─── Layer 1: Prompt Loading ────────────────────────────────────────────────

/** Role names must be lowercase alphanumeric with hyphens (e.g., 'test-engineer'). */
const SAFE_ROLE_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Load behavioral prompt content for a given agent role.
 * Returns null if the prompt file does not exist or the role name is invalid.
 */
export async function loadRolePrompt(
  role: string,
  promptsDir: string,
): Promise<string | null> {
  if (!SAFE_ROLE_PATTERN.test(role)) return null;
  const filePath = join(promptsDir, `${role}.md`);
  try {
    const content = await readFile(filePath, 'utf-8');
    return content.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Check whether a role has a corresponding prompt file.
 */
export function isKnownRole(role: string, promptsDir: string): boolean {
  if (!SAFE_ROLE_PATTERN.test(role)) return false;
  return existsSync(join(promptsDir, `${role}.md`));
}

/**
 * List all available roles by scanning the prompts directory.
 * Returns role names (filename without .md extension).
 */
export async function listAvailableRoles(promptsDir: string): Promise<string[]> {
  try {
    const files = await readdir(promptsDir);
    return files
      .filter(f => f.endsWith('.md'))
      .map(f => f.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

// ─── Layer 2: Heuristic Role Routing ────────────────────────────────────────

export interface RoleRouterResult {
  role: string;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

type LaneIntent =
  | 'implementation'
  | 'verification'
  | 'review'
  | 'debug'
  | 'design'
  | 'docs'
  | 'build-fix'
  | 'cleanup'
  | 'unknown';

/**
 * Keyword-to-role mapping categories.
 * Order matters: first match wins within a category, but higher keyword count wins across categories.
 */
const ROLE_KEYWORDS: ReadonlyArray<{ role: string; keywords: readonly string[] }> = [
  { role: 'test-engineer', keywords: ['test', 'spec', 'coverage', 'tdd', 'jest', 'vitest', 'mocha', 'pytest', 'unit test', 'integration test', 'e2e', '테스트', '커버리지'] },
  { role: 'designer', keywords: ['ui', 'component', 'layout', 'css', 'design', 'responsive', 'tailwind', 'react', 'frontend', 'styling', 'ux', '디자인', '레이아웃', '컴포넌트'] },
  { role: 'debugger', keywords: ['build', 'compile', 'tsc', 'type error', 'typescript error', 'build error', 'compilation', '빌드', '컴파일', '타입 오류'] },
  { role: 'debugger', keywords: ['debug', 'investigate', 'root cause', 'regression', 'stack trace', 'bisect', 'diagnose', '디버그', '조사', '원인'] },
  { role: 'writer', keywords: ['doc', 'readme', 'migration guide', 'changelog', 'comment', 'documentation', 'api doc', '문서', '가이드', '변경로그'] },
  { role: 'quality-reviewer', keywords: ['review', 'audit', 'quality', 'lint', 'anti-pattern', 'code review', '검토', '리뷰'] },
  { role: 'code-reviewer', keywords: ['security', 'owasp', 'xss', 'injection', 'cve', 'vulnerability', '보안', '취약점'] },
  { role: 'code-simplifier', keywords: ['refactor', 'simplify', 'clean up', 'reduce complexity', 'consolidate', '리팩터', '단순화'] },
];

const IMPLEMENTATION_INTENT = /\b(?:add|build|create|fix|implement|make|migrate|repair|ship|support|update|wire)\b|(?:구현|추가|수정|업데이트|지원)/i;
const REVIEW_INTENT = /\b(?:audit|check|inspect|review|validate|verify)\b|(?:검토|리뷰|감사|확인|검증)/i;
const PRIMARY_TEST_INTENT = /^(?:add|create|expand|improve|increase|write)\b.*\b(?:tests?|specs?|coverage)\b|^(?:테스트\s*(?:추가|작성)|커버리지\s*추가)/i;
const DOCS_INTENT = /\b(?:docs?|documentation|readme|guide|changelog)\b|(?:문서|가이드|README|변경로그)/i;
const PRIMARY_DOCS_INTENT = /^(?:document|draft|write|update)\b.*\b(?:docs?|documentation|readme|guide|changelog)\b|^(?:문서\s*(?:업데이트|작성)|README\s*업데이트|가이드\s*작성)/i;
const DEBUG_INTENT = /\b(?:debug|diagnose|investigate|root cause|trace|bisect)\b|(?:디버그|조사|원인)/i;
const DESIGN_INTENT = /\b(?:design|layout|style)\b|\b(?:build|create)\b.*\b(?:ui|component|frontend)\b|(?:디자인|레이아웃|스타일|컴포넌트)/i;
const BUILD_FIX_INTENT = /\b(?:build|compile|tsc|type error|compilation)\b|(?:빌드|컴파일|타입 오류)/i;
const CLEANUP_INTENT = /\b(?:clean up|consolidate|reduce complexity|refactor|simplify)\b|(?:정리|단순화|리팩터)/i;
const SECURITY_DOMAIN = /\b(?:auth|authentication|authorization|cve|injection|owasp|security|vulnerability|xss)\b|(?:보안|인증|인가|취약점)/i;
const LOCAL_EXPLORATION_VERB = /\b(?:check|find|inspect|locate|look up|lookup|map|review|search|trace|understand|where(?:\s+is|\s+are)?|which files?|what files?)\b/i;
const LOCAL_EXPLORATION_SUBJECT = /\b(?:file|files|symbol|symbols|repo|repository|codebase|path|paths|usage|usages|reference|references|relationship|relationships|wiring|flow|implementation|local)\b/i;
const LOCAL_USAGE_DISCOVERY = /\b(?:call sites?|current(?:ly)? use|how\s+we\s+use|integration points?|our usage|where\s+we\s+use)\b/i;
const DEPENDENCY_EVALUATION_SIGNAL = /\b(?:dependency|dependencies|package|packages|sdk|sdks|library|libraries|framework|frameworks|crate|crates|npm|pypi|crates\.io|license|licenses|maintenance|download stats?|migration path|vendor)\b/i;
const DEPENDENCY_EVALUATION_VERB = /\b(?:adopt|assess|choose|compare|evaluate|recommend|replace|select|swap|upgrade)\b/i;
const DEPENDENCY_EVALUATION_CONTEXT = /\b(?:candidate|candidates|comparison|download stats?|license|licenses|maintenance|migration path|options?|replacement|risk|trade-?offs?|upgrade|vendor)\b/i;
const DEPENDENCY_IMPLEMENTATION_SIGNAL = /\b(?:adapter|api|call sites?|client|clients|code(?:path|paths)?|endpoint|endpoints|flow|flows|handler|handlers|implementation|imports?|integrat(?:e|ion)|module|modules|refactor|wire)\b/i;
const RESEARCH_SIGNAL = /\b(?:official docs?|upstream docs?|vendor docs?|reference|references|api docs?|release notes?|changelog|version(?:ing)?|compatib(?:ility|le)|research)\b/i;
const RESEARCH_VERB = /\b(?:check|consult|investigate|look up|lookup|read|research|review|study|verify)\b/i;
const CHOSEN_TECH_RESEARCH_SIGNAL = /\b(?:api|apis|framework|frameworks|library|libraries|sdk|sdks|service|services|tool|tools|vendor)\b/i;
const CHOSEN_TECH_RESEARCH_NEED = /\b(?:behavior|best way|configuration|configure|example|examples|feature|features?|how(?:\s+do|\s+to)?|in the wild|lifecycle|option|options|parameter|parameters|usage|what(?:\s+does|\s+is)|when(?:\s+does|\s+should)|why(?:\s+does)?)\b/i;
const DOCS_DELIVERABLE_VERB = /\b(?:add|document|draft|edit|prepare|publish|refresh|revise|update|write)\b/i;
const DOCS_DELIVERABLE_NOUN = /\b(?:api docs?|changelog|comments?|documentation|docs?|guide|guides|readme|release notes?)\b/i;

function isLocalExplorationTask(text: string): boolean {
  return (LOCAL_EXPLORATION_VERB.test(text) && LOCAL_EXPLORATION_SUBJECT.test(text))
    || (LOCAL_USAGE_DISCOVERY.test(text) && /\b(?:current|currently|dependency|existing|local|our|package|packages|repo|repository|sdk|sdks|library|libraries)\b/i.test(text));
}

function isDocumentationDeliverableTask(text: string): boolean {
  return PRIMARY_DOCS_INTENT.test(text) || (DOCS_DELIVERABLE_VERB.test(text) && DOCS_DELIVERABLE_NOUN.test(text));
}

function isImplementationHeavyDependencyTask(text: string): boolean {
  return DEPENDENCY_EVALUATION_SIGNAL.test(text)
    && IMPLEMENTATION_INTENT.test(text)
    && DEPENDENCY_IMPLEMENTATION_SIGNAL.test(text)
    && /\b(?:adopt|migrate|port|replace|replacement|swap|upgrade|wire)\b/i.test(text)
    && !/\b(?:assess|choose|compare|evaluate|options?|recommend|select|trade-?offs?)\b/i.test(text);
}

function isDependencyEvaluationTask(text: string): boolean {
  if (isDocumentationDeliverableTask(text) || isImplementationHeavyDependencyTask(text)) {
    return false;
  }

  return DEPENDENCY_EVALUATION_SIGNAL.test(text)
    && (
      DEPENDENCY_EVALUATION_VERB.test(text)
      || DEPENDENCY_EVALUATION_CONTEXT.test(text)
    );
}

function isResearchTask(text: string): boolean {
  const docsDrivenResearch = RESEARCH_SIGNAL.test(text)
    && (RESEARCH_VERB.test(text) || /\b(?:compatib(?:ility|le)|official docs?|release notes?|upstream docs?|vendor docs?|version(?:ing)?)\b/i.test(text));
  const chosenTechnologyGuidance = CHOSEN_TECH_RESEARCH_SIGNAL.test(text)
    && CHOSEN_TECH_RESEARCH_NEED.test(text);

  return (docsDrivenResearch || chosenTechnologyGuidance)
    && !isDocumentationDeliverableTask(text)
    && !isLocalExplorationTask(text)
    && !isDependencyEvaluationTask(text);
}

function inferLaneIntent(text: string): LaneIntent {
  if (BUILD_FIX_INTENT.test(text) && /\b(?:fix|resolve|repair)\b|(?:수정|해결)/i.test(text)) return 'build-fix';
  if (DEBUG_INTENT.test(text)) return 'debug';
  if (REVIEW_INTENT.test(text)) return 'review';
  if (PRIMARY_TEST_INTENT.test(text)) return 'verification';
  if (PRIMARY_DOCS_INTENT.test(text) || DOCS_INTENT.test(text)) return 'docs';
  if (DESIGN_INTENT.test(text)) return 'design';
  if (CLEANUP_INTENT.test(text)) return 'cleanup';
  if (IMPLEMENTATION_INTENT.test(text)) return 'implementation';
  return 'unknown';
}

/**
 * Phase-context labels used in routing reason strings.
 * These are NOT applied as role assignments — they only appear in diagnostic output
 * to indicate what a phase-aware router might suggest.
 */
const PHASE_CONTEXT_LABELS: Partial<Record<TeamPhase, string>> = {
  'team-verify': 'verifier',
  'team-fix': 'debugger',
  'team-plan': 'planner',
  'team-prd': 'analyst',
};

/**
 * Map a task description to the best agent role using keyword heuristics.
 * Falls back to fallbackRole when confidence is low.
 */
export function routeTaskToRole(
  taskSubject: string,
  taskDescription: string,
  phase: TeamPhase | null,
  fallbackRole: string,
): RoleRouterResult {
  const text = `${taskSubject} ${taskDescription}`.toLowerCase();
  const intent = inferLaneIntent(text);

  if (intent === 'build-fix') {
    return {
      role: 'debugger',
      confidence: 'high',
      reason: 'primary intent is build/compile repair',
    };
  }

  if (intent === 'debug') {
    return {
      role: 'debugger',
      confidence: 'high',
      reason: 'primary intent is investigation/debugging',
    };
  }

  if (isLocalExplorationTask(text)) {
    return {
      role: 'explore',
      confidence: 'high',
      reason: 'primary intent is local codebase/file/symbol exploration',
    };
  }

  if (isImplementationHeavyDependencyTask(text)) {
    return {
      role: fallbackRole,
      confidence: 'medium',
      reason: 'dependency/sdk terms appear inside implementation-heavy replacement work, so using fallback implementation lane',
    };
  }

  if (isDependencyEvaluationTask(text)) {
    return {
      role: 'dependency-expert',
      confidence: 'high',
      reason: 'primary intent is external dependency/package evaluation',
    };
  }

  if (isResearchTask(text)) {
    return {
      role: 'researcher',
      confidence: 'high',
      reason: 'primary intent is external documentation/reference research',
    };
  }

  if (intent === 'docs') {
    return {
      role: 'writer',
      confidence: 'high',
      reason: 'primary intent is documentation deliverable',
    };
  }

  if (intent === 'design') {
    return {
      role: 'designer',
      confidence: 'high',
      reason: 'primary intent is UI/design implementation',
    };
  }

  if (intent === 'cleanup') {
    return {
      role: 'code-simplifier',
      confidence: 'high',
      reason: 'primary intent is simplification/refactor work',
    };
  }

  if (intent === 'review') {
    return {
      role: SECURITY_DOMAIN.test(text) ? 'code-reviewer' : 'quality-reviewer',
      confidence: 'high',
      reason: SECURITY_DOMAIN.test(text)
        ? 'primary intent is security-focused review'
        : 'primary intent is review/verification',
    };
  }

  if (intent === 'verification') {
    return {
      role: 'test-engineer',
      confidence: 'high',
      reason: 'primary intent is test/verification output',
    };
  }

  if (intent === 'implementation' && SECURITY_DOMAIN.test(text)) {
    return {
      role: fallbackRole,
      confidence: 'medium',
      reason: 'security/auth domain detected but task intent is implementation, so using fallback implementation lane',
    };
  }

  // Score each role category by keyword match count
  let bestRole = '';
  let bestCount = 0;
  let bestKeyword = '';

  for (const { role, keywords } of ROLE_KEYWORDS) {
    let count = 0;
    let matchedKeyword = '';
    for (const kw of keywords) {
      if (text.includes(kw)) {
        count++;
        if (!matchedKeyword) matchedKeyword = kw;
      }
    }
    if (count > bestCount) {
      bestCount = count;
      bestRole = role;
      bestKeyword = matchedKeyword;
    }
  }

  // High confidence: 2+ keyword matches from the same category
  if (bestCount >= 2) {
    return {
      role: bestRole,
      confidence: 'high',
      reason: `matched ${bestCount} keywords in ${bestRole} category (e.g., "${bestKeyword}")`,
    };
  }

  // Medium confidence: exactly 1 keyword match
  if (bestCount === 1) {
    return {
      role: bestRole,
      confidence: 'medium',
      reason: `matched keyword "${bestKeyword}" for ${bestRole}`,
    };
  }

  // Low confidence: phase-context inference only
  if (phase) {
    const phaseDefault = PHASE_CONTEXT_LABELS[phase];
    if (phaseDefault) {
      return {
        role: fallbackRole, // use fallbackRole for low confidence per plan
        confidence: 'low',
        reason: `no keyword match; phase ${phase} suggests ${phaseDefault} but using fallback`,
      };
    }
  }

  return {
    role: fallbackRole,
    confidence: 'low',
    reason: 'no keyword match; using fallback role',
  };
}
