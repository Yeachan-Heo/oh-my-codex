import type { ModelProvider, ModelRequest } from '../model/provider.js';
import {
  type FixProposal,
  type MechanicalFixInput,
  parseFixerResponse,
} from './mechanical-fixer.js';

export interface ReasoningFixInput extends MechanicalFixInput {
  releaseNotes: string;
  previousAttempts?: readonly { diff: string; testOutput: string }[];
}

export const REASONING_FIXER_SYSTEM_PROMPT =
  'You are Bumpkin\'s reasoning breakage fixer, invoked after the mechanical ' +
  'fixer failed. You have additional context: the library release notes and ' +
  'previous failed attempts. Reason carefully about behavioral changes (async ' +
  'semantics, default values, lifecycle hooks) before producing a diff. Respond ' +
  'with JSON: {"diff": "<unified diff>", "explanation": "<reasoning>"}.';

export function buildReasoningFixerRequest(input: ReasoningFixInput): ModelRequest {
  const previousBlock = input.previousAttempts?.length
    ? `\n\nPrevious failed attempts (${input.previousAttempts.length}):\n` +
      input.previousAttempts
        .map((a, i) => `--- attempt ${i + 1} ---\nDiff:\n${a.diff}\nResulting test output:\n${a.testOutput}`)
        .join('\n\n')
    : '';
  const user =
    `Library: ${input.libraryApiDelta.libraryName} ${input.libraryApiDelta.fromVersion} -> ${input.libraryApiDelta.toVersion}\n` +
    `API delta:\n${input.libraryApiDelta.summary}\n\n` +
    `Release notes:\n${input.releaseNotes}\n\n` +
    `Failing test: ${input.failingTest.file} :: ${input.failingTest.name}\n` +
    `Test output:\n${input.failingTest.output}\n\n` +
    `Source under repair:\n${input.sourceSnippet}` +
    previousBlock;
  return {
    system: REASONING_FIXER_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: user }],
  };
}

export async function proposeReasoningFix(
  provider: ModelProvider,
  input: ReasoningFixInput,
): Promise<FixProposal> {
  const response = await provider.call(buildReasoningFixerRequest(input));
  return parseFixerResponse(response.content);
}
