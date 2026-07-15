import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  RELEASE_GATES,
  executeReleaseGate,
  releaseGateCommand,
  runReleaseGateCli,
  runReleaseGates,
  type ReleaseGateExecution,
} from '../run-release-gates.js';

const ALL_SCRIPTS = Object.fromEntries(
  RELEASE_GATES
    .filter((gate) => gate.program === 'npm')
    .map((gate) => [gate.args[1], 'test fixture']),
);

describe('release gate runner', () => {
  it('is exposed through the single cross-platform package command', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    assert.equal(packageJson.scripts?.['verify:release'], 'node dist/scripts/run-release-gates.js');
  });

  it('pins the canonical release gates in exact order', () => {
    assert.deepEqual(
      RELEASE_GATES.map((gate) => [gate.program, ...gate.args]),
      [
        ['npm', 'run', 'build'],
        ['npm', 'run', 'lint'],
        ['npm', 'run', 'check:no-unused'],
        ['npm', 'run', 'verify:native-agents'],
        ['npm', 'run', 'verify:plugin-bundle'],
        ['npm', 'run', 'test:node'],
        ['cargo', 'test', '--workspace'],
        ['npm', 'run', 'coverage:team-critical:compiled'],
        ['npm', 'run', 'coverage:workflow-critical:compiled'],
        ['npm', 'run', 'coverage:ts:full:checked:compiled'],
        ['npm', 'run', 'test:mutation:core:compiled'],
        ['npm', 'run', 'smoke:packed-install'],
      ],
    );
  });

  it('spawns npm and cargo with platform-correct executable names', () => {
    assert.equal(releaseGateCommand(RELEASE_GATES[0], 'linux'), 'npm');
    assert.equal(releaseGateCommand(RELEASE_GATES[0], 'darwin'), 'npm');
    assert.equal(releaseGateCommand(RELEASE_GATES[0], 'win32'), 'npm.cmd');
    assert.equal(releaseGateCommand(RELEASE_GATES[6], 'linux'), 'cargo');
    assert.equal(releaseGateCommand(RELEASE_GATES[6], 'win32'), 'cargo.exe');
  });

  it('executes a real child process through the production spawn boundary', () => {
    const result = executeReleaseGate({
      gate: RELEASE_GATES[0],
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      cwd: process.cwd(),
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
  });

  it('loads scripts from package.json when no script map is injected', () => {
    const executions: ReleaseGateExecution[] = [];
    runReleaseGates({
      execute: (execution) => {
        executions.push(execution);
        return { status: 0 };
      },
      log: () => undefined,
    });
    assert.equal(executions.length, RELEASE_GATES.length);
  });

  it('stops at the first failed gate and preserves its exit code', () => {
    const executions: ReleaseGateExecution[] = [];
    const execute = (execution: ReleaseGateExecution) => {
      executions.push(execution);
      return { status: execution.gate.args[1] === 'check:no-unused' ? 37 : 0 };
    };

    assert.throws(
      () => runReleaseGates({ execute, scripts: ALL_SCRIPTS, log: () => undefined }),
      (error: unknown) => {
        assert.equal(error instanceof Error, true);
        assert.match((error as Error).message, /RELEASE_GATE_FAILED: npm run check:no-unused \(exit 37\)/);
        return true;
      },
    );
    assert.deepEqual(
      executions.map(({ gate }) => gate.args[1]),
      ['build', 'lint', 'check:no-unused'],
    );
    assert.equal(
      runReleaseGateCli({ execute, scripts: ALL_SCRIPTS, log: () => undefined, reportError: () => undefined }),
      37,
    );
  });

  it('fails clearly when an npm gate script is missing without spawning it', () => {
    const executions: ReleaseGateExecution[] = [];
    const scripts = { ...ALL_SCRIPTS };
    delete scripts['verify:plugin-bundle'];

    assert.throws(
      () => runReleaseGates({
        scripts,
        execute: (execution) => {
          executions.push(execution);
          return { status: 0 };
        },
        log: () => undefined,
      }),
      /RELEASE_GATE_SCRIPT_MISSING: verify:plugin-bundle/,
    );
    assert.equal(executions.some(({ gate }) => gate.args[1] === 'verify:plugin-bundle'), false);
  });
});
