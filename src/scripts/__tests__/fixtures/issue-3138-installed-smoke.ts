import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SCHEMA = 'omx.issue3138.installed-smoke.v5';
const MANDATORY_SCENARIOS = [
  'missing-owner-alias-activation',
  'unmatched-write',
  'ordinary-clear',
  'cancel',
  'cancel-force',
  'owner-terminal-native-stop',
  'all-sessions-clear',
  'managed-unmatched-idle-delivery-no-receipts',
  'rejected-root-no-launch',
  'managed-unmatched-lifecycle-delivery-no-receipts',
  'explicit-payload-session-isolation',
  'notify-existing-fork-preserves-payload-owner',
] as const;

type ScenarioName = typeof MANDATORY_SCENARIOS[number];

interface SmokeArguments {
  packageRoot: string;
  testedSha: string;
  tarballSha256: string;
}

interface ScenarioResult {
  name: ScenarioName;
  pass: boolean;
}

function fail(message: string): never {
  throw new Error(message);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

function parseArgs(argv: string[]): SmokeArguments {
  let packageRoot = '';
  let testedSha = '';
  let tarballSha256 = '';

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--package-root') {
      packageRoot = value || '';
      index += 1;
      continue;
    }
    if (arg === '--tested-sha') {
      testedSha = value || '';
      index += 1;
      continue;
    }
    if (arg === '--tarball-sha256') {
      tarballSha256 = value || '';
      index += 1;
      continue;
    }
    fail(`unknown installed smoke argument: ${arg}`);
  }

  assert(isAbsolute(packageRoot), '--package-root must be an absolute installed package path');
  assert(/(?:^|[\\/])node_modules[\\/]oh-my-codex$/.test(packageRoot), '--package-root must name the installed oh-my-codex package');
  assert(/^[0-9a-f]{40}$/i.test(testedSha), '--tested-sha must be a 40-character SHA');
  assert(/^[0-9a-f]{64}$/i.test(tarballSha256), '--tarball-sha256 must be a SHA-256 digest');
  assert(existsSync(join(packageRoot, 'package.json')), 'installed package.json is missing');
  assert(existsSync(join(packageRoot, 'dist', 'cli', 'omx.js')), 'installed CLI is missing');
  return { packageRoot, testedSha, tarballSha256 };
}

async function importInstalled<T>(packageRoot: string, relativeModulePath: string): Promise<T> {
  const modulePath = join(packageRoot, relativeModulePath);
  assert(existsSync(modulePath), `installed module is missing: ${modulePath}`);
  return await import(pathToFileURL(modulePath).href) as T;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf-8')) as T;
}

async function withEnvironment<T>(
  updates: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(updates)) previous.set(key, process.env[key]);
  try {
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withWorkspace<T>(name: string, run: (cwd: string, home: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), `omx-issue-3138-${name}-`));
  const cwd = join(root, 'project');
  const home = join(root, 'home');
  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
  await writeFile(join(cwd, '.omx', 'managed'), 'issue #3138 installed smoke fixture');
  try {
    return await run(cwd, home);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeFakeTmux(binDir: string, instanceId: string): Promise<void> {
  await mkdir(binDir, { recursive: true });
  const path = join(binDir, 'tmux');
  await writeFile(path, `#!/usr/bin/env bash
set -eu
case "$*" in
  *"@omx_pane_instance_id"*) printf '${instanceId}\\n' ;;
  *"@omx_instance_id"*) printf '${instanceId}\\n' ;;
  *"display-message"*) printf 'issue-3138-smoke\\n' ;;
  *"list-sessions"*) printf 'issue-3138-smoke\\t${instanceId}\\n' ;;
  *) exit 0 ;;
esac
`);
  await chmod(path, 0o755);
}

function installedCliPath(packageRoot: string): string {
  return join(packageRoot, 'dist', 'cli', 'omx.js');
}

function runInstalledCli(
  packageRoot: string,
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  return spawnSync(process.execPath, [installedCliPath(packageRoot), ...args], {
    cwd,
    encoding: 'utf-8',
    env,
  });
}

function runInstalledScript(
  packageRoot: string,
  cwd: string,
  relativeScriptPath: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  const scriptPath = join(packageRoot, relativeScriptPath);
  assert(existsSync(scriptPath), `installed script is missing: ${scriptPath}`);
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: 'utf-8',
    env,
  });
}

function statePath(cwd: string, sessionId: string, mode: string): string {
  return join(cwd, '.omx', 'state', 'sessions', sessionId, `${mode}-state.json`);
}

