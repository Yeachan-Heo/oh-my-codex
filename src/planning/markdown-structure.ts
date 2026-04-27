export interface MarkdownFenceState {
  char: string;
  length: number;
}

export type MarkdownScanState = 'normal' | 'fenced' | 'indented-code';

const MARKDOWN_FENCE_PATTERN = /^(?<marker>`{3,}|~{3,})/;

export function isIndentedMarkdownCodeLine(line: string): boolean {
  return /^(?: {4,}|\t)/.test(line);
}

export function getMarkdownScanState(
  activeFence: MarkdownFenceState | null,
  line: string,
): MarkdownScanState {
  if (activeFence) {
    return 'fenced';
  }
  const trimmed = line.trim();
  if (MARKDOWN_FENCE_PATTERN.test(trimmed)) {
    return 'fenced';
  }
  if (isIndentedMarkdownCodeLine(line)) {
    return 'indented-code';
  }
  return 'normal';
}

export function advanceMarkdownFenceState(
  activeFence: MarkdownFenceState | null,
  line: string,
): MarkdownFenceState | null {
  const trimmed = line.trim();
  const fenceMarker = trimmed.match(MARKDOWN_FENCE_PATTERN)?.groups?.marker ?? null;
  if (!fenceMarker) {
    return activeFence;
  }
  if (activeFence) {
    if (fenceMarker[0] === activeFence.char && fenceMarker.length >= activeFence.length) {
      return null;
    }
    return activeFence;
  }
  return { char: fenceMarker[0]!, length: fenceMarker.length };
}

export function collectMarkdownVisibleMatches(content: string, pattern: RegExp): RegExpMatchArray[] {
  const lines = content.split(/\r?\n/);
  const globalFlags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  let activeFence: MarkdownFenceState | null = null;
  const matches: RegExpMatchArray[] = [];

  for (const line of lines) {
    if (getMarkdownScanState(activeFence, line) === 'normal') {
      matches.push(...line.matchAll(new RegExp(pattern.source, globalFlags)));
    }
    activeFence = advanceMarkdownFenceState(activeFence, line);
  }

  return matches;
}
