import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


function isolatedChildEnv(fakeBinDir: string): NodeJS.ProcessEnv {
  const tmuxBin = join(fakeBinDir, 'tmux');
  return {
    PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
    OMX_TEST_TMUX_BIN: tmuxBin,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
  };
}

function buildFakeTmux(tmuxLogPath: string): string {
  const bufferPath = `${tmuxLogPath}.buffer`;
  return `#!/usr/bin/env bash
set -eu
printf '[%s]' "$@" >> "${tmuxLogPath}"
printf '\n' >> "${tmuxLogPath}"
cmd="$1"
shift || true
if [[ "$cmd" == "set-buffer" ]]; then
  printf '%s' "\${@: -1}" > "${bufferPath}"
  exit 0
fi
if [[ "$cmd" == "show-buffer" ]]; then
  if [[ -f "${bufferPath}" ]]; then
    cat "${bufferPath}"
  fi
  exit 0
fi
if [[ "$cmd" == "delete-buffer" ]]; then
  rm -f "${bufferPath}"
fi
exit 0
`;
}

function runSendPaneInputInChild(params: {
  fakeBinDir: string;
  moduleUrl: string;
  paneTarget: string;
  prompt: string;
  submitKeyPresses: number;
  typePrompt: boolean;
  queueFirstSubmit?: boolean;
}) {
  const payload = JSON.stringify({
    paneTarget: params.paneTarget,
    prompt: params.prompt,
    submitKeyPresses: params.submitKeyPresses,
    tmuxBin: join(params.fakeBinDir, 'tmux'),
    typePrompt: params.typePrompt,
    queueFirstSubmit: params.queueFirstSubmit,
  });
  const script = `
    const input = ${payload};
    process.env.OMX_TEST_TMUX_BIN = input.tmuxBin;
    process.env.PATH = ${JSON.stringify('__CHILD_PATH__')};
    const { sendPaneInput } = await import(${JSON.stringify(params.moduleUrl)});
    const result = await sendPaneInput(input);
    process.stdout.write(JSON.stringify(result));
  `.replace('__CHILD_PATH__', `${params.fakeBinDir}:${process.env.PATH ?? ''}`);
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf-8',
    env: isolatedChildEnv(params.fakeBinDir),
  });
}

function runEvaluatePaneInjectionReadinessInChild(params: {
  fakeBinDir: string;
  moduleUrl: string;
  paneTarget: string;
  options?: Record<string, unknown>;
}) {
  const payload = JSON.stringify({
    paneTarget: params.paneTarget,
    options: params.options ?? {},
    tmuxBin: join(params.fakeBinDir, 'tmux'),
  });
  const script = `
    const input = ${payload};
    process.env.OMX_TEST_TMUX_BIN = input.tmuxBin;
    process.env.PATH = ${JSON.stringify('__CHILD_PATH__')};
    const { evaluatePaneInjectionReadiness } = await import(${JSON.stringify(params.moduleUrl)});
    const result = await evaluatePaneInjectionReadiness(input.paneTarget, input.options);
    process.stdout.write(JSON.stringify(result));
  `.replace('__CHILD_PATH__', `${params.fakeBinDir}:${process.env.PATH ?? ''}`);
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf-8',
    env: isolatedChildEnv(params.fakeBinDir),
  });
}

