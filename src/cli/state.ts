import { executeStateOperation, type StateOperationName } from '../state/operations.js';

const STATE_HELP = `Usage: omx state <read|write|clear|list-active|get-status> [--input <json>] [--json]\n\nExamples:\n  omx state read --input '{"mode":"ralph"}' --json\n  omx state write --input '{"mode":"ralph","active":true,"current_phase":"executing"}' --json\n  omx state clear --input '{"mode":"ralph","all_sessions":true}' --json\n  omx state list-active --json\n  omx state get-status --input '{"mode":"ralph"}' --json`;

const STATE_OPERATION_MAP: Record<string, StateOperationName> = {
  read: 'state_read',
  write: 'state_write',
  clear: 'state_clear',
  'list-active': 'state_list_active',
  'get-status': 'state_get_status',
};

export interface StateCommandDependencies {
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  execute?: typeof executeStateOperation;
}

function isHelpArg(arg: string | undefined): boolean {
  return arg === '--help' || arg === '-h' || arg === 'help';
}

function parseStateInput(input: string | undefined): Record<string, unknown> {
  if (!input) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    throw new Error(`--input must be valid JSON: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--input must decode to a JSON object');
  }
  return { ...(parsed as Record<string, unknown>) };
}

export async function stateCommand(
  args: string[],
  deps: StateCommandDependencies = {},
): Promise<void> {
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  const stderr = deps.stderr ?? ((line: string) => console.error(line));
  const execute = deps.execute ?? executeStateOperation;

  const subcommand = args[0];
  if (!subcommand || isHelpArg(subcommand)) {
    stdout(STATE_HELP);
    return;
  }

  const operation = STATE_OPERATION_MAP[subcommand];
  if (!operation) {
    throw new Error(`Unknown state subcommand: ${subcommand}\n${STATE_HELP}`);
  }

  if (isHelpArg(args[1])) {
    stdout(STATE_HELP);
    return;
  }

  let inputValue: string | undefined;
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
      index += 1;
      continue;
    }
    if (arg.startsWith('--input=')) {
      inputValue = arg.slice('--input='.length);
      continue;
    }
    throw new Error(`Unknown state argument: ${arg}`);
  }

  const input = parseStateInput(inputValue);
  const result = await execute(operation, input);
  const body = JSON.stringify(result.payload, null, json ? 0 : 2);

  if (result.isError) {
    stderr(body);
    process.exitCode = 1;
    return;
  }

  stdout(body);
}
