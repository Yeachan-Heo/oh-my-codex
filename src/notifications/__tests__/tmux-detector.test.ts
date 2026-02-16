import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyzePaneContent } from '../tmux-detector.js';
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
