import type { RepeatProblemHistory } from './supervision-registry.js';

/**
 * @iqdoctor's issue/PR history (235 items, /tmp/iq-all.tsv at authoring time) mapped onto
 * repeat-problem check ids. Fixture data: replace with a per-user history to reuse the checks.
 */
export const IQDOCTOR_HISTORY: RepeatProblemHistory = {
  'silver-rule-lane-reuse': [2511, 2512, 2599, 3098],
  'ralplan-lane-reuse': [2511, 2512, 2599, 2600],
  'native-subagent-blocker': [2870, 2658],
  'hud-cpu-load': [4201, 4202],
  'hud-duplicate-panes': [2479, 2480, 2481, 2648, 2770, 4201],
  'process-rss': [4201],
  'disk-growth': [4201],
  'autopilot-phase-illegal': [2994, 2864],
  'team-phase-transition-illegal': [2864, 2994, 2863],
  'autopilot-phase-stuck': [2876],
  'autopilot-gate-loop': [2618, 2876, 3081, 2626, 2629],
  'stop-hook-invalid-json': [2580, 2581, 3081, 2661, 2779],
  'hud-authority-churn': [2903, 2971, 2634, 2776],
  'native-agent-toml-drift': [2870, 2636],
  'question-outside-tmux': [4183, 4182],
  'stale-omx-root': [2995, 3043, 2440, 2441],
  'hud-deleted-cwd': [2639, 2655, 2582, 2583],
  'setup-cache-drift': [3024, 3034, 2677, 2672],
};
