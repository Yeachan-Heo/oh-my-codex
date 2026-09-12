/**
 * Uniform sunset-stub resolver for removed skills / prompts.
 * Single SSOT for future removals: add entry here and the
 * keyword / hook surfaces will emit a clean
 * "removed, use X" error without per-site edits.
 */

export interface RemovedSkillInfo {
  /** Replacement skill token (e.g. "$ask") or null if no direct replacement. */
  replacement: string | null;
  /** Human-readable guidance, always contains "removed" and "use" for CI. */
  message: string;
}

export const REMOVED_SKILLS: Readonly<Record<string, RemovedSkillInfo>> = Object.freeze({
  "ask-claude": {
    replacement: "$ask",
    message: 'Skill "$ask-claude" has been removed. Use "$ask" (ask claude) instead.',
  },
  "ask-gemini": {
    replacement: "$ask",
    message: 'Skill "$ask-gemini" has been removed. Use "$ask" (ask gemini) instead.',
  },
  "build-fix": {
    replacement: null,
    message: 'Skill "$build-fix" has been removed. Use the active execution/debugging workflow instead.',
  },
  "deepsearch": {
    replacement: "$analyze",
    message: 'Skill "$deepsearch" has been removed. Use "$analyze" instead.',
  },
  "ecomode": {
    // Was "$ultrawork", which is itself a sunset stub: a two-hop dead end that bounced the user
    // from one removed skill to another. Replacements must name a live catalog skill.
    replacement: "$team",
    message: 'Skill "$ecomode" has been removed. Use "$team" instead.',
  },
  "frontend-ui-ux": {
    replacement: "$design",
    message: 'Skill "$frontend-ui-ux" has been removed. Use "$design" (or "$visual-ralph" for live visual) instead.',
  },
  "help": {
    replacement: "$omx-setup",
    message: 'Skill "$help" has been removed. Use "$omx-setup" or "omx doctor" instead.',
  },
  "note": {
    replacement: null,
    message: 'Skill "$note" has been removed. Use OMX memory/notepad surfaces instead.',
  },
  ralph: {
    replacement: "$ultragoal",
    message: 'Skill "$ralph" has been removed. Use "$ultragoal" instead. The `omx ralph` CLI and ralph persistence runtime are unaffected.',
  },
  ultrawork: {
    replacement: "$team",
    message: 'Skill "$ultrawork" has been removed. Use "$team" instead.',
  },
  pipeline: {
    replacement: "$plan",
    message: 'Skill "$pipeline" has been removed. Use "$plan" for optional planning, "$team" for coordinated execution, or "$ultragoal" for durable goals instead.',
  },
  "autoresearch-goal": {
    replacement: "$autoresearch",
    message: 'Skill "$autoresearch-goal" has been removed. Use "$autoresearch" instead.',
  },
  "ralph-init": {
    // Was "$ralph", which is a sunset stub in the catalog: another two-hop dead end.
    replacement: "$ultragoal",
    message: 'Skill "$ralph-init" has been removed. Use "$ultragoal" instead.',
  },
  "review": {
    replacement: "$code-review",
    message: 'Skill "$review" has been removed. Use "$code-review" instead.',
  },
  "security-review": {
    replacement: "$code-review",
    message: 'Skill "$security-review" has been removed. Use "$code-review" instead. Security review remains available via prompts/security-reviewer.md role prompt.',
  },
  "swarm": {
    replacement: "$team",
    message: 'Skill "$swarm" has been removed. Use "$team" instead.',
  },
  "tdd": {
    replacement: null,
    message: 'Skill "$tdd" has been removed. Use test-first discipline inside the active workflow instead.',
  },
  "trace": {
    replacement: null,
    message: 'Skill "$trace" has been removed. Use runtime inspection surfaces instead.',
  },
  "visual-verdict": {
    replacement: "$visual-ralph",
    message: 'Skill "$visual-verdict" has been removed. Use "$visual-ralph" instead.',
  },
  "web-clone": {
    replacement: "$visual-ralph",
    message: 'Skill "$web-clone" has been removed. Use "$visual-ralph" instead.',
  },
  "prometheus-strict": {
    replacement: null,
    message: 'Skill "$prometheus-strict" has been removed. Use "$plan" for planning instead.',
  },
  "prometheus-strict-metis": {
    replacement: null,
    message: 'Prompt "$prometheus-strict-metis" has been removed. Use "$plan" instead.',
  },
  "prometheus-strict-momus": {
    replacement: null,
    message: 'Prompt "$prometheus-strict-momus" has been removed. Use "$plan" instead.',
  },
  "prometheus-strict-oracle": {
    replacement: null,
    message: 'Prompt "$prometheus-strict-oracle" has been removed. Use "$plan" instead.',
  },
  "scholastic": {
    replacement: null,
    message: 'Prompt "$scholastic" has been removed. Use "$plan" with advisory review instead.',
  },
  "sisyphus-lite": {
    replacement: null,
    message: 'Prompt "sisyphus-lite" has been removed.',
  },
});

export function getRemovedSkillInfo(token: string): RemovedSkillInfo | undefined {
  return REMOVED_SKILLS[token.toLowerCase()];
}
