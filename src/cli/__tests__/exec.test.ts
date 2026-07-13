import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildExecFollowupStopOutput,
  injectExecFollowup,
  readPendingExecFollowups,
} from '../../exec/followup.js';
import { writeSessionStart } from '../../hooks/session.js';

function runOmx(
  cwd: string,
  argv: string[],
  envOverrides: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string; error: string } {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const omxBin = join(repoRoot, 'dist', 'cli', 'omx.js');
  const result = spawnSync(process.execPath, [omxBin, ...argv], {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      CODEX_HOME: '',
      OMX_MODEL_INSTRUCTIONS_FILE: '',
      OMX_TEAM_WORKER: '',
      OMX_TEAM_STATE_ROOT: '',
      OMX_TEAM_LEADER_CWD: '',
      ...envOverrides,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error?.message || '',
  };
}

describe('omx exec', () => {
  it('persists audited follow-up prompts for the active exec session without pane input', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-exec-followup-'));
    try {
      const session = await writeSessionStart(wd, 'omx-test-followup');
      const result = await injectExecFollowup({
        cwd: wd,
        sessionId: session.session_id,
        actor: 'test-operator',
        prompt: 'Please include the new migration note before finishing.',
        nowIso: '2026-04-27T10:00:00.000Z',
      });

      assert.equal(result.queued.session_id, 'omx-test-followup');
      assert.equal(result.queued.actor, 'test-operator');
      assert.equal(result.queued.prompt, 'Please include the new migration note before finishing.');
      assert.match(result.queuePath, /exec-followups\.json$/);

      const persisted = JSON.parse(await readFile(result.queuePath, 'utf-8')) as {
        records: Array<Record<string, unknown>>;
      };
      assert.equal(persisted.records.length, 1);
      assert.equal(persisted.records[0]?.delivered_at, undefined);

      const auditPath = join(wd, '.omx', 'logs', 'exec-followups-2026-04-27.jsonl');
      assert.match(await readFile(auditPath, 'utf-8'), /exec_followup_queued/);
      assert.match(await readFile(auditPath, 'utf-8'), /Please include the new migration note/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves all follow-up prompts from concurrent injections', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-exec-followup-concurrent-'));
    try {
      const session = await writeSessionStart(wd, 'omx-test-concurrent-followup');
      const count = 25;
      const results = await Promise.all(Array.from({ length: count }, async (_, index) => (
        injectExecFollowup({
          cwd: wd,
          sessionId: session.session_id,
          actor: `operator-${index}`,
          prompt: `Concurrent follow-up ${index}`,
          nowIso: '2026-04-27T10:01:00.000Z',
        })
      )));

      const pending = await readPendingExecFollowups(wd, session.session_id);
      assert.equal(pending.pending.length, count);
      assert.deepEqual(
        [...new Set(pending.pending.map((record) => record.id))].sort(),
        results.map((result) => result.queued.id).sort(),
      );
      assert.deepEqual(
        pending.pending.map((record) => record.prompt).sort(),
        Array.from({ length: count }, (_, index) => `Concurrent follow-up ${index}`).sort(),
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('delivers queued follow-ups through Stop hook output and marks them delivered', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-exec-followup-stop-'));
    try {
      const session = await writeSessionStart(wd, 'omx-test-stop-followup');
      const queued = await injectExecFollowup({
        cwd: wd,
        sessionId: session.session_id,
        actor: 'qa',
        prompt: 'Before stopping, verify the targeted exec tests.',
        nowIso: '2026-04-27T10:05:00.000Z',
      });

      const output = await buildExecFollowupStopOutput(wd, session.session_id);
      assert.equal(output?.decision, 'block');
      assert.match(String(output?.reason), new RegExp(queued.queued.id));
      assert.match(String(output?.systemMessage), /queued follow-up instruction/);
      assert.match(String(output?.systemMessage), /Before stopping, verify the targeted exec tests/);

      const after = await readPendingExecFollowups(wd, session.session_id);
      assert.equal(after.pending.length, 0);
      const persisted = JSON.parse(await readFile(queued.queuePath, 'utf-8')) as {
        records: Array<{ delivered_at?: string; delivery_event?: string }>;
      };
      assert.equal(persisted.records[0]?.delivery_event, 'stop-hook');
      assert.ok(persisted.records[0]?.delivered_at);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('quarantines malformed follow-up queue JSON instead of crashing Stop delivery', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-exec-followup-corrupt-'));
    try {
      const session = await writeSessionStart(wd, 'omx-test-corrupt-followup');
      const queuePath = join(wd, '.omx', 'state', 'sessions', session.session_id, 'exec-followups.json');
      await mkdir(dirname(queuePath), { recursive: true });
      await writeFile(queuePath, '{"version":1,"records":[', 'utf-8');

      const output = await buildExecFollowupStopOutput(wd, session.session_id);
      assert.equal(output, null);

      const recovered = JSON.parse(await readFile(queuePath, 'utf-8')) as {
        records: Array<Record<string, unknown>>;
      };
      assert.deepEqual(recovered.records, []);

      const queueDirEntries = await readdir(dirname(queuePath));
      assert.ok(
        queueDirEntries.some((entry) => entry.startsWith('exec-followups.json.corrupt-')),
        'malformed queue should be quarantined beside the recovered queue',
      );
      const auditPath = join(wd, '.omx', 'logs', `exec-followups-${new Date().toISOString().slice(0, 10)}.jsonl`);
      assert.match(await readFile(auditPath, 'utf-8'), /exec_followup_queue_corrupt_recovered/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('runs codex exec with session-scoped instructions that preserve AGENTS and overlay content', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-exec-cli-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');

      await mkdir(join(home, '.codex'), { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(join(home, '.codex', 'AGENTS.md'), '# User Instructions\n\nGlobal guidance.\n');
      await writeFile(join(wd, 'AGENTS.md'), '# Project Instructions\n\nProject guidance.\n');
      await writeFile(
        fakeCodexPath,
        [
          '#!/bin/sh',
          'printf \'fake-codex:%s\\n\' "$*"',
          'for arg in "$@"; do',
          '  case "$arg" in',
          '    model_instructions_file=*)',
          '      file=$(printf %s "$arg" | sed \'s/^model_instructions_file="//; s/"$//\')',
          '      printf \'instructions-path:%s\\n\' "$file"',
          '      printf \'instructions-start\\n\'',
          '      cat "$file"',
          '      printf \'instructions-end\\n\'',
          '      ;;',
          '  esac',
          'done',
        ].join('\n'),
      );
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);

      const result = runOmx(wd, ['exec', '--model', 'gpt-5', 'say hi'], {
        HOME: home,
        NODE_OPTIONS: '',
        PATH: `${fakeBin}:/usr/bin:/bin`,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
      });

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:exec --model gpt-5 say hi /);
      assert.match(result.stdout, /instructions-path:.*\/\.omx\/state\/sessions\/omx-.*\/AGENTS\.md/);
      assert.match(result.stdout, /# User Instructions/);
      assert.match(result.stdout, /# Project Instructions/);
      assert.match(result.stdout, /<!-- OMX:RUNTIME:START -->/);

      const sessionRoot = join(wd, '.omx', 'state', 'sessions');
      const sessionEntries = await readdir(sessionRoot);
      assert.equal(sessionEntries.length, 1);
      const sessionFiles = await readdir(join(sessionRoot, sessionEntries[0]));
      assert.equal(sessionFiles.includes('AGENTS.md'), false, 'session-scoped AGENTS file should be cleaned up after exec exits');
      assert.equal(existsSync(join(wd, '.omx', 'state', 'session.json')), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('passes literal max and ultra after -- with raw config args to Codex exec unchanged', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-exec-reasoning-passthrough-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');
      const fakeCapturePath = join(wd, 'fake-codex-argv.json');
      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        fakeCodexPath,
        [
          '#!/bin/sh',
          `exec "$NODE_BINARY" -e 'require("node:fs").writeFileSync(process.env.OMX_FAKE_CODEX_CAPTURE_PATH, JSON.stringify(process.argv.slice(1)))' -- "$@"`,
          '',
        ].join('\n'),
      );
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);

      const result = runOmx(
        wd,
        [
          'exec',
          '-c',
          'model_reasoning_effort=MAX',
          '--',
          '--max',
          '--ultra',
          '-c',
          'model_reasoning_effort="ultra"',
          '-c',
          'model_reasoning_effort=future',
          'suffix argument with spaces',
          '',
          '--',
          'after second marker',
        ],
        {
          HOME: home,
          NODE_OPTIONS: '',
          PATH: `${fakeBin}:/usr/bin:/bin`,
          OMX_AUTO_UPDATE: '0',
          OMX_NOTIFY_FALLBACK: '0',
          OMX_HOOK_DERIVED_SIGNALS: '0',
          NODE_BINARY: process.execPath,
          OMX_FAKE_CODEX_CAPTURE_PATH: fakeCapturePath,
        },
      );

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      const capturedArgv = JSON.parse(await readFile(fakeCapturePath, 'utf-8')) as string[];
      const firstMarkerIndex = capturedArgv.indexOf('--');
      assert.equal(firstMarkerIndex, 5);
      const modelInstructionsArg = capturedArgv[firstMarkerIndex - 1];
      assert.match(modelInstructionsArg, /^model_instructions_file="[^"\n]+"$/);
      assert.match(modelInstructionsArg, /\.omx\/state\/sessions\/omx-[^"]+\/AGENTS\.md"$/);
      assert.equal(capturedArgv.filter((arg) => arg.startsWith('model_instructions_file=')).length, 1);
      assert.deepEqual(capturedArgv, [
        'exec',
        '-c',
        'model_reasoning_effort=MAX',
        '-c',
        modelInstructionsArg,
        '--',
        '--max',
        '--ultra',
        '-c',
        'model_reasoning_effort="ultra"',
        '-c',
        'model_reasoning_effort=future',
        'suffix argument with spaces',
        '',
        '--',
        'after second marker',
      ]);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('passes exec --help through to codex exec', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-exec-help-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(fakeCodexPath, '#!/bin/sh\nprintf \'fake-codex:%s\\n\' \"$*\"\n');
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);

      const result = runOmx(wd, ['exec', '--help'], {
        HOME: home,
        NODE_OPTIONS: '',
        PATH: `${fakeBin}:/usr/bin:/bin`,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
      });

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:exec --help\b/);
      assert.doesNotMatch(result.stdout, /oh-my-codex \(omx\) - Multi-agent orchestration for Codex CLI/i);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});

describe('omx reasoning root validation', () => {
  it('rejects max, ultra, and casing without creating or mutating config.toml', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-root-reasoning-validation-'));
    try {
      const codexHome = join(wd, 'codex-home');
      const configPath = join(codexHome, 'config.toml');
      const configContents = 'model = "gpt-5"\n';
      await mkdir(codexHome, { recursive: true });
      await writeFile(configPath, configContents);

      const maxGuidance = 'Per-agent "max" is configured with agentReasoning; direct -c model_reasoning_effort=... is passed to Codex and remains capability-dependent.';
      const ultraGuidance = 'Direct -c model_reasoning_effort=... remains opaque Codex passthrough.';
      const assertFragmentsInOrder = (output: string, fragments: string[]): void => {
        let previousIndex = -1;
        for (const fragment of fragments) {
          const index = output.indexOf(fragment);
          assert.ok(index > previousIndex, `expected ordered stderr fragment: ${fragment}`);
          previousIndex = index;
        }
      };
      for (const mode of ['max', 'MAX']) {
        const result = runOmx(wd, ['reasoning', mode], { CODEX_HOME: codexHome });
        assert.equal(result.status, 1, result.error || result.stderr || result.stdout);
        assert.equal(result.stdout, '');
        assertFragmentsInOrder(result.stderr, [
          `Reasoning mode "${mode}" is not supported by "omx reasoning".`,
          maxGuidance,
          `Invalid reasoning mode "${mode}". Expected one of: low, medium, high, xhigh.`,
          'Usage: omx reasoning <low|medium|high|xhigh>',
        ]);
        assert.equal(await readFile(configPath, 'utf-8'), configContents);
      }

      for (const mode of ['ultra', 'uLtRa']) {
        const result = runOmx(wd, ['reasoning', mode], { CODEX_HOME: codexHome });
        assert.equal(result.status, 1, result.error || result.stderr || result.stdout);
        assert.equal(result.stdout, '');
        assertFragmentsInOrder(result.stderr, [
          `Reasoning mode "${mode}" is not supported by OMX root or per-agent reasoning and is not an alias for "max".`,
          ultraGuidance,
          `Invalid reasoning mode "${mode}". Expected one of: low, medium, high, xhigh.`,
          'Usage: omx reasoning <low|medium|high|xhigh>',
        ]);
        assert.equal(await readFile(configPath, 'utf-8'), configContents);
      }

      const casingResult = runOmx(wd, ['reasoning', 'High'], { CODEX_HOME: codexHome });
      assert.equal(casingResult.status, 1, casingResult.error || casingResult.stderr || casingResult.stdout);
      assert.equal(casingResult.stdout, '');
      assertFragmentsInOrder(casingResult.stderr, [
        'Invalid reasoning mode "High". Expected one of: low, medium, high, xhigh.',
        'Usage: omx reasoning <low|medium|high|xhigh>',
      ]);
      assert.equal(await readFile(configPath, 'utf-8'), configContents);

      const absentCodexHome = join(wd, 'absent-codex-home');
      const absentResult = runOmx(wd, ['reasoning', 'MAX'], { CODEX_HOME: absentCodexHome });
      assert.equal(absentResult.status, 1, absentResult.error || absentResult.stderr || absentResult.stdout);
      assert.equal(absentResult.stdout, '');
      assert.equal(existsSync(absentCodexHome), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
