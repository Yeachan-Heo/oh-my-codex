import { readFile } from 'node:fs/promises';
import { TextDecoder } from 'node:util';

import { executeStateOperation, type StateOperationName } from '../state/operations.js';
import {
  executeReviewOperation,
  type ReviewOperationName,
} from '../code-review/coordinator.js';

const STATE_HELP = `Usage: omx state <read|write|clear|list-active|get-status> [--input <json> | --input-file <path>] [--mode <mode>] [--json]
       omx state <review-start|review-get|review-record-lane|review-resume|review-finalize> --input - [--json]

Examples:
  omx state read --input '{"mode":"ralph"}' --json
  omx state read --mode ralph --json
  omx state write --input '{"mode":"ralph","active":true,"current_phase":"executing"}' --json
  omx state clear --mode ralph --json
  omx state clear --input-file ./payload.json --json
  omx state list-active --json
  omx state get-status --mode ralph --json
  printf '%s' '{"workingDirectory":".","review_id":"..."}' | omx state review-get --input - --json

Windows note: native shells may strip the quotes from --input JSON. Use --mode for simple mode recovery or --input-file to pass JSON from a file.`;

const WINDOWS_QUOTE_HINT =
  '\nHint: on Windows native shells the quotes around --input JSON can be stripped before omx sees them. ' +
  'Use --mode <mode> for simple recovery (e.g. `omx state read --mode ralph --json`) ' +
  'or --input-file <path> to read JSON from a file instead.';
const WINDOWS_REVIEW_STDIN_HINT =
  '\nHint: code-review recovery accepts JSON only from stdin. Pipe JSON to `omx state review-get --input - --json`.';

const STATE_OPERATION_MAP: Record<string, StateOperationName> = {
  read: 'state_read',
  write: 'state_write',
  clear: 'state_clear',
  'list-active': 'state_list_active',
  'get-status': 'state_get_status',
};

const REVIEW_OPERATION_MAP: Record<string, ReviewOperationName> = {
  'review-start': 'review_start',
  'review-get': 'review_get',
  'review-record-lane': 'review_record_lane',
  'review-resume': 'review_resume',
  'review-finalize': 'review_finalize',
};

const MAX_REVIEW_STDIN_BYTES = 1_048_576;

export interface StateCommandDependencies {
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  execute?: typeof executeStateOperation;
  executeReview?: typeof executeReviewOperation;
  readStdin?: () => Promise<Buffer>;
}

function isHelpArg(arg: string | undefined): boolean {
  return arg === '--help' || arg === '-h' || arg === 'help';
}

function looksLikeQuoteStrippedJson(raw: string): boolean {
  const trimmed = raw.trim();
  return trimmed.startsWith('{') && trimmed.endsWith('}') && !trimmed.includes('"');
}

function parseStateInputJson(
  raw: string,
  source: '--input' | '--input-file',
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    let message = `${source} must be valid JSON: ${(error as Error).message}`;
    if (source === '--input' && looksLikeQuoteStrippedJson(raw)) {
      message += WINDOWS_QUOTE_HINT;
    }
    throw new Error(message);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${source} must decode to a JSON object`);
  }
  return { ...(parsed as Record<string, unknown>) };
}

async function readBoundedStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_REVIEW_STDIN_BYTES) {
      throw new Error(`stdin JSON exceeds ${MAX_REVIEW_STDIN_BYTES} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseReviewStdin(buffer: Buffer): Record<string, unknown> {
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new Error('stdin must contain valid UTF-8 JSON');
  }
  if (raw.trim().length === 0) throw new Error('stdin must contain one JSON object');
  try {
    return parseStateInputJson(raw, '--input');
  } catch (error) {
    throw new Error(`${(error as Error).message}${WINDOWS_REVIEW_STDIN_HINT}`);
  }
}

