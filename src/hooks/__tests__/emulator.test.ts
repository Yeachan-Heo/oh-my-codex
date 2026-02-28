import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOOK_MAPPING,
  KEYWORD_TRIGGERS,
  type HookEvent,
  generateKeywordDetectionSection,
} from '../emulator.js';

const ALL_HOOK_EVENTS: HookEvent[] = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'Stop',
  'SessionEnd',
];

describe('hook emulator mapping contracts', () => {
  it('defines mapping metadata for every hook event', () => {
    const mappingKeys = Object.keys(HOOK_MAPPING).sort();
    const expectedKeys = [...ALL_HOOK_EVENTS].sort();
    assert.deepEqual(mappingKeys, expectedKeys);

    for (const event of ALL_HOOK_EVENTS) {
      const mapped = HOOK_MAPPING[event];
      assert.ok(mapped, `missing mapping for ${event}`);
      assert.equal(typeof mapped.mechanism, 'string');
      assert.equal(mapped.mechanism.length > 0, true);
      assert.equal(typeof mapped.notes, 'string');
      assert.equal(mapped.notes.length > 0, true);
      assert.ok(['full', 'partial', 'none'].includes(mapped.capability));
    }
  });

  it('preserves expected session lifecycle capability semantics', () => {
    assert.equal(HOOK_MAPPING.SessionStart.capability, 'full');
    assert.equal(HOOK_MAPPING.Stop.capability, 'full');
    assert.equal(HOOK_MAPPING.SessionEnd.capability, 'partial');
    assert.match(HOOK_MAPPING.SessionStart.mechanism, /AGENTS\.md/i);
    assert.match(HOOK_MAPPING.SessionEnd.mechanism, /postLaunch/i);
  });
});

describe('hook emulator keyword guidance generation', () => {
  it('renders every keyword trigger into the generated section', () => {
    const section = generateKeywordDetectionSection();
    for (const [keyword, action] of Object.entries(KEYWORD_TRIGGERS)) {
      assert.match(section, new RegExp(`When user says "${keyword}"`));
      assert.match(section, new RegExp(action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });

  it('includes visual iteration gate guidance', () => {
    const section = generateKeywordDetectionSection();
    assert.match(section, /\$visual-verdict/);
    assert.match(section, /Visual iteration gate/i);
    assert.match(section, /score \+ qualitative next actions/i);
  });
});
