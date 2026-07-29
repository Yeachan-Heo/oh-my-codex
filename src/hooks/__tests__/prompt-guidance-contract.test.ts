import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CORE_ROLE_CONTRACTS, ROOT_TEMPLATE_CONTRACTS } from '../prompt-guidance-contract.js';
import { assertContractSurface, loadSurface, listTrackedAgentSurfaces } from './prompt-guidance-test-helpers.js';

describe('prompt guidance contract', () => {
  for (const contract of [...ROOT_TEMPLATE_CONTRACTS, ...CORE_ROLE_CONTRACTS]) {
    it(`${contract.id} satisfies the core prompt-guidance contract`, () => {
      assertContractSurface(contract);
    });
  }

  it('tracked AGENTS surfaces lock agent-owned reversible OMX/runtime actions', () => {
    for (const surface of listTrackedAgentSurfaces()) {
      const content = loadSurface(surface);
      assert.match(content, /Do not ask or instruct humans to perform ordinary non-destructive, reversible actions/i);
      assert.match(content, /Treat OMX runtime manipulation, state transitions, and ordinary command execution as agent responsibilities/i);
      assert.doesNotMatch(content, /Run `omx setup` to install all components\. Run `omx doctor` to verify installation\./);
    }
  });

  it('keeps native children non-writing while a Conductor workflow is active', () => {
    const content = loadSurface('templates/AGENTS.md');
    assert.match(content, /Conductor workflow is active.*native children are verification\/advice-only/i);
    assert.match(content, /child-to-leader reporting also requires separate host-authenticated caller, parent, and target proof/i);
    assert.match(content, /Codex 0\.145\.0 does not expose that proof.*collaboration reporting and source\/product mutations remain denied/i);
    assert.match(content, /return a bounded read-only result or blocker/i);
    assert.match(content, /Route implementation through Team only after Team's separate host-authority checks pass/i);
    assert.match(content, /local state, task text, session fields, trackers, or child provenance as authority/i);
  });

  it('tracked AGENTS and core prompt surfaces stay action-first and avoid permission-seeking softeners', () => {
    const banned = [/if you[’']d like/i, /if you want/i, /would you like/i, /let me know if you want/i];

    for (const surface of [...listTrackedAgentSurfaces(), ...CORE_ROLE_CONTRACTS.map((contract) => contract.path)]) {
      const content = loadSurface(surface);
      for (const pattern of banned) {
        assert.doesNotMatch(content, pattern, `${surface} should not contain permission-seeking softeners matching ${pattern}`);
      }
    }
  });

  it('tracked AGENTS and core prompt surfaces encode AUTO-CONTINUE vs ASK autonomy steering', () => {
    const surfaces = [...listTrackedAgentSurfaces(), ...CORE_ROLE_CONTRACTS.map((contract) => contract.path)];

    for (const surface of surfaces) {
      const content = loadSurface(surface);
      assert.match(content, /AUTO-CONTINUE.*clear.*already-requested.*low-risk.*reversible.*local/i);
      assert.match(
        content,
        /ASK only.*destructive.*irreversible.*credential-gated.*external-production.*materially scope-changing/i,
      );
      assert.match(content, /AUTO-CONTINUE branches.*permission-handoff phrasing/i);
    }
  });
});
