import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir, chmod } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync } from 'fs';
import {
  initTeamState,
  createTask,
  readTeamConfig,
  saveTeamConfig,
} from '../state.js';
import {
  startTeam,
  shutdownTeam,
  resolveWorkerLaunchArgsFromEnv,
  type TeamRuntime,
} from '../runtime.js';
import { scaleUp } from '../scaling.js';
import { resolveTeamLowComplexityDefaultModel } from '../model-contract.js';

function expectedLowComplexityModel(codexHomeOverride?: string): string {
  return resolveTeamLowComplexityDefaultModel(codexHomeOverride);
}

function withoutTeamWorkerEnv<T>(fn: () => T): T {
  const prev = process.env.OMX_TEAM_WORKER;
  delete process.env.OMX_TEAM_WORKER;
  let restoreImmediately = true;
  try {
    const result = fn();
    if (result instanceof Promise) {
      restoreImmediately = false;
      return result.finally(() => {
        if (typeof prev === 'string') process.env.OMX_TEAM_WORKER = prev;
        else delete process.env.OMX_TEAM_WORKER;
      }) as T;
    }
    return result;
  } finally {
    if (restoreImmediately) {
      if (typeof prev === 'string') process.env.OMX_TEAM_WORKER = prev;
      else delete process.env.OMX_TEAM_WORKER;
    }
  }
}

function withMockPromptModeCodexAllowed<T>(fn: () => T): T {
  const previous = process.env.OMX_TEST_ALLOW_NONTTY_CODEX_PROMPT;
  process.env.OMX_TEST_ALLOW_NONTTY_CODEX_PROMPT = '1';
  let restoreImmediately = true;
  const restore = () => {
    if (typeof previous === 'string') process.env.OMX_TEST_ALLOW_NONTTY_CODEX_PROMPT = previous;
    else delete process.env.OMX_TEST_ALLOW_NONTTY_CODEX_PROMPT;
  };
  try {
    const result = fn();
    if (result instanceof Promise) {
      restoreImmediately = false;
      return result.finally(restore) as T;
    }
    return result;
  } finally {
    if (restoreImmediately) restore();
  }
}

