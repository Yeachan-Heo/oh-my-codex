import type { ModelProvider, ModelRequest } from '../model/provider.js';

export interface FailingTest {
  file: string;
  name: string;
  output: string;
}

export interface LibraryApiDelta {
  libraryName: string;
  fromVersion: string;
  toVersion: string;
  summary: string;
}

export interface MechanicalFixInput {
  failingTest: FailingTest;
  libraryApiDelta: LibraryApiDelta;
  sourceSnippet: string;
}

export interface FixProposal {
  diff: string;
  explanation: string;
  raw: string;
}

export const MECHANICAL_FIXER_SYSTEM_PROMPT =
  'You are Bumpkin\'s mechanical breakage fixer. Given a failing test caused by a ' +
  'library upgrade, and the old/new API delta, produce the MINIMUM unified diff ' +
  'that makes the test pass. Change only the calling code, not the test. Respond ' +
  'with JSON: {"diff": "<unified diff>", "explanation": "<short rationale>"}.';

export function buildMechanicalFixerRequest(input: MechanicalFixInput): ModelRequest {
  const user =
    `Library: ${input.libraryApiDelta.libraryName} ${input.libraryApiDelta.fromVersion} -> ${input.libraryApiDelta.toVersion}\n` +
    `API delta:\n${input.libraryApiDelta.summary}\n\n` +
    `Failing test: ${input.failingTest.file} :: ${input.failingTest.name}\n` +
    `Test output:\n${input.failingTest.output}\n\n` +
    `Source under repair:\n${input.sourceSnippet}`;
  return {
    system: MECHANICAL_FIXER_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: user }],
  };
}

export class FixerResponseError extends Error {}

export function parseFixerResponse(raw: string): FixProposal {
  let parsed: { diff?: string; explanation?: string };
  try {
    parsed = JSON.parse(raw) as { diff?: string; explanation?: string };
  } catch (e) {
    throw new FixerResponseError(`fixer output was not JSON: ${(e as Error).message}`);
  }
  if (typeof parsed.diff !== 'string' || parsed.diff.length === 0) {
    throw new FixerResponseError('fixer output missing non-empty "diff"');
  }
  return {
    diff: parsed.diff,
    explanation: parsed.explanation ?? '',
    raw,
  };
}

export async function proposeMechanicalFix(
  provider: ModelProvider,
  input: MechanicalFixInput,
): Promise<FixProposal> {
  const response = await provider.call(buildMechanicalFixerRequest(input));
  return parseFixerResponse(response.content);
}
