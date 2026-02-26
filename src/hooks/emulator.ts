/**
 * Hook Emulation Layer for oh-my-codex
 *
 * Since Codex CLI's hooks are limited (AfterAgent + AfterToolUse only, fire-and-forget),
 * we emulate the full OMC hook pipeline through alternative mechanisms:
 *
 * 1. SessionStart -> AGENTS.md (native Codex CLI, no hook needed)
 * 2. PreToolUse -> AGENTS.md instructions (inline guidance, no hook needed)
 * 3. PostToolUse -> notify config (fire-and-forget, no context injection)
 * 4. UserPromptSubmit -> AGENTS.md keyword detection instructions
 * 5. SubagentStart/Stop -> Codex CLI multi_agent system (native tracking)
 * 6. PreCompact -> Not available (Codex manages compaction internally)
 * 7. Stop -> notify config (can detect turn completion)
 *
 * For features that require context injection (keyword detection triggering
 * skill loading), we rely on the AGENTS.md orchestration brain to instruct
 * the model to self-invoke skills when it detects keywords.
 *
 * This is the key architectural difference from OMC:
 * - OMC: External hook detects keyword -> injects skill prompt via system-reminder
 * - OMX: AGENTS.md instructs model -> model self-detects keyword -> model loads skill
 */

import { KEYWORD_TRIGGER_DEFINITIONS } from './keyword-registry.js';

/**
 * Hook event types (for compatibility with OMC concepts)
 */
export type HookEvent =
  | 'SessionStart'       // -> AGENTS.md native loading
  | 'PreToolUse'         // -> AGENTS.md inline guidance
  | 'PostToolUse'        // -> notify config
  | 'UserPromptSubmit'   // -> AGENTS.md keyword detection
  | 'SubagentStart'      // -> Codex CLI multi_agent tracking
  | 'SubagentStop'       // -> Codex CLI multi_agent tracking
  | 'PreCompact'         // -> Not available
  | 'Stop'               // -> notify config
  | 'SessionEnd';        // -> Not directly available

/**
 * Mapping of OMC hook capabilities to OMX equivalents
 */
export const HOOK_MAPPING: Record<HookEvent, {
  mechanism: string;
  capability: 'full' | 'partial' | 'none';
  notes: string;
}> = {
  SessionStart: {
    mechanism: 'AGENTS.md native loading + runtime overlay',
    capability: 'full',
    notes: 'Codex CLI reads AGENTS.md at start; omx preLaunch injects dynamic overlay (modes, notepad, memory, compaction protocol)',
  },
  PreToolUse: {
    mechanism: 'AGENTS.md inline guidance',
    capability: 'partial',
    notes: 'No pre-tool interception, but AGENTS.md can instruct model behavior before tool use',
  },
  PostToolUse: {
    mechanism: 'notify config (fire-and-forget)',
    capability: 'partial',
    notes: 'Can log and update state, but cannot inject context back into conversation',
  },
  UserPromptSubmit: {
    mechanism: 'AGENTS.md self-detection instructions',
    capability: 'partial',
    notes: 'Model detects keywords via AGENTS.md instructions instead of external hook',
  },
  SubagentStart: {
    mechanism: 'Codex CLI multi_agent system',
    capability: 'full',
    notes: 'Native sub-agent lifecycle tracking via multi_agent feature',
  },
  SubagentStop: {
    mechanism: 'Codex CLI multi_agent system',
    capability: 'full',
    notes: 'Native sub-agent lifecycle tracking via multi_agent feature',
  },
  PreCompact: {
    mechanism: 'AGENTS.md overlay compaction protocol',
    capability: 'partial',
    notes: 'Overlay includes compaction survival instructions; no event interception but model is instructed to checkpoint state',
  },
  Stop: {
    mechanism: 'notify config + postLaunch cleanup',
    capability: 'full',
    notes: 'notify fires on agent-turn-complete; postLaunch strips overlay and archives session on exit',
  },
  SessionEnd: {
    mechanism: 'omx postLaunch lifecycle phase',
    capability: 'partial',
    notes: 'postLaunch runs after Codex exits: strips overlay, archives session, cancels active modes',
  },
};

/**
 * Keyword detection configuration (embedded in AGENTS.md)
 * Instead of external hook detection, the model is instructed to self-detect
 */
export const KEYWORD_TRIGGERS: Record<string, string> = Object.fromEntries(
  KEYWORD_TRIGGER_DEFINITIONS.map((entry) => {
    const guidance = entry.skill === 'ralph'
      ? `${entry.guidance} (planning-gated: require PRD + test spec before implementation tools)`
      : entry.skill === 'ralplan'
        ? `${entry.guidance} and complete PRD + test spec before implementation`
        : entry.guidance;
    return [entry.keyword, guidance];
  }),
);

/**
 * Generate the keyword detection section for AGENTS.md
 */
export function generateKeywordDetectionSection(): string {
  const lines = Object.entries(KEYWORD_TRIGGERS)
    .map(([keyword, action]) => `- When user says "${keyword}": ${action}`)
    .join('\n');

  return `
<keyword_detection>
When you see these keywords in user messages, activate the corresponding skill:
${lines}

Ralplan-first execution gate:
- Before implementation/tool execution, ensure both artifacts exist in \`.omx/plans/\`: \`prd-*.md\` and \`test-spec-*.md\`.
- If ralph is active and either artifact is missing, stay in planning mode and do not execute implementation tools.
- Only begin implementation after the planning gate is complete.

To activate a skill, use the corresponding slash command or invoke the skill directly.
If a keyword is detected, announce the activation to the user before proceeding.
</keyword_detection>
`;
}
