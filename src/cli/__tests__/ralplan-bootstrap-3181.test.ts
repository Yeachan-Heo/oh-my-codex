import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ralplanCommand } from '../ralplan.js';
import { resolveRuntimeStateScope } from '../../mcp/state-paths.js';
import { dispatchCodexNativeHook } from '../../scripts/codex-native-hook.js';
import { signNativeLaunchClaim } from '../../subagents/native-anchor-auth.js';
import { hasVerifiedLeaderAttestation, readSubagentTrackingState } from '../../subagents/tracker.js';

const ROLE_COMMAND = 'omx ralplan role-intent write --role architect --parent-thread "$CODEX_THREAD_ID" --json';
const TEST_CODEX_HOME = join(tmpdir(), 'omx-3212-shared-codex-home');

function payload(cwd: string, nativeSessionId: string, overrides: Record<string, unknown> = {}) {
  return { hook_event_name: 'PreToolUse', cwd, session_id: nativeSessionId, tool_name: 'Bash', tool_use_id: 'synthetic-tool-use', tool_input: { command: ROLE_COMMAND }, ...overrides };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`);
}

async function prepareLaunch(cwd: string, canonical: string, native: string, launchId = 'launch-3212'): Promise<void> {
  const codexHome = TEST_CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  await mkdir(join(codexHome, '.omx'), { recursive: true });
  await writeFile(join(codexHome, '.omx', 'native-anchor-auth.key'), Buffer.alloc(32, 7));
  const signature = signNativeLaunchClaim(launchId, native, { ...process.env, CODEX_HOME: codexHome });
  await writeJson(join(cwd, '.omx', 'state', 'session.json'), { session_id: canonical, native_session_id: native, cwd });
  await writeJson(join(cwd, '.omx', 'state', 'plugin-hook-launches', `${launchId}.json`), { sessionId: native, signature });
}

async function withLaunchEnv<T>(cwd: string, launchId: string, run: () => Promise<T>): Promise<T> {
  const previous = { CODEX_HOME: process.env.CODEX_HOME, OMX_ROOT: process.env.OMX_ROOT, OMX_ENTRY_PATH: process.env.OMX_ENTRY_PATH, OMX_CODEX_LAUNCH_ID: process.env.OMX_CODEX_LAUNCH_ID };
  delete process.env.OMX_ROOT;
  process.env.CODEX_HOME = TEST_CODEX_HOME;
  process.env.OMX_ENTRY_PATH = join(process.cwd(), 'dist', 'cli', 'omx.js');
  process.env.OMX_CODEX_LAUNCH_ID = launchId;
  try { return await run(); } finally {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
}

function denialReason(result: Awaited<ReturnType<typeof dispatchCodexNativeHook>>): unknown {
  return (result.outputJson?.hookSpecificOutput as Record<string, unknown> | undefined)?.permissionDecisionReason;
}


describe('#3212 authenticated Codex 0.144.5 leader bootstrap', { concurrency: false }, () => {
  it('supports SessionStart pointer then no-thread PreToolUse and records one idempotent intent', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-3212-positive-'));
    const canonical = 'omx-canonical-3212';
    const native = 'native-root-3212';
    const launchId = 'launch-positive-3212';
    try {
      await prepareLaunch(cwd, canonical, native, launchId);
      const rootTranscript = join(cwd, 'root-transcript.jsonl');
      await writeJson(rootTranscript, { type: 'session_meta', payload: { id: native, session_id: native, cwd, originator: 'codex_exec', source: 'exec', thread_source: 'user' } });
      await withLaunchEnv(cwd, launchId, async () => {
        assert.equal((await dispatchCodexNativeHook(payload(cwd, native, { transcript_path: rootTranscript }), { cwd })).outputJson, null);
        assert.equal((await dispatchCodexNativeHook(payload(cwd, native, { transcript_path: rootTranscript }), { cwd })).outputJson, null);
      });
      const tracker = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'subagent-tracking.json'), 'utf8'));
      assert.equal(tracker.sessions[canonical].leader_thread_id, native);
      assert.equal(tracker.sessions[canonical].leader_attest_source, 'native-pretooluse-transcript');
      assert.ok(tracker.sessions[canonical].leader_attested_at);
      const normalizedTracker = await readSubagentTrackingState(cwd);
      assert.equal(hasVerifiedLeaderAttestation(canonical, normalizedTracker.sessions[canonical]), true);
      const receipts: string[] = [];
      const invoke = () => ralplanCommand(['role-intent', 'write', '--role', 'architect', '--parent-thread', native, '--session', canonical, '--json'], {
        cwd: () => cwd,
        stdout: (line) => receipts.push(line),
        generateCorrelationToken: () => 'a'.repeat(32),
        resolveSessionScope: async (root, requestedSessionId) => {
          const scope = await resolveRuntimeStateScope(root, requestedSessionId);
          process.env.CODEX_HOME = TEST_CODEX_HOME;
          delete process.env.OMX_ROOT;
          return scope;
        },
      });
      await invoke(); await invoke();
      const updated = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'subagent-tracking.json'), 'utf8'));
      assert.equal(updated.pending_role_intents.length, 1);
      assert.deepEqual(JSON.parse(receipts[1]!), JSON.parse(receipts[0]!));
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  for (const scenario of [
    { name: 'direct Codex without claim', prepare: async () => {} },
    { name: 'nested child with mismatched claim', prepare: async (cwd: string, canonical: string, native: string) => prepareLaunch(cwd, canonical, `${native}-parent`) },
    { name: 'mismatched pointer native id', prepare: async (cwd: string, canonical: string, native: string) => prepareLaunch(cwd, canonical, `${native}-pointer`) },
    { name: 'malformed transcript provenance', prepare: async (cwd: string, canonical: string, native: string) => { await prepareLaunch(cwd, canonical, native); await writeFile(join(cwd, 'transcript.jsonl'), '{bad\n'); } },
    { name: 'source-less transcript despite matching claim', prepare: async (cwd: string, canonical: string, native: string) => { await prepareLaunch(cwd, canonical, native); await writeJson(join(cwd, 'source-less.jsonl'), { type: 'session_meta', payload: { id: native, session_id: native, cwd } }); } },
    { name: 'tracked subagent', prepare: async (cwd: string, canonical: string, native: string) => { await prepareLaunch(cwd, canonical, native); await writeJson(join(cwd, '.omx', 'state', 'subagent-tracking.json'), { schemaVersion: 1, sessions: { foreign: { session_id: 'foreign', updated_at: new Date().toISOString(), threads: { [native]: { thread_id: native, kind: 'subagent' } } } }, pending_role_intents: [] }); } },
    { name: 'corrupt tracker', prepare: async (cwd: string, canonical: string, native: string) => { await prepareLaunch(cwd, canonical, native); await writeFile(join(cwd, '.omx', 'state', 'subagent-tracking.json'), '{bad'); } },
  ]) it(`fails closed for ${scenario.name}`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-3212-negative-'));
    try {
      await scenario.prepare(cwd, 'omx-negative-3212', 'native-negative-3212');
      const overrides = scenario.name === 'malformed transcript provenance'
        ? { transcript_path: join(cwd, 'transcript.jsonl') }
        : scenario.name === 'source-less transcript despite matching claim'
          ? { transcript_path: join(cwd, 'source-less.jsonl') }
          : {};
      const result = await withLaunchEnv(cwd, 'launch-3212', () => dispatchCodexNativeHook(payload(cwd, 'native-negative-3212', overrides), { cwd }));
      assert.match(String(denialReason(result)), /unsupported_documented_leader_proof/);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('rejects child, role, and conflicting-thread provenance with a matching claim', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-3212-provenance-'));
    try {
      await prepareLaunch(cwd, 'omx-provenance-3212', 'native-provenance-3212');
      for (const overrides of [{ source: { subagent: { thread_spawn: {} } } }, { source: { subagent: { thread_spawn: null } } }, { agent_role: null }, { agentType: 'architect' }, { thread_id: 'foreign-thread' }]) {
        const result = await withLaunchEnv(cwd, 'launch-3212', () => dispatchCodexNativeHook(payload(cwd, 'native-provenance-3212', overrides), { cwd }));
        assert.match(String(denialReason(result)), /unsupported_documented_leader_proof/);
      }
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('does not accept caller-supplied parent thread as proof', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-3212-parent-'));
    try {
      await prepareLaunch(cwd, 'omx-parent-3212', 'native-parent-3212');
      const stdout: string[] = [];
      await ralplanCommand(['role-intent', 'write', '--role', 'architect', '--parent-thread', 'caller-value', '--json'], { cwd: () => cwd, stdout: (line) => stdout.push(line), generateCorrelationToken: () => 'b'.repeat(32) });
      assert.match(JSON.parse(stdout[0]!).reason, /native_anchor/);
      process.exitCode = undefined;
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('rejects syntactically valid forged tracker attestations', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-3212-forged-tracker-'));
    const canonical = 'omx-forged-tracker-3212';
    const native = 'native-forged-tracker-3212';
    try {
      await prepareLaunch(cwd, canonical, native);
      await writeJson(join(cwd, '.omx', 'state', 'subagent-tracking.json'), {
        schemaVersion: 1,
        sessions: {
          [canonical]: {
            session_id: canonical,
            leader_thread_id: native,
            leader_attested_at: new Date().toISOString(),
            leader_attest_source: 'native-pretooluse-transcript',
            leader_attest_signature: '0'.repeat(64),
            updated_at: new Date().toISOString(),
            threads: {},
          },
        },
        pending_role_intents: [],
      });
      const stdout: string[] = [];
      await ralplanCommand(['role-intent', 'write', '--role', 'architect', '--parent-thread', native, '--session', canonical, '--json'], {
        cwd: () => cwd,
        stdout: (line) => stdout.push(line),
        generateCorrelationToken: () => '1'.repeat(32),
      });
      assert.deepEqual(JSON.parse(stdout[0]!), { ok: false, reason: 'native_anchor_unavailable' });
      process.exitCode = undefined;
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('does not attest a verified root for unrelated Bash commands', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-3212-unrelated-bash-'));
    const canonical = 'omx-unrelated-bash-3212';
    const native = 'native-unrelated-bash-3212';
    try {
      await prepareLaunch(cwd, canonical, native);
      const rootTranscript = join(cwd, 'unrelated-root-transcript.jsonl');
      await writeJson(rootTranscript, { type: 'session_meta', payload: { id: native, session_id: native, cwd, originator: 'codex_exec', source: 'exec', thread_source: 'user' } });
      const result = await withLaunchEnv(cwd, 'launch-3212', () => dispatchCodexNativeHook(payload(cwd, native, {
        transcript_path: rootTranscript,
        tool_input: { command: 'echo ok' },
      }), { cwd }));
      assert.equal(result.outputJson, null);
      assert.equal(existsSync(join(cwd, '.omx', 'state', 'subagent-tracking.json')), false);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('records authenticated intents for project-local custom roles', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-3212-custom-role-'));
    const canonical = 'omx-custom-role-3212';
    const native = 'native-custom-role-3212';
    try {
      await prepareLaunch(cwd, canonical, native);
      await mkdir(join(cwd, '.codex', 'agents'), { recursive: true });
      await writeFile(join(cwd, '.codex', 'agents', 'custom-reviewer.toml'), 'name = "custom-reviewer"\n');
      const rootTranscript = join(cwd, 'custom-root-transcript.jsonl');
      await writeJson(rootTranscript, { type: 'session_meta', payload: { id: native, session_id: native, cwd, originator: 'codex_exec', source: 'exec', thread_source: 'user' } });
      await withLaunchEnv(cwd, 'launch-3212', async () => {
        assert.equal((await dispatchCodexNativeHook(payload(cwd, native, {
          tool_input: { command: 'omx ralplan role-intent write --role custom-reviewer --parent-thread "$CODEX_THREAD_ID" --json' },
          transcript_path: rootTranscript,
        }), { cwd })).outputJson, null);
      });
      const stdout: string[] = [];
      await ralplanCommand(['role-intent', 'write', '--role', 'custom-reviewer', '--parent-thread', native, '--session', canonical, '--json'], {
        cwd: () => cwd,
        stdout: (line) => stdout.push(line),
        generateCorrelationToken: () => 'c'.repeat(32),
        resolveSessionScope: async (root, requestedSessionId) => {
          const scope = await resolveRuntimeStateScope(root, requestedSessionId);
          process.env.CODEX_HOME = TEST_CODEX_HOME;
          delete process.env.OMX_ROOT;
          return scope;
        },
      });
      assert.equal(JSON.parse(stdout[0]!).intent.role, 'custom-reviewer');
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('keeps unknown-role precedence with no state creation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-3212-unknown-'));
    try {
      const result = await dispatchCodexNativeHook(payload(cwd, 'native-unknown', { tool_input: { command: 'omx ralplan role-intent write --role synthetic-unknown --parent-thread "$CODEX_THREAD_ID" --json' } }), { cwd });
      assert.match(String(denialReason(result)), /unknown_role/);
      assert.equal(existsSync(join(cwd, '.omx', 'state', 'session.json')), false);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
});