async function writeCanonicalPointer(
  packageRoot: string,
  cwd: string,
  home: string,
  canonicalSessionId: string,
  nativeSessionId: string,
  ownerSessionId?: string,
): Promise<void> {
  const session = await importInstalled<{
    writeSessionStart: (
      cwd: string,
      sessionId: string,
      options: { nativeSessionId?: string; ownerOmxSessionId?: string },
    ) => Promise<unknown>;
  }>(packageRoot, 'dist/hooks/session.js');
  await withEnvironment(cleanEnv(home, cwd), async () => {
    await session.writeSessionStart(cwd, canonicalSessionId, {
      nativeSessionId,
      ...(ownerSessionId ? { ownerOmxSessionId: ownerSessionId } : {}),
    });
  });
}

async function writeModeState(
  cwd: string,
  sessionId: string,
  mode: string,
  values: Record<string, unknown>,
): Promise<void> {
  const path = statePath(cwd, sessionId, mode);
  await mkdir(join(cwd, '.omx', 'state', 'sessions', sessionId), { recursive: true });
  await writeFile(path, JSON.stringify({
    mode,
    session_id: sessionId,
    active: true,
    current_phase: 'executing',
    ...values,
  }, null, 2));
}
async function writeRalplanConsensusEvidence(cwd: string, sessionId: string): Promise<Record<string, unknown>> {
  const now = '2026-07-14T00:00:00.000Z';
  await writeFile(join(cwd, '.omx', 'state', 'subagent-tracking.json'), JSON.stringify({
    schemaVersion: 1,
    sessions: {
      [sessionId]: {
        session_id: sessionId,
        leader_thread_id: 'thread-leader',
        updated_at: now,
        threads: {
          'thread-leader': { thread_id: 'thread-leader', kind: 'leader', first_seen_at: now, last_seen_at: now, turn_count: 1 },
          'thread-architect': { thread_id: 'thread-architect', kind: 'subagent', first_seen_at: now, last_seen_at: now, completed_at: now, turn_count: 1 },
          'thread-critic': { thread_id: 'thread-critic', kind: 'subagent', first_seen_at: now, last_seen_at: now, completed_at: now, turn_count: 1 },
        },
      },
    },
  }, null, 2));
  return {
    required: true,
    complete: true,
    sequence: ['architect-review', 'critic-review'],
    planning_artifacts_are_not_consensus: true,
    required_review_roles: ['architect', 'critic'],
    ralplan_architect_review: {
      agent_role: 'architect', verdict: 'approve', provenance_kind: 'native_subagent', session_id: sessionId,
      thread_id: 'thread-architect', artifact_path: '.omx/artifacts/architect.md', tracker_path: '.omx/state/subagent-tracking.json',
    },
    ralplan_critic_review: {
      agent_role: 'critic', verdict: 'approve', provenance_kind: 'native_subagent', session_id: sessionId,
      thread_id: 'thread-critic', artifact_path: '.omx/artifacts/critic.md', tracker_path: '.omx/state/subagent-tracking.json',
    },
  };
}

function cleanEnv(home: string, cwd: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    CODEX_HOME: join(home, '.codex'),
    OMX_ROOT: cwd,
    OMX_STATE_ROOT: undefined,
    OMX_TEAM_STATE_ROOT: undefined,
    OMX_MCP_WORKDIR_ROOTS: undefined,
    OMX_SESSION_ID: undefined,
    CODEX_SESSION_ID: undefined,
    SESSION_ID: undefined,
    OMX_TEAM_WORKER: '',
    OMX_TEAM_INTERNAL_WORKER: '',
    OMX_OPENCLAW: '',
    OMX_NOTIFY_TEMP: '',
    OMX_NOTIFY_TEMP_CONTRACT: '',
    TMUX: '',
    TMUX_PANE: '',
    ...extra,
  };
}

