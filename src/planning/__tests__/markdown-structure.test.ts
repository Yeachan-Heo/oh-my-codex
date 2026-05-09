import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collectMarkdownVisibleMatches } from '../markdown-structure.js';

describe('collectMarkdownVisibleMatches', () => {
  it('collects matches from normal markdown lines', () => {
    const matches = collectMarkdownVisibleMatches(
      [
        '# PRD',
        '',
        'match-alpha',
        '',
        'match-beta',
      ].join('\n'),
      /match-[a-z]+/g,
    );

    assert.deepEqual(matches.map((match) => match[0]), ['match-alpha', 'match-beta']);
  });

  it('ignores matches inside backtick fenced code blocks with info strings', () => {
    const matches = collectMarkdownVisibleMatches(
      [
        '# PRD',
        '',
        '```sh',
        'match-hidden',
        '```',
        '',
        'match-visible',
      ].join('\n'),
      /match-[a-z]+/g,
    );

    assert.deepEqual(matches.map((match) => match[0]), ['match-visible']);
  });

  it('ignores matches inside tilde fenced code blocks', () => {
    const matches = collectMarkdownVisibleMatches(
      [
        '# PRD',
        '',
        '~~~md',
        'match-hidden',
        '~~~',
        '',
        'match-visible',
      ].join('\n'),
      /match-[a-z]+/g,
    );

    assert.deepEqual(matches.map((match) => match[0]), ['match-visible']);
  });

  it('ignores matches inside four-space indented code blocks', () => {
    const matches = collectMarkdownVisibleMatches(
      [
        '# PRD',
        '',
        '    match-hidden',
        '',
        'match-visible',
      ].join('\n'),
      /match-[a-z]+/g,
    );

    assert.deepEqual(matches.map((match) => match[0]), ['match-visible']);
  });

  it('ignores matches inside tab-indented code blocks', () => {
    const matches = collectMarkdownVisibleMatches(
      [
        '# PRD',
        '',
        '\tmatch-hidden',
        '',
        'match-visible',
      ].join('\n'),
      /match-[a-z]+/g,
    );

    assert.deepEqual(matches.map((match) => match[0]), ['match-visible']);
  });

  it('keeps a longer tilde fence active until an equal-or-longer matching close', () => {
    const matches = collectMarkdownVisibleMatches(
      [
        '# PRD',
        '',
        '~~~~md',
        'match-hidden-a',
        '```',
        'match-hidden-b',
        '~~~',
        'match-hidden-c',
        '~~~~',
        '',
        'match-visible',
      ].join('\n'),
      /match-[a-z-]+/g,
    );

    assert.deepEqual(matches.map((match) => match[0]), ['match-visible']);
  });
});
