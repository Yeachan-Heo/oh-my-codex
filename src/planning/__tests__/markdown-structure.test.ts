import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collectMarkdownVisibleMatches } from '../markdown-structure.js';

type ModelFenceChar = '`' | '~';

interface ModelFenceState {
  readonly char: ModelFenceChar;
  readonly length: number;
}

interface ModelFenceMarker extends ModelFenceState {
  readonly suffix: string;
}

interface ModelVisibilityState {
  readonly fence: ModelFenceState | null;
  readonly commentDepth: number;
}

const MATCH_TOKEN_PATTERN = /match-[a-z]+/g;
const MULTILINE_MATCH_PATTERN = /match-alpha\s+match-beta/g;
const MODEL_COMMENT_LINE_PATTERN = /^(?: {0,3})<!--/;
const MODEL_COMMENT_OPEN = '<!--';
const MODEL_COMMENT_CLOSE = '-->';
const INITIAL_MODEL_VISIBILITY_STATE: ModelVisibilityState = {
  fence: null,
  commentDepth: 0,
};

function isModelIndentedCodeLine(line: string): boolean {
  return line.startsWith('    ') || line.startsWith('\t');
}

function readModelFenceMarker(line: string): ModelFenceMarker | null {
  let index = 0;
  while (index < line.length && line[index] === ' ' && index < 4) {
    index += 1;
  }
  if (index >= 4 || line[index] === '\t') {
    return null;
  }
  const char = line[index];
  if (char !== '`' && char !== '~') {
    return null;
  }
  let markerEnd = index;
  while (line[markerEnd] === char) {
    markerEnd += 1;
  }
  const length = markerEnd - index;
  if (length < 3) {
    return null;
  }
  return {
    char,
    length,
    suffix: line.slice(markerEnd),
  };
}

function advanceModelCommentDepth(activeDepth: number, line: string): number {
  if (activeDepth === 0 && !MODEL_COMMENT_LINE_PATTERN.test(line)) {
    return 0;
  }

  let depth = activeDepth;
  let index = 0;

  while (index < line.length) {
    const nextOpen = line.indexOf(MODEL_COMMENT_OPEN, index);
    const nextClose = line.indexOf(MODEL_COMMENT_CLOSE, index);

    if (nextOpen === -1 && nextClose === -1) {
      break;
    }
    if (nextOpen !== -1 && (nextClose === -1 || nextOpen < nextClose)) {
      depth += 1;
      index = nextOpen + MODEL_COMMENT_OPEN.length;
      continue;
    }
    if (depth > 0) {
      depth -= 1;
    }
    index = nextClose + MODEL_COMMENT_CLOSE.length;
  }

  return depth;
}

function advanceModelFenceState(
  activeFence: ModelFenceState | null,
  line: string,
): ModelFenceState | null {
  const fenceMarker = readModelFenceMarker(line);
  if (!fenceMarker) {
    return activeFence;
  }
  if (activeFence) {
    if (
      fenceMarker.char === activeFence.char
      && fenceMarker.length >= activeFence.length
      && /^[ \t]*$/.test(fenceMarker.suffix)
    ) {
      return null;
    }
    return activeFence;
  }
  return { char: fenceMarker.char, length: fenceMarker.length };
}

