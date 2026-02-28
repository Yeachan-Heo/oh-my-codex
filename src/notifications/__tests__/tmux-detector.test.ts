import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyzePaneContent, buildSendPaneArgvs, buildCapturePaneArgv } from '../tmux-detector.js';
import type { PaneAnalysis } from '../tmux-detector.js';

describe('analyzePaneContent', () => {
  it('returns zero confidence for empty content', () => {
    const result = analyzePaneContent('');
    assert.equal(result.hasCodex, false);
    assert.equal(result.hasRateLimitMessage, false);
    assert.equal(result.isBlocked, false);
    assert.equal(result.confidence, 0);
  });

  it('detects "codex" keyword', () => {
    const result = analyzePaneContent('Running Codex agent...');
    assert.equal(result.hasCodex, true);
    assert.ok(result.confidence >= 0.5);
  });

  it('detects "omx" keyword', () => {
    const result = analyzePaneContent('omx session started');
    assert.equal(result.hasCodex, true);
  });

  it('detects "oh-my-codex" keyword', () => {
    const result = analyzePaneContent('oh-my-codex v1.0');
    assert.equal(result.hasCodex, true);
  });

  it('detects "openai" keyword', () => {
    const result = analyzePaneContent('openai api call');
    assert.equal(result.hasCodex, true);
  });

  it('is case insensitive', () => {
    const result = analyzePaneContent('CODEX RUNNING');
    assert.equal(result.hasCodex, true);
  });

  it('detects rate limit messages', () => {
    const result = analyzePaneContent('Error: rate limit exceeded');
    assert.equal(result.hasRateLimitMessage, true);
  });

  it('detects rate-limit with hyphen', () => {
    const result = analyzePaneContent('rate-limit error');
    assert.equal(result.hasRateLimitMessage, true);
  });

  it('detects 429 status code', () => {
    const result = analyzePaneContent('HTTP 429 Too Many Requests');
    assert.equal(result.hasRateLimitMessage, true);
  });

  it('detects blocked/waiting state', () => {
    const result = analyzePaneContent('Waiting for user input...');
    assert.equal(result.isBlocked, true);
  });

  it('detects paused state', () => {
    const result = analyzePaneContent('Agent paused');
    assert.equal(result.isBlocked, true);
  });

  it('adds confidence for prompt characters', () => {
    const result = analyzePaneContent('$ some command\n> next line');
    assert.ok(result.confidence >= 0.2);
  });

  it('adds confidence for agent/task keywords', () => {
    const result = analyzePaneContent('agent running task 1');
    assert.ok(result.confidence >= 0.1);
  });

  it('gives high confidence for codex content with prompt chars', () => {
    const result = analyzePaneContent('Codex > Running agent task...');
    assert.equal(result.hasCodex, true);
    // codex=0.5, >=0.1, agent/task=0.1, non-empty=0.1 = 0.8
    assert.ok(result.confidence >= 0.7, `Expected confidence >= 0.7, got ${result.confidence}`);
  });

  it('caps confidence at 1.0', () => {
    const result = analyzePaneContent('Codex $ > agent task running omx');
    assert.ok(result.confidence <= 1.0);
  });

  it('gives some confidence for non-empty non-codex content', () => {
    const result = analyzePaneContent('some random text here');
    assert.equal(result.hasCodex, false);
    assert.ok(result.confidence > 0);
  });
});

