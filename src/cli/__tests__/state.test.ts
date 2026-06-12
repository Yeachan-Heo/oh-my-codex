import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  it('maps --mode to a {mode} input object', async () => {
    let captured: Record<string, unknown> | undefined;
    await stateCommand(['read', '--mode', 'deep-interview', '--json'], {
      stdout: () => undefined,
      stderr: () => undefined,
      execute: async (_operation, input) => {
        captured = input;
        return { payload: { exists: false, mode: 'deep-interview' } };
      },
    });
    assert.deepEqual(captured, { mode: 'deep-interview' });
  });

  it('accepts the --mode=<value> form', async () => {
    let captured: Record<string, unknown> | undefined;
    await stateCommand(['clear', '--mode=ralph', '--json'], {
      stdout: () => undefined,
      stderr: () => undefined,
      execute: async (_operation, input) => {
        captured = input;
        return { payload: { cleared: true } };
      },
    });
    assert.deepEqual(captured, { mode: 'ralph' });
  });

  it('lets --mode override the mode from --input', async () => {
    let captured: Record<string, unknown> | undefined;
    await stateCommand(['read', '--input', '{"mode":"ralph","session_id":"abc"}', '--mode', 'team', '--json'], {
      stdout: () => undefined,
      stderr: () => undefined,
      execute: async (_operation, input) => {
        captured = input;
        return { payload: { exists: false } };
      },
    });
    assert.deepEqual(captured, { mode: 'team', session_id: 'abc' });
  });

  it('reads structured input from --input-file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omx-state-input-file-'));
    const file = join(dir, 'payload.json');
    await writeFile(file, JSON.stringify({ mode: 'ralph', all_sessions: true }), 'utf-8');
    try {
      let captured: Record<string, unknown> | undefined;
      await stateCommand(['clear', '--input-file', file, '--json'], {
        stdout: () => undefined,
        stderr: () => undefined,
        execute: async (_operation, input) => {
          captured = input;
          return { payload: { cleared: true } };
        },
      });
      assert.deepEqual(captured, { mode: 'ralph', all_sessions: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects an unreadable --input-file path', async () => {
    await assert.rejects(
      stateCommand(['read', '--input-file', join(tmpdir(), 'omx-state-missing-does-not-exist.json')], {
        stdout: () => undefined,
        stderr: () => undefined,
      }),
      /--input-file could not be read/,
    );
  });

  it('rejects supplying both --input and --input-file', async () => {
    await assert.rejects(
      stateCommand(['read', '--input', '{"mode":"ralph"}', '--input-file', 'payload.json'], {
        stdout: () => undefined,
        stderr: () => undefined,
      }),
      /either --input or --input-file/,
    );
  });

  it('adds a Windows quote-stripping hint for quote-stripped --input JSON', async () => {
    await assert.rejects(
      stateCommand(['read', '--input', '{mode:deep-interview}'], {
        stdout: () => undefined,
        stderr: () => undefined,
      }),
      (error: unknown) => {
        const message = (error as Error).message;
        assert.match(message, /valid JSON/i);
        assert.match(message, /Windows native shells/);
        assert.match(message, /--mode/);
        assert.match(message, /--input-file/);
        return true;
      },
    );
  });

  it('does not add the Windows hint for ordinary malformed JSON', async () => {
    await assert.rejects(
      stateCommand(['read', '--input', '{"mode":"ralph"'], {
        stdout: () => undefined,
        stderr: () => undefined,
      }),
      (error: unknown) => {
        assert.doesNotMatch((error as Error).message, /Windows native shells/);
        return true;
      },
    );
  });
});