function collectMatchesFromMarkdownModel(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const matches: string[] = [];
  let state = INITIAL_MODEL_VISIBILITY_STATE;

  for (const line of lines) {
    if (state.fence) {
      state = {
        fence: advanceModelFenceState(state.fence, line),
        commentDepth: state.commentDepth,
      };
      continue;
    }
    if (state.commentDepth > 0 || MODEL_COMMENT_LINE_PATTERN.test(line)) {
      state = {
        fence: null,
        commentDepth: advanceModelCommentDepth(state.commentDepth, line),
      };
      continue;
    }
    if (isModelIndentedCodeLine(line)) {
      continue;
    }

    const fenceMarker = readModelFenceMarker(line);
    if (fenceMarker) {
      state = {
        fence: { char: fenceMarker.char, length: fenceMarker.length },
        commentDepth: 0,
      };
      continue;
    }

    matches.push(...Array.from(line.matchAll(MATCH_TOKEN_PATTERN), (match) => match[0]));
  }

  return matches;
}

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
      MATCH_TOKEN_PATTERN,
    );

    assert.deepEqual(matches.map((match) => match[0]), ['match-alpha', 'match-beta']);
  });

  it('preserves multiline matches across contiguous visible markdown while blocking hidden-gap counterfactuals', () => {
    const cases = [
      {
        name: 'visible-adjacent-lines',
        content: [
          'match-alpha',
          'match-beta',
        ].join('\n'),
        expected: ['match-alpha\nmatch-beta'],
      },
      {
        name: 'visible-blank-line',
        content: [
          'match-alpha',
          '',
          'match-beta',
        ].join('\n'),
        expected: ['match-alpha\n\nmatch-beta'],
      },
      {
        name: 'fenced-gap',
        content: [
          'match-alpha',
          '```md',
          'match-hidden',
          '```',
          'match-beta',
        ].join('\n'),
        expected: [],
      },
      {
        name: 'comment-gap',
        content: [
          'match-alpha',
          '<!--',
          'match-hidden',
          '-->',
          'match-beta',
        ].join('\n'),
        expected: [],
      },
      {
        name: 'indented-gap',
        content: [
          'match-alpha',
          '    match-hidden',
          'match-beta',
        ].join('\n'),
        expected: [],
      },
    ] as const;

    for (const { name, content, expected } of cases) {
      assert.deepEqual(
        collectMarkdownVisibleMatches(content, MULTILINE_MATCH_PATTERN).map((match) => match[0]),
        expected,
        name,
      );
    }
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
      MATCH_TOKEN_PATTERN,
    );

    assert.deepEqual(matches.map((match) => match[0]), ['match-visible']);
  });

  it('treats fences with up to three leading spaces as real fenced blocks', () => {
    const matches = collectMarkdownVisibleMatches(
      [
        '# PRD',
        '',
        '   ```sh',
        'match-hidden',
        '   ```',
        '',
        'match-visible',
      ].join('\n'),
      MATCH_TOKEN_PATTERN,
    );

    assert.deepEqual(matches.map((match) => match[0]), ['match-visible']);
  });

  it('treats block comments with up to three leading spaces as hidden blocks', () => {
    const matches = collectMarkdownVisibleMatches(
      [
        '# PRD',
        '',
        '   <!--',
        'match-hidden',
        '   -->',
        '',
        'match-visible',
      ].join('\n'),
      MATCH_TOKEN_PATTERN,
    );

    assert.deepEqual(matches.map((match) => match[0]), ['match-visible']);
  });

  it('keeps nested block comments opaque across arbitrary nesting depths', () => {
    for (let depth = 1; depth <= 6; depth += 1) {
      const matches = collectMarkdownVisibleMatches(
        [
          '# PRD',
          '',
          ...Array.from({ length: depth }, () => '<!--'),
          '```md',
          'match-hidden-a',
          '~~~',
          'match-hidden-b',
          ...Array.from({ length: depth }, () => '-->'),
          '',
          'match-visible',
        ].join('\n'),
        MATCH_TOKEN_PATTERN,
      );

      assert.deepEqual(
        matches.map((match) => match[0]),
        ['match-visible'],
        `depth: ${depth}`,
      );
    }
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
      MATCH_TOKEN_PATTERN,
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
      MATCH_TOKEN_PATTERN,
    );

    assert.deepEqual(matches.map((match) => match[0]), ['match-visible']);
  });

  it('does not let tab-indented fence lookalikes open a fenced block', () => {
    const matches = collectMarkdownVisibleMatches(
      [
        '# PRD',
        '',
        '\t```',
        'match-visible',
      ].join('\n'),
      MATCH_TOKEN_PATTERN,
    );

    assert.deepEqual(matches.map((match) => match[0]), ['match-visible']);
  });

  it('handles CRLF markdown without leaking hidden matches', () => {
    const matches = collectMarkdownVisibleMatches(
      [
        '# PRD',
        '',
        '```sh',
        'match-hidden',
        '```',
        '',
        'match-visible',
      ].join('\r\n'),
      MATCH_TOKEN_PATTERN,
    );

    assert.deepEqual(matches.map((match) => match[0]), ['match-visible']);
  });

  it('keeps three-space fences distinct from four-space indented fence lookalikes', () => {
    const fencedMatches = collectMarkdownVisibleMatches(
      [
        '# PRD',
        '',
        '   ```md',
        'match-hidden',
        '   ```',
        '',
        'match-visible',
      ].join('\n'),
      MATCH_TOKEN_PATTERN,
    );
    const indentedMatches = collectMarkdownVisibleMatches(
      [
        '# PRD',
        '',
        '    ```',
        'match-visible',
      ].join('\n'),
      MATCH_TOKEN_PATTERN,
    );

    assert.deepEqual(fencedMatches.map((match) => match[0]), ['match-visible']);
    assert.deepEqual(indentedMatches.map((match) => match[0]), ['match-visible']);
  });

  it('does not treat short fence markers as fenced blocks', () => {
    const matches = collectMarkdownVisibleMatches(
      [
        '# PRD',
        '',
        '``',
        'match-visible',
      ].join('\n'),
      MATCH_TOKEN_PATTERN,
    );

    assert.deepEqual(matches.map((match) => match[0]), ['match-visible']);
  });

  it('does not let four-space-indented fence markers close an active fenced block', () => {
    const matches = collectMarkdownVisibleMatches(
      [
        '# PRD',
        '',
        '```md',
        'match-hidden-a',
        '    ```',
        'match-hidden-b',
        '```',
        '',
        'match-visible',
      ].join('\n'),
      MATCH_TOKEN_PATTERN,
    );

    assert.deepEqual(matches.map((match) => match[0]), ['match-visible']);
  });

  it('does not let four-space-indented fence markers open a fenced block', () => {
    const matches = collectMarkdownVisibleMatches(
      [
        '# PRD',
        '',
        '    ```',
        'match-visible',
      ].join('\n'),
      MATCH_TOKEN_PATTERN,
    );

    assert.deepEqual(matches.map((match) => match[0]), ['match-visible']);
  });

  it('keeps exact closing fences distinct from trailing-text fence lookalikes', () => {
    const closedMatches = collectMarkdownVisibleMatches(
      [
        '# PRD',
        '',
        '```md',
        'match-hidden-a',
        '```',
        'match-visible',
      ].join('\n'),
      MATCH_TOKEN_PATTERN,
    );
    const stillOpenMatches = collectMarkdownVisibleMatches(
      [
        '# PRD',
        '',
        '```md',
        'match-hidden-a',
        '```still-open',
        'match-hidden-b',
        '```',
        '',
        'match-visible',
      ].join('\n'),
      MATCH_TOKEN_PATTERN,
    );

    assert.deepEqual(closedMatches.map((match) => match[0]), ['match-visible']);
    assert.deepEqual(stillOpenMatches.map((match) => match[0]), ['match-visible']);
  });

  it('allows closing fences with trailing spaces', () => {
    const matches = collectMarkdownVisibleMatches(
      [
        '# PRD',
        '',
        '```md',
        'match-hidden',
        '```   ',
        '',
        'match-visible',
      ].join('\n'),
      MATCH_TOKEN_PATTERN,
    );

    assert.deepEqual(matches.map((match) => match[0]), ['match-visible']);
  });

  it('does not treat trailing info text as a fenced-block close marker', () => {
    const matches = collectMarkdownVisibleMatches(
      [
        '# PRD',
        '',
        '```md',
        'match-hidden-a',
        '```still-open',
        'match-hidden-b',
        '```',
        '',
        'match-visible',
      ].join('\n'),
      MATCH_TOKEN_PATTERN,
    );

    assert.deepEqual(matches.map((match) => match[0]), ['match-visible']);
  });

  it('keeps matching close characters distinct from different-character fence lookalikes', () => {
    const closedMatches = collectMarkdownVisibleMatches(
      [
        '# PRD',
        '',
        '~~~md',
        'match-hidden-a',
        '~~~',
        '',
        'match-visible',
      ].join('\n'),
      MATCH_TOKEN_PATTERN,
    );
    const mismatchedMatches = collectMarkdownVisibleMatches(
      [
        '# PRD',
        '',
        '~~~md',
        'match-hidden-a',
        '```',
        'match-hidden-b',
        '~~~',
        '',
        'match-visible',
      ].join('\n'),
      MATCH_TOKEN_PATTERN,
    );

    assert.deepEqual(closedMatches.map((match) => match[0]), ['match-visible']);
    assert.deepEqual(mismatchedMatches.map((match) => match[0]), ['match-visible']);
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
      MATCH_TOKEN_PATTERN,
    );

    assert.deepEqual(matches.map((match) => match[0]), ['match-visible']);
  });

  it('matches a reference markdown-visibility model across generated line sequences', () => {
    const generatedLinePatterns = [
      { name: 'blank', line: '' },
      { name: 'visible-alpha', line: 'match-alpha' },
      { name: 'visible-beta', line: 'match-beta' },
      { name: 'indented-visible', line: '    match-alpha' },
      { name: 'tab-indented-fence-like', line: '\t```' },
      { name: 'short-backtick', line: '``' },
      { name: 'open-backtick', line: '```md' },
      { name: 'open-long-backtick', line: '````md' },
      { name: 'open-three-space-backtick', line: '   ```md' },
      { name: 'close-backtick', line: '```' },
      { name: 'close-backtick-spaces', line: '```   ' },
      { name: 'indented-fence-like', line: '    ```' },
      { name: 'close-like-with-text', line: '```still-open' },
      { name: 'open-tilde', line: '~~~md' },
      { name: 'close-tilde', line: '~~~' },
      { name: 'single-line-comment', line: '<!-- match-hidden -->' },
      { name: 'comment-open', line: '<!--' },
      { name: 'comment-open-with-match', line: '<!-- match-hidden' },
      { name: 'comment-open-with-nested-open', line: '<!-- nested <!--' },
      { name: 'comment-close', line: '-->' },
      { name: 'comment-close-with-match', line: '--> match-alpha' },
      { name: 'commented-fence-like', line: '<!-- ``` -->' },
    ] as const;

    let checkedSequenceCount = 0;

    for (const first of generatedLinePatterns) {
      for (const second of generatedLinePatterns) {
        for (const third of generatedLinePatterns) {
          for (const fourth of generatedLinePatterns) {
            const sequence = [first, second, third, fourth];
            const content = sequence.map((entry) => entry.line).join('\n');
            const expectedMatches = collectMatchesFromMarkdownModel(content);
            const actualMatches = collectMarkdownVisibleMatches(content, MATCH_TOKEN_PATTERN)
              .map((match) => match[0]);
            assert.deepEqual(
              actualMatches,
              expectedMatches,
              `sequence: ${sequence.map((entry) => entry.name).join(' -> ')}`,
            );
            checkedSequenceCount += 1;
          }
        }
      }
    }

    assert.equal(checkedSequenceCount, generatedLinePatterns.length ** 4);
  });
});
