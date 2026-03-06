import type { EnterprisePolicy } from './contracts.js';

const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_DIVISION_LEADS = 6;
const DEFAULT_MAX_SUBORDINATES_PER_LEAD = 5;
const DEFAULT_MAX_SUBORDINATES_TOTAL = 30;

function clampPositiveInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

export function defaultEnterprisePolicy(): EnterprisePolicy {
  return {
    max_depth: DEFAULT_MAX_DEPTH,
    max_division_leads: DEFAULT_MAX_DIVISION_LEADS,
    max_subordinates_per_lead: DEFAULT_MAX_SUBORDINATES_PER_LEAD,
    max_subordinates_total: DEFAULT_MAX_SUBORDINATES_TOTAL,
    chairman_visibility: 'summary_only',
    subordinate_write_mode: 'lead_controlled_apply',
    raw_transcript_visibility: 'debug_only',
  };
}

export function normalizeEnterprisePolicy(policy?: Partial<EnterprisePolicy> | null): EnterprisePolicy {
  const base = defaultEnterprisePolicy();
  const maxDepth = clampPositiveInteger(policy?.max_depth, base.max_depth, 2, 2);
  const maxDivisionLeads = clampPositiveInteger(policy?.max_division_leads, base.max_division_leads, 1, 12);
  const maxSubordinatesPerLead = clampPositiveInteger(
    policy?.max_subordinates_per_lead,
    base.max_subordinates_per_lead,
    1,
    10,
  );
  const maxSubordinatesTotal = clampPositiveInteger(
    policy?.max_subordinates_total,
    base.max_subordinates_total,
    1,
    60,
  );

  return {
    max_depth: maxDepth,
    max_division_leads: maxDivisionLeads,
    max_subordinates_per_lead: maxSubordinatesPerLead,
    max_subordinates_total: maxSubordinatesTotal,
    chairman_visibility: policy?.chairman_visibility === 'debug' ? 'debug' : base.chairman_visibility,
    subordinate_write_mode: policy?.subordinate_write_mode === 'read_only'
      ? 'read_only'
      : base.subordinate_write_mode,
    raw_transcript_visibility: policy?.raw_transcript_visibility === 'suppressed'
      ? 'suppressed'
      : base.raw_transcript_visibility,
  };
}