describe('worker runtime identity contract', () => {
  it('keeps low-complexity launch defaults without changing the role lane', () => {
    const args = resolveWorkerLaunchArgsFromEnv(
      { OMX_TEAM_WORKER_LAUNCH_ARGS: '--no-alt-screen' },
      'explore',
    );
    assert.deepEqual(args, ['--no-alt-screen', '--model', expectedLowComplexityModel()]);
  });

  it('startTeam preserves low-complexity assigned roles as outer runtime identities', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-identity-start-'));
    const binDir = join(cwd, 'bin');
    const fakeCodexPath = join(binDir, 'codex');
    const captureDir = join(cwd, 'captures');
    const promptsDir = join(cwd, '.codex', 'prompts');
    await mkdir(binDir, { recursive: true });
    await mkdir(captureDir, { recursive: true });
    await mkdir(promptsDir, { recursive: true });
    await writeFile(join(promptsDir, 'explore.md'), '<identity>You are Explorer.</identity>');
    await writeFile(join(promptsDir, 'style-reviewer.md'), '<identity>You are Style Reviewer.</identity>');
    await writeFile(join(promptsDir, 'sisyphus-lite.md'), '<identity>You are Sisyphus-lite.</identity>');
    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const worker = String(process.env.OMX_TEAM_WORKER || 'unknown').replace(/[^a-zA-Z0-9_-]+/g, '__');
const out = path.join(process.env.OMX_ARGV_CAPTURE_DIR, worker + '.json');
fs.writeFileSync(out, JSON.stringify({ argv: process.argv.slice(2), worker }, null, 2));
process.stdin.resume();
setTimeout(() => process.exit(0), 5000);
process.on('SIGTERM', () => process.exit(0));
`,
      { mode: 0o755 },
    );

    const prevPath = process.env.PATH;
    const prevTmux = process.env.TMUX;
    const prevLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const prevWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const prevCaptureDir = process.env.OMX_ARGV_CAPTURE_DIR;
    const prevLaunchArgs = process.env.OMX_TEAM_WORKER_LAUNCH_ARGS;

    process.env.PATH = `${binDir}:${prevPath ?? ''}`;
    delete process.env.TMUX;
    process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'prompt';
    process.env.OMX_TEAM_WORKER_CLI = 'codex';
    process.env.OMX_ARGV_CAPTURE_DIR = captureDir;
    delete process.env.OMX_TEAM_WORKER_LAUNCH_ARGS;

    let runtime: TeamRuntime | null = null;
    try {
      runtime = await withMockPromptModeCodexAllowed(() =>
        withoutTeamWorkerEnv(() =>
          startTeam(
            'team-low-role-routing',
            'low complexity routing handoff',
            'executor',
            2,
            [
              { subject: 'map files', description: 'map files', owner: 'worker-1', role: 'explore' },
              { subject: 'review style', description: 'review style', owner: 'worker-2', role: 'style-reviewer' },
            ],
            cwd,
          )));

      assert.equal(runtime.config.worker_launch_mode, 'prompt');
      assert.equal(runtime.config.workers[0]?.role, 'explore');
      assert.equal(runtime.config.workers[1]?.role, 'style-reviewer');

      const worker1Instructions = await readFile(join(cwd, '.omx', 'state', 'team', runtime.teamName, 'workers', 'worker-1', 'AGENTS.md'), 'utf-8');
      const worker2Instructions = await readFile(join(cwd, '.omx', 'state', 'team', runtime.teamName, 'workers', 'worker-2', 'AGENTS.md'), 'utf-8');
      assert.match(worker1Instructions, /You are operating as the \*\*explore\*\* role/);
      assert.match(worker1Instructions, /You are Explorer\./);
      assert.doesNotMatch(worker1Instructions, /Sisyphus-lite/);
      assert.match(worker2Instructions, /You are operating as the \*\*style-reviewer\*\* role/);
      assert.match(worker2Instructions, /You are Style Reviewer\./);
      assert.doesNotMatch(worker2Instructions, /Sisyphus-lite/);

      let worker1Args: string[] | null = null;
      let worker2Args: string[] | null = null;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const worker1Path = join(captureDir, 'team-low-role-routing__worker-1.json');
        const worker2Path = join(captureDir, 'team-low-role-routing__worker-2.json');
        if (existsSync(worker1Path) && existsSync(worker2Path)) {
          worker1Args = JSON.parse(await readFile(worker1Path, 'utf-8')).argv;
          worker2Args = JSON.parse(await readFile(worker2Path, 'utf-8')).argv;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      assert.ok(worker1Args, 'worker-1 argv capture file should be written');
      assert.ok(worker2Args, 'worker-2 argv capture file should be written');
      const worker1Joined = worker1Args!.join(' ');
      const worker2Joined = worker2Args!.join(' ');
      assert.match(worker1Joined, /model_reasoning_effort="low"/);
      assert.match(worker1Joined, /--model gpt-5\.3-codex-spark/);
      assert.match(worker2Joined, /model_reasoning_effort="low"/);
      assert.match(worker2Joined, /--model gpt-5\.3-codex-spark/);

      await shutdownTeam(runtime.teamName, cwd, { force: true });
      runtime = null;
    } finally {
      if (runtime) {
        await shutdownTeam(runtime.teamName, cwd, { force: true }).catch(() => {});
      }
      if (typeof prevPath === 'string') process.env.PATH = prevPath;
      else delete process.env.PATH;
      if (typeof prevTmux === 'string') process.env.TMUX = prevTmux;
      else delete process.env.TMUX;
      if (typeof prevLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = prevLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      if (typeof prevWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = prevWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      if (typeof prevCaptureDir === 'string') process.env.OMX_ARGV_CAPTURE_DIR = prevCaptureDir;
      else delete process.env.OMX_ARGV_CAPTURE_DIR;
      if (typeof prevLaunchArgs === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_ARGS = prevLaunchArgs;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_ARGS;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('scaleUp preserves low-complexity assigned roles as outer runtime identities', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-identity-scale-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-runtime-identity-scale-bin-'));
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const previousPath = process.env.PATH;

    try {
      await writeFile(
        tmuxStubPath,
        [
          '#!/bin/sh',
          'set -eu',
          `printf '%s\n' "$*" >> "${tmuxLogPath}"`,
          'case "${1:-}" in',
          '  -V)',
          '    echo "tmux 3.2a"',
          '    ;;',
          '  split-window)',
          '    echo "%31"',
          '    ;;',
          '  list-panes)',
          '    echo "42424"',
          '    ;;',
          '  capture-pane)',
          '    echo ""',
          '    ;;',
          'esac',
          'exit 0',
          '',
        ].join('\n'),
      );
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await mkdir(join(cwd, '.codex', 'prompts'), { recursive: true });
      await writeFile(join(cwd, '.codex', 'prompts', 'explore.md'), '<identity>You are Explorer.</identity>');
      await writeFile(join(cwd, '.codex', 'prompts', 'sisyphus-lite.md'), '<identity>You are Sisyphus-lite.</identity>');
      await mkdir(join(cwd, '.omx', 'state', 'team', 'low-role-scale'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'state', 'team', 'low-role-scale', 'worker-agents.md'), '# Base worker instructions\n');

      await initTeamState('low-role-scale', 'task', 'executor', 1, cwd, undefined, process.env, {
        workspace_mode: 'single',
        leader_cwd: cwd,
        team_state_root: join(cwd, '.omx', 'state'),
      });
      await createTask('low-role-scale', {
        subject: 'existing task',
        description: 'already persisted',
        status: 'pending',
        owner: 'worker-1',
      }, cwd);

      const config = await readTeamConfig('low-role-scale', cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = 'omx-team-low-role-scale';
      config.leader_pane_id = '%11';
      config.workers[0]!.pane_id = '%21';
      await saveTeamConfig(config, cwd);

      const manifestPath = join(cwd, '.omx', 'state', 'team', 'low-role-scale', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
      manifest.policy = {
        ...(manifest.policy ?? {}),
        dispatch_mode: 'transport_direct',
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleUp(
        'low-role-scale',
        1,
        'executor',
        [{ subject: 'map files', description: 'map files', owner: 'worker-2', role: 'explore' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const workerAgents = await readFile(join(cwd, '.omx', 'state', 'team', 'low-role-scale', 'workers', 'worker-2', 'AGENTS.md'), 'utf-8');
      assert.match(workerAgents, /You are operating as the \*\*explore\*\* role/);
      assert.match(workerAgents, /You are Explorer\./);
      assert.doesNotMatch(workerAgents, /Sisyphus-lite/);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /gpt-5\.3-codex-spark/);
      assert.match(tmuxLog, /model_reasoning_effort.*low/);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });
});