describe('notify-hook team tmux guard bridge', () => {
  it('submits without typing when typePrompt=false', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-tmux-guard-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');

    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const moduleUrl = new URL('../../../dist/scripts/notify-hook/team-tmux-guard.js', import.meta.url).href;
      const result = runSendPaneInputInChild({
        fakeBinDir,
        moduleUrl,
        paneTarget: '%42',
        prompt: 'hello bridge',
        submitKeyPresses: 2,
        typePrompt: false,
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.error, undefined);
      assert.match(result.stdout, /"ok":true/);

      const log = await readFile(tmuxLogPath, 'utf-8');
      assert.doesNotMatch(log, /paste-buffer/);
      assert.doesNotMatch(log, /hello bridge/);
      const lines = log.trim().split('\n').filter(Boolean);
      assert.equal(lines.length, 2);
      assert.match(lines[0], /\[send-keys\]\[-t\]\[%42\]\[C-m\]/);
      assert.match(lines[1], /\[send-keys\]\[-t\]\[%42\]\[C-m\]/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('queue-first submits with Tab before C-m when requested', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-tmux-guard-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');

    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const moduleUrl = new URL('../../../dist/scripts/notify-hook/team-tmux-guard.js', import.meta.url).href;
      const result = runSendPaneInputInChild({
        fakeBinDir,
        moduleUrl,
        paneTarget: '%42',
        prompt: 'Read /tmp/team/mailbox/leader-fixed.json; new msg from worker-1. Review it; decide next step.',
        submitKeyPresses: 2,
        typePrompt: true,
        queueFirstSubmit: true,
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.error, undefined);
      assert.match(result.stdout, /"ok":true/);

      const lines = (await readFile(tmuxLogPath, 'utf-8')).trim().split('\n').filter(Boolean);
      assert.equal(lines.length, 8);
      assert.match(lines[0], /\[set-buffer\]\[-b\]\[omx-pane-input-/);
      assert.match(lines[0], /\[--\]\[Read \/tmp\/team\/mailbox\/leader-fixed\.json/);
      assert.match(lines[1], /\[show-buffer\]\[-b\]\[omx-pane-input-/);
      assert.match(lines[2], /\[send-keys\]\[-t\]\[%42\]\[C-u\]/);
      assert.match(lines[3], /\[paste-buffer\]\[-t\]\[%42\]\[-b\]\[omx-pane-input-.*\]\[-p\]\[-d\]/);
      assert.match(lines[4], /\[send-keys\]\[-t\]\[%42\]\[Tab\]/);
      assert.match(lines[5], /\[send-keys\]\[-t\]\[%42\]\[C-m\]/);
      assert.match(lines[6], /\[send-keys\]\[-t\]\[%42\]\[C-m\]/);
      assert.match(lines[7], /\[delete-buffer\]\[-b\]\[omx-pane-input-/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('types then submits when typePrompt=true', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-tmux-guard-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');

    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const moduleUrl = new URL('../../../dist/scripts/notify-hook/team-tmux-guard.js', import.meta.url).href;
      const result = runSendPaneInputInChild({
        fakeBinDir,
        moduleUrl,
        paneTarget: '%42',
        prompt: 'hello bridge',
        submitKeyPresses: 1,
        typePrompt: true,
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.error, undefined);
      assert.match(result.stdout, /"ok":true/);

      const log = await readFile(tmuxLogPath, 'utf-8');
      assert.doesNotMatch(log, /load-buffer/);
      assert.match(log, /\[set-buffer\]\[-b\]\[omx-pane-input-.*\]\[--\]\[hello bridge\]/);
      assert.match(log, /\[show-buffer\]\[-b\]\[omx-pane-input-/);
      assert.match(log, /\[send-keys\]\[-t\]\[%42\]\[C-u\]/);
      assert.match(log, /\[paste-buffer\]\[-t\]\[%42\]\[-b\]\[omx-pane-input-.*\]\[-p\]\[-d\]/);
      const lines = log.trim().split('\n').filter(Boolean);
      assert.equal(lines.length, 6);
      assert.match(lines[4], /\[send-keys\]\[-t\]\[%42\]\[C-m\]/);
      assert.match(lines[5], /\[delete-buffer\]\[-b\]\[omx-pane-input-/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('aborts before paste when buffer setup fails so stale tmux content is not reused', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-tmux-guard-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');

    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(
        join(fakeBinDir, 'tmux'),
        `#!/usr/bin/env bash
set -eu
printf '[%s]' "$@" >> "${tmuxLogPath}"
printf '\n' >> "${tmuxLogPath}"
cmd="$1"
if [[ "$cmd" == "set-buffer" ]]; then
  echo "invalid buffer load" >&2
  exit 1
fi
if [[ "$cmd" == "paste-buffer" ]]; then
  echo "would have pasted stale buffer" >&2
  exit 2
fi
exit 0
`,
      );
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const moduleUrl = new URL('../../../dist/scripts/notify-hook/team-tmux-guard.js', import.meta.url).href;
      const result = runSendPaneInputInChild({
        fakeBinDir,
        moduleUrl,
        paneTarget: '%42',
        prompt: 'intended supervisor handoff',
        submitKeyPresses: 1,
        typePrompt: true,
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.error, undefined);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.sent, false);
      assert.equal(parsed.reason, 'buffer_set_failed');

      const log = await readFile(tmuxLogPath, 'utf-8');
      assert.match(log, /\[set-buffer\]\[-b\]\[omx-pane-input-/);
      assert.doesNotMatch(log, /show-buffer/);
      assert.doesNotMatch(log, /paste-buffer/);
      assert.doesNotMatch(log, /\[send-keys\]\[-t\]\[%42\]\[C-m\]/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('deletes the named buffer when verification fails after setup', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-tmux-guard-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');

    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(
        join(fakeBinDir, 'tmux'),
        `#!/usr/bin/env bash
set -eu
printf '[%s]' "$@" >> "${tmuxLogPath}"
printf '\n' >> "${tmuxLogPath}"
cmd="$1"
shift || true
if [[ "$cmd" == "set-buffer" ]]; then
  exit 0
fi
if [[ "$cmd" == "show-buffer" ]]; then
  echo "cannot read buffer" >&2
  exit 1
fi
exit 0
`,
      );
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const moduleUrl = new URL('../../../dist/scripts/notify-hook/team-tmux-guard.js', import.meta.url).href;
      const result = runSendPaneInputInChild({
        fakeBinDir,
        moduleUrl,
        paneTarget: '%42',
        prompt: 'supervisor handoff after setup',
        submitKeyPresses: 1,
        typePrompt: true,
      });

      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.reason, 'buffer_show_failed');

      const lines = (await readFile(tmuxLogPath, 'utf-8')).trim().split('\n').filter(Boolean);
      assert.match(lines[0] ?? '', /\[set-buffer\]\[-b\]\[omx-pane-input-/);
      assert.match(lines[1] ?? '', /\[show-buffer\]\[-b\]\[omx-pane-input-/);
      assert.match(lines[2] ?? '', /\[delete-buffer\]\[-b\]\[omx-pane-input-/);
      assert.equal(lines.length, 3);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('deletes the named buffer when paste fails after verification', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-tmux-guard-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');
    const bufferPath = `${tmuxLogPath}.buffer`;

    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(
        join(fakeBinDir, 'tmux'),
        `#!/usr/bin/env bash
set -eu
printf '[%s]' "$@" >> "${tmuxLogPath}"
printf '\n' >> "${tmuxLogPath}"
cmd="$1"
shift || true
if [[ "$cmd" == "set-buffer" ]]; then
  printf '%s' "\${@: -1}" > "${bufferPath}"
  exit 0
fi
if [[ "$cmd" == "show-buffer" ]]; then
  cat "${bufferPath}"
  exit 0
fi
if [[ "$cmd" == "paste-buffer" ]]; then
  echo "paste failed" >&2
  exit 1
fi
if [[ "$cmd" == "delete-buffer" ]]; then
  rm -f "${bufferPath}"
fi
exit 0
`,
      );
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const moduleUrl = new URL('../../../dist/scripts/notify-hook/team-tmux-guard.js', import.meta.url).href;
      const result = runSendPaneInputInChild({
        fakeBinDir,
        moduleUrl,
        paneTarget: '%42',
        prompt: 'supervisor handoff after verify',
        submitKeyPresses: 1,
        typePrompt: true,
      });

      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.reason, 'buffer_paste_failed');

      const lines = (await readFile(tmuxLogPath, 'utf-8')).trim().split('\n').filter(Boolean);
      assert.match(lines[0] ?? '', /\[set-buffer\]\[-b\]\[omx-pane-input-/);
      assert.match(lines[1] ?? '', /\[show-buffer\]\[-b\]\[omx-pane-input-/);
      assert.match(lines[2] ?? '', /\[send-keys\]\[-t\]\[%42\]\[C-u\]/);
      assert.match(lines[3] ?? '', /\[paste-buffer\]\[-t\]\[%42\]\[-b\]\[omx-pane-input-.*\]\[-p\]\[-d\]/);
      assert.match(lines[4] ?? '', /\[delete-buffer\]\[-b\]\[omx-pane-input-/);
      assert.equal(lines.length, 5);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('reports pane_not_ready with capture context when the pane is not input-ready', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-tmux-guard-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');

    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(
        join(fakeBinDir, 'tmux'),
        `#!/usr/bin/env bash
set -eu
echo "$@" >> "${tmuxLogPath}"
cmd="$1"
shift || true
if [[ "$cmd" == "display-message" ]]; then
  format="\${@: -1}"
  if [[ "$format" == "#{pane_current_command}" ]]; then
    echo "codex"
    exit 0
  fi
  if [[ "$format" == "#{pane_in_mode}" ]]; then
    echo "0"
    exit 0
  fi
  exit 0
fi
if [[ "$cmd" == "capture-pane" ]]; then
  printf "loading workspace state...\\n"
  exit 0
fi
exit 0
`,
      );
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const moduleUrl = new URL('../../../dist/scripts/notify-hook/team-tmux-guard.js', import.meta.url).href;
      const result = runEvaluatePaneInjectionReadinessInChild({
        fakeBinDir,
        moduleUrl,
        paneTarget: '%42',
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.error, undefined);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.reason, 'pane_not_ready');
      assert.equal(parsed.paneCurrentCommand, 'codex');
      assert.match(parsed.paneCapture, /loading workspace state/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('treats capture-pane failure as non-blocking for a live codex pane', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-tmux-guard-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');

    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(
        join(fakeBinDir, 'tmux'),
        `#!/usr/bin/env bash
set -eu
echo "$@" >> "${tmuxLogPath}"
cmd="$1"
shift || true
if [[ "$cmd" == "display-message" ]]; then
  format="\${@: -1}"
  if [[ "$format" == "#{pane_current_command}" ]]; then
    echo "codex"
    exit 0
  fi
  if [[ "$format" == "#{pane_in_mode}" ]]; then
    echo "0"
    exit 0
  fi
  exit 0
fi
if [[ "$cmd" == "capture-pane" ]]; then
  echo "capture failed" >&2
  exit 1
fi
exit 0
`,
      );
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const moduleUrl = new URL('../../../dist/scripts/notify-hook/team-tmux-guard.js', import.meta.url).href;
      const result = runEvaluatePaneInjectionReadinessInChild({
        fakeBinDir,
        moduleUrl,
        paneTarget: '%42',
        options: { skipIfScrolling: true },
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.error, undefined);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.reason, 'ok');
      assert.equal(parsed.paneCurrentCommand, 'codex');
      assert.equal(parsed.paneCapture, '');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
