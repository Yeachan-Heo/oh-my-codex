export const VISUAL_NEXT_ACTIONS_LIMIT = 5;

export const VISUAL_VERDICT_STATUSES = ['pass', 'revise', 'fail'] as const;

export type VisualVerdictStatus = (typeof VISUAL_VERDICT_STATUSES)[number];
