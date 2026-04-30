import { evaluateQuestionPolicy } from '../question/policy.js';
import {
  createQuestionRecord,
  markQuestionTerminalError,
  markQuestionPrompting,
  waitForQuestionTerminalState,
} from '../question/state.js';
import { isQuestionRendererAlive, launchQuestionRenderer } from '../question/renderer.js';
import { normalizeQuestionInput } from '../question/types.js';
import { runQuestionUi } from '../question/ui.js';

const DEFAULT_QUESTION_WAIT_TIMEOUT_MS = 30 * 60 * 1000;

function parseQuestionWaitTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = String(env.OMX_QUESTION_WAIT_TIMEOUT_MS ?? '').trim();
  if (!raw) return DEFAULT_QUESTION_WAIT_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_QUESTION_WAIT_TIMEOUT_MS;
}

export const QUESTION_HELP = `omx question - OMX-owned blocking user question entrypoint

Usage:
  omx question --input '<json>' [--json]
  omx question --ui --state-path <absolute-or-relative-record-path>

Options:
  --help, -h           Show this help message
  --input <json>       JSON object with question/options schema; blocks until answered
  --input=<json>       Same as --input
  --json               Emit compact JSON on stdout for machine callers
  --ui                 Internal renderer mode; renders the OMX question UI for an existing state record
  --state-path <path>  Question record path used by --ui mode

Input schema:
  {
    "header": "Optional short heading",
    "question": "What should OMX do next?",
    "questions": [
      {"id":"next-step","question":"What should OMX do next?","options":[{"label":"Proceed","value":"proceed"}],"allow_other":false}
    ],
    "options": [
      {"label": "Proceed", "value": "proceed", "description": "Continue"},
      {"label": "Revise", "value": "revise"}
    ],
    "allow_other": true,
    "other_label": "Other",
    "type": "single-answerable",
    "multi_select": false,
    "source": "deep-interview",
    "session_id": "optional-session-id"
  }

Notes:
  - 'type' accepts 'single-answerable' or 'multi-answerable'; legacy 'multi_select' is still accepted.
  - options may be [] only when allow_other is true, for a free-text-only prompt.
  - machine callers should use --json and read stdout; the command does not return
    until the user submitted all answers. Success payloads include primary
    batch fields 'questions' and 'answers'; one-question calls may also include
    transitional 'prompt' and 'answer' projections.
`;

interface ParsedQuestionArgs {
  help: boolean;
  json: boolean;
  ui: boolean;
  input?: string;
  statePath?: string;
}

function parseQuestionArgs(args: string[]): ParsedQuestionArgs {
  const parsed: ParsedQuestionArgs = { help: false, json: false, ui: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h' || arg === 'help') {
      parsed.help = true;
      continue;
    }
    if (arg === '--json') {
      parsed.json = true;
      continue;
    }
    if (arg === '--ui') {
      parsed.ui = true;
      continue;
    }
    if (arg === '--input') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing JSON value after --input');
      parsed.input = next;
      index += 1;
      continue;
    }
    if (arg.startsWith('--input=')) {
      parsed.input = arg.slice('--input='.length);
      continue;
    }
    if (arg === '--state-path') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing path value after --state-path');
      parsed.statePath = next;
      index += 1;
      continue;
    }
    if (arg.startsWith('--state-path=')) {
      parsed.statePath = arg.slice('--state-path='.length);
      continue;
    }
    throw new Error(`Unknown question argument: ${arg}`);
  }
  return parsed;
}

function printJson(payload: unknown, compact: boolean): void {
  console.log(JSON.stringify(payload, null, compact ? 0 : 2));
}

function extractErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createJsonSafeInlineQuestionOutput(): { isTTY?: boolean; write(chunk: string): boolean } {
  return {
    get isTTY() {
      return process.stdout.isTTY;
    },
    write(chunk: string): boolean {
      return process.stderr.write(chunk);
    },
  };
}

export async function questionCommand(args: string[]): Promise<void> {
  const parsed = parseQuestionArgs(args);
  if (parsed.help || args.length === 0) {
    console.log(QUESTION_HELP);
    return;
  }

  if (parsed.ui) {
    if (!parsed.statePath) throw new Error('--ui requires --state-path');
    await runQuestionUi(parsed.statePath);
    return;
  }

  if (!parsed.input) throw new Error('omx question requires --input in normal mode');

  let rawInput: unknown;
  try {
    rawInput = JSON.parse(parsed.input);
  } catch (error) {
    throw new Error(`--input must be valid JSON: ${(error as Error).message}`);
  }

  const input = normalizeQuestionInput(rawInput);
  const cwd = process.cwd();
  const policy = await evaluateQuestionPolicy({ cwd, explicitSessionId: input.session_id });
  if (!policy.allowed) {
    printJson({
      ok: false,
      error: {
        code: policy.code,
        message: policy.message,
      },
    }, parsed.json);
    process.exitCode = 1;
    return;
  }

  const { record, recordPath } = await createQuestionRecord(cwd, input, policy.sessionId);

  let finalRecord;
  try {
    const renderer = launchQuestionRenderer({
      cwd,
      recordPath,
      sessionId: policy.sessionId,
    });
    await markQuestionPrompting(recordPath, renderer);
    if (renderer.renderer === 'inline-tty') {
      await runQuestionUi(
        recordPath,
        parsed.json ? { output: createJsonSafeInlineQuestionOutput() } : {},
      );
    }
    finalRecord = await waitForQuestionTerminalState(recordPath, {
      timeoutMs: parseQuestionWaitTimeoutMs(),
      rendererAlive: (currentRecord) => isQuestionRendererAlive(currentRecord.renderer),
      rendererDeathMessage: (currentRecord) => (
        `Question renderer ${currentRecord.renderer?.renderer ?? renderer.renderer} ${currentRecord.renderer?.target ?? renderer.target} exited before answering.`
      ),
    });
  } catch (error) {
    const message = extractErrorMessage(error);
    await markQuestionTerminalError(
      recordPath,
      'error',
      'question_runtime_failed',
      message,
    );
    printJson({
      ok: false,
      question_id: record.question_id,
      session_id: record.session_id,
      error: {
        code: 'question_runtime_failed',
        message,
      },
    }, parsed.json);
    process.exitCode = 1;
    return;
  }

  if (finalRecord.status !== 'answered' || !finalRecord.answer) {
    printJson({
      ok: false,
      question_id: finalRecord.question_id,
      error: finalRecord.error ?? {
        code: 'question_not_answered',
        message: `Question ended with status ${finalRecord.status}.`,
      },
    }, parsed.json);
    process.exitCode = 1;
    return;
  }

  printJson({
    ok: true,
    question_id: finalRecord.question_id,
    session_id: finalRecord.session_id,
    questions: finalRecord.questions,
    answers: finalRecord.answers ?? (finalRecord.answer ? [{
      question_id: finalRecord.questions?.[0]?.id ?? 'q-1',
      index: 0,
      answer: finalRecord.answer,
    }] : []),
    ...(finalRecord.answer ? {
      prompt: {
        header: finalRecord.header,
        question: finalRecord.question,
        options: finalRecord.options,
        allow_other: finalRecord.allow_other,
        other_label: finalRecord.other_label,
        type: finalRecord.type,
        multi_select: finalRecord.multi_select,
        source: finalRecord.source,
      },
      answer: finalRecord.answer,
    } : {}),
  }, parsed.json);
}
