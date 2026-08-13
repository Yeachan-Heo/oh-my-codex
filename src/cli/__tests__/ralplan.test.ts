import assert from 'node:assert/strict';
import { describe, it, test } from 'node:test';

import { RALPLAN_HELP, ralplanCommand, type RalplanCommandDependencies } from '../ralplan.js';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function invoke(args: string[], deps: RalplanCommandDependencies = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const previous = process.exitCode;
  try {
    process.exitCode = undefined;
    await ralplanCommand(args, { ...deps, stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) });
    return { stdout, stderr, exitCode: process.exitCode };
  } finally {
    process.exitCode = previous;
  }
}

test('starts a session-scoped executable Ralplan runtime entry', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-cli-start-'));
  const sessionId = 'sess-ralplan-cli-start';
  try {
    await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
    await writeFile(join(cwd, '.omx', 'state', 'session.json'), JSON.stringify({ session_id: sessionId, cwd, state_root: join(cwd, '.omx', 'state') }));
    const result = await invoke(['start', '--task', 'plan issue 3515', '--session', sessionId, '--json'], { cwd: () => cwd });
    assert.equal(result.exitCode, undefined);
    assert.match(result.stdout[0], /"mode":"ralplan"/);
    assert.match(result.stdout[0], /Planner first.*Architect approval second.*Critic approval third/s);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('executes the injected consensus runtime from the production Ralplan command path', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-cli-runtime-'));
  const sessionId = 'sess-ralplan-cli-runtime';
  try {
    await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
    await mkdir(join(cwd, '.omx', 'plans'), { recursive: true });
    await writeFile(join(cwd, '.omx', 'state', 'session.json'), JSON.stringify({ session_id: sessionId, cwd, state_root: join(cwd, '.omx', 'state') }));
    await writeFile(join(cwd, '.omx', 'plans', 'plan.md'), '# Plan\n');
    const result = await invoke(['start', '--task', 'execute plan', '--session', sessionId, '--json'], {
      cwd: () => cwd,
      consensusExecutor: {
        async draft() { return { summary: 'draft', planPath: '.omx/plans/plan.md' }; },
        async architectReview() { return { verdict: 'approve', agent_role: 'architect' }; },
        async criticReview() { return { verdict: 'approve', agent_role: 'critic' }; },
      },
    });
    assert.equal(result.exitCode, undefined);
    assert.match(result.stdout[0], /"status":"completed"/);
    const state = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'sessions', sessionId, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
    assert.equal((state.ralplan_execution_handoff as Record<string, unknown>).source, 'user');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

describe('#3194 ralplan CLI authority diagnostics and runtime surface', () => {
  it('documents executable session runtime plus fail-closed adapted-authority diagnostics', () => {
    assert.match(RALPLAN_HELP, /consensus planning runtime/);
    assert.match(RALPLAN_HELP, /omx ralplan start --task/);
    assert.match(RALPLAN_HELP, /Planner -> Architect -> Critic/);
    assert.match(RALPLAN_HELP, /Required only when native role routing is unavailable and adapted Ralplan authority is requested/);
    assert.match(RALPLAN_HELP, /State-preserving diagnostic only/);
    assert.match(RALPLAN_HELP, /Ordinary work remains under its own workflow gates/);
    assert.match(RALPLAN_HELP, /Compatibility diagnostic only: installed roles are denied with unsupported_documented_leader_proof/);
    assert.doesNotMatch(RALPLAN_HELP, /validated role intents/i);
  });
  it('fails the explicit adapted-surface preflight with bounded diagnostics and no state mutation', async () => {
    let resolved = false;
    let probeCalls = 0;
    const result = await invoke(['preflight', '--json'], {
      resolveInstalledRoleName: () => { resolved = true; return 'architect'; },
      probeCodexVersionDetailed: () => {
        probeCalls += 1;
        return { status: 'ok', collected: { output: 'codex-cli 0.146.1\n', truncated: false, lineLimitExceeded: false } };
      },
    });
    assert.equal(result.exitCode, 1);
    assert.equal(resolved, false);
    assert.equal(probeCalls, 1);
    assert.deepEqual(result.stderr, []);
    assert.deepEqual(JSON.parse(result.stdout.join('\n')), {
      ok: false,
      reason: 'unsupported_documented_leader_proof',
      diagnostics: {
        probe_status: 'ok',
        detected_version: '0.146.1',
        documented_root_identity: { status: 'missing' },
      },
    });
  });

  it('validates malformed arguments before resolving a role', async () => {
    let resolved = false;
    await assert.rejects(() => invoke(['role-intent', 'write', '--role', 'architect', '--json'], {
      resolveInstalledRoleName: () => { resolved = true; return 'architect'; },
    }), /Missing --parent-thread/);
    assert.equal(resolved, false);
  });

  it('keeps unknown-role precedence without consulting an authority state source', async () => {
    const result = await invoke(['role-intent', 'write', '--role', 'synthetic-unknown', '--parent-thread', 'forged-parent', '--json'], {
      resolveInstalledRoleName: () => null,
    });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(JSON.parse(result.stdout.join('\n')), { ok: false, reason: 'unknown_role' });
  });

  it('denies an installed role without consulting forgeable authority state', async () => {
    const result = await invoke(['role-intent', 'write', '--role', 'architect', '--parent-thread', 'forged-parent', '--session', 'forged-session', '--ttl-ms', '1', '--json'], {
      resolveInstalledRoleName: (role) => role === 'architect' ? role : null,
    });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.stderr, []);
    assert.deepEqual(JSON.parse(result.stdout.join('\n')), { ok: false, reason: 'unsupported_documented_leader_proof' });
  });

  it('normalizes prefixed, bare, stable, and prerelease reviewed versions with first-token precedence', async () => {
    for (const [output, expected] of [
      ['codex-cli 0.145.0', '0.145.0'],
      ['codex 0.145.0', '0.145.0'],
      ['0.145.0', '0.145.0'],
      ['v0.146.1', '0.146.1'],
      ['codex-cli 0.148.0-alpha.5', '0.148.0-alpha.5'],
      ['v0.148.0-alpha.5', '0.148.0-alpha.5'],
      ['0.145.0\n0.144.5', '0.145.0'],
    ] as const) {
      const result = await invoke(['preflight', '--json'], {
        probeCodexVersionDetailed: () => ({ status: 'ok', collected: { output, truncated: false, lineLimitExceeded: false } }),
      });
      const body = JSON.parse(result.stdout.join('\n'));
      assert.equal(body.diagnostics.detected_version, expected);
      assert.equal(body.diagnostics.documented_root_identity.status, 'missing');
    }
  });

  it('keeps malformed, unreviewed, and over-limit diagnostics non-authorizing', async () => {
    const cases = [
      { probe: { status: 'ok', collected: { output: 'codex-cli malformed', truncated: false, lineLimitExceeded: false } }, detectedVersion: null },
      { probe: { status: 'ok', collected: { output: 'codex-cli 0.147.0', truncated: false, lineLimitExceeded: false } }, detectedVersion: '0.147.0' },
      { probe: { status: 'ok', collected: { output: 'codex-cli 0.148.0-alpha.4', truncated: false, lineLimitExceeded: false } }, detectedVersion: '0.148.0-alpha.4' },
      { probe: { status: 'ok', collected: { output: 'codex-cli 0.148.0', truncated: false, lineLimitExceeded: false } }, detectedVersion: '0.148.0' },
      { probe: { status: 'ok', collected: { output: `codex-cli 0.148.0-${'a'.repeat(65)}`, truncated: false, lineLimitExceeded: false } }, detectedVersion: null },
      { probe: { status: 'ok', collected: { output: 'codex-cli 0.146.1', truncated: true, lineLimitExceeded: false } }, detectedVersion: null },
      { probe: { status: 'ok', collected: { output: 'codex-cli 0.146.1', truncated: false, lineLimitExceeded: true } }, detectedVersion: null },
    ] as const;
    for (const { probe, detectedVersion } of cases) {
      const result = await invoke(['preflight', '--json'], {
        probeCodexVersionDetailed: () => probe,
      });
      const body = JSON.parse(result.stdout.join('\n'));
      assert.equal(body.diagnostics.documented_root_identity.status, 'unknown');
      assert.equal(body.diagnostics.detected_version, detectedVersion);
    }
  });

  it('maps injected null and throws to deterministic exit-failure without retrying', async () => {
    let nullCalls = 0;
    const nullResult = await invoke(['preflight', '--json'], {
      probeCodexVersionDetailed: () => { nullCalls += 1; return null; },
    });
    assert.equal(nullCalls, 1);
    assert.equal(JSON.parse(nullResult.stdout.join('\n')).diagnostics.probe_status, 'exit-failure');

    let throwCalls = 0;
    const throwResult = await invoke(['preflight'], {
      probeCodexVersionDetailed: () => { throwCalls += 1; throw new Error('probe failed'); },
    });
    assert.equal(throwCalls, 1);
    assert.deepEqual(throwResult.stderr, [
      'ralplan preflight failed: unsupported_documented_leader_proof',
      'detected codex null; probe_status: exit-failure; documented_root_identity: unknown',
    ]);
  });
});