async function scenarioMissingOwnerAliasActivation(packageRoot: string): Promise<void> {
  await withWorkspace('missing-owner-alias', async (cwd, home) => {
    const ownerSessionId = 'omx-owner-alias';
    const nativeSessionId = 'native-owner-alias';
    const binDir = join(cwd, 'bin');
    await writeFakeTmux(binDir, ownerSessionId);
    await withEnvironment(cleanEnv(home, cwd, {
      OMX_SESSION_ID: ownerSessionId,
      TMUX: '/tmp/tmux-1000/default,1,0',
      TMUX_PANE: '%issue3138-owner-pane',
      PATH: `${binDir}:${process.env.PATH || ''}`,
    }), async () => {
      const native = await importInstalled<{
        dispatchCodexNativeHook: (payload: Record<string, unknown>, options?: Record<string, unknown>) => Promise<{
          outputJson: Record<string, unknown> | null;
        }>;
      }>(packageRoot, 'dist/scripts/codex-native-hook.js');
      const start = await native.dispatchCodexNativeHook({
        hook_event_name: 'SessionStart',
        session_id: nativeSessionId,
        cwd,
      }, { cwd, sessionOwnerPid: process.pid });
      const pointer = await readJson<Record<string, unknown>>(join(cwd, '.omx', 'state', 'session.json'));
      const canonicalSessionId = String(pointer.session_id || '');
      assert(canonicalSessionId.length > 0, 'native SessionStart did not establish a canonical pointer');
      assert(pointer.owner_omx_session_id === ownerSessionId, 'native SessionStart did not bind the verified owner alias');
      assert(start.outputJson?.decision !== 'block', 'native SessionStart unexpectedly blocked alias activation');

      const prompt = await native.dispatchCodexNativeHook({
        hook_event_name: 'UserPromptSubmit',
        session_id: nativeSessionId,
        thread_id: 'issue3138-owner-thread',
        turn_id: 'issue3138-owner-turn',
        cwd,
        prompt: '$ralph continue verification',
      }, { cwd });
      assert(prompt.outputJson?.decision !== 'block', 'owner alias prompt activation unexpectedly blocked');
      assert(existsSync(statePath(cwd, canonicalSessionId, 'ralph')), 'owner alias activation did not write canonical Ralph state');
      assert(!existsSync(join(cwd, '.omx', 'state', 'sessions', ownerSessionId)), 'owner alias activation created a split owner scope');
    });
  });
}

async function scenarioUnmatchedWrite(packageRoot: string): Promise<void> {
  await withWorkspace('unmatched-write', async (cwd, home) => {
    const canonicalSessionId = 'omx-canonical-write';
    const ownerSessionId = 'omx-unmatched-write';
    await writeCanonicalPointer(packageRoot, cwd, home, canonicalSessionId, 'native-unmatched-write');
    const result = runInstalledCli(packageRoot, cwd, [
      'state', 'write', '--input', JSON.stringify({
        mode: 'ralph', active: true, current_phase: 'executing',
      }), '--json',
    ], cleanEnv(home, cwd, { OMX_SESSION_ID: ownerSessionId, TMUX: '', TMUX_PANE: '' }));
    assert(result.status !== 0, 'unmatched owner state write unexpectedly succeeded');
    assert(!existsSync(statePath(cwd, canonicalSessionId, 'ralph')), 'unmatched owner state write mutated canonical state');
    assert(!existsSync(join(cwd, '.omx', 'state', 'sessions', ownerSessionId)), 'unmatched owner state write created an owner scope');
  });
}

async function scenarioOrdinaryClear(packageRoot: string): Promise<void> {
  await withWorkspace('ordinary-clear', async (cwd, home) => {
    const canonicalSessionId = 'omx-canonical-clear';
    const ownerSessionId = 'omx-unmatched-clear';
    await writeCanonicalPointer(packageRoot, cwd, home, canonicalSessionId, 'native-unmatched-clear');
    await writeModeState(cwd, canonicalSessionId, 'ralph', { current_phase: 'executing' });
    const before = await readFile(statePath(cwd, canonicalSessionId, 'ralph'), 'utf-8');
    const result = runInstalledCli(packageRoot, cwd, [
      'state', 'clear', '--mode', 'ralph', '--json',
    ], cleanEnv(home, cwd, { OMX_SESSION_ID: ownerSessionId, TMUX: '', TMUX_PANE: '' }));
    assert(result.status !== 0, 'unmatched owner ordinary clear unexpectedly succeeded');
    assert(await readFile(statePath(cwd, canonicalSessionId, 'ralph'), 'utf-8') === before, 'unmatched owner ordinary clear mutated canonical state');
    assert(!existsSync(join(cwd, '.omx', 'state', 'sessions', ownerSessionId)), 'ordinary clear created an owner scope');
  });
}