// issue #107: C-m must be sent in an isolated, separate send-keys call —
// never bundled with text — to prevent submit injection.
describe('buildSendPaneArgvs', () => {
  it('sends text with -l (literal) flag so key names in text are not interpreted', () => {
    const argvs = buildSendPaneArgvs('%3', 'hello world', false);
    const textArgv = argvs[0];
    assert.ok(textArgv.includes('-l'), 'text argv must include -l flag');
    assert.ok(textArgv.includes('hello world'), 'text argv must include the text');
  });

  it('uses -- separator so text starting with - is not parsed as a flag', () => {
    const argvs = buildSendPaneArgvs('%3', '-flag-like', false);
    const textArgv = argvs[0];
    const sepIdx = textArgv.indexOf('--');
    assert.ok(sepIdx !== -1, '-- separator must be present');
    assert.equal(textArgv[sepIdx + 1], '-flag-like', 'text must come immediately after --');
  });

  it('sends C-m as an isolated separate argv — never bundled with text', () => {
    const argvs = buildSendPaneArgvs('%3', 'hello', true);
    assert.ok(argvs.length >= 2, 'must have at least text argv + one C-m argv');

    // The text argv must NOT contain C-m
    const textArgv = argvs[0];
    assert.ok(!textArgv.includes('C-m'), 'text argv must not contain C-m');

    // Submit argvs must NOT use -l (they are key names, not literal text)
    for (const submitArgv of argvs.slice(1)) {
      assert.ok(!submitArgv.includes('-l'), 'C-m argv must not use -l flag');
      assert.ok(submitArgv.includes('C-m'), 'C-m argv must include C-m');
    }
  });

  it('sends C-m twice when pressEnter is true', () => {
    const argvs = buildSendPaneArgvs('%3', 'hello', true);
    const submitArgvs = argvs.slice(1);
    assert.equal(submitArgvs.length, 2, 'must send C-m exactly twice');
    for (const argv of submitArgvs) {
      assert.equal(argv[argv.length - 1], 'C-m');
    }
  });

  it('omits C-m entirely when pressEnter is false', () => {
    const argvs = buildSendPaneArgvs('%3', 'hello', false);
    assert.equal(argvs.length, 1, 'must have only the text argv when pressEnter=false');
    assert.ok(!argvs[0].includes('C-m'), 'no C-m when pressEnter=false');
  });

  it('strips newlines from text to prevent literal submit injection via -l', () => {
    const argvs = buildSendPaneArgvs('%3', 'line1\nline2\r\nline3', false);
    const textArgv = argvs[0];
    const text = textArgv[textArgv.length - 1];
    assert.ok(!text.includes('\n'), 'newline must be stripped');
    assert.ok(!text.includes('\r'), 'carriage return must be stripped');
    assert.ok(text.includes('line1'), 'text content must be preserved');
  });

  it('targets the correct pane in every argv', () => {
    const argvs = buildSendPaneArgvs('%42', 'hello', true);
    for (const argv of argvs) {
      const tIdx = argv.indexOf('-t');
      assert.ok(tIdx !== -1, 'every argv must have -t flag');
      assert.equal(argv[tIdx + 1], '%42', 'pane target must be %42');
    }
  });

  it('matches the two-step pattern of buildSendKeysArgv from tmux-hook-engine', () => {
    // Regression guard: the structure must be [typeArgv, submitArgv, submitArgv]
    // consistent with the established pattern across the codebase.
    const argvs = buildSendPaneArgvs('%5', 'continue', true);
    assert.deepEqual(argvs, [
      ['send-keys', '-t', '%5', '-l', '--', 'continue'],
      ['send-keys', '-t', '%5', 'C-m'],
      ['send-keys', '-t', '%5', 'C-m'],
    ]);
  });
});

// issue #156: capturePaneContent must use execFileSync with an args array so
// that a malicious paneId cannot inject arbitrary shell commands.
describe('buildCapturePaneArgv', () => {
  it('returns an array with paneId as a standalone element (no shell interpolation)', () => {
    const argv = buildCapturePaneArgv('%3', 15);
    // paneId must appear as its own discrete element
    assert.ok(argv.includes('%3'), 'paneId must be present in the argv');
    // No other element should embed paneId (shell interpolation would produce e.g. '-t %3' as one string)
    assert.ok(
      !argv.some(el => el !== '%3' && el.includes('%3')),
      'paneId must not be embedded inside another element',
    );
  });

  it('places paneId immediately after the -t flag', () => {
    const argv = buildCapturePaneArgv('%7', 10);
    const tIdx = argv.indexOf('-t');
    assert.ok(tIdx !== -1, 'argv must contain -t flag');
    assert.equal(argv[tIdx + 1], '%7', 'paneId must be the element directly after -t');
  });

  it('a paneId containing shell metacharacters is passed as a literal argument', () => {
    const malicious = '%0; touch /tmp/injected';
    const argv = buildCapturePaneArgv(malicious, 15);
    const tIdx = argv.indexOf('-t');
    assert.ok(tIdx !== -1);
    // The exact malicious string must appear as a single element — no expansion
    assert.equal(argv[tIdx + 1], malicious);
    // It must not be split across multiple elements
    assert.ok(!argv.some(el => el !== malicious && el.includes(';')));
  });

  it('encodes the lines count as a single -S argument (not a separate shell flag)', () => {
    const argv = buildCapturePaneArgv('%1', 30);
    assert.ok(argv.includes('-30'), 'lines must appear as -<n> in the array');
    const sIdx = argv.indexOf('-S');
    assert.ok(sIdx !== -1, '-S flag must be present');
    assert.equal(argv[sIdx + 1], '-30', '-S and the lines value must be adjacent elements');
  });

  it('produces the canonical argv for a normal pane', () => {
    assert.deepEqual(buildCapturePaneArgv('%3', 15), [
      'capture-pane', '-t', '%3', '-p', '-S', '-15',
    ]);
  });
});
