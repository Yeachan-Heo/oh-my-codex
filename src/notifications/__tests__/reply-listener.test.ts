import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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

  it('strips bidi left-to-right mark (U+200E)', () => {
    assert.equal(sanitizeReplyInput('hello\u200Eworld'), 'helloworld');
  });

  it('strips bidi right-to-left mark (U+200F)', () => {
    assert.equal(sanitizeReplyInput('hello\u200Fworld'), 'helloworld');
  });

  it('strips bidi left-to-right embedding (U+202A)', () => {
    assert.equal(sanitizeReplyInput('hello\u202Aworld'), 'helloworld');
  });

  it('strips bidi right-to-left embedding (U+202B)', () => {
    assert.equal(sanitizeReplyInput('hello\u202Bworld'), 'helloworld');
  });

  it('strips bidi pop directional formatting (U+202C)', () => {
    assert.equal(sanitizeReplyInput('hello\u202Cworld'), 'helloworld');
  });

  it('strips bidi left-to-right override (U+202D)', () => {
    assert.equal(sanitizeReplyInput('hello\u202Dworld'), 'helloworld');
  });

  it('strips bidi right-to-left override (U+202E)', () => {
    assert.equal(sanitizeReplyInput('hello\u202Eworld'), 'helloworld');
  });

  it('strips bidi left-to-right isolate (U+2066)', () => {
    assert.equal(sanitizeReplyInput('hello\u2066world'), 'helloworld');
  });

  it('strips bidi right-to-left isolate (U+2067)', () => {
    assert.equal(sanitizeReplyInput('hello\u2067world'), 'helloworld');
  });

  it('strips bidi first strong isolate (U+2068)', () => {
    assert.equal(sanitizeReplyInput('hello\u2068world'), 'helloworld');
  });

  it('strips bidi pop directional isolate (U+2069)', () => {
    assert.equal(sanitizeReplyInput('hello\u2069world'), 'helloworld');
  });

  it('strips multiple bidi characters from a realistic trojan-source payload', () => {
    // Simulates a trojan-source attack using bidi overrides
    const malicious = '\u202E\u2066// Check if admin\u2069\u2066 /* \u2069\u202Eis_admin = true';
    const sanitized = sanitizeReplyInput(malicious);
    assert.ok(!sanitized.includes('\u202E'));
    assert.ok(!sanitized.includes('\u2066'));
    assert.ok(!sanitized.includes('\u2069'));
    assert.ok(sanitized.includes('is_admin'));
  });

  it('strips bidi after control char stripping, before newline replacement', () => {
    // Order: controls stripped first, then bidi, then newlines -> spaces
    const input = '\x01\u202Ehello\nworld';
    const result = sanitizeReplyInput(input);
    assert.ok(!result.includes('\x01'));
    assert.ok(!result.includes('\u202E'));
    assert.ok(!result.includes('\n'));
    assert.ok(result.includes('hello world'));
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
