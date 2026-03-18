import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { normalizeAutoresearchCodexArgs, parseAutoresearchArgs } from '../autoresearch.js';
import {
  buildSidecarRefreshSnapshot,
  initializeAutoresearchSparkPrepassSnapshot,
  readAutoresearchSparkPrepassSnapshot,
  runAutoresearchSparkPrepass,
  shouldSparkSidecarRefresh,
  type AutoresearchSparkPrepassSnapshot,
} from '../../autoresearch/spark-prepass.js';

function runOmx(
  cwd: string,
  argv: string[],
  envOverrides: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string; error?: string } {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const omxBin = join(repoRoot, 'bin', 'omx.js');
  const r = spawnSync(process.execPath, [omxBin, ...argv], {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      OMX_AUTO_UPDATE: '0',
      OMX_NOTIFY_FALLBACK: '0',
      OMX_HOOK_DERIVED_SIGNALS: '0',
      ...envOverrides,
    },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error?.message };
}

async function initRepo(): Promise<string> {
  const raw = await mkdtemp(join(tmpdir(), 'omx-autoresearch-test-'));
  const cwd = realpathSync(raw);
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'ignore' });
  await writeFile(join(cwd, 'README.md'), 'hello\n', 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'ignore' });
  return cwd;
}

function findAutoresearchRunId(repo: string): string {
  const logsRoot = join(repo, '.omx', 'logs', 'autoresearch');
  const [runId] = execFileSync('find', [logsRoot, '-mindepth', '1', '-maxdepth', '1', '-type', 'd', '-printf', '%f\n'], { encoding: 'utf-8' })
    .trim()
    .split('\n')
    .filter(Boolean);
  assert.ok(runId);
  return runId;
}

describe('normalizeAutoresearchCodexArgs', () => {
  it('adds sandbox bypass by default for autoresearch workers', () => {
    assert.deepEqual(normalizeAutoresearchCodexArgs(['--model', 'gpt-5']), ['--model', 'gpt-5', '--dangerously-bypass-approvals-and-sandbox']);
  });

  it('deduplicates explicit bypass flags', () => {
    assert.deepEqual(normalizeAutoresearchCodexArgs(['--dangerously-bypass-approvals-and-sandbox']), ['--dangerously-bypass-approvals-and-sandbox']);
  });

  it('normalizes --madmax to the canonical bypass flag', () => {
    assert.deepEqual(normalizeAutoresearchCodexArgs(['--madmax']), ['--dangerously-bypass-approvals-and-sandbox']);
  });
});

describe('parseAutoresearchArgs', () => {
  it('treats --spark-prepass before mission-dir as a supervisor flag', () => {
    assert.deepEqual(parseAutoresearchArgs(['--spark-prepass', 'missions/demo', '--model', 'gpt-5']), {
      missionDir: 'missions/demo',
      runId: null,
      codexArgs: ['--model', 'gpt-5'],
      sparkPrepass: true,
      sparkSidecar: false,
    });
  });

  it('leaves --spark-prepass after mission-dir inside codex args', () => {
    assert.deepEqual(parseAutoresearchArgs(['missions/demo', '--spark-prepass', '--model', 'gpt-5']), {
      missionDir: 'missions/demo',
      runId: null,
      codexArgs: ['--spark-prepass', '--model', 'gpt-5'],
      sparkPrepass: false,
      sparkSidecar: false,
    });
  });
});

describe('parseAutoresearchArgs --spark-sidecar', () => {
  it('treats --spark-sidecar before mission-dir as a supervisor flag that implies --spark-prepass', () => {
    assert.deepEqual(parseAutoresearchArgs(['--spark-sidecar', 'missions/demo', '--model', 'gpt-5']), {
      missionDir: 'missions/demo',
      runId: null,
      codexArgs: ['--model', 'gpt-5'],
      sparkPrepass: true,
      sparkSidecar: true,
    });
  });

  it('supports both --spark-prepass and --spark-sidecar together', () => {
    assert.deepEqual(parseAutoresearchArgs(['--spark-prepass', '--spark-sidecar', 'missions/demo']), {
      missionDir: 'missions/demo',
      runId: null,
      codexArgs: [],
      sparkPrepass: true,
      sparkSidecar: true,
    });
  });

  it('leaves --spark-sidecar after mission-dir inside codex args', () => {
    assert.deepEqual(parseAutoresearchArgs(['missions/demo', '--spark-sidecar']), {
      missionDir: 'missions/demo',
      runId: null,
      codexArgs: ['--spark-sidecar'],
      sparkPrepass: false,
      sparkSidecar: false,
    });
  });

  it('supports --spark-sidecar with --resume', () => {
    assert.deepEqual(parseAutoresearchArgs(['--spark-sidecar', '--resume', 'run-123']), {
      missionDir: null,
      runId: 'run-123',
      codexArgs: [],
      sparkPrepass: true,
      sparkSidecar: true,
    });
  });
});

