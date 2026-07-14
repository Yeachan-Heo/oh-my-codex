import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ScopeSelector } from './contract.js';

export type ReviewOutputFormat = 'markdown' | 'json';

export type ParsedCodeReviewInvocation =
  | {
      operation: 'start';
      format: ReviewOutputFormat;
      selector: ScopeSelector;
    }
  | {
      operation: 'resume';
      format: ReviewOutputFormat;
      review_id: string;
    };

export interface ParseCodeReviewArgumentsOptions {
  workingDirectory: string;
  validateRef?: (ref: string) => boolean | Promise<boolean>;
}

export class InvalidReviewInvocationError extends Error {
  readonly code = 'INVALID_INVOCATION' as const;

  constructor(message: string) {
    super(message);
    this.name = 'InvalidReviewInvocationError';
  }
}

function invalid(message: string): never {
  throw new InvalidReviewInvocationError(message);
}

function requireFlagValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    invalid(`${flag} requires a value`);
  }
  if (value.length === 0 || value.length > 1_024 || /[\0\r\n]/u.test(value)) {
    invalid(`${flag} has an invalid value`);
  }
  return value;
}

function normalizeExplicitPath(workingDirectory: string, value: string): string {
  if (value.length === 0 || [...value].length > 1_024 || value.includes('\0') || /[\r\n]/u.test(value)) {
    invalid('review path is invalid');
  }
  const root = resolve(workingDirectory);
  const target = isAbsolute(value) ? resolve(value) : resolve(root, value);
  const relativePath = relative(root, target);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    invalid('review path is outside the repository root');
  }
  return (relativePath || '.').split(sep).join('/');
}

function validateReviewId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    invalid('--resume requires a cryptographic UUID review id');
  }
  return value.toLowerCase();
}

export async function parseCodeReviewArguments(
  rawArgs: readonly string[],
  options: ParseCodeReviewArgumentsOptions,
): Promise<ParsedCodeReviewInvocation> {
  if (rawArgs[0] === 'code-review') invalid('code-review must be invoked as $code-review');
  const args = rawArgs[0] === '$code-review' ? rawArgs.slice(1) : [...rawArgs];
  let format: ReviewOutputFormat = 'markdown';
  let base: string | undefined;
  let reviewId: string | undefined;
  let sawFormat = false;
  let sawBase = false;
  let sawResume = false;
  const paths: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--format') {
      if (sawFormat) invalid('--format may be provided only once');
      sawFormat = true;
      const value = requireFlagValue(args, index, arg);
      if (value !== 'markdown' && value !== 'json') invalid('--format must be markdown or json');
      format = value;
      index += 1;
      continue;
    }
    if (arg === '--base') {
      if (sawBase) invalid('--base may be provided only once');
      sawBase = true;
      base = requireFlagValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--resume') {
      if (sawResume) invalid('--resume may be provided only once');
      sawResume = true;
      reviewId = validateReviewId(requireFlagValue(args, index, arg));
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) invalid(`unknown code-review flag: ${arg}`);
    paths.push(normalizeExplicitPath(options.workingDirectory, arg));
  }

  if (sawResume) {
    if (sawBase || paths.length > 0) invalid('--resume may be combined only with --format');
    return { operation: 'resume', review_id: reviewId!, format };
  }

  if (base !== undefined) {
    let isValidRef = false;
    try {
      isValidRef = Boolean(options.validateRef && await options.validateRef(base));
    } catch {
      invalid(`could not validate base ref: ${base}`);
    }
    if (!isValidRef) {
      invalid(`invalid base ref: ${base}`);
    }
  }

  return {
    operation: 'start',
    format,
    selector: {
      ...(base === undefined ? {} : { requested_base: base }),
      explicit_paths: paths,
    },
  };
}

export const parseCodeReviewInvocation = parseCodeReviewArguments;
