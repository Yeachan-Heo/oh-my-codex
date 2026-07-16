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

function liveExactPaneProof(): string {
  return `if [[ "\${1:-}" == "list-panes" && "$#" -eq 4 && "\${2:-}" == "-a" && "\${3:-}" == "-F" && "\${4:-}" == "#{pane_id}\t#{pane_dead}\t#{pane_pid}" ]]; then
  printf '%%42\\t0\\t4242\\n'
  exit 0
fi`;
}

function buildFakeTmux(tmuxLogPath: string): string {
  const bufferPath = `${tmuxLogPath}.buffer`;
  return `#!/usr/bin/env bash
set -eu
${liveExactPaneProof()}

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
  exactPaneId?: string;
  expectedPanePid?: number;
  expectedPaneOwnerId?: string;
}) {
  const payload = JSON.stringify({
    paneTarget: params.paneTarget,
    prompt: params.prompt,
    submitKeyPresses: params.submitKeyPresses,
    tmuxBin: join(params.fakeBinDir, 'tmux'),
    typePrompt: params.typePrompt,
    queueFirstSubmit: params.queueFirstSubmit,
    exactPaneId: params.exactPaneId,
    expectedPanePid: params.expectedPanePid,
    expectedPaneOwnerId: params.expectedPaneOwnerId,
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
        exactPaneId: '%42',
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
      assert.equal(lines.length, 3);
      assert.match(lines[0], /\[display-message\]\[-p\]\[-t\]\[%42\]\[#\{pane_start_command\}\]/);
      assert.match(lines[1], /\[send-keys\]\[-t\]\[%42\]\[C-m\]/);
      assert.match(lines[2], /\[send-keys\]\[-t\]\[%42\]\[C-m\]/);
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
        exactPaneId: '%42',
        prompt: 'Read /tmp/team/mailbox/leader-fixed.json; new msg from worker-1. Review it; decide next step.',
        submitKeyPresses: 2,
        typePrompt: true,
        queueFirstSubmit: true,
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.error, undefined);
      assert.match(result.stdout, /"ok":true/);

      const lines = (await readFile(tmuxLogPath, 'utf-8')).trim().split('\n').filter(Boolean);
      assert.equal(lines.length, 9);
      assert.match(lines[0], /\[display-message\]\[-p\]\[-t\]\[%42\]\[#\{pane_start_command\}\]/);
      assert.match(lines[1], /\[set-buffer\]\[-b\]\[omx-pane-input-/);
      assert.match(lines[1], /\[--\]\[Read \/tmp\/team\/mailbox\/leader-fixed\.json/);
      assert.match(lines[2], /\[show-buffer\]\[-b\]\[omx-pane-input-/);
      assert.match(lines[3], /\[send-keys\]\[-t\]\[%42\]\[C-u\]/);
      assert.match(lines[4], /\[paste-buffer\]\[-t\]\[%42\]\[-b\]\[omx-pane-input-.*\]\[-p\]\[-d\]/);
      assert.match(lines[5], /\[send-keys\]\[-t\]\[%42\]\[Tab\]/);
      assert.match(lines[6], /\[send-keys\]\[-t\]\[%42\]\[C-m\]/);
      assert.match(lines[7], /\[send-keys\]\[-t\]\[%42\]\[C-m\]/);
      assert.match(lines[8], /\[delete-buffer\]\[-b\]\[omx-pane-input-/);
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
        exactPaneId: '%42',
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
      assert.equal(lines.length, 7);
      assert.match(lines[0], /\[display-message\]\[-p\]\[-t\]\[%42\]\[#\{pane_start_command\}\]/);
      assert.match(lines[5], /\[send-keys\]\[-t\]\[%42\]\[C-m\]/);
      assert.match(lines[6], /\[delete-buffer\]\[-b\]\[omx-pane-input-/);
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
${liveExactPaneProof()}

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
        exactPaneId: '%42',
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
${liveExactPaneProof()}

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
        exactPaneId: '%42',
        prompt: 'supervisor handoff after setup',
        submitKeyPresses: 1,
        typePrompt: true,
      });

      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.reason, 'buffer_show_failed');

      const lines = (await readFile(tmuxLogPath, 'utf-8')).trim().split('\n').filter(Boolean);
      assert.match(lines[0] ?? '', /\[display-message\]\[-p\]\[-t\]\[%42\]\[#\{pane_start_command\}\]/);
      assert.match(lines[1] ?? '', /\[set-buffer\]\[-b\]\[omx-pane-input-/);
      assert.match(lines[2] ?? '', /\[show-buffer\]\[-b\]\[omx-pane-input-/);
      assert.match(lines[3] ?? '', /\[delete-buffer\]\[-b\]\[omx-pane-input-/);
      assert.equal(lines.length, 4);
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
${liveExactPaneProof()}

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
        exactPaneId: '%42',
        prompt: 'supervisor handoff after verify',
        submitKeyPresses: 1,
        typePrompt: true,
      });

      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.reason, 'buffer_paste_failed');

      const lines = (await readFile(tmuxLogPath, 'utf-8')).trim().split('\n').filter(Boolean);
      assert.match(lines[0] ?? '', /\[display-message\]\[-p\]\[-t\]\[%42\]\[#\{pane_start_command\}\]/);
      assert.match(lines[1] ?? '', /\[set-buffer\]\[-b\]\[omx-pane-input-/);
      assert.match(lines[2] ?? '', /\[show-buffer\]\[-b\]\[omx-pane-input-/);
      assert.match(lines[3] ?? '', /\[send-keys\]\[-t\]\[%42\]\[C-u\]/);
      assert.match(lines[4] ?? '', /\[paste-buffer\]\[-t\]\[%42\]\[-b\]\[omx-pane-input-.*\]\[-p\]\[-d\]/);
      assert.match(lines[5] ?? '', /\[delete-buffer\]\[-b\]\[omx-pane-input-/);
      assert.equal(lines.length, 6);
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
${liveExactPaneProof()}

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
        options: { exactPaneId: '%42' },
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

  it('fails closed without input effects when exact-pane readiness queries fail', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-tmux-guard-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');

    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(
        join(fakeBinDir, 'tmux'),
        `#!/usr/bin/env bash
set -eu
${liveExactPaneProof()}
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
      const captureResult = runEvaluatePaneInjectionReadinessInChild({
        fakeBinDir,
        moduleUrl,
        paneTarget: '%42',
        options: { skipIfScrolling: true, exactPaneId: '%42' },
      });

      assert.equal(captureResult.status, 0, captureResult.stderr);
      assert.equal(captureResult.error, undefined);
      const captureParsed = JSON.parse(captureResult.stdout);
      assert.equal(captureParsed.ok, false);
      assert.equal(captureParsed.reason, 'pane_readiness_unverified');
      assert.equal(captureParsed.readinessEvidence, 'capture_failed');
      assert.doesNotMatch(await readFile(tmuxLogPath, 'utf-8'), /set-buffer|paste-buffer|send-keys|delete-buffer/);

      await writeFile(
        join(fakeBinDir, 'tmux'),
        `#!/usr/bin/env bash
set -eu
${liveExactPaneProof()}
echo "$@" >> "${tmuxLogPath}"
if [[ "$1" == "display-message" ]]; then
  echo "pane current command query failed" >&2
  exit 1
fi
exit 0
`,
      );
      const commandResult = runEvaluatePaneInjectionReadinessInChild({
        fakeBinDir,
        moduleUrl,
        paneTarget: '%42',
        options: { exactPaneId: '%42' },
      });

      assert.equal(commandResult.status, 0, commandResult.stderr);
      assert.equal(commandResult.error, undefined);
      const commandParsed = JSON.parse(commandResult.stdout);
      assert.equal(commandParsed.ok, false);
      assert.equal(commandParsed.reason, 'pane_readiness_unverified');
      assert.equal(commandParsed.readinessEvidence, 'start_command_failed');
      assert.doesNotMatch(await readFile(tmuxLogPath, 'utf-8'), /set-buffer|paste-buffer|send-keys|delete-buffer/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects an invalid explicit pane identity without any tmux action', async () => {
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
        exactPaneId: 'invalid-pane-id',
        prompt: 'must not be sent',
        submitKeyPresses: 1,
        typePrompt: true,
      });

      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.reason, 'exact_pane_unavailable');
      assert.equal(parsed.exactPaneProof?.reason, 'invalid_pane_id');
      assert.equal(await readFile(tmuxLogPath, 'utf-8').catch(() => ''), '');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('stops before input effects when authoritative exact-pane query fails', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-tmux-proof-fail-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');
    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), `#!/usr/bin/env bash\nprintf '[%s]' "$@" >> "${tmuxLogPath}"\nprintf '\\n' >> "${tmuxLogPath}"\nexit 1\n`);
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      const moduleUrl = new URL('../../../dist/scripts/notify-hook/team-tmux-guard.js', import.meta.url).href;
      const result = runSendPaneInputInChild({
        fakeBinDir,
        moduleUrl,
        paneTarget: '%42',
        exactPaneId: '%42',
        prompt: 'must not be sent',
        submitKeyPresses: 2,
        typePrompt: true,
      });
      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.reason, 'exact_pane_unavailable');
      const log = await readFile(tmuxLogPath, 'utf8');
      assert.match(log, /\[list-panes\]\[-a\]\[-F\]/);
      assert.doesNotMatch(log, /set-buffer|paste-buffer|send-keys|delete-buffer/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

it('rejects omitted and mismatched exact pane identities before any tmux effect', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-team-tmux-binding-'));
  const fakeBinDir = join(cwd, 'fake-bin');
  try {
    await mkdir(fakeBinDir, { recursive: true });
    const moduleUrl = new URL('../../../dist/scripts/notify-hook/team-tmux-guard.js', import.meta.url).href;
    const omitted = runSendPaneInputInChild({
      fakeBinDir,
      moduleUrl,
      paneTarget: '%42',
      prompt: 'must not send',
      submitKeyPresses: 1,
      typePrompt: false,
    });
    assert.equal(omitted.status, 0, omitted.stderr);
    assert.equal(JSON.parse(omitted.stdout).exactPaneProof.reason, 'missing_exact_pane_id');

    const mismatched = runSendPaneInputInChild({
      fakeBinDir,
      moduleUrl,
      paneTarget: '%42',
      exactPaneId: '%43',
      prompt: 'must not send',
      submitKeyPresses: 1,
      typePrompt: false,
    });
    assert.equal(mismatched.status, 0, mismatched.stderr);
    assert.equal(JSON.parse(mismatched.stdout).exactPaneProof.reason, 'pane_target_mismatch');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it('rejects an exact live pane whose start command identifies the HUD', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-team-tmux-hud-target-'));
  const fakeBinDir = join(cwd, 'fake-bin');
  const tmuxLogPath = join(cwd, 'tmux.log');
  try {
    await mkdir(fakeBinDir, { recursive: true });
    await writeFile(join(fakeBinDir, 'tmux'), `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${tmuxLogPath}"
if [ "$1" = "list-panes" ]; then printf '%%42\t0\t4242\n'; exit 0; fi
case "$*" in
  *'#{pane_start_command}'*) echo 'node dist/cli/omx.js hud --watch' ;;
esac
`);
    await chmod(join(fakeBinDir, 'tmux'), 0o755);
    const moduleUrl = new URL('../../../dist/scripts/notify-hook/team-tmux-guard.js', import.meta.url).href;
    const result = runSendPaneInputInChild({
      fakeBinDir,
      moduleUrl,
      paneTarget: '%42',
      exactPaneId: '%42',
      prompt: 'must not send',
      submitKeyPresses: 1,
      typePrompt: false,
    });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.reason, 'hud_pane_target');
    assert.doesNotMatch(await readFile(tmuxLogPath, 'utf8'), /set-buffer|paste-buffer|send-keys/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it('stops before input when a repeated exact proof observes a new pane PID', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-team-tmux-pid-change-'));
  const fakeBinDir = join(cwd, 'fake-bin');
  const tmuxLogPath = join(cwd, 'tmux.log');
  const countPath = join(cwd, 'proof-count');
  try {
    await mkdir(fakeBinDir, { recursive: true });
    await writeFile(join(fakeBinDir, 'tmux'), `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${tmuxLogPath}"
if [ "$1" = "list-panes" ]; then
  count=0; [ ! -f "${countPath}" ] || count=$(cat "${countPath}")
  count=$((count + 1)); printf '%s' "$count" > "${countPath}"
  if [ "$count" -eq 1 ]; then printf '%%42\t0\t4242\n'; else printf '%%42\t0\t4343\n'; fi
fi
`);
    await chmod(join(fakeBinDir, 'tmux'), 0o755);
    const moduleUrl = new URL('../../../dist/scripts/notify-hook/team-tmux-guard.js', import.meta.url).href;
    const result = runSendPaneInputInChild({
      fakeBinDir,
      moduleUrl,
      paneTarget: '%42',
      exactPaneId: '%42',
      prompt: 'must not send',
      submitKeyPresses: 1,
      typePrompt: false,
    });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.exactPaneProof.reason, 'pane_pid_changed');
    assert.doesNotMatch(await readFile(tmuxLogPath, 'utf8'), /send-keys/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it('rejects a same-PID owner takeover before any Team pane input effect', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-team-tmux-owner-change-'));
  const fakeBinDir = join(cwd, 'fake-bin');
  const tmuxLogPath = join(cwd, 'tmux.log');
  try {
    await mkdir(fakeBinDir, { recursive: true });
    await writeFile(join(fakeBinDir, 'tmux'), `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${tmuxLogPath}"
if [ "$1" = "list-panes" ]; then printf '%%42\t0\t4242\n'; exit 0; fi
if [ "$1" = "display-message" ]; then echo codex; exit 0; fi
if [ "$1" = "show-option" ]; then echo team:foreign; exit 0; fi
`);
    await chmod(join(fakeBinDir, 'tmux'), 0o755);
    const moduleUrl = new URL('../../../dist/scripts/notify-hook/team-tmux-guard.js', import.meta.url).href;
    const result = runSendPaneInputInChild({
      fakeBinDir,
      moduleUrl,
      paneTarget: '%42',
      exactPaneId: '%42',
      expectedPanePid: 4242,
      expectedPaneOwnerId: 'team:alpha',
      prompt: 'must not send',
      submitKeyPresses: 1,
      typePrompt: false,
    });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.exactPaneProof.reason, 'pane_owner_changed');
    assert.doesNotMatch(await readFile(tmuxLogPath, 'utf8'), /send-keys|paste-buffer/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it('rejects a replacement pane observed after a matching owner read', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-team-tmux-owner-replacement-'));
  const fakeBinDir = join(cwd, 'fake-bin');
  const tmuxLogPath = join(cwd, 'tmux.log');
  const countPath = join(cwd, 'proof-count');
  try {
    await mkdir(fakeBinDir, { recursive: true });
    await writeFile(join(fakeBinDir, 'tmux'), `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${tmuxLogPath}"
if [ "$1" = "list-panes" ]; then
  count=0; [ ! -f "${countPath}" ] || count=$(cat "${countPath}")
  count=$((count + 1)); printf '%s' "$count" > "${countPath}"
  if [ "$count" -le 3 ]; then printf '%%42\t0\t4242\n'; else printf '%%42\t0\t4343\n'; fi
  exit 0
fi
if [ "$1" = "display-message" ]; then echo codex; exit 0; fi
if [ "$1" = "show-option" ]; then echo team:alpha; exit 0; fi
`);
    await chmod(join(fakeBinDir, 'tmux'), 0o755);
    const moduleUrl = new URL('../../../dist/scripts/notify-hook/team-tmux-guard.js', import.meta.url).href;
    const result = runSendPaneInputInChild({
      fakeBinDir,
      moduleUrl,
      paneTarget: '%42',
      exactPaneId: '%42',
      expectedPanePid: 4242,
      expectedPaneOwnerId: 'team:alpha',
      prompt: 'must not send',
      submitKeyPresses: 1,
      typePrompt: false,
    });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.exactPaneProof.reason, 'pane_pid_changed');
    assert.doesNotMatch(await readFile(tmuxLogPath, 'utf8'), /send-keys|paste-buffer/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it('rejects a foreign-owner Team pane before inspecting readiness content', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-team-readiness-owner-change-'));
  const fakeBinDir = join(cwd, 'fake-bin');
  const tmuxLogPath = join(cwd, 'tmux.log');
  try {
    await mkdir(fakeBinDir, { recursive: true });
    await writeFile(join(fakeBinDir, 'tmux'), `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${tmuxLogPath}"
if [ "$1" = "list-panes" ]; then printf '%%42\t0\t4242\n'; exit 0; fi
if [ "$1" = "show-option" ]; then echo team:foreign; exit 0; fi
if [ "$1" = "display-message" ]; then echo foreign-command; exit 0; fi
if [ "$1" = "capture-pane" ]; then echo foreign-content; exit 0; fi
`);
    await chmod(join(fakeBinDir, 'tmux'), 0o755);
    const moduleUrl = new URL('../../../dist/scripts/notify-hook/team-tmux-guard.js', import.meta.url).href;
    const result = runEvaluatePaneInjectionReadinessInChild({
      fakeBinDir,
      moduleUrl,
      paneTarget: '%42',
      options: {
        exactPaneId: '%42',
        expectedPanePid: 4242,
        expectedPaneOwnerId: 'team:alpha',
        expectedHudPaneId: '%99',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.exactPaneProof.reason, 'pane_owner_changed');
    assert.equal(parsed.paneCapture, '');
    assert.doesNotMatch(await readFile(tmuxLogPath, 'utf8'), /display-message|capture-pane/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it('rejects a replacement Team pane after the owner proof and before readiness reads', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-team-readiness-owner-replacement-'));
  const fakeBinDir = join(cwd, 'fake-bin');
  const tmuxLogPath = join(cwd, 'tmux.log');
  const countPath = join(cwd, 'proof-count');
  try {
    await mkdir(fakeBinDir, { recursive: true });
    await writeFile(join(fakeBinDir, 'tmux'), `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${tmuxLogPath}"
if [ "$1" = "list-panes" ]; then
  count=0; [ ! -f "${countPath}" ] || count=$(cat "${countPath}")
  count=$((count + 1)); printf '%s' "$count" > "${countPath}"
  if [ "$count" -eq 1 ]; then printf '%%42\t0\t4242\n'; else printf '%%42\t0\t4343\n'; fi
  exit 0
fi
if [ "$1" = "show-option" ]; then echo team:alpha; exit 0; fi
if [ "$1" = "display-message" ]; then echo foreign-command; exit 0; fi
if [ "$1" = "capture-pane" ]; then echo foreign-content; exit 0; fi
`);
    await chmod(join(fakeBinDir, 'tmux'), 0o755);
    const moduleUrl = new URL('../../../dist/scripts/notify-hook/team-tmux-guard.js', import.meta.url).href;
    const result = runEvaluatePaneInjectionReadinessInChild({
      fakeBinDir,
      moduleUrl,
      paneTarget: '%42',
      options: {
        exactPaneId: '%42',
        expectedPanePid: 4242,
        expectedPaneOwnerId: 'team:alpha',
        expectedHudPaneId: '%99',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.exactPaneProof.reason, 'pane_pid_changed');
    assert.equal(parsed.paneCapture, '');
    assert.doesNotMatch(await readFile(tmuxLogPath, 'utf8'), /display-message|capture-pane/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it('rejects the configured Team HUD without reading its command or capture', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-team-readiness-hud-'));
  const fakeBinDir = join(cwd, 'fake-bin');
  const tmuxLogPath = join(cwd, 'tmux.log');
  try {
    await mkdir(fakeBinDir, { recursive: true });
    await writeFile(join(fakeBinDir, 'tmux'), `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${tmuxLogPath}"
echo foreign-content
`);
    await chmod(join(fakeBinDir, 'tmux'), 0o755);
    const moduleUrl = new URL('../../../dist/scripts/notify-hook/team-tmux-guard.js', import.meta.url).href;
    const result = runEvaluatePaneInjectionReadinessInChild({
      fakeBinDir,
      moduleUrl,
      paneTarget: '%42',
      options: {
        exactPaneId: '%42',
        expectedPanePid: 4242,
        expectedPaneOwnerId: 'team:alpha',
        expectedHudPaneId: '%42',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.reason, 'hud_pane_target');
    assert.equal(parsed.paneCapture, '');
    await assert.rejects(readFile(tmuxLogPath, 'utf8'));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it('authorizes Team ownership before reading the start command', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-team-tmux-start-command-owner-'));
  const fakeBinDir = join(cwd, 'fake-bin');
  const tmuxLogPath = join(cwd, 'tmux.log');
  try {
    await mkdir(fakeBinDir, { recursive: true });
    await writeFile(join(fakeBinDir, 'tmux'), `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${tmuxLogPath}"
if [ "$1" = "list-panes" ]; then printf '%%42\t0\t4242\n'; exit 0; fi
if [ "$1" = "show-option" ]; then echo team:foreign; exit 0; fi
if [ "$1" = "display-message" ]; then echo foreign-command; exit 0; fi
`);
    await chmod(join(fakeBinDir, 'tmux'), 0o755);
    const moduleUrl = new URL('../../../dist/scripts/notify-hook/team-tmux-guard.js', import.meta.url).href;
    const result = runSendPaneInputInChild({
      fakeBinDir,
      moduleUrl,
      paneTarget: '%42',
      exactPaneId: '%42',
      expectedPanePid: 4242,
      expectedPaneOwnerId: 'team:alpha',
      prompt: 'must not inspect or send',
      submitKeyPresses: 1,
      typePrompt: false,
    });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.exactPaneProof.reason, 'pane_owner_changed');
    const log = await readFile(tmuxLogPath, 'utf8');
    assert.doesNotMatch(log, /display-message|send-keys|paste-buffer/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
