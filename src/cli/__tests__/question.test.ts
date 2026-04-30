import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { questionCommand } from '../question.js';
import { markQuestionAnswered, readQuestionRecord } from '../../question/state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const omxBin = join(repoRoot, 'dist', 'cli', 'omx.js');
const tempDirs: string[] = [];
let originalProcessExitCode: string | number | null | undefined;

async function makeRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-question-cli-'));
  tempDirs.push(cwd);
  await mkdir(join(cwd, '.omx', 'state', 'sessions', 'sess-q', 'questions'), { recursive: true });
  await writeFile(join(cwd, '.omx', 'state', 'session.json'), JSON.stringify({ session_id: 'sess-q' }));
  return cwd;
}

afterEach(async () => {
  process.exitCode = originalProcessExitCode;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('omx question CLI', () => {
  beforeEach(() => {
    originalProcessExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  it('hard-fails worker contexts before UI launch', async () => {
    const cwd = await makeRepo();
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [omxBin, 'question', '--input', JSON.stringify({
        question: 'Pick one',
        options: ['A'],
        allow_other: true,
      }), '--json'], {
        cwd,
        env: { ...process.env, OMX_TEAM_WORKER: 'demo/worker-1', OMX_AUTO_UPDATE: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });

    assert.equal(result.code, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.error.code, 'worker_blocked');
    assert.deepEqual(await readdir(join(cwd, '.omx', 'state', 'sessions', 'sess-q', 'questions')), []);
  });

  it('blocks until an answer is written and returns structured payload', async () => {
    const cwd = await makeRepo();
    const input = JSON.stringify({
      question: 'Pick one',
      options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }],
      allow_other: true,
      source: 'deep-interview',
      type: 'multi-answerable',
      session_id: 'sess-q',
    });

    const child = spawn(process.execPath, [omxBin, 'question', '--input', input, '--json'], {
      cwd,
      env: { ...process.env, OMX_AUTO_UPDATE: '0', OMX_NOTIFY_FALLBACK: '0', OMX_HOOK_DERIVED_SIGNALS: '0', OMX_QUESTION_TEST_RENDERER: 'noop' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const closePromise = new Promise<number | null>((resolve) => child.on('close', resolve));

    const questionsDir = join(cwd, '.omx', 'state', 'sessions', 'sess-q', 'questions');
    let recordFile = '';
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const { readdir } = await import('node:fs/promises');
        const entries = await readdir(questionsDir);
        recordFile = entries.find((entry) => entry.endsWith('.json')) || '';
        if (recordFile) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.notEqual(recordFile, '', `expected question record file, stderr=${stderr}`);
    const recordPath = join(questionsDir, recordFile);

    let record = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      record = await readQuestionRecord(recordPath);
      if (record?.status === 'prompting') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.equal(record?.status, 'prompting', `expected prompting question record, stderr=${stderr}`);
    await markQuestionAnswered(recordPath, {
      kind: 'other',
      value: 'free text answer',
      selected_labels: ['Other'],
      selected_values: ['free text answer'],
      other_text: 'free text answer',
    });

    const exitCode = await closePromise;
    assert.equal(exitCode, 0, stderr || stdout);
    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.answer.value, 'free text answer');
    assert.equal(payload.answers[0].answer.value, 'free text answer');
    assert.equal(payload.questions[0].question, 'Pick one');
    assert.equal(payload.prompt.source, 'deep-interview');
    assert.equal(payload.prompt.type, 'multi-answerable');
  });

  it('fails closed when tmux reports a split pane that does not actually exist', async () => {
    const cwd = await makeRepo();
    const fakeBinDir = join(cwd, 'fake-bin');
    await mkdir(fakeBinDir, { recursive: true });
    await writeFile(join(fakeBinDir, 'tmux'), `#!/bin/sh
printf '%s\\n' "$*" >> "${join(cwd, 'tmux.log')}"
case "$1" in
  split-window)
    printf '%%5\\n'
    ;;
  list-panes)
    if [ "$2" = "-t" ] && [ "$3" = "%5" ]; then
      echo "can't find pane: %5" >&2
      exit 1
    fi
    printf '%%0\\t1\\n%%2\\t0\\n'
    ;;
  display-message)
    if [ "$2" = "-p" ] && [ "$3" = "-t" ] && [ "$4" = "%0" ] && [ "$5" = "#{session_attached}" ]; then
      printf '1\n'
      exit 0
    fi
    printf '%%0\n'
    ;;
esac
`, { mode: 0o755 });

    const input = JSON.stringify({
      question: 'Pick one',
      options: [{ label: 'A', value: 'a' }],
      allow_other: true,
      session_id: 'sess-q',
    });

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [omxBin, 'question', '--input', input, '--json'], {
        cwd,
        env: {
          ...process.env,
          PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
          TMUX: '/tmp/fake',
          TMUX_PANE: '%0',
          OMX_QUESTION_RETURN_PANE: '',
          OMX_LEADER_PANE_ID: '',
          OMX_AUTO_UPDATE: '0',
          OMX_NOTIFY_FALLBACK: '0',
          OMX_HOOK_DERIVED_SIGNALS: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });

    assert.equal(result.code, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'question_runtime_failed');
    assert.match(payload.error.message, /pane %5 disappeared immediately after launch/i);

    const entries = await readdir(join(cwd, '.omx', 'state', 'sessions', 'sess-q', 'questions'));
    assert.equal(entries.length, 1);
    const recordPath = join(cwd, '.omx', 'state', 'sessions', 'sess-q', 'questions', entries[0]!);
    const record = JSON.parse(await readFile(recordPath, 'utf-8')) as { status: string; error?: { code?: string; message?: string } };
    assert.equal(record.status, 'error');
    assert.equal(record.error?.code, 'question_runtime_failed');
    assert.match(record.error?.message || '', /pane %5 disappeared immediately after launch/i);
  });

  it('fails instead of hanging when a renderer pane dies after prompting starts', async () => {
    const cwd = await makeRepo();
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');
    const countPath = join(cwd, 'list-panes-count');
    await mkdir(fakeBinDir, { recursive: true });
    await writeFile(join(fakeBinDir, 'tmux'), `#!/bin/sh
printf '%s\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  display-message)
    printf '1\n'
    ;;
  split-window)
    printf '%%45\n'
    ;;
  list-panes)
    count=0
    if [ -f "${countPath}" ]; then count=$(cat "${countPath}"); fi
    count=$((count + 1))
    printf '%s' "$count" > "${countPath}"
    if [ "$count" = "1" ]; then
      printf '0\t%%45\n'
      exit 0
    fi
    echo "can't find pane: %45" >&2
    exit 1
    ;;
esac
`, { mode: 0o755 });

    const input = JSON.stringify({
      question: 'Pick one',
      options: [{ label: 'A', value: 'a' }],
      allow_other: true,
      session_id: 'sess-q',
    });

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [omxBin, 'question', '--input', input, '--json'], {
        cwd,
        env: {
          ...process.env,
          PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
          TMUX: '/tmp/fake',
          TMUX_PANE: '%0',
          OMX_QUESTION_RETURN_PANE: '',
          OMX_LEADER_PANE_ID: '',
          OMX_AUTO_UPDATE: '0',
          OMX_NOTIFY_FALLBACK: '0',
          OMX_HOOK_DERIVED_SIGNALS: '0',
          OMX_QUESTION_WAIT_TIMEOUT_MS: '5000',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });

    assert.equal(result.code, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'question_runtime_failed');
    assert.match(payload.error.message, /renderer tmux-pane %45 exited before answering/i);

    const entries = await readdir(join(cwd, '.omx', 'state', 'sessions', 'sess-q', 'questions'));
    assert.equal(entries.length, 1);
    const recordPath = join(cwd, '.omx', 'state', 'sessions', 'sess-q', 'questions', entries[0]!);
    const record = JSON.parse(await readFile(recordPath, 'utf-8')) as { status: string; error?: { code?: string; message?: string } };
    assert.equal(record.status, 'error');
    assert.equal(record.error?.code, 'question_runtime_failed');
    assert.match(record.error?.message || '', /exited before answering/i);
  });

  it('times out unanswered test renderers instead of waiting forever', async () => {
    const cwd = await makeRepo();
    const input = JSON.stringify({
      question: 'Pick one',
      options: [{ label: 'A', value: 'a' }],
      allow_other: true,
      session_id: 'sess-q',
    });

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [omxBin, 'question', '--input', input, '--json'], {
        cwd,
        env: {
          ...process.env,
          OMX_AUTO_UPDATE: '0',
          OMX_NOTIFY_FALLBACK: '0',
          OMX_HOOK_DERIVED_SIGNALS: '0',
          OMX_QUESTION_TEST_RENDERER: 'noop',
          OMX_QUESTION_WAIT_TIMEOUT_MS: '50',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });

    assert.equal(result.code, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'question_runtime_failed');
    assert.match(payload.error.message, /Timed out waiting for question answer after 50ms/i);
  });

  it('fails closed outside an attached tmux pane without creating a detached session', async () => {
    const cwd = await makeRepo();
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');
    await mkdir(fakeBinDir, { recursive: true });
    await writeFile(join(fakeBinDir, 'tmux'), `#!/bin/sh
printf '%s\\n' "$*" >> "${tmuxLogPath}"
exit 0
`, { mode: 0o755 });

    const input = JSON.stringify({
      question: 'Pick one',
      options: [{ label: 'A', value: 'a' }],
      allow_other: true,
      session_id: 'sess-q',
    });

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
      OMX_AUTO_UPDATE: '0',
      OMX_NOTIFY_FALLBACK: '0',
      OMX_HOOK_DERIVED_SIGNALS: '0',
    };
    delete childEnv.TMUX;
    delete childEnv.TMUX_PANE;
    delete childEnv.OMX_QUESTION_RETURN_PANE;
    delete childEnv.OMX_LEADER_PANE_ID;
    delete childEnv.OMX_QUESTION_TEST_RENDERER;

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [omxBin, 'question', '--input', input, '--json'], {
        cwd,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });

    assert.equal(result.code, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'question_runtime_failed');
    assert.match(payload.error.message, /visible renderer/i);
    assert.match(payload.error.message, /attached tmux pane/i);
    assert.match(payload.error.message, /Run omx question from inside tmux/i);
    assert.doesNotMatch(payload.error.message, /tmux is unavailable/i);

    const entries = await readdir(join(cwd, '.omx', 'state', 'sessions', 'sess-q', 'questions'));
    assert.equal(entries.length, 1);
    const recordPath = join(cwd, '.omx', 'state', 'sessions', 'sess-q', 'questions', entries[0]!);
    const record = JSON.parse(await readFile(recordPath, 'utf-8')) as { status: string; error?: { code?: string; message?: string } };
    assert.equal(record.status, 'error');
    assert.equal(record.error?.code, 'question_runtime_failed');
    assert.match(record.error?.message || '', /visible renderer/i);
    assert.match(record.error?.message || '', /attached tmux pane/i);
    assert.doesNotMatch(record.error?.message || '', /tmux is unavailable/i);

    let tmuxLog = '';
    try {
      tmuxLog = await readFile(tmuxLogPath, 'utf-8');
    } catch {}
    assert.doesNotMatch(tmuxLog, /new-session/);
  });

  it('fails closed inside a detached tmux session with no attached client', async () => {
    const cwd = await makeRepo();
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');
    await mkdir(fakeBinDir, { recursive: true });
    await writeFile(join(fakeBinDir, 'tmux'), `#!/bin/sh
printf '%s\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  display-message)
    printf '0\n'
    ;;
  split-window)
    printf '%%5\n'
    ;;
esac
exit 0
`, { mode: 0o755 });

    const input = JSON.stringify({
      question: 'Pick one',
      options: [{ label: 'A', value: 'a' }],
      allow_other: true,
      session_id: 'sess-q',
    });

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [omxBin, 'question', '--input', input, '--json'], {
        cwd,
        env: {
          ...process.env,
          PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
          TMUX: '/tmp/fake',
          TMUX_PANE: '%0',
          OMX_QUESTION_RETURN_PANE: '',
          OMX_LEADER_PANE_ID: '',
          OMX_AUTO_UPDATE: '0',
          OMX_NOTIFY_FALLBACK: '0',
          OMX_HOOK_DERIVED_SIGNALS: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });

    assert.equal(result.code, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'question_runtime_failed');
    assert.match(payload.error.message, /visible renderer/i);
    assert.match(payload.error.message, /no attached client/i);
    assert.match(payload.error.message, /attached tmux pane/i);

    const entries = await readdir(join(cwd, '.omx', 'state', 'sessions', 'sess-q', 'questions'));
    assert.equal(entries.length, 1);
    const recordPath = join(cwd, '.omx', 'state', 'sessions', 'sess-q', 'questions', entries[0]!);
    const record = JSON.parse(await readFile(recordPath, 'utf-8')) as { status: string; error?: { code?: string; message?: string } };
    assert.equal(record.status, 'error');
    assert.equal(record.error?.code, 'question_runtime_failed');
    assert.match(record.error?.message || '', /no attached client/i);

    const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
    assert.match(tmuxLog, /display-message -p -t %0 #\{session_attached\}/);
    assert.doesNotMatch(tmuxLog, /split-window/);
    assert.doesNotMatch(tmuxLog, /new-session/);
  });

  it('uses an explicit return pane to launch from a container-like shell without TMUX', async () => {
    const cwd = await makeRepo();
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');
    await mkdir(fakeBinDir, { recursive: true });
    await writeFile(join(fakeBinDir, 'tmux'), `#!/bin/sh
printf '%s\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  display-message)
    printf '40\n'
    ;;
  split-window)
    printf '%%45\n'
    ;;
  list-panes)
    printf '0	%%45\n'
    ;;
esac
`, { mode: 0o755 });

    const input = JSON.stringify({
      question: 'Pick one',
      options: [{ label: 'A', value: 'a' }],
      allow_other: true,
      session_id: 'sess-q',
    });

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
      OMX_QUESTION_RETURN_PANE: '%44',
      OMX_AUTO_UPDATE: '0',
      OMX_NOTIFY_FALLBACK: '0',
      OMX_HOOK_DERIVED_SIGNALS: '0',
    };
    delete childEnv.TMUX;
    delete childEnv.TMUX_PANE;
    delete childEnv.OMX_LEADER_PANE_ID;
    delete childEnv.OMX_QUESTION_TEST_RENDERER;

    const child = spawn(process.execPath, [omxBin, 'question', '--input', input, '--json'], {
      cwd,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const closePromise = new Promise<number | null>((resolve) => child.on('close', resolve));

    const questionsDir = join(cwd, '.omx', 'state', 'sessions', 'sess-q', 'questions');
    let recordFile = '';
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const entries = await readdir(questionsDir);
      recordFile = entries.find((entry) => entry.endsWith('.json')) || '';
      if (recordFile) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.notEqual(recordFile, '', `expected question record file, stderr=${stderr}`);
    const recordPath = join(questionsDir, recordFile);

    let record = await readQuestionRecord(recordPath);
    for (let attempt = 0; attempt < 100 && !record?.renderer; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      record = await readQuestionRecord(recordPath);
    }
    assert.equal(record?.renderer?.renderer, 'tmux-pane');
    assert.equal(record?.renderer?.target, '%45');
    assert.equal(record?.renderer?.return_target, '%44');

    await markQuestionAnswered(recordPath, {
      kind: 'option',
      value: 'a',
      selected_labels: ['A'],
      selected_values: ['a'],
    });

    const exitCode = await closePromise;
    assert.equal(exitCode, 0, stderr || stdout);
    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.answer.value, 'a');

    const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
    assert.match(tmuxLog, /split-window -v -l 24 -t %44 -P -F #\{pane_id\}/);
    assert.doesNotMatch(tmuxLog, /new-session/);
  });

  it('runs inline in interactive Windows non-attached sessions instead of hard-failing on missing TMUX', async () => {
    const cwd = await makeRepo();
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    const originalStdinIsTTY = process.stdin.isTTY;
    const originalStdoutIsTTY = process.stdout.isTTY;
    const originalSetRawMode = process.stdin.setRawMode;
    const originalResume = process.stdin.resume;
    const originalPause = process.stdin.pause;
    const originalWrite = process.stdout.write.bind(process.stdout);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    const originalCwd = process.cwd();
    const originalTmux = process.env.TMUX;
    const originalTmuxPane = process.env.TMUX_PANE;
    const originalQuestionReturnPane = process.env.OMX_QUESTION_RETURN_PANE;
    const originalLeaderPaneId = process.env.OMX_LEADER_PANE_ID;
    const writes: string[] = [];
    const stderrWrites: string[] = [];

    Object.defineProperty(process, 'platform', { value: 'win32' });
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    delete process.env.OMX_QUESTION_RETURN_PANE;
    delete process.env.OMX_LEADER_PANE_ID;
    process.stdin.setRawMode = ((_: boolean) => process.stdin) as unknown as typeof process.stdin.setRawMode;
    process.stdin.resume = (() => process.stdin) as unknown as typeof process.stdin.resume;
    process.stdin.pause = (() => process.stdin) as unknown as typeof process.stdin.pause;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrWrites.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    process.chdir(cwd);

    try {
      const runPromise = questionCommand([
        '--input',
        JSON.stringify({
          question: 'Pick one',
          options: [{ label: 'A', value: 'a' }],
          allow_other: false,
          session_id: 'sess-q',
        }),
        '--json',
      ]);

      setTimeout(() => {
        process.stdin.emit('keypress', '', { name: 'enter' });
      }, 25);

      await runPromise;
      const joined = writes.join('');
      const stderrJoined = stderrWrites.join('');
      const payload = JSON.parse(joined);
      assert.equal(payload.ok, true);
      assert.equal(payload.answer.value, 'a');
      assert.doesNotMatch(joined, /Use ↑\/↓ to move, Enter to select\./);
      assert.match(stderrJoined, /Use ↑\/↓ to move, Enter to select\./);

      const entries = await readdir(join(cwd, '.omx', 'state', 'sessions', 'sess-q', 'questions'));
      assert.equal(entries.length, 1);
      const record = await readQuestionRecord(join(cwd, '.omx', 'state', 'sessions', 'sess-q', 'questions', entries[0]!));
      assert.equal(record?.status, 'answered');
      assert.equal(record?.renderer?.renderer, 'inline-tty');
    } finally {
      if (originalPlatformDescriptor) Object.defineProperty(process, 'platform', originalPlatformDescriptor);
      Object.defineProperty(process.stdin, 'isTTY', { value: originalStdinIsTTY, configurable: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: originalStdoutIsTTY, configurable: true });
      process.stdin.setRawMode = originalSetRawMode;
      process.stdin.resume = originalResume;
      process.stdin.pause = originalPause;
      process.stdout.write = originalWrite as typeof process.stdout.write;
      process.stderr.write = originalStderrWrite as typeof process.stderr.write;
      process.chdir(originalCwd);
      if (typeof originalTmux === 'string') process.env.TMUX = originalTmux;
      else delete process.env.TMUX;
      if (typeof originalTmuxPane === 'string') process.env.TMUX_PANE = originalTmuxPane;
      else delete process.env.TMUX_PANE;
      if (typeof originalQuestionReturnPane === 'string') process.env.OMX_QUESTION_RETURN_PANE = originalQuestionReturnPane;
      else delete process.env.OMX_QUESTION_RETURN_PANE;
      if (typeof originalLeaderPaneId === 'string') process.env.OMX_LEADER_PANE_ID = originalLeaderPaneId;
      else delete process.env.OMX_LEADER_PANE_ID;
    }
  });

});
