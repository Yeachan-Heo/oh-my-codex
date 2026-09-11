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

  it('keeps the Conductor native capability contract reachable under inherited permissions (#3635)', () => {
    const content = loadSurface('templates/AGENTS.md');
    assert.match(content, /under ordinary native support with inherited permissions/i);
    assert.match(content, /may implement, mutate, and report bounded delegated work directly/i);
    assert.match(content, /reporting back through the native result surface is ordinary completion/i);
    assert.match(content, /Scope the Main-root Conductor write restriction to the Main lane only/i);
    assert.match(content, /local state, task text, session fields, trackers, or child provenance remain routing\/diagnostic data/i);
    assert.match(content, /return a bounded read-only result or blocker with the supported recovery path/i);
    assert.doesNotMatch(content, /native children are verification\/advice-only/i);
    assert.doesNotMatch(content, /child-to-leader reporting also requires separate host-authenticated caller, parent, and target proof/i);
    assert.doesNotMatch(content, /collaboration reporting and source\/product mutations remain denied/i);
  });

  it('keeps capability guidance free of semver-pinned Codex claims', () => {
    const pinnedCapabilityClaim = /Codex\s+\d+\.\d+\.\d+\s+does not expose/;
    for (const surface of listTrackedAgentSurfaces()) {
      const content = loadSurface(surface);
      assert.doesNotMatch(
        content,
        pinnedCapabilityClaim,
        `${surface} must state the delegation capability gate by capability, not by a pinned Codex version (issue #3545)`,
      );
    }
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

  it('keeps AUTO-CONTINUE vs ASK autonomy steering in AGENTS.md only', () => {
    for (const surface of listTrackedAgentSurfaces()) {
      const content = loadSurface(surface);
      assert.match(content, /AUTO-CONTINUE.*clear.*already-requested.*low-risk.*reversible.*local/i);
      assert.match(
        content,
        /ASK only.*destructive.*irreversible.*credential-gated.*external-production.*materially scope-changing/i,
      );
      assert.match(content, /AUTO-CONTINUE branches.*permission-handoff phrasing/i);
    }

    for (const contract of CORE_ROLE_CONTRACTS) {
      const content = loadSurface(contract.path);
      assert.doesNotMatch(content, /AUTO-CONTINUE.*already-requested/i);
      assert.doesNotMatch(content, /ASK only.*credential-gated/i);
    }
  });
});
