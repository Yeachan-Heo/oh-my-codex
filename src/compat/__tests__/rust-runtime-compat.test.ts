import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { enqueueDispatchRequest, initTeamState, listDispatchRequests, listMailboxMessages, sendDirectMessage } from '../../team/state.js';
import { readTeamState } from '../../hud/state.js';

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

function runOmx(
  cwd: string,
  argv: string[],
  envOverrides: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string; error?: string } {
  const omxBin = join(repoRoot(), 'dist', 'cli', 'omx.js');
  const result = spawnSync(process.execPath, [omxBin, ...argv], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...envOverrides },
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '', error: result.error?.message };
}

function shouldSkipForSpawnPermissions(err?: string): boolean {
  return typeof err === 'string' && /(EPERM|EACCES)/i.test(err);
}

async function withTempTeamStateRoot<T>(
  teamStateRoot: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previousRoot = process.env.OMX_TEAM_STATE_ROOT;
  process.env.OMX_TEAM_STATE_ROOT = teamStateRoot;
  try {
    return await fn();
  } finally {
    if (previousRoot === undefined) delete process.env.OMX_TEAM_STATE_ROOT;
    else process.env.OMX_TEAM_STATE_ROOT = previousRoot;
  }
}

async function writeCompatRuntimeFixture(runtimePath: string): Promise<void> {
  await writeFile(
    runtimePath,
    `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
function argValue(prefix) {
  const entry = argv.find((value) => value.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : null;
}
function stateDir() {
  return argValue('--state-dir=') || process.cwd();
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\\n');
}
function nowIso() { return new Date().toISOString(); }
if (argv[0] === 'schema') {
  process.stdout.write(JSON.stringify({ schema_version: 1, commands: ['acquire-authority','renew-authority','queue-dispatch','mark-notified','mark-delivered','mark-failed','request-replay','capture-snapshot'], events: [], transport: 'tmux' }) + '\\n');
  process.exit(0);
}
if (argv[0] !== 'exec') process.exit(1);
const command = JSON.parse(argv[1] || '{}');
const dir = stateDir();
const dispatchPath = path.join(dir, 'dispatch.json');
const mailboxPath = path.join(dir, 'mailbox.json');
const dispatch = readJson(dispatchPath, { records: [] });
const mailbox = readJson(mailboxPath, { records: [] });
const timestamp = nowIso();
switch (command.command) {
  case 'QueueDispatch':
    dispatch.records.push({ request_id: command.request_id, target: command.target, status: 'pending', created_at: timestamp, notified_at: null, delivered_at: null, failed_at: null, reason: null, metadata: command.metadata ?? null });
    writeJson(dispatchPath, dispatch);
    process.stdout.write(JSON.stringify({ event: 'DispatchQueued', request_id: command.request_id, target: command.target }) + '\\n');
    process.exit(0);
  case 'CreateMailboxMessage':
    mailbox.records.push({ message_id: command.message_id, from_worker: command.from_worker, to_worker: command.to_worker, body: command.body, created_at: timestamp, notified_at: null, delivered_at: null });
    writeJson(mailboxPath, mailbox);
    process.stdout.write(JSON.stringify({ event: 'MailboxMessageCreated', message_id: command.message_id, from_worker: command.from_worker, to_worker: command.to_worker }) + '\\n');
    process.exit(0);
  default:
    process.stdout.write(JSON.stringify({ event: 'ok' }) + '\\n');
    process.exit(0);
}
`,
  );
  await chmod(runtimePath, 0o755);
}

