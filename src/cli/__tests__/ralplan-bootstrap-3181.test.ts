import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { dispatchCodexNativeHook } from '../../scripts/codex-native-hook.js';

const documentedRoleIntent = {
  hook_event_name: 'PreToolUse',
  cwd: 'synthetic-cwd',
  session_id: 'synthetic-session',
  tool_name: 'Bash',
  tool_use_id: 'synthetic-tool-use',
  tool_input: { command: 'omx ralplan role-intent write --role architect --parent-thread "$CODEX_THREAD_ID" --json' },
};

describe('#3194 documented PreToolUse bootstrap', () => {
  it('denies the Codex 0.144.5 documented role shape before creating a pointer or tracker', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-3194-'));
    try {
      const result = await dispatchCodexNativeHook({ ...documentedRoleIntent, cwd }, { cwd, sessionOwnerPid: process.pid });
      assert.deepEqual(result.outputJson, {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'unsupported_documented_leader_proof: Codex 0.144.5 hooks do not expose documented root identity required for adapted Ralplan.',
        },
      });
      assert.equal(existsSync(join(cwd, '.omx', 'state', 'session.json')), false);
      assert.equal(existsSync(join(cwd, '.omx', 'state', 'subagent-tracking.json')), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps unknown-role precedence for the documented shape with no state creation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-3194-'));
    try {
      const result = await dispatchCodexNativeHook({
        ...documentedRoleIntent,
        cwd,
        tool_input: { command: 'omx ralplan role-intent write --role synthetic-unknown --parent-thread "$CODEX_THREAD_ID" --json' },
      }, { cwd, sessionOwnerPid: process.pid });
      assert.deepEqual(result.outputJson, {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Ralplan role-intent denied: unknown_role.',
        },
      });
      assert.equal(existsSync(join(cwd, '.omx', 'state')), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('resolves project-installed custom roles against the dispatched workspace', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-3194-custom-role-'));
    try {
      const agentsDir = join(cwd, '.codex', 'agents');
      await mkdir(agentsDir, { recursive: true });
      await writeFile(join(agentsDir, 'custom-reviewer.toml'), 'name = "custom-reviewer"\n');
      const result = await dispatchCodexNativeHook({
        ...documentedRoleIntent,
        cwd,
        tool_input: { command: 'omx ralplan role-intent write --role custom-reviewer --parent-thread "$CODEX_THREAD_ID" --json' },
      }, { cwd, sessionOwnerPid: process.pid });
      assert.equal(
        (result.outputJson?.hookSpecificOutput as Record<string, unknown>)?.permissionDecisionReason,
        'unsupported_documented_leader_proof: Codex 0.144.5 hooks do not expose documented root identity required for adapted Ralplan.',
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
