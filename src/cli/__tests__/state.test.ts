import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { stateCommand } from '../state.js';

describe('stateCommand', () => {
  it('prints help for empty args', async () => {
    const out: string[] = [];
    await stateCommand([], {
      stdout: (line) => out.push(line),
      stderr: () => undefined,
    });
    assert.match(out.join('\n'), /Usage: omx state/);
  });


  it('prints help for operation-level help forms without executing state operations', async () => {
    const operations = ['read', 'write', 'clear', 'list-active', 'get-status'];
    const helpForms = ['--help', '-h', 'help'];

    for (const operation of operations) {
      for (const helpForm of helpForms) {
        const out: string[] = [];
        let executed = false;
        await stateCommand([operation, helpForm], {
          stdout: (line) => out.push(line),
          stderr: () => undefined,
          execute: async () => {
            executed = true;
            return { payload: { error: 'should not execute' }, isError: true };
          },
        });

        assert.equal(executed, false, `${operation} ${helpForm} should not execute state operation`);
        assert.match(out.join('\n'), /Usage: omx state/);
        assert.doesNotMatch(out.join('\n'), /Unknown state argument/);
      }
    }
  });

  it('emits a frozen compact JSON envelope when --json is set', async () => {
    const out: string[] = [];
    await stateCommand(['read', '--input', '{"mode":"ralph"}', '--json'], {
      stdout: (line) => out.push(line),
      stderr: () => undefined,
      execute: async () => ({ payload: { exists: false, mode: 'ralph' } }),
    });
    assert.deepEqual(out, ['{"exists":false,"mode":"ralph"}']);
  });

  it('writes errors to stderr and sets exitCode', async () => {
    const err: string[] = [];
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = undefined;
      await stateCommand(['clear', '--input', '{"mode":"ralph"}', '--json'], {
        stdout: () => undefined,
        stderr: (line) => err.push(line),
        execute: async () => ({ payload: { error: 'boom' }, isError: true }),
      });
      assert.equal(process.exitCode, 1);
      assert.deepEqual(err, ['{"error":"boom"}']);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('rejects malformed --input JSON', async () => {
    await assert.rejects(
      stateCommand(['read', '--input', '{bad-json'], {
        stdout: () => undefined,
        stderr: () => undefined,
      }),
      /valid JSON/i,
    );
  });
});