async function scenarioCancel(packageRoot: string): Promise<void> {
  await withWorkspace('cancel', async (cwd, home) => {
    const canonicalSessionId = 'omx-canonical-cancel';
    const ownerSessionId = 'omx-unmatched-cancel';
    await writeCanonicalPointer(packageRoot, cwd, home, canonicalSessionId, 'native-unmatched-cancel');
    await writeModeState(cwd, canonicalSessionId, 'ralph', { current_phase: 'executing' });
    const before = await readFile(statePath(cwd, canonicalSessionId, 'ralph'), 'utf-8');
    const result = runInstalledCli(packageRoot, cwd, ['cancel'], cleanEnv(home, cwd, {
      OMX_SESSION_ID: ownerSessionId,
      TMUX: '',
      TMUX_PANE: '',
    }));
    assert(result.status !== null, 'unmatched owner cancel did not exit');
    assert(await readFile(statePath(cwd, canonicalSessionId, 'ralph'), 'utf-8') === before, 'unmatched owner cancel mutated canonical state');
    assert(!existsSync(join(cwd, '.omx', 'state', 'sessions', ownerSessionId)), 'cancel created an owner scope');
  });
}

async function scenarioCancelForce(packageRoot: string): Promise<void> {
  await withWorkspace('cancel-force', async (cwd, home) => {
    const canonicalSessionId = 'omx-canonical-cancel-force';
    const ownerSessionId = 'omx-unmatched-cancel-force';
    await writeCanonicalPointer(packageRoot, cwd, home, canonicalSessionId, 'native-unmatched-cancel-force');
    await writeModeState(cwd, canonicalSessionId, 'ralph', { current_phase: 'executing' });
    const before = await readFile(statePath(cwd, canonicalSessionId, 'ralph'), 'utf-8');
    const result = runInstalledCli(packageRoot, cwd, ['cancel', '--force'], cleanEnv(home, cwd, {
      OMX_SESSION_ID: ownerSessionId,
      TMUX: '',
      TMUX_PANE: '',
    }));
    assert(result.status !== null, 'unmatched owner force cancel did not exit');
    assert(await readFile(statePath(cwd, canonicalSessionId, 'ralph'), 'utf-8') === before, 'unmatched owner force cancel mutated canonical state');
    assert(!existsSync(join(cwd, '.omx', 'state', 'sessions', ownerSessionId)), 'force cancel created an owner scope');
  });
}

async function scenarioOwnerTerminalNativeStop(packageRoot: string): Promise<void> {
  await withWorkspace('owner-terminal-stop', async (cwd, home) => {
    const canonicalSessionId = 'omx-canonical-terminal';
    const ownerSessionId = 'omx-owner-terminal';
    const nativeSessionId = 'native-owner-terminal';
    const binDir = join(cwd, 'bin');
    await writeFakeTmux(binDir, ownerSessionId);
    await writeCanonicalPointer(packageRoot, cwd, home, canonicalSessionId, nativeSessionId);
    const env = cleanEnv(home, cwd, {
      OMX_SESSION_ID: ownerSessionId,
      TMUX: '/tmp/tmux-1000/default,1,0',
      TMUX_PANE: '%issue3138-terminal-pane',
      PATH: `${binDir}:${process.env.PATH || ''}`,
    });
    const consensusGate = await writeRalplanConsensusEvidence(cwd, canonicalSessionId);
    await withEnvironment(env, async () => {
      const native = await importInstalled<{
        dispatchCodexNativeHook: (payload: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown>;
      }>(packageRoot, 'dist/scripts/codex-native-hook.js');
      await native.dispatchCodexNativeHook({
        hook_event_name: 'SessionStart',
        session_id: nativeSessionId,
        cwd,
      }, { cwd, sessionOwnerPid: process.pid });
    });
    const terminal = runInstalledCli(packageRoot, cwd, [
      'state', 'write', '--input', JSON.stringify({
        mode: 'ralplan', active: false, current_phase: 'complete', completed_at: new Date().toISOString(),
        ralplan_consensus_gate: consensusGate,
      }), '--json',
    ], env);
    assert(terminal.status === 0, terminal.stderr || terminal.stdout || 'owner terminal state write failed');
    const terminalState = await readJson<Record<string, unknown>>(statePath(cwd, canonicalSessionId, 'ralplan'));
    assert(terminalState.active === false && terminalState.current_phase === 'complete', 'owner terminal write did not update canonical state');
    assert(!existsSync(join(cwd, '.omx', 'state', 'sessions', ownerSessionId)), 'owner terminal write created a split owner scope');

    await withEnvironment(env, async () => {
      const native = await importInstalled<{
        dispatchCodexNativeHook: (payload: Record<string, unknown>, options?: Record<string, unknown>) => Promise<{
          outputJson: Record<string, unknown> | null;
        }>;
      }>(packageRoot, 'dist/scripts/codex-native-hook.js');
      const stop = await native.dispatchCodexNativeHook({
        hook_event_name: 'Stop',
        session_id: nativeSessionId,
        cwd,
      }, { cwd });
      assert(stop.outputJson?.decision !== 'block', 'native Stop continued a terminal canonical Ralph plan');
      assert(!String(stop.outputJson?.stopReason || '').startsWith('skill_ralplan_'), 'native Stop reported a stale Ralph-plan continuation');
      assert(!String(stop.outputJson?.reason || '').includes('continue_from_artifact'), 'native Stop reported an artifact continuation');
    });
  });
}

async function scenarioAllSessionsClear(packageRoot: string): Promise<void> {
  await withWorkspace('all-sessions-clear', async (cwd, home) => {
    const canonicalSessionId = 'omx-canonical-all-clear';
    const otherSessionId = 'omx-existing-other';
    const ownerSessionId = 'omx-unmatched-all-clear';
    await writeCanonicalPointer(packageRoot, cwd, home, canonicalSessionId, 'native-all-clear');
    await writeModeState(cwd, canonicalSessionId, 'ralph', { current_phase: 'executing' });
    await writeModeState(cwd, otherSessionId, 'ralph', { current_phase: 'executing' });
    const result = runInstalledCli(packageRoot, cwd, [
      'state', 'clear', '--input', JSON.stringify({ mode: 'ralph', all_sessions: true }), '--json',
    ], cleanEnv(home, cwd, { OMX_SESSION_ID: ownerSessionId, TMUX: '', TMUX_PANE: '' }));
    assert(result.status === 0, result.stderr || result.stdout || 'all-sessions clear failed');
    assert(!existsSync(statePath(cwd, canonicalSessionId, 'ralph')), 'all-sessions clear left canonical Ralph state');
    assert(!existsSync(statePath(cwd, otherSessionId, 'ralph')), 'all-sessions clear left existing secondary Ralph state');
    assert(!existsSync(join(cwd, '.omx', 'state', 'sessions', ownerSessionId)), 'all-sessions clear initialized an owner scope');
  });
}

async function writeNotificationConfig(home: string): Promise<void> {
  const codexHome = join(home, '.codex');
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(codexHome, '.omx-config.json'), JSON.stringify({
    notifications: {
      enabled: true,
      telegram: {
        enabled: true,
        botToken: '123456:issue3138-smoke-token',
        chatId: 'issue3138-smoke-chat',
      },
    },
  }, null, 2));
}

