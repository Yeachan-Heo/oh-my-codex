import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sanitizeReplyInput, isReplyListenerProcess } from '../reply-listener.js';

describe('sanitizeReplyInput', () => {
  it('passes through normal text', () => {
    assert.equal(sanitizeReplyInput('hello world'), 'hello world');
  });

  it('strips control characters', () => {
    assert.equal(sanitizeReplyInput('hello\x00world'), 'helloworld');
    assert.equal(sanitizeReplyInput('test\x07bell'), 'testbell');
    assert.equal(sanitizeReplyInput('test\x1bescseq'), 'testescseq');
  });

  it('replaces newlines with spaces', () => {
    assert.equal(sanitizeReplyInput('line1\nline2'), 'line1 line2');
    assert.equal(sanitizeReplyInput('line1\r\nline2'), 'line1 line2');
  });

  it('escapes backslashes', () => {
    assert.equal(sanitizeReplyInput('path\\to\\file'), 'path\\\\to\\\\file');
  });

  it('escapes backticks', () => {
    assert.equal(sanitizeReplyInput('run `cmd`'), 'run \\`cmd\\`');
  });

  it('escapes $( command substitution', () => {
    assert.equal(sanitizeReplyInput('$(whoami)'), '\\$(whoami)');
  });

  it('escapes ${ variable expansion', () => {
    assert.equal(sanitizeReplyInput('${HOME}'), '\\${HOME}');
  });

  it('trims whitespace', () => {
    assert.equal(sanitizeReplyInput('  hello  '), 'hello');
  });

  it('handles empty string', () => {
    assert.equal(sanitizeReplyInput(''), '');
  });

  it('handles whitespace-only string', () => {
    assert.equal(sanitizeReplyInput('   '), '');
  });

  it('handles combined dangerous patterns', () => {
    const input = '$(rm -rf /) && `evil` ${PATH}\nmore';
    const result = sanitizeReplyInput(input);
    // Should not contain unescaped backticks or newlines
    assert.ok(!result.includes('\n'));
    // $( should be escaped to \$(
    assert.ok(result.includes('\\$('));
    // ${ should be escaped to \${
    assert.ok(result.includes('\\${'));
    // backticks should be escaped
    assert.ok(result.includes('\\`'));
  });

  it('preserves normal special characters', () => {
    assert.equal(sanitizeReplyInput('hello! @user #tag'), 'hello! @user #tag');
  });

  it('handles unicode text', () => {
    const result = sanitizeReplyInput('Hello world');
    assert.ok(result.length > 0);
  });
});

describe('isReplyListenerProcess', () => {
  it('returns false for the current process (test runner has no daemon marker)', () => {
    assert.equal(isReplyListenerProcess(process.pid), false);
  });

  it('returns true for a process whose command line contains the daemon marker', (_, done) => {
    // Spawn a long-lived node process whose -e script contains 'pollLoop',
    // matching what startReplyListener injects into the daemon script.
    const child = spawn(
      process.execPath,
      ['-e', 'const pollLoop = () => {}; setInterval(pollLoop, 60000);'],
      { stdio: 'ignore' },
    );
    child.once('spawn', () => {
      const pid = child.pid!;
      const result = isReplyListenerProcess(pid);
      child.kill();
      assert.equal(result, true);
      done();
    });
    child.once('error', (err) => {
      done(err);
    });
  });

  it('returns false for a process whose command line lacks the daemon marker', (_, done) => {
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 60000);'],
      { stdio: 'ignore' },
    );
    child.once('spawn', () => {
      const pid = child.pid!;
      const result = isReplyListenerProcess(pid);
      child.kill();
      assert.equal(result, false);
      done();
    });
    child.once('error', (err) => {
      done(err);
    });
  });

  it('returns false for a non-existent PID', () => {
    // PID 0 is never a valid user process
    assert.equal(isReplyListenerProcess(0), false);
  });
});

async function importReplyListenerFresh() {
  const moduleUrl = new URL('../reply-listener.js', import.meta.url);
  moduleUrl.searchParams.set('t', `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  return import(moduleUrl.href);
}

describe('isDaemonRunning stale PID handling', () => {
  it('treats non-daemon PID as stale and removes pid file', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'omx-reply-listener-'));
    const stateDir = join(homeDir, '.omx', 'state');
    const pidFilePath = join(stateDir, 'reply-listener.pid');
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000);'], { stdio: 'ignore' });

    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', () => resolve());
        child.once('error', reject);
      });

      await mkdir(stateDir, { recursive: true });
      await writeFile(pidFilePath, String(child.pid));
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;

      const replyListener = await importReplyListenerFresh();
      const running = replyListener.isDaemonRunning();

      assert.equal(running, false);
      assert.equal(existsSync(pidFilePath), false);
    } finally {
      child.kill();
      if (typeof originalHome === 'string') process.env.HOME = originalHome;
      else delete process.env.HOME;
      if (typeof originalUserProfile === 'string') process.env.USERPROFILE = originalUserProfile;
      else delete process.env.USERPROFILE;
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
