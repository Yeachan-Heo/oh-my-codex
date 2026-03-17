import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { normalizeAutoresearchCodexArgs, parseAutoresearchArgs } from '../autoresearch.js';

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
      assert.match(result.stdout, /Usage:[\s\S]*omx autoresearch <mission-dir>/i);
      assert.match(result.stdout, /omx autoresearch init/i);
      assert.match(result.stdout, /--topic\/\.\.\./i);
      assert.match(result.stdout, /novice bridge/i);
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

  it('treats top-level topic/evaluator flags as seeded novice-bridge input', () => {
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

      const worktreePath = join(repo, '..', `${basename(repo)}.omx-worktrees`, 'autoresearch-missions-demo');
      assert.equal(existsSync(worktreePath), false, 'expected launch to abort before creating autoresearch worktree');
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
candidate_file=$(find /tmp -path '*/.omx/logs/autoresearch/*/candidate.json' | head -n 1)
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
      const [runId] = readdirSync(logsRoot, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
      assert.ok(runId);

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
