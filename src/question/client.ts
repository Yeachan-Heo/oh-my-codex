import { spawn } from 'node:child_process';
import { resolveOmxCliEntryPath } from '../utils/paths.js';
import type { QuestionAnswer, QuestionAnswerEntry, QuestionInput, NormalizedQuestionItem } from './types.js';

export interface OmxQuestionSuccessPayload {
  ok: true;
  question_id: string;
  session_id?: string;
  questions: NormalizedQuestionItem[];
  answers: QuestionAnswerEntry[];
  prompt?: QuestionInput | NormalizedQuestionItem;
  question?: QuestionInput | NormalizedQuestionItem;
  answer?: QuestionAnswer;
}

export interface OmxQuestionErrorPayload {
  ok: false;
  question_id?: string;
  session_id?: string;
  error: {
    code: string;
    message: string;
  };
}

export type OmxQuestionPayload = OmxQuestionSuccessPayload | OmxQuestionErrorPayload;

export interface OmxQuestionClientOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  argv1?: string | null;
  runner?: OmxQuestionProcessRunner;
}

export interface OmxQuestionProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type OmxQuestionProcessRunner = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<OmxQuestionProcessResult>;

export class OmxQuestionError extends Error {
  readonly code: string;
  readonly payload?: OmxQuestionErrorPayload;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;

  constructor(
    code: string,
    message: string,
    options: {
      payload?: OmxQuestionErrorPayload;
      stdout?: string;
      stderr?: string;
      exitCode?: number | null;
    } = {},
  ) {
    super(`${code}: ${message}`);
    this.name = 'OmxQuestionError';
    this.code = code;
    this.payload = options.payload;
    this.stdout = options.stdout ?? '';
    this.stderr = options.stderr ?? '';
    this.exitCode = options.exitCode ?? null;
  }
}

export async function defaultOmxQuestionProcessRunner(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<OmxQuestionProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function parseQuestionStdout(stdout: string, stderr: string, exitCode: number | null): OmxQuestionPayload {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new OmxQuestionError('question_no_stdout', 'omx question did not emit a JSON response on stdout.', {
      stdout,
      stderr,
      exitCode,
    });
  }

  try {
    return JSON.parse(trimmed) as OmxQuestionPayload;
  } catch (error) {
    throw new OmxQuestionError(
      'question_invalid_stdout',
      `omx question emitted invalid JSON on stdout: ${(error as Error).message}`,
      { stdout, stderr, exitCode },
    );
  }
}

export async function runOmxQuestion(
  input: (Partial<QuestionInput> & { question: string }) | { questions: Array<Partial<QuestionInput> & { question: string }>; header?: string; source?: string; session_id?: string },
  options: OmxQuestionClientOptions = {},
): Promise<OmxQuestionSuccessPayload> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const omxBin = resolveOmxCliEntryPath({ argv1: options.argv1, cwd, env });
  if (!omxBin) {
    throw new OmxQuestionError('question_cli_not_found', 'Could not resolve the omx CLI entrypoint for blocking question execution.');
  }

  const runner = options.runner ?? defaultOmxQuestionProcessRunner;
  const result = await runner(
    process.execPath,
    [omxBin, 'question', '--json', '--input', JSON.stringify(input)],
    { cwd, env },
  );
  const payload = parseQuestionStdout(result.stdout, result.stderr, result.code);

  if (!payload.ok) {
    throw new OmxQuestionError(payload.error.code, payload.error.message, {
      payload,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.code,
    });
  }

  if (result.code !== 0) {
    throw new OmxQuestionError(
      'question_nonzero_exit',
      `omx question returned an answer but exited with code ${result.code}.`,
      { stdout: result.stdout, stderr: result.stderr, exitCode: result.code },
    );
  }

  return payload;
}