export async function stateCommand(
  args: string[],
  deps: StateCommandDependencies = {},
): Promise<void> {
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  const stderr = deps.stderr ?? ((line: string) => console.error(line));
  const execute = deps.execute ?? executeStateOperation;
  const executeReview = deps.executeReview ?? executeReviewOperation;
  const readStdin = deps.readStdin ?? readBoundedStdin;

  const subcommand = args[0];
  if (!subcommand || isHelpArg(subcommand)) {
    stdout(STATE_HELP);
    return;
  }

  const operation = STATE_OPERATION_MAP[subcommand];
  const reviewOperation = REVIEW_OPERATION_MAP[subcommand];
  if (!operation && !reviewOperation) {
    throw new Error(`Unknown state subcommand: ${subcommand}\n${STATE_HELP}`);
  }

  if (isHelpArg(args[1])) {
    stdout(STATE_HELP);
    return;
  }

  let inputValue: string | undefined;
  let inputUsedEquals = false;
  let inputOptionCount = 0;
  let inputFileValue: string | undefined;
  let modeValue: string | undefined;
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--input') {
      const next = args[index + 1];
      if (!next) {
        throw new Error('Missing JSON value after --input');
      }
      inputValue = next;
      inputOptionCount += 1;
      index += 1;
      continue;
    }
    if (arg.startsWith('--input=')) {
      inputValue = arg.slice('--input='.length);
      inputUsedEquals = true;
      inputOptionCount += 1;
      continue;
    }
    if (arg === '--input-file') {
      const next = args[index + 1];
      if (!next) {
        throw new Error('Missing path value after --input-file');
      }
      inputFileValue = next;
      index += 1;
      continue;
    }
    if (arg.startsWith('--input-file=')) {
      inputFileValue = arg.slice('--input-file='.length);
      continue;
    }
    if (arg === '--mode') {
      const next = args[index + 1];
      if (!next) {
        throw new Error('Missing value after --mode');
      }
      modeValue = next;
      index += 1;
      continue;
    }
    if (arg.startsWith('--mode=')) {
      modeValue = arg.slice('--mode='.length);
      continue;
    }
    throw new Error(`Unknown state argument: ${arg}`);
  }

  if (inputValue !== undefined && inputFileValue !== undefined) {
    throw new Error('Provide either --input or --input-file, not both');
  }

  if (reviewOperation !== undefined) {
    if (modeValue !== undefined) {
      throw new Error('review-* subcommands do not accept --mode');
    }
    if (inputFileValue !== undefined) {
      throw new Error(`review-* subcommands do not accept --input-file${WINDOWS_REVIEW_STDIN_HINT}`);
    }
    if (inputOptionCount > 1) {
      throw new Error('review-* subcommands accept --input only once');
    }
    if (inputValue !== '-' || inputUsedEquals) {
      throw new Error(`review-* subcommands require the exact arguments --input -${WINDOWS_REVIEW_STDIN_HINT}`);
    }
    const result = await executeReview(reviewOperation, parseReviewStdin(await readStdin()), { source: 'CLI' });
    const body = JSON.stringify(result.payload, null, json ? 0 : 2);
    if (result.isError) {
      stderr(body);
      process.exitCode = 1;
      return;
    }
    stdout(body);
    return;
  }

  let input: Record<string, unknown> = {};
  if (inputValue !== undefined) {
    input = parseStateInputJson(inputValue, '--input');
  } else if (inputFileValue !== undefined) {
    let fileContents: string;
    try {
      fileContents = await readFile(inputFileValue, 'utf-8');
    } catch (error) {
      throw new Error(`--input-file could not be read: ${(error as Error).message}`);
    }
    input = parseStateInputJson(fileContents, '--input-file');
  }

  if (modeValue !== undefined) {
    if (modeValue.length === 0) {
      throw new Error('Missing value after --mode');
    }
    input = { ...input, mode: modeValue };
  }

  const result = await execute(operation!, input);
  const body = JSON.stringify(result.payload, null, json ? 0 : 2);

  if (result.isError) {
    stderr(body);
    process.exitCode = 1;
    return;
  }

  stdout(body);
}
