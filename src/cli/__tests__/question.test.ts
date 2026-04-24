import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import { markQuestionAnswered, readQuestionRecord } from '../../question/state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const omxBin = join(repoRoot, 'dist', 'cli', 'omx.js');
const tempDirs: string[] = [];

async function makeRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-question-cli-'));
  tempDirs.push(cwd);
  await mkdir(join(cwd, '.omx', 'state', 'sessions', 'sess-q', 'questions'), { recursive: true });
  await writeFile(join(cwd, '.omx', 'state', 'session.json'), JSON.stringify({ session_id: 'sess-q' }));
  return cwd;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('omx question CLI', () => {
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
    for (let attempt = 0; attempt < 50; attempt += 1) {
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

    const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve));
    assert.equal(exitCode, 0, stderr || stdout);
    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.answer.value, 'free text answer');
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
  split-window)
    printf '%%45\n'
    ;;
  list-panes)
    printf '0\t%%45\n'
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

    let record = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      record = await readQuestionRecord(recordPath);
      if (record?.status === 'prompting') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(record?.status, 'prompting', `expected prompting question record, stderr=${stderr}`);
    assert.equal(record?.renderer?.renderer, 'tmux-pane');
    assert.equal(record?.renderer?.target, '%45');
    assert.equal(record?.renderer?.return_target, '%44');

    await markQuestionAnswered(recordPath, {
      kind: 'option',
      value: 'a',
      selected_labels: ['A'],
      selected_values: ['a'],
    });

    const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve));
    assert.equal(exitCode, 0, stderr || stdout);
    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.answer.value, 'a');

    const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
    assert.match(tmuxLog, /split-window -v -l 12 -t %44 -P -F #\{pane_id\}/);
    assert.doesNotMatch(tmuxLog, /new-session/);
  });

});