describe('rust runtime legacy-reader compatibility', () => {
  it('keeps team status on the manifest-authored compatibility view', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-rust-compat-team-'));
    try {
      const teamStateRoot = join(wd, '.omx', 'state');
      await withTempTeamStateRoot(teamStateRoot, async () => {
        await initTeamState('rust-compat-team', 'compatibility lane', 'executor', 1, wd);

        const teamDir = join(teamStateRoot, 'team', 'rust-compat-team');
        const configPath = join(teamDir, 'config.json');
        const manifestPath = join(teamDir, 'manifest.v2.json');
        const config = JSON.parse(await readFile(configPath, 'utf-8')) as Record<string, unknown>;
        const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as Record<string, unknown>;

        config.workspace_mode = 'single';
        config.tmux_session = 'omx-team-legacy-rust-compat-team';
        manifest.workspace_mode = 'worktree';
        manifest.tmux_session = 'omx-team-rust-compat-team';

        await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

        const result = runOmx(wd, ['team', 'status', 'rust-compat-team', '--json'], { OMX_TEAM_STATE_ROOT: teamStateRoot });
        if (shouldSkipForSpawnPermissions(result.error)) return;

        assert.equal(result.status, 0, result.stderr || result.stdout);
        const payload = JSON.parse(result.stdout) as {
          command?: string;
          team_name?: string;
          status?: string;
          workspace_mode?: string | null;
        };
        assert.equal(payload.command, 'omx team status');
        assert.equal(payload.team_name, 'rust-compat-team');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.workspace_mode, 'worktree');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps doctor --team on the manifest-authored tmux session', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-rust-compat-doctor-'));
    try {
      const teamStateRoot = join(wd, '.omx', 'state');
      await withTempTeamStateRoot(teamStateRoot, async () => {
        await initTeamState('rust-compat-doctor', 'compatibility lane', 'executor', 1, wd);

        const teamDir = join(teamStateRoot, 'team', 'rust-compat-doctor');
        const configPath = join(teamDir, 'config.json');
        const manifestPath = join(teamDir, 'manifest.v2.json');
        const config = JSON.parse(await readFile(configPath, 'utf-8')) as Record<string, unknown>;
        const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as Record<string, unknown>;

        config.tmux_session = 'omx-team-legacy-rust-compat-doctor';
        manifest.tmux_session = 'omx-team-rust-compat-doctor';

        await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

        const fakeBin = join(wd, 'bin');
        await mkdir(fakeBin, { recursive: true });
        const tmuxPath = join(fakeBin, 'tmux');
        await writeFile(
          tmuxPath,
          '#!/bin/sh\nif [ "$1" = "list-sessions" ]; then echo "omx-team-rust-compat-doctor"; exit 0; fi\nexit 0\n',
        );
        await chmod(tmuxPath, 0o755);

        const result = runOmx(
          wd,
          ['doctor', '--team'],
          { PATH: `${fakeBin}:${process.env.PATH || ''}`, OMX_TEAM_STATE_ROOT: teamStateRoot },
        );
        if (shouldSkipForSpawnPermissions(result.error)) return;

        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, /team diagnostics: no issues/);
        assert.match(result.stdout, /All team checks passed\./);
        assert.doesNotMatch(result.stdout, /resume_blocker/);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps HUD team state on the session-scoped compatibility file', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-rust-compat-hud-'));
    try {
      const stateRoot = join(wd, '.omx', 'state');
      const sessionId = 'hud-rust-compat';
      const sessionStateDir = join(stateRoot, 'sessions', sessionId);
      await mkdir(sessionStateDir, { recursive: true });

      await writeFile(join(stateRoot, 'session.json'), JSON.stringify({ session_id: sessionId }, null, 2));
      await writeFile(
        join(stateRoot, 'team-state.json'),
        JSON.stringify({
          active: false,
          current_phase: 'root-fallback',
          team_name: 'legacy-root',
          agent_count: 1,
        }, null, 2),
      );
      await writeFile(
        join(sessionStateDir, 'team-state.json'),
        JSON.stringify({
          active: true,
          current_phase: 'executing',
          team_name: 'rust-session',
          agent_count: 3,
        }, null, 2),
      );

      const state = await readTeamState(wd);
      assert.ok(state);
      assert.equal(state?.team_name, 'rust-session');
      assert.equal(state?.current_phase, 'executing');
      assert.equal(state?.agent_count, 3);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('prefers bridge-authored dispatch/mailbox compatibility views over stale legacy files', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-rust-compat-bridge-'));
    const previousRuntimeBinary = process.env.OMX_RUNTIME_BINARY;
    try {
      const teamStateRoot = join(wd, '.omx', 'state');
      await withTempTeamStateRoot(teamStateRoot, async () => {
        await initTeamState('rust-compat-bridge', 'compatibility lane', 'executor', 2, wd);
        const fakeBin = join(wd, 'bin');
        await mkdir(fakeBin, { recursive: true });
        const runtimePath = join(fakeBin, 'omx-runtime');
        await writeCompatRuntimeFixture(runtimePath);
        process.env.OMX_RUNTIME_BINARY = runtimePath;

        const teamDir = join(teamStateRoot, 'team', 'rust-compat-bridge');
        await writeFile(
          join(teamDir, 'dispatch', 'requests.json'),
          JSON.stringify([{ request_id: 'legacy-only', kind: 'mailbox', team_name: 'rust-compat-bridge', to_worker: 'worker-2', trigger_message: 'legacy', status: 'pending', attempt_count: 0, created_at: '2026-04-01T00:00:00.000Z', updated_at: '2026-04-01T00:00:00.000Z', message_id: 'legacy-msg' }], null, 2),
        );
        await writeFile(
          join(teamDir, 'mailbox', 'worker-2.json'),
          JSON.stringify({ worker: 'worker-2', messages: [{ message_id: 'legacy-msg', from_worker: 'worker-1', to_worker: 'worker-2', body: 'legacy body', created_at: '2026-04-01T00:00:00.000Z' }] }, null, 2),
        );

        const queued = await enqueueDispatchRequest(
          'rust-compat-bridge',
          { kind: 'mailbox', to_worker: 'worker-2', message_id: 'bridge-msg', trigger_message: 'bridge trigger' },
          wd,
        );
        const message = await sendDirectMessage('rust-compat-bridge', 'worker-1', 'worker-2', 'bridge body', wd);
        const dispatch = await listDispatchRequests('rust-compat-bridge', wd);
        const mailbox = await listMailboxMessages('rust-compat-bridge', 'worker-2', wd);

        assert.equal(dispatch.some((entry) => entry.request_id === queued.request.request_id), true);
        assert.equal(dispatch.some((entry) => entry.request_id === 'legacy-only'), false, 'bridge compat view should win over stale legacy dispatch file');
        assert.equal(mailbox.some((entry) => entry.message_id === message.message_id), true);
        assert.equal(mailbox.some((entry) => entry.message_id === 'legacy-msg'), false, 'bridge compat view should win over stale legacy mailbox file');
      });
    } finally {
      if (typeof previousRuntimeBinary === 'string') process.env.OMX_RUNTIME_BINARY = previousRuntimeBinary;
      else delete process.env.OMX_RUNTIME_BINARY;
      await rm(wd, { recursive: true, force: true });
    }
  });
});