describe('omx autoresearch', () => {
  it('documents autoresearch in top-level help', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-autoresearch-help-'));
    try {
      const result = runOmx(cwd, ['--help']);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /omx autoresearch\s+Launch thin-supervisor autoresearch with keep\/discard\/reset parity/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('routes autoresearch --help to command-local help', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-autoresearch-local-help-'));
    try {
      const result = runOmx(cwd, ['autoresearch', '--help']);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /Usage:[\s\S]*omx autoresearch \[--spark-prepass\] \[--spark-sidecar\] run <mission-dir>/i);
      assert.match(result.stdout, /--spark-sidecar/i);
      assert.match(result.stdout, /omx autoresearch init/i);
      assert.match(result.stdout, /--topic\/\.\.\./i);
      assert.match(result.stdout, /deep-interview/i);
      assert.match(result.stdout, /human entrypoint/i);
      assert.doesNotMatch(result.stdout, /oh-my-codex \(omx\) - Multi-agent orchestration for Codex CLI/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('documents --resume in command-local help', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-autoresearch-resume-help-'));
    try {
      const result = runOmx(cwd, ['autoresearch', '--help']);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /--resume <run-id>/i);
      assert.match(result.stdout, /--spark-prepass/i);
      assert.match(result.stdout, /run-tagged/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails fast when mission dir is missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-autoresearch-missing-arg-'));
    try {
      const result = runOmx(cwd, ['autoresearch']);
      assert.notEqual(result.status, 0, result.stderr || result.stdout);
      assert.match(`${result.stderr}\n${result.stdout}`, /mission-dir|Usage:\s*omx autoresearch <mission-dir>/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('treats top-level topic/evaluator flags as seeded deep-interview input', () => {
    const parsed = parseAutoresearchArgs(['--topic', 'Improve docs', '--evaluator', 'node eval.js', '--slug', 'docs-run']);
    assert.equal(parsed.guided, true);
    assert.equal(parsed.seedArgs?.topic, 'Improve docs');
    assert.equal(parsed.seedArgs?.evaluatorCommand, 'node eval.js');
    assert.equal(parsed.seedArgs?.slug, 'docs-run');
  });

  it('treats bare init as guided alias and init with flags as expert init args', () => {
    const bare = parseAutoresearchArgs(['init']);
    assert.equal(bare.guided, true);
    assert.deepEqual(bare.initArgs, []);

    const flagged = parseAutoresearchArgs(['init', '--topic', 'Ship feature']);
    assert.equal(flagged.guided, true);
    assert.deepEqual(flagged.initArgs, ['--topic', 'Ship feature']);
  });

  it('parses explicit run subcommand without breaking bare mission-dir execution', () => {
    const runParsed = parseAutoresearchArgs(['run', 'missions/demo', '--model', 'gpt-5']);
    assert.equal(runParsed.runSubcommand, true);
    assert.equal(runParsed.missionDir, 'missions/demo');
    assert.deepEqual(runParsed.codexArgs, ['--model', 'gpt-5']);

    const bareParsed = parseAutoresearchArgs(['missions/demo', '--model', 'gpt-5']);
    assert.equal(bareParsed.runSubcommand, undefined);
    assert.equal(bareParsed.missionDir, 'missions/demo');
    assert.deepEqual(bareParsed.codexArgs, ['--model', 'gpt-5']);
  });


  it('resolves guided deep-interview artifacts by seeded slug even when file mtimes predate launch timestamp', async () => {
    const repo = await initRepo();
    const fakeBin = await mkdtemp(join(tmpdir(), 'omx-autoresearch-deep-interview-mtime-bin-'));
    try {
      const fakeCodexPath = join(fakeBin, 'codex');
      await writeFile(
        fakeCodexPath,
        `#!/bin/sh
if [ "$1" = "exec" ]; then
  candidate_file=$(find "$OMX_TEST_REPO_ROOT/.omx/logs/autoresearch" -name candidate.json | head -n 1)
  head_commit=$(git rev-parse HEAD)
  cat >"$candidate_file" <<'EOF'
{
  "status": "abort",
  "candidate_commit": null,
  "base_commit": "HEAD_PLACEHOLDER",
  "description": "stop after guided handoff",
  "notes": ["fake codex exec"],
  "created_at": "2026-03-18T00:00:00.000Z"
}
EOF
  perl -0pi -e "s/HEAD_PLACEHOLDER/$head_commit/g" "$candidate_file"
  exit 0
fi
mkdir -p "$OMX_TEST_REPO_ROOT/.omx/specs/autoresearch-test-launch"
cat >"$OMX_TEST_REPO_ROOT/.omx/specs/deep-interview-autoresearch-test-launch.md" <<'EOF'
# Deep Interview Autoresearch Draft — test-launch

## Mission Draft
Investigate flaky onboarding behavior

## Evaluator Draft
node scripts/eval.js

## Keep Policy
score_improvement

## Session Slug
test-launch

## Seed Inputs
- topic: (none)
- evaluator: (none)
- keep_policy: (none)
- slug: (none)

## Launch Readiness
Launch-ready: yes
- Evaluator command is concrete and can be compiled into sandbox.md

## Confirmation Bridge
- refine further
- launch
EOF
cat >"$OMX_TEST_REPO_ROOT/.omx/specs/autoresearch-test-launch/mission.md" <<'EOF'
# Mission

Investigate flaky onboarding behavior
EOF
cat >"$OMX_TEST_REPO_ROOT/.omx/specs/autoresearch-test-launch/sandbox.md" <<'EOF'
---
evaluator:
  command: node scripts/eval.js
  format: json
  keep_policy: score_improvement
---
EOF
cat >"$OMX_TEST_REPO_ROOT/.omx/specs/autoresearch-test-launch/result.json" <<'EOF'
{
  "kind": "omx.autoresearch.deep-interview/v1",
  "compileTarget": {
    "topic": "Investigate flaky onboarding behavior",
    "evaluatorCommand": "node scripts/eval.js",
    "keepPolicy": "score_improvement",
    "slug": "test-launch",
    "repoRoot": "${repo}"
  },
  "draftArtifactPath": "${repo}/.omx/specs/deep-interview-autoresearch-test-launch.md",
  "missionArtifactPath": "${repo}/.omx/specs/autoresearch-test-launch/mission.md",
  "sandboxArtifactPath": "${repo}/.omx/specs/autoresearch-test-launch/sandbox.md",
  "launchReady": true,
  "blockedReasons": []
}
EOF
touch -t 202603180000 "$OMX_TEST_REPO_ROOT/.omx/specs/deep-interview-autoresearch-test-launch.md"
touch -t 202603180000 "$OMX_TEST_REPO_ROOT/.omx/specs/autoresearch-test-launch/mission.md"
touch -t 202603180000 "$OMX_TEST_REPO_ROOT/.omx/specs/autoresearch-test-launch/sandbox.md"
touch -t 202603180000 "$OMX_TEST_REPO_ROOT/.omx/specs/autoresearch-test-launch/result.json"
`,
        'utf-8',
      );
      execFileSync('chmod', ['+x', fakeCodexPath], { stdio: 'ignore' });

      const result = runOmx(repo, ['autoresearch', '--topic', 'Investigate flaky onboarding behavior', '--evaluator', 'node scripts/eval.js', '--slug', 'test-launch'], {
        PATH: `${fakeBin}:${process.env.PATH || ''}`,
        OMX_TEST_REPO_ROOT: repo,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const missionContent = await readFile(join(repo, 'missions', 'test-launch', 'mission.md'), 'utf-8');
      const sandboxContent = await readFile(join(repo, 'missions', 'test-launch', 'sandbox.md'), 'utf-8');
      assert.match(missionContent, /Investigate flaky onboarding behavior/);
      assert.match(sandboxContent, /command: node scripts\/eval\.js/);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(fakeBin, { recursive: true, force: true });
    }
  });

  it('launches interactive deep-interview intake, materializes mission files, and then prefers split-pane handoff', async () => {
    const repo = await initRepo();
    const fakeBin = await mkdtemp(join(tmpdir(), 'omx-autoresearch-deep-interview-bin-'));
    try {
      const codexLog = join(repo, 'codex-launch.log');
      const tmuxLog = join(repo, 'guided-tmux.log');
      const fakeCodexPath = join(fakeBin, 'codex');
      await writeFile(
        fakeCodexPath,
        `#!/bin/sh
printf '%s\n' "$*" >>"${codexLog}"
if [ "$1" = "exec" ]; then
candidate_file=$(find "$OMX_TEST_REPO_ROOT/.omx/logs/autoresearch" -name candidate.json | head -n 1)
head_commit=$(git rev-parse HEAD)
cat >"$candidate_file" <<'EOF'
{
  "status": "abort",
  "candidate_commit": null,
  "base_commit": "HEAD_PLACEHOLDER",
  "description": "stop after guided handoff",
  "notes": ["fake codex exec"],
  "created_at": "2026-03-18T00:00:00.000Z"
}
EOF
perl -0pi -e "s/HEAD_PLACEHOLDER/$head_commit/g" "$candidate_file"
exit 0
fi
mkdir -p "$OMX_TEST_REPO_ROOT/.omx/specs/deep-int"
mkdir -p "$OMX_TEST_REPO_ROOT/.omx/specs/autoresearch-test-launch"
cat >"$OMX_TEST_REPO_ROOT/.omx/specs/deep-interview-autoresearch-test-launch.md" <<'EOF'
# Deep Interview Autoresearch Draft — test-launch

## Mission Draft
Investigate flaky onboarding behavior

## Evaluator Draft
node scripts/eval.js

## Keep Policy
score_improvement

## Session Slug
test-launch

## Seed Inputs
- topic: (none)
- evaluator: (none)
- keep_policy: (none)
- slug: (none)

## Launch Readiness
Launch-ready: yes
- Evaluator command is concrete and can be compiled into sandbox.md

## Confirmation Bridge
- refine further
- launch
EOF
cat >"$OMX_TEST_REPO_ROOT/.omx/specs/autoresearch-test-launch/mission.md" <<'EOF'
# Mission

Investigate flaky onboarding behavior
EOF
cat >"$OMX_TEST_REPO_ROOT/.omx/specs/autoresearch-test-launch/sandbox.md" <<'EOF'
---
evaluator:
  command: node scripts/eval.js
  format: json
  keep_policy: score_improvement
---
EOF
cat >"$OMX_TEST_REPO_ROOT/.omx/specs/autoresearch-test-launch/result.json" <<'EOF'
{
  "kind": "omx.autoresearch.deep-interview/v1",
  "compileTarget": {
    "topic": "Investigate flaky onboarding behavior",
    "evaluatorCommand": "node scripts/eval.js",
    "keepPolicy": "score_improvement",
    "slug": "test-launch",
    "repoRoot": "${repo}"
  },
  "draftArtifactPath": "${repo}/.omx/specs/deep-interview-autoresearch-test-launch.md",
  "missionArtifactPath": "${repo}/.omx/specs/autoresearch-test-launch/mission.md",
  "sandboxArtifactPath": "${repo}/.omx/specs/autoresearch-test-launch/sandbox.md",
  "launchReady": true,
  "blockedReasons": []
}
EOF
`,
        'utf-8',
      );
      execFileSync('chmod', ['+x', fakeCodexPath], { stdio: 'ignore' });

      const fakeTmuxPath = join(fakeBin, 'tmux');
      await writeFile(
        fakeTmuxPath,
        `#!/bin/sh
printf '%s\n' "$*" >>"${tmuxLog}"
case "$1" in
  -V)
    printf 'tmux 3.4\n'
    exit 0
    ;;
  display-message)
    case "$*" in
      *"#{pane_id}"*) printf '%%42\n' ;;
      *"#{pane_current_path}"*) printf '%s\n' "$OMX_TEST_REPO_ROOT" ;;
      *"#S"*) printf 'devsession\n' ;;
      *) printf 'devsession\n' ;;
    esac
    exit 0
    ;;
  list-panes)
    exit 0
    ;;
  split-window)
    last=""
    for arg in "$@"; do
      last="$arg"
    done
    printf '%%2\n'
    if printf '%s' "$last" | grep -q 'autoresearch '; then
      /bin/sh -lc "$last"
    fi
    exit 0
    ;;
  attach-session|set-option|set-hook|kill-session|kill-pane)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
        'utf-8',
      );
      execFileSync('chmod', ['+x', fakeTmuxPath], { stdio: 'ignore' });

      const result = runOmx(repo, ['autoresearch', '--topic', 'Investigate flaky onboarding behavior', '--evaluator', 'node scripts/eval.js', '--slug', 'test-launch'], {
        PATH: `${fakeBin}:${process.env.PATH || ''}`,
        OMX_TEST_REPO_ROOT: repo,
        TMUX: '/tmp/fake-tmux,12345,0',
        TMUX_PANE: '%42',
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const codexArgs = await readFile(codexLog, 'utf-8');
      const tmuxOutput = await readFile(tmuxLog, 'utf-8');
      assert.match(codexArgs, /\$deep-interview --autoresearch/);
      assert.match(tmuxOutput, /split-window -h -t %42 -d -P -F #\{pane_id\} -c/);

      const missionContent = await readFile(join(repo, 'missions', 'test-launch', 'mission.md'), 'utf-8');
      const sandboxContent = await readFile(join(repo, 'missions', 'test-launch', 'sandbox.md'), 'utf-8');
      assert.match(missionContent, /Investigate flaky onboarding behavior/);
      assert.match(sandboxContent, /command: node scripts\/eval\.js/);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(fakeBin, { recursive: true, force: true });
    }
  });

  it('uses split-window launch for explicit run inside tmux while preserving the interview pane', async () => {
    const repo = await initRepo();
    const fakeBin = await mkdtemp(join(tmpdir(), 'omx-autoresearch-run-split-bin-'));
    try {
      const missionDir = join(repo, 'missions', 'demo');
      const tmuxLog = join(repo, 'tmux.log');
      await mkdir(missionDir, { recursive: true });
      await mkdir(join(repo, 'scripts'), { recursive: true });
      await writeFile(join(missionDir, 'mission.md'), '# Mission\nSplit pane launch.\n', 'utf-8');
      await writeFile(
        join(missionDir, 'sandbox.md'),
        '---\nevaluator:\n  command: node scripts/eval.js\n  format: json\n  keep_policy: pass_only\n---\nStay inside the mission boundary.\n',
        'utf-8',
      );
      await writeFile(join(repo, 'scripts', 'eval.js'), "process.stdout.write(JSON.stringify({ pass: true }));\n", 'utf-8');
      execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'add autoresearch mission'], { cwd: repo, stdio: 'ignore' });

      const fakeCodexPath = join(fakeBin, 'codex');
      await writeFile(
        fakeCodexPath,
        `#!/bin/sh
candidate_file=$(find "$OMX_TEST_REPO_ROOT/.omx/logs/autoresearch" -name candidate.json | head -n 1)
head_commit=$(git rev-parse HEAD)
cat >"$candidate_file" <<'EOF'
{
  "status": "abort",
  "candidate_commit": null,
  "base_commit": "HEAD_PLACEHOLDER",
  "description": "stop after split launch",
  "notes": ["fake codex exec"],
  "created_at": "2026-03-18T00:00:00.000Z"
}
EOF
perl -0pi -e "s/HEAD_PLACEHOLDER/$head_commit/g" "$candidate_file"
`,
        'utf-8',
      );
      execFileSync('chmod', ['+x', fakeCodexPath], { stdio: 'ignore' });

      const fakeTmuxPath = join(fakeBin, 'tmux');
      await writeFile(
        fakeTmuxPath,
        `#!/bin/sh
printf '%s\n' "$*" >>"${tmuxLog}"
case "$1" in
  -V)
    printf 'tmux 3.4\n'
    exit 0
    ;;
  display-message)
    case "$*" in
      *"#{pane_id}"*) printf '%%9\n' ;;
      *"#{pane_current_path}"*) printf '${repo}\n' ;;
      *"#S"*) printf 'devsess\n' ;;
      *) printf '0\n' ;;
    esac
    exit 0
    ;;
  list-panes)
    printf '%%9\tzsh\tomx autoresearch\n'
    exit 0
    ;;
  split-window)
    last=""
    for arg in "$@"; do
      last="$arg"
    done
    if printf '%s' "$last" | grep -q 'hud --watch'; then
      printf '%%3\n'
      exit 0
    fi
    printf '%%2\n'
    /bin/sh -lc "$last"
    exit 0
    ;;
  set-option|select-pane)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
        'utf-8',
      );
      execFileSync('chmod', ['+x', fakeTmuxPath], { stdio: 'ignore' });

      const result = runOmx(repo, ['autoresearch', 'run', missionDir, '--model', 'gpt-5'], {
        PATH: `${fakeBin}:${process.env.PATH || ''}`,
        OMX_TEST_REPO_ROOT: repo,
        TMUX: '/tmp/fake-tmux,12345,0',
        TMUX_PANE: '%9',
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const tmuxOutput = await readFile(tmuxLog, 'utf-8');
      assert.match(tmuxOutput, /split-window -h -t %9 -d -P -F #\{pane_id\} -c/);
      assert.match(tmuxOutput, /'autoresearch' '\/tmp\/[^']+\/missions\/demo' '--model' 'gpt-5'/);
      assert.doesNotMatch(tmuxOutput, /kill-pane -t %9/);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(fakeBin, { recursive: true, force: true });
    }
  });

  it('falls back to foreground execution when tmux split-window fails', async () => {
    const repo = await initRepo();
    const fakeBin = await mkdtemp(join(tmpdir(), 'omx-autoresearch-run-fallback-bin-'));
    try {
      const missionDir = join(repo, 'missions', 'demo');
      await mkdir(missionDir, { recursive: true });
      await mkdir(join(repo, 'scripts'), { recursive: true });
      await writeFile(join(missionDir, 'mission.md'), '# Mission\nFallback launch.\n', 'utf-8');
      await writeFile(
        join(missionDir, 'sandbox.md'),
        '---\nevaluator:\n  command: node scripts/eval.js\n  format: json\n  keep_policy: pass_only\n---\nStay inside the mission boundary.\n',
        'utf-8',
      );
      await writeFile(join(repo, 'scripts', 'eval.js'), "process.stdout.write(JSON.stringify({ pass: true }));\n", 'utf-8');
      execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'add autoresearch mission'], { cwd: repo, stdio: 'ignore' });

      const fakeCodexPath = join(fakeBin, 'codex');
      await writeFile(
        fakeCodexPath,
        `#!/bin/sh
candidate_file=$(find "$OMX_TEST_REPO_ROOT/.omx/logs/autoresearch" -name candidate.json | head -n 1)
head_commit=$(git rev-parse HEAD)
cat >"$candidate_file" <<'EOF'
{
  "status": "abort",
  "candidate_commit": null,
  "base_commit": "HEAD_PLACEHOLDER",
  "description": "stop after foreground fallback",
  "notes": ["fake codex exec"],
  "created_at": "2026-03-18T00:00:00.000Z"
}
EOF
perl -0pi -e "s/HEAD_PLACEHOLDER/$head_commit/g" "$candidate_file"
`,
        'utf-8',
      );
      execFileSync('chmod', ['+x', fakeCodexPath], { stdio: 'ignore' });

      const fakeTmuxPath = join(fakeBin, 'tmux');
      await writeFile(
        fakeTmuxPath,
        `#!/bin/sh
case "$1" in
  -V)
    printf 'tmux 3.4\n'
    exit 0
    ;;
  display-message)
    case "$*" in
      *"#{pane_id}"*) printf '%%9\n' ;;
      *"#{pane_current_path}"*) printf '${repo}\n' ;;
      *"#S"*) printf 'devsess\n' ;;
      *) printf '0\n' ;;
    esac
    exit 0
    ;;
  list-panes)
    printf '%%9\tzsh\tomx autoresearch\n'
    exit 0
    ;;
  split-window)
    exit 1
    ;;
  set-option|select-pane)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
        'utf-8',
      );
      execFileSync('chmod', ['+x', fakeTmuxPath], { stdio: 'ignore' });

      const result = runOmx(repo, ['autoresearch', 'run', missionDir], {
        PATH: `${fakeBin}:${process.env.PATH || ''}`,
        OMX_TEST_REPO_ROOT: repo,
        TMUX: '/tmp/fake-tmux,12345,0',
        TMUX_PANE: '%9',
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const logsRoot = join(repo, '.omx', 'logs', 'autoresearch');
      const [runId] = readdirSync(logsRoot, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
      assert.ok(runId);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(fakeBin, { recursive: true, force: true });
    }
  });

  it('rejects mission directories outside a git repo', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-autoresearch-outside-git-'));
    try {
      await writeFile(join(cwd, 'mission.md'), '# Mission\n', 'utf-8');
      await writeFile(join(cwd, 'sandbox.md'), '---\nevaluator:\n  command: node eval.js\n---\n', 'utf-8');

      const result = runOmx(cwd, ['autoresearch', cwd]);
      assert.notEqual(result.status, 0, result.stderr || result.stdout);
      assert.match(`${result.stderr}\n${result.stdout}`, /git repo|git repository|inside a git repo/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects missing mission.md inside an in-repo mission dir', async () => {
    const repo = await initRepo();
    try {
      const missionDir = join(repo, 'missions', 'demo');
      await mkdir(missionDir, { recursive: true });
      await writeFile(join(missionDir, 'sandbox.md'), '---\nevaluator:\n  command: node eval.js\n---\n', 'utf-8');

      const result = runOmx(repo, ['autoresearch', missionDir]);
      assert.notEqual(result.status, 0, result.stderr || result.stdout);
      assert.match(`${result.stderr}\n${result.stdout}`, /mission\.md/i);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('rejects missing sandbox.md inside an in-repo mission dir', async () => {
    const repo = await initRepo();
    try {
      const missionDir = join(repo, 'missions', 'demo');
      await mkdir(missionDir, { recursive: true });
      await writeFile(join(missionDir, 'mission.md'), '# Mission\n', 'utf-8');

      const result = runOmx(repo, ['autoresearch', missionDir]);
      assert.notEqual(result.status, 0, result.stderr || result.stdout);
      assert.match(`${result.stderr}\n${result.stdout}`, /sandbox\.md/i);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('rejects sandbox.md without evaluator frontmatter', async () => {
    const repo = await initRepo();
    try {
      const missionDir = join(repo, 'missions', 'demo');
      await mkdir(missionDir, { recursive: true });
      await writeFile(join(missionDir, 'mission.md'), '# Mission\n', 'utf-8');
      await writeFile(join(missionDir, 'sandbox.md'), 'No frontmatter here.\n', 'utf-8');

      const result = runOmx(repo, ['autoresearch', missionDir]);
      assert.notEqual(result.status, 0, result.stderr || result.stdout);
      assert.match(`${result.stderr}\n${result.stdout}`, /frontmatter|evaluator/i);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('rejects autoresearch launch when root ralph mode is already active', async () => {
    const repo = await initRepo();
    try {
      const missionDir = join(repo, 'missions', 'demo');
      await mkdir(missionDir, { recursive: true });
      await writeFile(join(missionDir, 'mission.md'), '# Mission\n', 'utf-8');
      await writeFile(
        join(missionDir, 'sandbox.md'),
        '---\nevaluator:\n  command: node eval.js\n  format: json\n---\nStay inside the mission boundary.\n',
        'utf-8',
      );
      await mkdir(join(repo, '.omx', 'state'), { recursive: true });
      await writeFile(
        join(repo, '.omx', 'state', 'ralph-state.json'),
        JSON.stringify({
          active: true,
          mode: 'ralph',
          iteration: 0,
          max_iterations: 50,
          current_phase: 'executing',
          task_description: 'existing root ralph lane',
          started_at: '2026-03-14T00:00:00.000Z',
        }, null, 2),
        'utf-8',
      );

      const result = runOmx(repo, ['autoresearch', missionDir]);
      assert.notEqual(result.status, 0, result.stderr || result.stdout);
      assert.match(`${result.stderr}\n${result.stdout}`, /Cannot start autoresearch: ralph is already active/i);

      const worktreesRoot = join(repo, '.omx', 'worktrees');
      assert.equal(existsSync(worktreesRoot), false, 'expected launch to abort before creating autoresearch worktree');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('launches codex exec for autoresearch turns without shelling out to cat', async () => {
    const repo = await initRepo();
    const fakeBin = await mkdtemp(join(tmpdir(), 'omx-autoresearch-fake-bin-'));
    try {
      const missionDir = join(repo, 'missions', 'demo');
      await mkdir(missionDir, { recursive: true });
      await mkdir(join(repo, 'scripts'), { recursive: true });
      await writeFile(join(missionDir, 'mission.md'), '# Mission\nWrite a noop candidate artifact.\n', 'utf-8');
      await writeFile(
        join(missionDir, 'sandbox.md'),
        '---\nevaluator:\n  command: node scripts/eval.js\n  format: json\n  keep_policy: pass_only\n---\nStay inside the mission boundary.\n',
        'utf-8',
      );
      await writeFile(join(repo, 'scripts', 'eval.js'), "process.stdout.write(JSON.stringify({ pass: true }));\n", 'utf-8');
      execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'add autoresearch mission'], { cwd: repo, stdio: 'ignore' });

      const fakeCatPath = join(fakeBin, 'cat');
      await writeFile(
        fakeCatPath,
        `#!/bin/sh
printf 'unexpected cat invocation\\n' >&2
exit 97
`,
        'utf-8',
      );
      execFileSync('chmod', ['+x', fakeCatPath], { stdio: 'ignore' });

      const fakeCodexPath = join(fakeBin, 'codex');
      await writeFile(
        fakeCodexPath,
        `#!/bin/sh
printf 'fake-codex:%s\\n' "$*" >&2
while IFS= read -r _; do
  :
done
candidate_file=$(find "$OMX_TEST_REPO_ROOT/.omx/logs/autoresearch" -name candidate.json | head -n 1)
head_commit=$(git rev-parse HEAD)
printf '{\\n  "status": "abort",\\n  "candidate_commit": null,\\n  "base_commit": "%s",\\n  "description": "stop after first exec",\\n  "notes": ["fake codex exec"],\\n  "created_at": "2026-03-15T00:00:00.000Z"\\n}\\n' "$head_commit" >"$candidate_file"
`,
        'utf-8',
      );
      execFileSync('chmod', ['+x', fakeCodexPath], { stdio: 'ignore' });

      const result = runOmx(
        repo,
        ['autoresearch', missionDir, '--dangerously-bypass-approvals-and-sandbox'],
        { PATH: `${fakeBin}:${process.env.PATH || ''}`, OMX_TEST_REPO_ROOT: repo },
      );

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stderr, /fake-codex:exec --dangerously-bypass-approvals-and-sandbox -/);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(fakeBin, { recursive: true, force: true });
    }
  });

  it('runs an optional spark prepass once and injects the fact packet into bootstrap instructions', async () => {
    const repo = await initRepo();
    const fakeBin = await mkdtemp(join(tmpdir(), 'omx-autoresearch-prepass-bin-'));
    try {
      const missionDir = join(repo, 'missions', 'demo');
      const promptCapture = join(fakeBin, 'codex-prompt.md');
      const exploreCapture = join(fakeBin, 'explore-args.txt');
      await mkdir(missionDir, { recursive: true });
      await mkdir(join(repo, 'scripts'), { recursive: true });
      await writeFile(join(missionDir, 'mission.md'), '# Mission\nUse cheap discovery before the main worker turn.\n', 'utf-8');
      await writeFile(
        join(missionDir, 'sandbox.md'),
        '---\nevaluator:\n  command: node scripts/eval.js\n  format: json\n  keep_policy: pass_only\n---\nStay inside the mission boundary.\n',
        'utf-8',
      );
      await writeFile(join(repo, 'scripts', 'eval.js'), "process.stdout.write(JSON.stringify({ pass: true }));\n", 'utf-8');
      execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'add spark prepass mission'], { cwd: repo, stdio: 'ignore' });

      const fakeCodexPath = join(fakeBin, 'codex');
      await writeFile(
        fakeCodexPath,
        `#!/bin/sh
cat >"$OMX_TEST_PROMPT_CAPTURE"
candidate_file=$(find "$OMX_TEST_REPO_ROOT/.omx/logs/autoresearch" -name candidate.json | head -n 1)
head_commit=$(git rev-parse HEAD)
cat >"$candidate_file" <<EOF
{
  "status": "abort",
  "candidate_commit": null,
  "base_commit": "$head_commit",
  "description": "stop after spark prepass coverage",
  "notes": ["fake codex exec"],
  "created_at": "2026-03-17T00:00:00.000Z"
}
EOF
`,
        'utf-8',
      );
      execFileSync('chmod', ['+x', fakeCodexPath], { stdio: 'ignore' });

      const fakeExplorePath = join(fakeBin, 'explore-harness');
      await writeFile(
        fakeExplorePath,
        `#!/bin/sh
printf '%s\n' "$@" > "$OMX_TEST_EXPLORE_CAPTURE"
cat <<'EOF'
## Relevant files
- src/cli/autoresearch.ts — supervisor loop and flag parsing

## Key facts
- one Codex candidate-producing turn still owns candidate.json

## Evidence
- src/autoresearch/runtime.ts rewrites bootstrap instructions between iterations

## Next reads
- src/cli/explore.ts
EOF
`,
        'utf-8',
      );
      execFileSync('chmod', ['+x', fakeExplorePath], { stdio: 'ignore' });

      const result = runOmx(
        repo,
        ['autoresearch', '--spark-prepass', missionDir, '--dangerously-bypass-approvals-and-sandbox'],
        {
          PATH: `${fakeBin}:${process.env.PATH || ''}`,
          OMX_EXPLORE_BIN: fakeExplorePath,
          OMX_TEST_REPO_ROOT: repo,
          OMX_TEST_PROMPT_CAPTURE: promptCapture,
          OMX_TEST_EXPLORE_CAPTURE: exploreCapture,
        },
      );

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(await readFile(promptCapture, 'utf-8'), /Spark prepass fact packet/);
      assert.match(await readFile(promptCapture, 'utf-8'), /src\/cli\/autoresearch\.ts/);
      assert.match(await readFile(exploreCapture, 'utf-8'), /--prompt/);

      const runId = findAutoresearchRunId(repo);
      const instructions = await readFile(join(repo, '.omx', 'logs', 'autoresearch', runId, 'bootstrap-instructions.md'), 'utf-8');
      assert.match(instructions, /Spark prepass fact packet/);
      assert.match(instructions, /one Codex candidate-producing turn still owns candidate\.json/);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(fakeBin, { recursive: true, force: true });
    }
  });

  it('falls back cleanly when the spark prepass fails and still launches the main codex turn', async () => {
    const repo = await initRepo();
    const fakeBin = await mkdtemp(join(tmpdir(), 'omx-autoresearch-prepass-fallback-bin-'));
    try {
      const missionDir = join(repo, 'missions', 'demo');
      const promptCapture = join(fakeBin, 'codex-prompt.md');
      await mkdir(missionDir, { recursive: true });
      await mkdir(join(repo, 'scripts'), { recursive: true });
      await writeFile(join(missionDir, 'mission.md'), '# Mission\nContinue even when spark discovery fails.\n', 'utf-8');
      await writeFile(
        join(missionDir, 'sandbox.md'),
        '---\nevaluator:\n  command: node scripts/eval.js\n  format: json\n  keep_policy: pass_only\n---\nStay inside the mission boundary.\n',
        'utf-8',
      );
      await writeFile(join(repo, 'scripts', 'eval.js'), "process.stdout.write(JSON.stringify({ pass: true }));\n", 'utf-8');
      execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'add spark prepass fallback mission'], { cwd: repo, stdio: 'ignore' });

      const fakeCodexPath = join(fakeBin, 'codex');
      await writeFile(
        fakeCodexPath,
        `#!/bin/sh
cat >"$OMX_TEST_PROMPT_CAPTURE"
candidate_file=$(find "$OMX_TEST_REPO_ROOT/.omx/logs/autoresearch" -name candidate.json | head -n 1)
head_commit=$(git rev-parse HEAD)
cat >"$candidate_file" <<EOF
{
  "status": "abort",
  "candidate_commit": null,
  "base_commit": "$head_commit",
  "description": "continue after prepass failure",
  "notes": ["fake codex exec"],
  "created_at": "2026-03-17T00:00:00.000Z"
}
EOF
`,
        'utf-8',
      );
      execFileSync('chmod', ['+x', fakeCodexPath], { stdio: 'ignore' });

      const result = runOmx(
        repo,
        ['autoresearch', '--spark-prepass', missionDir, '--dangerously-bypass-approvals-and-sandbox'],
        {
          PATH: `${fakeBin}:${process.env.PATH || ''}`,
          OMX_EXPLORE_BIN: join(fakeBin, 'missing-explore-harness'),
          OMX_TEST_REPO_ROOT: repo,
          OMX_TEST_PROMPT_CAPTURE: promptCapture,
        },
      );

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stderr, /spark prepass unavailable/i);
      assert.doesNotMatch(await readFile(promptCapture, 'utf-8'), /Spark prepass fact packet/);

      const runId = findAutoresearchRunId(repo);
      const instructions = await readFile(join(repo, '.omx', 'logs', 'autoresearch', runId, 'bootstrap-instructions.md'), 'utf-8');
      assert.doesNotMatch(instructions, /Spark prepass fact packet/);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(fakeBin, { recursive: true, force: true });
    }
  });

  it('stops after repeated noop turns', async () => {
    const repo = await initRepo();
    const fakeBin = await mkdtemp(join(tmpdir(), 'omx-autoresearch-noop-bin-'));
    try {
      const missionDir = join(repo, 'missions', 'demo');
      await mkdir(missionDir, { recursive: true });
      await mkdir(join(repo, 'scripts'), { recursive: true });
      await writeFile(join(missionDir, 'mission.md'), '# Mission\nKeep returning noop.\n', 'utf-8');
      await writeFile(
        join(missionDir, 'sandbox.md'),
        '---\nevaluator:\n  command: node scripts/eval.js\n  format: json\n  keep_policy: pass_only\n---\nStay inside the mission boundary.\n',
        'utf-8',
      );
      await writeFile(join(repo, 'scripts', 'eval.js'), "process.stdout.write(JSON.stringify({ pass: true }));\n", 'utf-8');
      execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'add autoresearch noop mission'], { cwd: repo, stdio: 'ignore' });

      const fakeCodexPath = join(fakeBin, 'codex');
      await writeFile(
        fakeCodexPath,
        `#!/bin/sh
cat >/dev/null
candidate_file=$(find "$OMX_TEST_REPO_ROOT/.omx/logs/autoresearch" -name candidate.json | head -n 1)
head_commit=$(git rev-parse HEAD)
cat >"$candidate_file" <<EOF
{
  "status": "noop",
  "candidate_commit": null,
  "base_commit": "$head_commit",
  "description": "noop from fake codex exec",
  "notes": ["fake noop"],
  "created_at": "2026-03-15T00:00:00.000Z"
}
EOF
`,
        'utf-8',
      );
      execFileSync('chmod', ['+x', fakeCodexPath], { stdio: 'ignore' });

      const result = runOmx(
        repo,
        ['autoresearch', missionDir, '--dangerously-bypass-approvals-and-sandbox'],
        { PATH: `${fakeBin}:${process.env.PATH || ''}`, OMX_TEST_REPO_ROOT: repo },
      );

      assert.equal(result.status, 0, result.stderr || result.stdout);

      const state = JSON.parse(await readFile(join(repo, '.omx', 'state', 'autoresearch-state.json'), 'utf-8')) as {
        active: boolean;
      };
      assert.equal(state.active, false);

      const logsRoot = join(repo, '.omx', 'logs', 'autoresearch');
      const runId = findAutoresearchRunId(repo);

      const manifest = JSON.parse(await readFile(join(logsRoot, runId, 'manifest.json'), 'utf-8')) as {
        status: string;
        stop_reason: string | null;
        completed_at: string | null;
      };
      assert.equal(manifest.status, 'stopped');
      assert.equal(manifest.stop_reason, 'repeated noop limit reached (3)');
      assert.match(manifest.completed_at || '', /^\d{4}-\d{2}-\d{2}T/);

      const ledger = JSON.parse(await readFile(join(logsRoot, runId, 'iteration-ledger.json'), 'utf-8')) as {
        entries: Array<{ decision: string }>;
      };
      assert.deepEqual(ledger.entries.map((entry) => entry.decision), ['baseline', 'noop', 'noop', 'noop']);

      const resumeResult = runOmx(repo, ['autoresearch', '--resume', runId]);
      assert.notEqual(resumeResult.status, 0, resumeResult.stderr || resumeResult.stdout);
      assert.match(`${resumeResult.stderr}\n${resumeResult.stdout}`, /autoresearch_resume_terminal_run/i);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(fakeBin, { recursive: true, force: true });
    }
  });
});

describe('shouldSparkSidecarRefresh', () => {
  const baseSnapshot: AutoresearchSparkPrepassSnapshot = {
    enabled: true,
    status: 'available',
    note: 'test',
    updated_at: '2026-03-17T00:00:00.000Z',
    packet_characters: 100,
    sidecar_enabled: true,
    last_refresh_iteration: 0,
    refresh_count: 0,
    last_refresh_reason: 'initial',
  };

  it('returns false when snapshot is null', () => {
    assert.equal(shouldSparkSidecarRefresh(null, 2, 5), false);
  });

  it('returns false when sidecar is not enabled', () => {
    assert.equal(shouldSparkSidecarRefresh({ ...baseSnapshot, sidecar_enabled: false }, 2, 5), false);
  });

  it('returns false when trailing noops are below trigger threshold', () => {
    assert.equal(shouldSparkSidecarRefresh(baseSnapshot, 1, 5), false);
  });

  it('returns true when trailing noops meet trigger and cooldown is satisfied', () => {
    assert.equal(shouldSparkSidecarRefresh(baseSnapshot, 2, 5), true);
  });

  it('returns false when cooldown period has not elapsed', () => {
    assert.equal(shouldSparkSidecarRefresh({ ...baseSnapshot, last_refresh_iteration: 4 }, 2, 5), false);
  });

  it('returns true when cooldown period has elapsed', () => {
    assert.equal(shouldSparkSidecarRefresh({ ...baseSnapshot, last_refresh_iteration: 2 }, 2, 5), true);
  });
});

describe('buildSidecarRefreshSnapshot', () => {
  const baseSnapshot: AutoresearchSparkPrepassSnapshot = {
    enabled: true,
    status: 'available',
    note: 'test',
    updated_at: '2026-03-17T00:00:00.000Z',
    packet_characters: 100,
    sidecar_enabled: true,
    last_refresh_iteration: 0,
    refresh_count: 1,
    last_refresh_reason: 'initial',
  };

  it('increments refresh_count and records iteration and reason', () => {
    const result = buildSidecarRefreshSnapshot(baseSnapshot, 5, '2 consecutive noops');
    assert.deepEqual(result, {
      sidecar_enabled: true,
      last_refresh_iteration: 5,
      refresh_count: 2,
      last_refresh_reason: '2 consecutive noops',
    });
  });

  it('handles missing refresh_count gracefully', () => {
    const { refresh_count: _, ...withoutCount } = baseSnapshot;
    const result = buildSidecarRefreshSnapshot(withoutCount as AutoresearchSparkPrepassSnapshot, 3, 'test');
    assert.equal(result.refresh_count, 1);
  });
});


describe('runAutoresearchSparkPrepass sidecar state preservation', () => {
  const contract = {
    missionContent: `# Mission
Inspect files only.
`,
    sandboxContent: `---
---
Read-only sandbox.
`,
    sandbox: { body: 'Read-only sandbox.' },
  } as any;

  it('preserves sidecar metadata after a successful bootstrap prepass', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-sidecar-prepass-success-'));
    const statusFile = join(cwd, 'spark-prepass-status.json');
    const packetFile = join(cwd, 'spark-prepass-fact-packet.md');
    try {
      await initializeAutoresearchSparkPrepassSnapshot(
        true,
        statusFile,
        packetFile,
        () => '2026-03-17T00:00:00.000Z',
        true,
      );

      const result = await runAutoresearchSparkPrepass(
        contract,
        {
          cwd,
          iteration: 1,
          lastKeptCommit: 'abc123',
          statusFile,
          packetFile,
        },
        {
          now: () => '2026-03-17T00:01:00.000Z',
          executeExplore: async () => ({
            stdout: `## Likely relevant files
- src/cli/autoresearch.ts

## Key matches
- --spark-sidecar flag

## Evidence snippets
- supervisor loop counts noop streaks

## Next files to inspect
- src/autoresearch/runtime.ts
`,
            stderr: '',
            exitCode: 0,
            backend: 'sparkshell',
          }),
        },
      );

      assert.equal(result.snapshot?.status, 'available');
      assert.equal(result.snapshot?.sidecar_enabled, true);
      assert.equal(result.snapshot?.refresh_count, 0);
      assert.equal(result.snapshot?.last_refresh_iteration, 0);
      assert.equal(result.snapshot?.last_refresh_reason, 'initial');

      const persisted = await readAutoresearchSparkPrepassSnapshot(statusFile, packetFile);
      assert.equal(persisted.snapshot?.sidecar_enabled, true);
      assert.equal(persisted.snapshot?.refresh_count, 0);
      assert.equal(persisted.snapshot?.last_refresh_iteration, 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves sidecar metadata after a fallback prepass result', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-sidecar-prepass-fallback-'));
    const statusFile = join(cwd, 'spark-prepass-status.json');
    const packetFile = join(cwd, 'spark-prepass-fact-packet.md');
    try {
      await initializeAutoresearchSparkPrepassSnapshot(
        true,
        statusFile,
        packetFile,
        () => '2026-03-17T00:00:00.000Z',
        true,
      );

      const result = await runAutoresearchSparkPrepass(
        contract,
        {
          cwd,
          iteration: 1,
          lastKeptCommit: 'abc123',
          statusFile,
          packetFile,
        },
        {
          now: () => '2026-03-17T00:02:00.000Z',
          executeExplore: async () => ({
            stdout: '',
            stderr: 'explore backend failed',
            exitCode: 1,
            backend: 'harness',
          }),
        },
      );

      assert.equal(result.snapshot?.status, 'fallback');
      assert.equal(result.snapshot?.sidecar_enabled, true);
      assert.equal(result.snapshot?.refresh_count, 0);
      assert.equal(result.snapshot?.last_refresh_iteration, 0);
      assert.equal(result.snapshot?.last_refresh_reason, 'initial');

      const persisted = await readAutoresearchSparkPrepassSnapshot(statusFile, packetFile);
      assert.equal(persisted.snapshot?.status, 'fallback');
      assert.equal(persisted.snapshot?.sidecar_enabled, true);
      assert.equal(persisted.snapshot?.refresh_count, 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
