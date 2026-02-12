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
 * 5. SubagentStart/Stop -> Codex CLI collab system (native tracking)
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

/**
 * Hook event types (for compatibility with OMC concepts)
 */
export type HookEvent =
  | 'SessionStart'       // -> AGENTS.md native loading
  | 'PreToolUse'         // -> AGENTS.md inline guidance
  | 'PostToolUse'        // -> notify config
  | 'UserPromptSubmit'   // -> AGENTS.md keyword detection
  | 'SubagentStart'      // -> Codex CLI collab tracking
  | 'SubagentStop'       // -> Codex CLI collab tracking
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
    mechanism: 'AGENTS.md native loading',
    capability: 'full',
    notes: 'Codex CLI reads AGENTS.md at session start automatically',
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
    mechanism: 'Codex CLI collab system',
    capability: 'full',
    notes: 'Native sub-agent lifecycle tracking via collab feature',
  },
  SubagentStop: {
    mechanism: 'Codex CLI collab system',
    capability: 'full',
    notes: 'Native sub-agent lifecycle tracking via collab feature',
  },
  PreCompact: {
    mechanism: 'Not available',
    capability: 'none',
    notes: 'Codex CLI manages context compaction internally',
  },
  Stop: {
    mechanism: 'notify config',
    capability: 'partial',
    notes: 'notify fires on agent-turn-complete, can detect session end',
  },
  SessionEnd: {
    mechanism: 'Not directly available',
    capability: 'none',
    notes: 'No session-end hook; notify on last turn is closest approximation',
  },
};

/**
 * Keyword detection configuration (embedded in AGENTS.md)
 * Instead of external hook detection, the model is instructed to self-detect
 */
export const KEYWORD_TRIGGERS: Record<string, string> = {
  'autopilot': 'Activate autopilot skill for autonomous execution',
  'ralph': 'Activate ralph persistence loop with verification',
  'ultrawork': 'Activate ultrawork parallel execution mode',
  'ulw': 'Activate ultrawork parallel execution mode',
  'ecomode': 'Activate ecomode for token-efficient execution',
  'eco': 'Activate ecomode for token-efficient execution',
  'plan': 'Activate planning skill',
  'ralplan': 'Activate consensus planning (planner + architect + critic)',
  'team': 'Activate coordinated team mode',
  'pipeline': 'Activate sequential pipeline mode',
  'research': 'Activate parallel research mode',
  'cancel': 'Cancel active execution modes',
};

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

To activate a skill, use the corresponding slash command or invoke the skill directly.
If a keyword is detected, announce the activation to the user before proceeding.
</keyword_detection>
`;
}
