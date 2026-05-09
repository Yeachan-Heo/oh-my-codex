export type MarkdownFenceChar = '`' | '~';

export interface MarkdownFenceState {
  readonly char: MarkdownFenceChar;
  readonly length: number;
}

export interface MarkdownVisibilityState {
  readonly fence: MarkdownFenceState | null;
  readonly commentDepth: number;
}

export type MarkdownScanState = 'normal' | 'fenced' | 'indented-code' | 'comment';

interface MarkdownFenceMarker {
  readonly char: MarkdownFenceChar;
  readonly length: number;
  readonly suffix: string;
}

export interface MarkdownLineInspection {
  readonly scanState: MarkdownScanState;
  readonly visibleText: string;
  readonly nextState: MarkdownVisibilityState;
}

const MARKDOWN_FENCE_PATTERN =
  /^(?: {0,3})(?<marker>`{3,}|~{3,})(?<suffix>[^\r\n]*)$/;
const MARKDOWN_FENCE_CLOSE_SUFFIX_PATTERN = /^[ \t]*$/;
const MARKDOWN_COMMENT_LINE_PATTERN = /^(?: {0,3})<!--/;
const MARKDOWN_COMMENT_OPEN = '<!--';
const MARKDOWN_COMMENT_CLOSE = '-->';

export const INITIAL_MARKDOWN_VISIBILITY_STATE: MarkdownVisibilityState = {
  fence: null,
  commentDepth: 0,
};

function readMarkdownFenceMarker(line: string): MarkdownFenceMarker | null {
  const markerMatch = line.match(MARKDOWN_FENCE_PATTERN);
  const marker = markerMatch?.groups?.marker ?? null;
  if (!marker) {
    return null;
  }
  const char = marker[0];
  if (char !== '`' && char !== '~') {
    return null;
  }
  return {
    char,
    length: marker.length,
    suffix: markerMatch?.groups?.suffix ?? '',
  };
}

export function isIndentedMarkdownCodeLine(line: string): boolean {
  return /^(?: {4,}|\t)/.test(line);
}

function advanceMarkdownCommentDepth(
  activeDepth: number,
  line: string,
): number {
  if (activeDepth === 0 && !MARKDOWN_COMMENT_LINE_PATTERN.test(line)) {
    return 0;
  }

  let depth = activeDepth;
  let index = 0;

  while (index < line.length) {
    const nextOpen = line.indexOf(MARKDOWN_COMMENT_OPEN, index);
    const nextClose = line.indexOf(MARKDOWN_COMMENT_CLOSE, index);

    if (nextOpen === -1 && nextClose === -1) {
      break;
    }
    if (nextOpen !== -1 && (nextClose === -1 || nextOpen < nextClose)) {
      depth += 1;
      index = nextOpen + MARKDOWN_COMMENT_OPEN.length;
      continue;
    }
    if (depth > 0) {
      depth -= 1;
    }
    index = nextClose + MARKDOWN_COMMENT_CLOSE.length;
  }

  return depth;
}

function advanceMarkdownFenceState(
  activeFence: MarkdownFenceState | null,
  line: string,
): MarkdownFenceState | null {
  const marker = readMarkdownFenceMarker(line);
  if (!marker) {
    return activeFence;
  }
  if (activeFence) {
    if (
      marker.char === activeFence.char
      && marker.length >= activeFence.length
      && MARKDOWN_FENCE_CLOSE_SUFFIX_PATTERN.test(marker.suffix)
    ) {
      return null;
    }
    return activeFence;
  }
  return { char: marker.char, length: marker.length };
}

function isMarkdownCommentLine(
  state: MarkdownVisibilityState,
  line: string,
): boolean {
  return state.commentDepth > 0 || MARKDOWN_COMMENT_LINE_PATTERN.test(line);
}

export function inspectMarkdownLine(
  state: MarkdownVisibilityState,
  line: string,
): MarkdownLineInspection {
  if (state.fence) {
    return {
      scanState: 'fenced',
      visibleText: '',
      nextState: {
        fence: advanceMarkdownFenceState(state.fence, line),
        commentDepth: state.commentDepth,
      },
    };
  }

  if (isMarkdownCommentLine(state, line)) {
    return {
      scanState: 'comment',
      visibleText: '',
      nextState: {
        fence: null,
        commentDepth: advanceMarkdownCommentDepth(state.commentDepth, line),
      },
    };
  }

  if (isIndentedMarkdownCodeLine(line)) {
    return {
      scanState: 'indented-code',
      visibleText: '',
      nextState: state,
    };
  }

  const nextFence = advanceMarkdownFenceState(null, line);
  return {
    scanState: nextFence ? 'fenced' : 'normal',
    visibleText: nextFence ? '' : line,
    nextState: {
      fence: nextFence,
      commentDepth: 0,
    },
  };
}

export function collectMarkdownVisibleMatches(
  content: string,
  pattern: RegExp,
): RegExpMatchArray[] {
  const lines = content.split(/\r?\n/);
  const globalFlags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  let state = INITIAL_MARKDOWN_VISIBILITY_STATE;
  const matches: RegExpMatchArray[] = [];

  for (const line of lines) {
    const inspection = inspectMarkdownLine(state, line);
    if (inspection.scanState === 'normal') {
      matches.push(...inspection.visibleText.matchAll(new RegExp(pattern.source, globalFlags)));
    }
    state = inspection.nextState;
  }

  return matches;
}
