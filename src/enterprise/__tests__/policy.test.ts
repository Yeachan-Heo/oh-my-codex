import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defaultEnterprisePolicy, normalizeEnterprisePolicy } from '../policy.js';

describe('enterprise policy', () => {
  it('provides bounded defaults for phase 1', () => {
    const policy = defaultEnterprisePolicy();
    assert.equal(policy.max_depth, 2);
    assert.equal(policy.max_division_leads, 6);
    assert.equal(policy.max_subordinates_per_lead, 5);
    assert.equal(policy.max_subordinates_total, 30);
    assert.equal(policy.chairman_visibility, 'summary_only');
    assert.equal(policy.subordinate_write_mode, 'lead_controlled_apply');
  });

  it('normalizes and clamps provided policy values', () => {
    const policy = normalizeEnterprisePolicy({
      max_depth: 99,
      max_division_leads: 0,
      max_subordinates_per_lead: 42,
      max_subordinates_total: 2,
      chairman_visibility: 'debug',
      subordinate_write_mode: 'read_only',
      raw_transcript_visibility: 'suppressed',
    });

    assert.equal(policy.max_depth, 2);
    assert.equal(policy.max_division_leads, 1);
    assert.equal(policy.max_subordinates_per_lead, 10);
    assert.equal(policy.max_subordinates_total, 2);
    assert.equal(policy.chairman_visibility, 'debug');
    assert.equal(policy.subordinate_write_mode, 'read_only');
    assert.equal(policy.raw_transcript_visibility, 'suppressed');
  });
});
