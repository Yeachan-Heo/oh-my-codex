import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  UNKNOWN_RALPLAN_ROLE_PRE_TOOL_USE,
  UNSUPPORTED_DOCUMENTED_LEADER_PRE_TOOL_USE,
  evaluateCodex01445PreToolUse,
  parseCodex01445AdaptedRoleIntentCommand,
} from '../documented-leader-preflight.js';

const posixCommand = (role: string) =>
  `omx ralplan role-intent write --role ${role} --parent-thread "$CODEX_THREAD_ID" --json`;
const windowsCommand = (role: string) =>
  `omx ralplan role-intent write --role ${role} --parent-thread "%CODEX_THREAD_ID%" --json`;

describe('Codex 0.144.5 adapted role-intent preflight', () => {
  it('recognizes only the canonical standalone POSIX and Windows forms', () => {
    assert.deepEqual(parseCodex01445AdaptedRoleIntentCommand(posixCommand('architect'), 'linux'), { role: 'architect' });
    assert.deepEqual(parseCodex01445AdaptedRoleIntentCommand(windowsCommand('critic'), 'win32'), { role: 'critic' });
    for (const command of [
      'ROLE=architect ' + posixCommand('architect'),
      'env ' + posixCommand('architect'),
      posixCommand('architect') + '; id',
      posixCommand('architect') + ' > out',
      'omx ralplan role-intent write --role architect --json',
      'omx ralplan role-intent write --role architect --role critic --parent-thread "$CODEX_THREAD_ID" --json',
      'omx ralplan role-intent write --parent-thread "$CODEX_THREAD_ID" --role architect --json',
      'omx ralplan role-intent write --role $ROLE --parent-thread "$CODEX_THREAD_ID" --json',
    ]) assert.equal(parseCodex01445AdaptedRoleIntentCommand(command, 'linux'), null, command);
  });

  it('denies installed roles and preserves unknown-role precedence without inspecting unrelated tools', () => {
    let calls = 0;
    const resolveInstalledRoleName = (role: string) => {
      calls += 1;
      return role === 'architect' || role === 'custom-role' ? role : null;
    };
    assert.equal(evaluateCodex01445PreToolUse({
      tool_name: 'Bash',
      tool_input: { command: posixCommand('architect') },
    }, { resolveInstalledRoleName, platform: 'linux' }), UNSUPPORTED_DOCUMENTED_LEADER_PRE_TOOL_USE);
    assert.equal(evaluateCodex01445PreToolUse({
      tool_name: 'Bash',
      tool_input: { command: posixCommand('custom-role') },
    }, { resolveInstalledRoleName, platform: 'linux' }), UNSUPPORTED_DOCUMENTED_LEADER_PRE_TOOL_USE);
    assert.equal(evaluateCodex01445PreToolUse({
      tool_name: 'Bash',
      tool_input: { command: posixCommand('missing-role') },
    }, { resolveInstalledRoleName, platform: 'linux' }), UNKNOWN_RALPLAN_ROLE_PRE_TOOL_USE);
    assert.equal(evaluateCodex01445PreToolUse({
      tool_name: 'apply_patch', agent_role: 'architect', tool_input: { command: posixCommand('architect') },
    }, { resolveInstalledRoleName, platform: 'linux' }), undefined);
    assert.equal(calls, 3);
  });
});