async function withMockedTelegramDelivery<T>(run: (deliveries: Array<Record<string, unknown>>) => Promise<T>): Promise<T> {
  const previousFetch = globalThis.fetch;
  const deliveries: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    deliveries.push(JSON.parse(String(init?.body || '{}')) as Record<string, unknown>);
    return new Response(JSON.stringify({ ok: true, result: { message_id: `issue3138-${deliveries.length}` } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  try {
    return await run(deliveries);
  } finally {
    globalThis.fetch = previousFetch;
  }
}

async function scenarioManagedUnmatchedIdleDeliveryNoReceipts(packageRoot: string): Promise<void> {
  await withWorkspace('managed-unmatched-idle', async (cwd, home) => {
    const ownerSessionId = 'omx-unmatched-idle';
    await writeNotificationConfig(home);
    await withEnvironment(cleanEnv(home, cwd, { OMX_SESSION_ID: ownerSessionId, TMUX_PANE: '%issue3138-idle-pane' }), async () => {
      const notifications = await importInstalled<{
        notifyLifecycle: (
          event: string,
          payload: Record<string, unknown>,
          profileName?: string,
          options?: { persistScopedReceipts?: boolean },
        ) => Promise<{ anySuccess: boolean; results: Array<{ messageId?: string }> } | null>;
      }>(packageRoot, 'dist/notifications/index.js');
      await withMockedTelegramDelivery(async (deliveries) => {
        const result = await notifications.notifyLifecycle('session-idle', {
          sessionId: ownerSessionId,
          projectPath: cwd,
          tmuxPaneId: '%issue3138-idle-pane',
          tmuxSession: 'issue3138-smoke',
          tmuxTail: 'fresh idle tail',
        }, undefined, { persistScopedReceipts: false });
        assert(result?.anySuccess === true, 'managed unmatched idle delivery did not succeed');
        assert(result.results.some((entry) => entry.messageId === 'issue3138-1'), 'managed unmatched idle delivery omitted the provider message ID');
        assert(deliveries.length === 1, 'managed unmatched idle delivery did not reach the provider');
      });
    });
    assert(!existsSync(join(cwd, '.omx', 'state', 'sessions', ownerSessionId, 'idle-notif-cooldown.json')), 'managed unmatched idle wrote an idle receipt');
    assert(!existsSync(join(cwd, '.omx', 'state', 'sessions', ownerSessionId, 'lifecycle-notif-state.json')), 'managed unmatched idle wrote a lifecycle receipt');
    assert(!existsSync(join(home, '.omx', 'state', 'reply-session-registry.jsonl')), 'managed unmatched idle wrote a reply mapping');
    assert(!existsSync(join(home, '.omx', 'state', 'reply-session-registry.lock')), 'managed unmatched idle left a reply registry lock');
  });
}

async function scenarioRejectedRootNoLaunch(packageRoot: string): Promise<void> {
  await withWorkspace('rejected-root', async (cwd, home) => {
    const outsideRoot = await mkdtemp(join(tmpdir(), 'omx-issue-3138-rejected-root-'));
    const binDir = join(cwd, 'bin');
    const invocationLog = join(cwd, 'unexpected-launch.log');
    try {
      await mkdir(binDir, { recursive: true });
      for (const command of ['codex', 'tmux']) {
        const path = join(binDir, command);
        await writeFile(path, `#!/usr/bin/env bash\nprintf '${command} %s\\n' "$*" >> ${JSON.stringify(invocationLog)}\nexit 0\n`);
        await chmod(path, 0o755);
      }
      const result = runInstalledCli(packageRoot, cwd, ['--dangerously-bypass-approvals-and-sandbox'], cleanEnv(home, cwd, {
        OMX_ROOT: outsideRoot,
        OMX_MCP_WORKDIR_ROOTS: cwd,
        OMX_LAUNCH_POLICY: 'direct',
        PATH: `${binDir}:${process.env.PATH || ''}`,
      }));
      assert(result.status !== 0, 'rejected root direct launch unexpectedly succeeded');
      assert(/session_pointer_context_failure|outside allowed roots/i.test(`${result.stdout}\n${result.stderr}`), 'rejected root did not report a typed context abort');
      const invocationText = existsSync(invocationLog) ? await readFile(invocationLog, 'utf-8') : '';
      assert(!/^codex\b/m.test(invocationText), 'rejected root launched Codex');
      assert(!/^tmux (?:new-session|set-option|split-window|send-keys)\b/m.test(invocationText), 'rejected root mutated tmux state');
      assert(!existsSync(join(cwd, '.omx', 'state', 'session.json')), 'rejected root committed a session pointer');
      assert(!existsSync(join(cwd, '.omx', 'runtime')), 'rejected root created post-launch runtime artifacts');
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
}

async function scenarioManagedUnmatchedLifecycleDeliveryNoReceipts(packageRoot: string): Promise<void> {
  await withWorkspace('managed-unmatched-lifecycle', async (cwd, home) => {
    const ownerSessionId = 'omx-unmatched-lifecycle';
    await writeNotificationConfig(home);
    await withEnvironment(cleanEnv(home, cwd, { OMX_SESSION_ID: ownerSessionId }), async () => {
      const notifications = await importInstalled<{
        notifyLifecycle: (
          event: string,
          payload: Record<string, unknown>,
          profileName?: string,
          options?: { persistScopedReceipts?: boolean },
        ) => Promise<{ anySuccess: boolean } | null>;
      }>(packageRoot, 'dist/notifications/index.js');
      await withMockedTelegramDelivery(async (deliveries) => {
        const first = await notifications.notifyLifecycle('session-start', {
          sessionId: ownerSessionId,
          projectPath: cwd,
        }, undefined, { persistScopedReceipts: false });
        const second = await notifications.notifyLifecycle('session-start', {
          sessionId: ownerSessionId,
          projectPath: cwd,
        }, undefined, { persistScopedReceipts: false });
        assert(first?.anySuccess === true && second?.anySuccess === true, 'managed unmatched lifecycle delivery did not succeed');
        assert(deliveries.length === 2, 'managed unmatched lifecycle delivery was unexpectedly deduped');
      });
    });
    assert(!existsSync(join(cwd, '.omx', 'state', 'sessions', ownerSessionId, 'lifecycle-notif-state.json')), 'managed unmatched lifecycle wrote a lifecycle receipt');
  });
}

async function scenarioExplicitPayloadSessionIsolation(packageRoot: string): Promise<void> {
  await withWorkspace('explicit-payload-isolation', async (cwd, home) => {
    const firstSessionId = 'codex-payload-first';
    const secondSessionId = 'codex-payload-second';
    await writeCanonicalPointer(packageRoot, cwd, home, firstSessionId, firstSessionId);
    await writeModeState(cwd, firstSessionId, 'ralph', { marker: 'first-before', owner_codex_session_id: firstSessionId });
    await writeModeState(cwd, secondSessionId, 'ralph', { marker: 'second-before', owner_codex_session_id: secondSessionId });
    const pointerPath = join(cwd, '.omx', 'state', 'session.json');
    const pointerBefore = await readFile(pointerPath, 'utf8');
    await withEnvironment(cleanEnv(home, cwd), async () => {
      const native = await importInstalled<{
        dispatchCodexNativeHook: (payload: Record<string, unknown>, options?: Record<string, unknown>) => Promise<{
          outputJson: Record<string, unknown> | null;
        }>;
      }>(packageRoot, 'dist/scripts/codex-native-hook.js');
      const secondBeforeFirst = await readFile(statePath(cwd, secondSessionId, 'ralph'), 'utf-8');
      const first = await native.dispatchCodexNativeHook({
        hook_event_name: 'UserPromptSubmit', session_id: firstSessionId, thread_id: 'explicit-first', turn_id: 'explicit-first-turn', cwd,
        prompt: '$ralph continue first payload session',
      }, { cwd });
      assert(first.outputJson?.decision !== 'block', 'first explicit payload prompt was blocked');
      assert(await readFile(statePath(cwd, secondSessionId, 'ralph'), 'utf-8') === secondBeforeFirst, 'first explicit payload mutated second scoped state');

      const firstBeforeSecond = await readFile(statePath(cwd, firstSessionId, 'ralph'), 'utf-8');
      const second = await native.dispatchCodexNativeHook({
        hook_event_name: 'UserPromptSubmit', session_id: secondSessionId, thread_id: 'explicit-second', turn_id: 'explicit-second-turn', cwd,
        prompt: '$ralph continue second payload session',
      }, { cwd });
      assert(second.outputJson?.decision !== 'block', 'second explicit payload prompt was blocked');
      assert(await readFile(statePath(cwd, firstSessionId, 'ralph'), 'utf-8') === firstBeforeSecond, 'second explicit payload mutated first scoped state');
    });
    assert(await readFile(pointerPath, 'utf8') === pointerBefore, 'explicit payload prompts rewrote the selected pointer');
  });
}

async function scenarioNotifyExistingForkPreservesPayloadOwner(packageRoot: string): Promise<void> {
  await withWorkspace('notify-existing-fork-owner', async (cwd, home) => {
    const canonicalSessionId = 'omx-notify-canonical';
    const payloadSessionId = 'codex-notify-owner';
    const forkSessionId = 'omx-notify-existing-fork';
    const canonicalHudPath = join(cwd, '.omx', 'state', 'sessions', canonicalSessionId, 'hud-state.json');
    await writeCanonicalPointer(packageRoot, cwd, home, canonicalSessionId, payloadSessionId);
    await mkdir(join(cwd, '.omx', 'state', 'sessions', forkSessionId), { recursive: true });
    await mkdir(join(cwd, '.omx', 'state', 'sessions', canonicalSessionId), { recursive: true });
    await writeFile(canonicalHudPath, JSON.stringify({ turn_count: 7, marker: 'canonical-source' }, null, 2));
    const canonicalHudBefore = await readFile(canonicalHudPath, 'utf-8');
    const pointerPath = join(cwd, '.omx', 'state', 'session.json');
    const pointerBefore = await readFile(pointerPath, 'utf-8');
    const pointer = await readJson<Record<string, unknown>>(pointerPath);
    assert(pointer.native_session_id === payloadSessionId, 'notify fork setup did not bind payload owner P');
    const result = runInstalledScript(packageRoot, cwd, 'dist/scripts/notify-hook.js', [JSON.stringify({
      cwd, session_id: payloadSessionId, type: 'agent-turn-complete', thread_id: 'notify-fork-thread', turn_id: 'notify-fork-turn',
      input_messages: ['$ralph continue'], last_assistant_message: 'fork storage receipt',
    })], cleanEnv(home, cwd, { OMX_SESSION_ID: forkSessionId }));
    assert(result.status === 0, result.stderr || result.stdout || 'installed notify fork route failed');
    const forkDir = join(cwd, '.omx', 'state', 'sessions', forkSessionId);
    const skillState = await readJson<Record<string, unknown>>(join(forkDir, 'skill-active-state.json'));
    const ralphState = await readJson<Record<string, unknown>>(join(forkDir, 'ralph-state.json'));
    assert(skillState.owner_codex_session_id === payloadSessionId, 'notify fork skill state did not retain payload owner P');
    assert(ralphState.owner_codex_session_id === payloadSessionId, 'notify fork Ralph seed did not retain payload owner P');
    const second = runInstalledScript(packageRoot, cwd, 'dist/scripts/notify-hook.js', [JSON.stringify({
      cwd, session_id: payloadSessionId, type: 'agent-turn-complete', thread_id: 'notify-fork-thread', turn_id: 'notify-fork-turn-2',
      input_messages: [], last_assistant_message: 'fork lifecycle continuation',
    })], cleanEnv(home, cwd, { OMX_SESSION_ID: forkSessionId }));
    assert(second.status === 0, second.stderr || second.stdout || 'installed notify fork continuation failed');
    const ralphAfterSecond = await readJson<Record<string, unknown>>(join(forkDir, 'ralph-state.json'));
    assert(ralphAfterSecond.owner_codex_session_id === payloadSessionId, 'notify fork lifecycle sync lost payload owner P');
    assert(existsSync(join(cwd, '.omx', 'state', 'sessions', forkSessionId, 'hud-state.json')), 'notify fork route did not mutate existing fork storage');
    assert(existsSync(join(cwd, '.omx', 'state', 'sessions', forkSessionId, 'notify-hook-state.json')), 'notify fork route did not persist its fork receipt');
    assert(await readFile(canonicalHudPath, 'utf-8') === canonicalHudBefore, 'notify fork route mutated canonical source storage');
    assert(!existsSync(join(cwd, '.omx', 'state', 'sessions', canonicalSessionId, 'notify-hook-state.json')), 'notify fork route created a canonical receipt');
    assert(!existsSync(join(cwd, '.omx', 'state', 'sessions', payloadSessionId)), 'notify fork route created payload owner storage');
    assert(await readFile(pointerPath, 'utf-8') === pointerBefore, 'notify fork route mutated the payload owner pointer');
  });
}

async function runScenario(name: ScenarioName, packageRoot: string): Promise<void> {
  switch (name) {
    case 'missing-owner-alias-activation':
      await scenarioMissingOwnerAliasActivation(packageRoot);
      return;
    case 'unmatched-write':
      await scenarioUnmatchedWrite(packageRoot);
      return;
    case 'ordinary-clear':
      await scenarioOrdinaryClear(packageRoot);
      return;
    case 'cancel':
      await scenarioCancel(packageRoot);
      return;
    case 'cancel-force':
      await scenarioCancelForce(packageRoot);
      return;
    case 'owner-terminal-native-stop':
      await scenarioOwnerTerminalNativeStop(packageRoot);
      return;
    case 'all-sessions-clear':
      await scenarioAllSessionsClear(packageRoot);
      return;
    case 'managed-unmatched-idle-delivery-no-receipts':
      await scenarioManagedUnmatchedIdleDeliveryNoReceipts(packageRoot);
      return;
    case 'rejected-root-no-launch':
      await scenarioRejectedRootNoLaunch(packageRoot);
      return;
    case 'managed-unmatched-lifecycle-delivery-no-receipts':
      await scenarioManagedUnmatchedLifecycleDeliveryNoReceipts(packageRoot);
      return;
    case 'explicit-payload-session-isolation':
      await scenarioExplicitPayloadSessionIsolation(packageRoot);
      return;
    case 'notify-existing-fork-preserves-payload-owner':
      await scenarioNotifyExistingForkPreservesPayloadOwner(packageRoot);
      return;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const packageJson = await readJson<{ version?: unknown }>(join(args.packageRoot, 'package.json'));
  assert(typeof packageJson.version === 'string' && packageJson.version.length > 0, 'installed package version is missing');

  const scenarios: ScenarioResult[] = [];
  const failures: string[] = [];
  for (const name of MANDATORY_SCENARIOS) {
    try {
      await runScenario(name, args.packageRoot);
      scenarios.push({ name, pass: true });
    } catch (error) {
      scenarios.push({ name, pass: false });
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  assert(scenarios.length === MANDATORY_SCENARIOS.length, 'installed smoke omitted a mandatory scenario');
  assert(new Set(scenarios.map((scenario) => scenario.name)).size === MANDATORY_SCENARIOS.length, 'installed smoke duplicated a mandatory scenario');
  const report = {
    schema: SCHEMA,
    tested_sha: args.testedSha,
    tarball_sha256: args.tarballSha256,
    installed_version: packageJson.version,
    scenarios,
    ...(failures.length > 0 ? { error: failures.join('\n') } : {}),
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
