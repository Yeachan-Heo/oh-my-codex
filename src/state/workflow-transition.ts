import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { getAuthoritativeActiveStatePaths } from '../mcp/state-paths.js';

export type DownstreamAuthority = 'plan_then_execute' | 'execute_now';

export interface PlanningGateState {
  downstream_authority: DownstreamAuthority;
  bypass_planning_gate_until?: string;
  objective_id?: string;
}

export interface PreToolUseGateInput {
  tool_name: string;
  tool_input?: string;
}

export interface PreToolUseGateDecision {
  allowed: boolean;
  reason?: string;
  gate_fired?: boolean;
}

const IMPLEMENTATION_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

const DENIED_BASH_PATTERNS: RegExp[] = [
  /\bgit\s+push\b/,
  /\bgh\s+pr\s+create\b/,
  /\bgh\s+pr\s+merge\b/,
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeProtectedArtifactPath(path: string): string {
  return path.replace(/^\.\//, '');
}

function normalizeShellPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/\.\//g, '/')
    .replace(/\/+/g, '/');
}

function joinShellPath(cwd: string, path: string): string {
  if (!cwd || cwd === '.') return normalizeShellPath(path);
  if (path.startsWith('/')) return normalizeShellPath(path);
  return normalizeShellPath(`${cwd}/${path}`);
}

function sameShellPath(candidate: string, target: string): boolean {
  return normalizeShellPath(candidate) === normalizeShellPath(target);
}

function shellCommandBasename(commandName: string): string {
  const normalized = normalizeShellPath(commandName);
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function shellWords(statement: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | null = null;
  let escaped = false;

  for (const char of statement) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== 'single') {
      escaped = true;
      continue;
    }
    if (char === "'" && quote !== 'double') {
      quote = quote === 'single' ? null : 'single';
      continue;
    }
    if (char === '"' && quote !== 'single') {
      quote = quote === 'double' ? null : 'double';
      continue;
    }
    if (/\s/.test(char) && !quote) {
      if (current) {
        words.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (current) words.push(current);
  return words;
}

interface ShellStatementRecord {
  text: string;
  subshellDepth: number;
  closesSubshells: number;
}

function shellStatementRecords(command: string): ShellStatementRecord[] {
  const statements: ShellStatementRecord[] = [];
  let current = '';
  let quote: 'single' | 'double' | null = null;
  let escaped = false;
  let subshellDepth = 0;
  let statementSubshellDepth = 0;
  let closesSubshells = 0;

  const pushStatement = () => {
    const statement = current.trim();
    if (statement) {
      statements.push({
        text: statement,
        subshellDepth: statementSubshellDepth,
        closesSubshells,
      });
    }
    current = '';
    statementSubshellDepth = subshellDepth;
    closesSubshells = 0;
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    const next = command[index + 1];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== 'single') {
      current += char;
      escaped = true;
      continue;
    }
    if (char === "'" && quote !== 'double') {
      current += char;
      quote = quote === 'single' ? null : 'single';
      continue;
    }
    if (char === '"' && quote !== 'single') {
      current += char;
      quote = quote === 'double' ? null : 'double';
      continue;
    }

    if (!quote && char === '(' && !current.trim()) {
      subshellDepth += 1;
      statementSubshellDepth = subshellDepth;
      current += char;
      continue;
    }

    current += char;

    if (!quote && char === ')' && subshellDepth > 0) {
      subshellDepth -= 1;
      closesSubshells += 1;
      continue;
    }

    if (!quote && (char === '\n' || char === ';' || (char === '&' && next === '&') || (char === '|' && next === '|'))) {
      current = current.slice(0, -1);
      pushStatement();
      if ((char === '&' && next === '&') || (char === '|' && next === '|')) index += 1;
      continue;
    }
  }

  pushStatement();
  return statements;
}

function shellStatements(command: string): string[] {
  return shellStatementRecords(command).map((statement) => statement.text);
}

function isShellName(name: string): boolean {
  return /^(?:sh|bash|dash|zsh|ksh|fish)$/.test(name);
}

function isScriptInterpreterName(name: string): boolean {
  return /^(?:python[0-9.]?|python3(?:\.[0-9]+)?|node|nodejs|ruby|perl|php|lua|deno|bun|tsx|go|npx|npm|pnpm|yarn)$/.test(name);
}

function isProtectedArtifactPath(path: string): boolean {
  return /^(?:\.\/)?\.omx\/(?:context|specs|tmp)\/[^"'\s;|&<>]+$/.test(path);
}

function resolveCommandOperand(cwd: string, operand: string): string {
  return joinShellPath(cwd, operand.replace(/^\.\//, ''));
}

function isPythonRuntimeOptionWithSeparateValue(word: string): boolean {
  return word === '-W' || word === '-X' || word === '--check-hash-based-pycs';
}

function runtimeLoadOptionOperandMatches(word: string, args: string[], index: number, cwd: string, targetPath: string): boolean {
  if (word === '-r' || word === '--require' || word === '--import' || word === '--loader' || word === '--experimental-loader') {
    const operand = args[index + 1];
    return Boolean(operand && sameShellPath(resolveCommandOperand(cwd, operand), targetPath));
  }
  for (const prefix of ['--require=', '--import=', '--loader=', '--experimental-loader=']) {
    if (word.startsWith(prefix)) return sameShellPath(resolveCommandOperand(cwd, word.slice(prefix.length)), targetPath);
  }
  return false;
}

function stdinRedirectOperandMatches(args: string[], cwd: string, targetPath: string): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index]!;
    if (word === '<') {
      const operand = args[index + 1];
      if (operand && sameShellPath(resolveCommandOperand(cwd, operand), targetPath)) return true;
      index += 1;
      continue;
    }
    if (/^\d*<[^<&].+/.test(word)) {
      const operand = word.replace(/^\d*</, '');
      if (sameShellPath(resolveCommandOperand(cwd, operand), targetPath)) return true;
    }
  }
  return false;
}
function shellScriptOperand(args: string[], cwd: string, targetPath: string): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index]!;
    if (word === '--') {
      const operand = args[index + 1];
      return Boolean(operand && sameShellPath(resolveCommandOperand(cwd, operand), targetPath));
    }
    if (word === '-c' || word === '--command') {
      const inlineCommand = args[index + 1];
      return Boolean(inlineCommand && hasTokenizedExecutionOfPath(inlineCommand, targetPath, cwd));
    }
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(word)) {
      const inlineCommand = args[index + 1];
      return Boolean(inlineCommand && hasTokenizedExecutionOfPath(inlineCommand, targetPath, cwd));
    }
    if (word === '--init-file' || word === '--rcfile') {
      const operand = args[index + 1];
      if (operand && sameShellPath(resolveCommandOperand(cwd, operand), targetPath)) return true;
      index += 1;
      continue;
    }
    if (word.startsWith('--init-file=') || word.startsWith('--rcfile=')) {
      if (sameShellPath(resolveCommandOperand(cwd, word.slice(word.indexOf('=') + 1)), targetPath)) return true;
      continue;
    }
    if (word === '-o' || word === '+o' || word === '-O' || word === '+O') {
      index += 1;
      continue;
    }
    if (word.startsWith('-') || word.startsWith('+')) continue;
    return sameShellPath(resolveCommandOperand(cwd, word), targetPath);
  }
  return false;
}

function scriptInterpreterOperand(args: string[], cwd: string, targetPath: string, commandName: string): boolean {
  let sawGoRun = false;
  let sawPackageRunner = commandName === 'npx';
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index]!;
    if (!word || word === '--') continue;
    if (/^python/.test(commandName)) {
      if (word === '-c' || word === '-m') return false;
      if (isPythonRuntimeOptionWithSeparateValue(word)) {
        index += 1;
        continue;
      }
      if (word.startsWith('-W') || word.startsWith('-X')) continue;
      if (word.startsWith('-')) continue;
      return sameShellPath(resolveCommandOperand(cwd, word), targetPath);
    }
    if (commandName === 'node' || commandName === 'nodejs' || commandName === 'bun' || commandName === 'tsx') {
      if (word === '-e' || word === '--eval' || word === '-p' || word === '--print') return false;
      if (runtimeLoadOptionOperandMatches(word, args, index, cwd, targetPath)) return true;
      if (word === '-r' || word === '--require' || word === '--import' || word === '--loader' || word === '--experimental-loader' || word === '--tsconfig' || word === '-C') {
        index += 1;
        continue;
      }
      if (word.startsWith('--require=') || word.startsWith('--import=') || word.startsWith('--loader=') || word.startsWith('--experimental-loader=')) continue;
      if (word.startsWith('--eval=') || word.startsWith('--print=')) return false;
      if (commandName === 'tsx' && word === 'watch') continue;
      if (word.startsWith('-')) continue;
      return sameShellPath(resolveCommandOperand(cwd, word), targetPath);
    }
    if (commandName === 'deno') {
      if (word === 'eval' || word === 'repl') return false;
      if (word === 'run') continue;
      if (word.startsWith('-')) continue;
      return sameShellPath(resolveCommandOperand(cwd, word), targetPath);
    }
    if (commandName === 'go') {
      if (!sawGoRun) {
        if (word === 'run') {
          sawGoRun = true;
          continue;
        }
        return false;
      }
      if (word.startsWith('-')) continue;
      return sameShellPath(resolveCommandOperand(cwd, word), targetPath);
    }
    if (commandName === 'npm' || commandName === 'pnpm' || commandName === 'yarn' || commandName === 'npx') {
      if (!sawPackageRunner) {
        if (word === 'exec' || word === 'x' || word === 'dlx') {
          sawPackageRunner = true;
          continue;
        }
        return false;
      }
      if (word.startsWith('-')) continue;
      if (word === 'tsx' || word === 'node' || word === 'bun' || word === 'deno') continue;
      return sameShellPath(resolveCommandOperand(cwd, word), targetPath);
    }
    if (word === '-e' || word.startsWith('-e')) return false;
    if (word.startsWith('-')) continue;
    return sameShellPath(resolveCommandOperand(cwd, word), targetPath);
  }
  return false;
}

function shellExecutionMatches(words: string[], cwd: string, targetPath: string): boolean {
  if (words.length === 0) return false;
  const rawCommandName = words[0]!;
  const commandName = shellCommandBasename(rawCommandName);

  if (commandName === 'source' || commandName === '.') {
    const operand = words[1];
    return Boolean(operand && sameShellPath(resolveCommandOperand(cwd, operand), targetPath));
  }

  if (isShellName(commandName)) {
    return stdinRedirectOperandMatches(words.slice(1), cwd, targetPath)
      || shellScriptOperand(words.slice(1), cwd, targetPath);
  }

  if (isScriptInterpreterName(commandName)) {
    return stdinRedirectOperandMatches(words.slice(1), cwd, targetPath)
      || scriptInterpreterOperand(words.slice(1), cwd, targetPath, commandName);
  }

  if (rawCommandName.startsWith('./') || rawCommandName.includes('/')) {
    return sameShellPath(resolveCommandOperand(cwd, rawCommandName), targetPath);
  }

  return false;
}

function findDirectWrapperOperandIndex(words: string[], startIndex: number): number | null {
  for (let index = startIndex; index < words.length; index += 1) {
    const word = words[index]!;
    if (!word || word === '--' || /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(word)) continue;
    if (word.startsWith('-')) continue;
    return index;
  }
  return null;
}

function findTimeWrapperOperandIndex(words: string[], startIndex: number): number | null {
  for (let index = startIndex; index < words.length; index += 1) {
    const word = words[index]!;
    if (!word || word === '--' || /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(word)) continue;
    if (word === '-f' || word === '--format' || word === '-o' || word === '--output') {
      index += 1;
      continue;
    }
    if (word.startsWith('--format=') || word.startsWith('--output=')) continue;
    if (word.startsWith('-')) continue;
    return index;
  }
  return null;
}

function findTimeoutWrapperOperandIndex(words: string[], startIndex: number): number | null {
  let sawDuration = false;
  for (let index = startIndex; index < words.length; index += 1) {
    const word = words[index]!;
    if (!word || word === '--' || /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(word)) continue;
    if (word === '-k' || word === '--kill-after' || word === '-s' || word === '--signal') {
      index += 1;
      continue;
    }
    if (word.startsWith('--kill-after=') || word.startsWith('--signal=')) continue;
    if (word.startsWith('-')) continue;
    if (!sawDuration) {
      sawDuration = true;
      continue;
    }
    return index;
  }
  return null;
}

function unwrapExecutionCommand(words: string[], cwd: string): { words: string[]; cwd: string } {
  let currentWords = words;
  let currentCwd = cwd;
  for (let unwrapCount = 0; unwrapCount < 8; unwrapCount += 1) {
    const commandName = shellCommandBasename(currentWords[0] ?? '');
    if (commandName === 'env') {
      const unwrapped = unwrapEnvCommand(currentWords, currentCwd);
      if (unwrapped.words === currentWords) return unwrapped;
      currentWords = unwrapped.words;
      currentCwd = unwrapped.cwd;
      continue;
    }

    const operandIndex = commandName === 'command' || commandName === 'nohup' || commandName === 'setsid'
      ? findDirectWrapperOperandIndex(currentWords, 1)
      : commandName === 'time'
        ? findTimeWrapperOperandIndex(currentWords, 1)
        : commandName === 'timeout' || commandName === 'gtimeout'
          ? findTimeoutWrapperOperandIndex(currentWords, 1)
          : null;
    if (operandIndex === null) return { words: currentWords, cwd: currentCwd };
    currentWords = currentWords.slice(operandIndex);
  }

  return { words: currentWords, cwd: currentCwd };
}

function unwrapCdCommandWords(words: string[]): string[] {
  let currentWords = words;
  for (let unwrapCount = 0; unwrapCount < 4; unwrapCount += 1) {
    const commandName = shellCommandBasename(currentWords[0] ?? '');
    if (commandName === 'command') {
      const operandIndex = findDirectWrapperOperandIndex(currentWords, 1);
      if (operandIndex === null) return currentWords;
      currentWords = currentWords.slice(operandIndex);
      continue;
    }
    if (commandName === 'builtin') {
      currentWords = currentWords.slice(1);
      continue;
    }
    return currentWords;
  }
  return currentWords;
}

function cdOperand(words: string[]): string | null {
  if (words[0] !== 'cd') return null;
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]!;
    if (word === '--') continue;
    if (/^-[LP]+$/.test(word)) continue;
    return word;
  }
  return null;
}

function cdTransitionTarget(words: string[], cwd: string): string | null {
  const operand = cdOperand(unwrapCdCommandWords(words));
  return operand ? resolveCommandOperand(cwd, operand) : null;
}

function unwrapEnvCommand(words: string[], cwd: string): { words: string[]; cwd: string } {
  if (shellCommandBasename(words[0] ?? '') !== 'env') return { words, cwd };

  let index = 1;
  let envCwd = cwd;
  while (index < words.length) {
    const word = words[index]!;
    if (word === '--') {
      index += 1;
      break;
    }
    if (word === '-C' || word === '--chdir') {
      const next = words[index + 1];
      if (!next) return { words: [], cwd: envCwd };
      envCwd = resolveCommandOperand(envCwd, next);
      index += 2;
      continue;
    }
    if (word.startsWith('-C') && word.length > 2) {
      envCwd = resolveCommandOperand(envCwd, word.slice(2));
      index += 1;
      continue;
    }
    if (word.startsWith('--chdir=')) {
      envCwd = resolveCommandOperand(envCwd, word.slice('--chdir='.length));
      index += 1;
      continue;
    }
    if (word.startsWith('-')) {
      index += 1;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(word)) {
      index += 1;
      continue;
    }
    break;
  }

  return { words: words.slice(index), cwd: envCwd };
}

function groupedShellWords(statement: string): string[] {
  const words = shellWords(statement);
  while (words.length > 0) {
    const first = words[0]!;
    if (first === '{') {
      words.shift();
      continue;
    }
    const stripped = first.replace(/^\(+/, '');
    if (stripped !== first) {
      if (stripped) words[0] = stripped;
      else words.shift();
      continue;
    }
    break;
  }

  while (words.length > 0) {
    const lastIndex = words.length - 1;
    const last = words[lastIndex]!;
    if (last === '}') {
      words.pop();
      continue;
    }
    const stripped = last.replace(/[)}]+$/, '');
    if (stripped !== last) {
      if (stripped) words[lastIndex] = stripped;
      else words.pop();
      continue;
    }
    break;
  }

  return words;
}

function scopedCwd(cwds: Map<number, string>, depth: number, initialCwd: string): string {
  if (cwds.has(depth)) return cwds.get(depth)!;
  if (depth <= 0) return initialCwd;
  return scopedCwd(cwds, depth - 1, initialCwd);
}

function hasTokenizedExecutionOfPath(command: string, path: string, initialCwd = ''): boolean {
  const targetPath = normalizeShellPath(path);
  const cwds = new Map<number, string>([[0, initialCwd]]);
  for (const statement of shellStatementRecords(command)) {
    const cwd = scopedCwd(cwds, statement.subshellDepth, initialCwd);
    const words = groupedShellWords(statement.text);
    if (words.length > 0) {
      const cdTarget = cdTransitionTarget(words, cwd);
      if (cdTarget) {
        cwds.set(statement.subshellDepth, cdTarget);
      } else {
        const unwrapped = unwrapExecutionCommand(words, cwd);
        if (shellExecutionMatches(unwrapped.words, unwrapped.cwd, targetPath)) return true;
      }
    }

    if (statement.closesSubshells > 0) {
      for (let depth = statement.subshellDepth; depth > statement.subshellDepth - statement.closesSubshells; depth -= 1) {
        cwds.delete(depth);
      }
    }
  }
  return false;
}

function isPlanningTmpShellPath(path: string): boolean {
  const normalized = normalizeShellPath(path);
  return normalized === '.omx/tmp' || normalized.startsWith('.omx/tmp/');
}

function stdinRedirectsPlanningTmp(args: string[], cwd: string): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index]!;
    if (word === '<') {
      const operand = args[index + 1];
      if (operand && isPlanningTmpShellPath(resolveCommandOperand(cwd, operand))) return true;
      index += 1;
      continue;
    }
    if (/^\d*<[^<&].+/.test(word)) {
      const operand = word.replace(/^\d*</, '');
      if (isPlanningTmpShellPath(resolveCommandOperand(cwd, operand))) return true;
    }
  }
  return false;
}

function commandStdinRedirectsPlanningTmpIntoInterpreter(command: string, initialCwd = ''): boolean {
  const cwds = new Map<number, string>([[0, initialCwd]]);
  for (const statement of shellStatementRecords(command)) {
    const cwd = scopedCwd(cwds, statement.subshellDepth, initialCwd);
    const words = groupedShellWords(statement.text);
    if (words.length > 0) {
      const cdTarget = cdTransitionTarget(words, cwd);
      if (cdTarget) {
        cwds.set(statement.subshellDepth, cdTarget);
      } else {
        const unwrapped = unwrapExecutionCommand(words, cwd);
        const commandName = shellCommandBasename(unwrapped.words[0] ?? '');
        if ((isShellName(commandName) || isScriptInterpreterName(commandName))
          && stdinRedirectsPlanningTmp(unwrapped.words.slice(1), unwrapped.cwd)) return true;
      }
    }

    if (statement.closesSubshells > 0) {
      for (let depth = statement.subshellDepth; depth > statement.subshellDepth - statement.closesSubshells; depth -= 1) {
        cwds.delete(depth);
      }
    }
  }
  return false;
}

function collectProtectedArtifactWritePaths(command: string): Set<string> {
  const paths = new Set<string>();
  const protectedPath = String.raw`(["']?)((?:\.\/)?\.omx\/(?:context|specs|plans|tmp)\/[^"'\s;|&<>]+)\1`;
  const redirectPattern = new RegExp(String.raw`(?:^|[^<])>>?\s*${protectedPath}`, 'g');

  for (const match of command.matchAll(redirectPattern)) {
    const path = match[2]?.trim();
    if (path) paths.add(normalizeProtectedArtifactPath(path));
  }

  const pythonPathWritePattern = /\bpython3?\b[\s\S]{0,520}\bPath\s*\(\s*(["'])((?:\.\/)?\.omx\/(?:context|specs|plans|tmp)\/[^"']+)\1\s*\)\s*\.\s*(?:write_text|write_bytes)\s*\(/g;
  for (const match of command.matchAll(pythonPathWritePattern)) {
    const path = match[2]?.trim();
    if (path) paths.add(normalizeProtectedArtifactPath(path));
  }

  for (const statement of shellStatements(command)) {
    const words = shellWords(statement);
    const teeIndex = words.findIndex((word) => word === 'tee');
    if (teeIndex === -1) continue;
    for (let index = teeIndex + 1; index < words.length; index += 1) {
      const word = words[index]!;
      if (word === '--') continue;
      if (word.startsWith('-')) continue;
      if (isProtectedArtifactPath(word)) paths.add(normalizeProtectedArtifactPath(word));
    }
  }

  return paths;
}

function executesOrSourcesPath(command: string, path: string): boolean {
  const escapedPath = escapeRegExp(path);
  const optionalDotSlashPath = String.raw`(?:\.\/)?${escapedPath}`;
  const quotedPath = String.raw`["']${optionalDotSlashPath}["']|${optionalDotSlashPath}`;
  const shellExecPattern = new RegExp(
    String.raw`(?:^|[\s;&|()])(?:sh|bash|dash|zsh|ksh|fish)\s+(?:-[^\s]+\s+)*(${quotedPath})(?:$|[\s;&|)])`,
  );
  const sourcePattern = new RegExp(
    String.raw`(?:^|[\s;&|()])(?:source|\.)\s+(${quotedPath})(?:$|[\s;&|)])`,
  );
  const directExecPattern = new RegExp(
    String.raw`(?:^|[;&|()\n])\s*(?:\.\/)?${escapedPath}(?:$|[\s;&|)])`,
  );
  return shellExecPattern.test(command)
    || sourcePattern.test(command)
    || directExecPattern.test(command)
    || hasTokenizedExecutionOfPath(command, path);
}

function hasSameCommandProtectedArtifactExecution(command: string): boolean {
  for (const path of collectProtectedArtifactWritePaths(command)) {
    if (executesOrSourcesPath(command, path)) return true;
  }
  return false;
}

export const PLANNING_GATE_BYPASS_TTL_MS = 10 * 60 * 1000;

export const BYPASS_PLANNING_GATE_PHRASE = 'bypass planning gate';

export function isImplementationToolCall(input: PreToolUseGateInput): boolean {
  if (IMPLEMENTATION_TOOLS.has(input.tool_name)) return true;
  if (input.tool_name === 'Bash' && typeof input.tool_input === 'string') {
    return DENIED_BASH_PATTERNS.some((pattern) => pattern.test(input.tool_input!))
      || commandStdinRedirectsPlanningTmpIntoInterpreter(input.tool_input)
      || hasSameCommandProtectedArtifactExecution(input.tool_input);
  }
  return false;
}

export function isPlanningGateBypassActive(
  state: PlanningGateState,
  now: Date = new Date(),
): boolean {
  const raw = typeof state.bypass_planning_gate_until === 'string'
    ? state.bypass_planning_gate_until.trim()
    : '';
  if (!raw) return false;
  const bypassMs = Date.parse(raw);
  if (!Number.isFinite(bypassMs)) return false;
  return now.getTime() < bypassMs;
}

export function evaluatePreToolUseGate(
  toolInput: PreToolUseGateInput,
  gateState: PlanningGateState | null | undefined,
  planningComplete: boolean,
  now: Date = new Date(),
): PreToolUseGateDecision {
  if (!gateState || gateState.downstream_authority !== 'plan_then_execute') {
    return { allowed: true };
  }

  if (planningComplete) {
    return { allowed: true };
  }

  if (!isImplementationToolCall(toolInput)) {
    return { allowed: true };
  }

  if (isPlanningGateBypassActive(gateState, now)) {
    return { allowed: true, reason: 'bypass_planning_gate active' };
  }

  return {
    allowed: false,
    gate_fired: true,
    reason: `deep-interview downstream_authority is plan_then_execute but no ralplan consensus artifact exists; ${toolInput.tool_name} denied`,
  };
}

export function computeBypassExpiry(
  now: Date = new Date(),
  ttlMs: number = PLANNING_GATE_BYPASS_TTL_MS,
): string {
  return new Date(now.getTime() + ttlMs).toISOString();
}

export function containsBypassPlanningGatePhrase(text: string): boolean {
  return text.toLowerCase().includes(BYPASS_PLANNING_GATE_PHRASE);
}

export function buildPlanningGateLogEvent(
  decision: PreToolUseGateDecision,
  toolInput: PreToolUseGateInput,
  gateState: PlanningGateState | null | undefined,
): Record<string, unknown> {
  return {
    event: 'planning-gate-fired',
    tool_name: toolInput.tool_name,
    allowed: decision.allowed,
    reason: decision.reason,
    downstream_authority: gateState?.downstream_authority,
    bypass_active: gateState ? isPlanningGateBypassActive(gateState) : false,
    timestamp: new Date().toISOString(),
  };
}

export const TRACKED_WORKFLOW_MODES = [
  'autopilot',
  'autoresearch',
  'team',
  'ultragoal',
  'ralph',
  'ultrawork',
  'ultraqa',
  'ralplan',
  'deep-interview',
] as const;

export type TrackedWorkflowMode = (typeof TRACKED_WORKFLOW_MODES)[number];
export type WorkflowTransitionAction = 'activate' | 'start' | 'write';
export type WorkflowTransitionKind = 'allow' | 'overlap' | 'auto-complete' | 'deny';

const ALLOWED_OVERLAP_PAIRS = new Set([
  'ralph|team',
]);

const AUTO_COMPLETE_TRANSITIONS = new Set([
  'deep-interview->autopilot',
  'deep-interview->autoresearch',
  'deep-interview->ralph',
  'deep-interview->team',
  'deep-interview->ultragoal',
  'deep-interview->ultrawork',
  'ralplan->team',
  'ralplan->ultragoal',
  'ralplan->ralph',
  'ralplan->autopilot',
  'ralplan->autoresearch',
  'ultragoal->ultraqa',
]);

const EVIDENCE_GATED_AUTO_COMPLETE_TRANSITIONS = new Set([
  'deep-interview->ralplan',
]);

const PLANNING_LIKE_MODES = new Set<TrackedWorkflowMode>([
  'deep-interview',
  'ralplan',
]);

const EXECUTION_LIKE_MODES = new Set<TrackedWorkflowMode>([
  'autopilot',
  'autoresearch',
  'team',
  'ultragoal',
  'ralph',
  'ultrawork',
  'ultraqa',
]);

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeTrackedModes(modes: Iterable<string>): TrackedWorkflowMode[] {
  const deduped = new Set<TrackedWorkflowMode>();
  for (const mode of modes) {
    if (isTrackedWorkflowMode(mode)) {
      deduped.add(mode);
    }
  }
  return [...deduped];
}

function buildPairKey(a: string, b: string): string {
  return [a, b].sort((left, right) => left.localeCompare(right)).join('|');
}

function isAllowedOverlap(a: TrackedWorkflowMode, b: TrackedWorkflowMode): boolean {
  if (a === 'ultrawork' || b === 'ultrawork') return true;
  return ALLOWED_OVERLAP_PAIRS.has(buildPairKey(a, b));
}

function buildAutoCompleteKey(a: TrackedWorkflowMode, b: TrackedWorkflowMode): string {
  return `${a}->${b}`;
}

function isAutoCompleteTransition(a: TrackedWorkflowMode, b: TrackedWorkflowMode): boolean {
  return AUTO_COMPLETE_TRANSITIONS.has(buildAutoCompleteKey(a, b));
}

function isEvidenceGatedAutoCompleteTransition(a: TrackedWorkflowMode, b: TrackedWorkflowMode): boolean {
  return EVIDENCE_GATED_AUTO_COMPLETE_TRANSITIONS.has(buildAutoCompleteKey(a, b));
}

function isRollbackTransition(
  currentModes: readonly TrackedWorkflowMode[],
  requestedMode: TrackedWorkflowMode,
): boolean {
  return PLANNING_LIKE_MODES.has(requestedMode)
    && currentModes.some((mode) => EXECUTION_LIKE_MODES.has(mode));
}

export function buildWorkflowTransitionMessage(
  sourceMode: TrackedWorkflowMode,
  requestedMode: TrackedWorkflowMode,
): string {
  return `mode transiting: ${sourceMode} -> ${requestedMode}`;
}

function formatActiveModes(modes: readonly string[]): string {
  if (modes.length === 0) return 'no tracked workflows';
  if (modes.length === 1) return `${modes[0]} is already active`;
  if (modes.length === 2) return `${modes[0]} and ${modes[1]} are already active`;
  return `${modes.slice(0, -1).join(', ')}, and ${modes[modes.length - 1]} are already active`;
}

export interface WorkflowTransitionDecision {
  allowed: boolean;
  kind: WorkflowTransitionKind;
  currentModes: TrackedWorkflowMode[];
  requestedMode: TrackedWorkflowMode;
  resultingModes: TrackedWorkflowMode[];
  autoCompleteModes: TrackedWorkflowMode[];
  transitionMessage?: string;
  denialReason?: 'rollback';
}

export function isTrackedWorkflowMode(mode: string): mode is TrackedWorkflowMode {
  return (TRACKED_WORKFLOW_MODES as readonly string[]).includes(mode);
}

export function evaluateWorkflowTransition(
  currentActiveModes: Iterable<string>,
  requestedMode: TrackedWorkflowMode,
): WorkflowTransitionDecision {
  const currentModes = normalizeTrackedModes(currentActiveModes);

  if (currentModes.includes(requestedMode)) {
    return {
      allowed: true,
      kind: 'allow',
      currentModes,
      requestedMode,
      resultingModes: currentModes,
      autoCompleteModes: [],
    };
  }

  if (currentModes.length === 0) {
    return {
      allowed: true,
      kind: 'allow',
      currentModes,
      requestedMode,
      resultingModes: [requestedMode],
      autoCompleteModes: [],
    };
  }

  const autoCompleteModes = currentModes.filter((mode) => (
    isAutoCompleteTransition(mode, requestedMode)
    || isEvidenceGatedAutoCompleteTransition(mode, requestedMode)
  ));
  const survivableModes = currentModes.filter((mode) => !autoCompleteModes.includes(mode));

  if (autoCompleteModes.length > 0 && survivableModes.every((mode) => isAllowedOverlap(mode, requestedMode))) {
    return {
      allowed: true,
      kind: 'auto-complete',
      currentModes,
      requestedMode,
      resultingModes: normalizeTrackedModes([...survivableModes, requestedMode]),
      autoCompleteModes,
      transitionMessage: buildWorkflowTransitionMessage(autoCompleteModes[0], requestedMode),
    };
  }

  if (currentModes.every((mode) => isAllowedOverlap(mode, requestedMode))) {
    return {
      allowed: true,
      kind: 'overlap',
      currentModes,
      requestedMode,
      resultingModes: normalizeTrackedModes([...currentModes, requestedMode]),
      autoCompleteModes: [],
    };
  }

  return {
    allowed: false,
    kind: 'deny',
    currentModes,
    requestedMode,
    resultingModes: currentModes,
    autoCompleteModes: [],
    ...(isRollbackTransition(currentModes, requestedMode) ? { denialReason: 'rollback' as const } : {}),
  };
}

export function buildWorkflowTransitionError(
  currentActiveModes: Iterable<string>,
  requestedMode: TrackedWorkflowMode,
  action: WorkflowTransitionAction = 'activate',
): string {
  const decision = evaluateWorkflowTransition(currentActiveModes, requestedMode);
  const activeModesMessage = formatActiveModes(decision.currentModes);
  const overlap = [...decision.currentModes, requestedMode].join(' + ');
  if (decision.denialReason === 'rollback') {
    return [
      `Cannot ${action} ${requestedMode}: ${activeModesMessage}.`,
      'Execution-to-planning rollback auto-complete is not allowed.',
      'First clear current state first and retry if this action is intended.',
      `Clear incompatible workflow state yourself via \`omx state clear --input '{"mode":"<mode>"}' --json\`; if explicit MCP compatibility is enabled, \`omx_state.*\` tools are also acceptable.`,
    ].join(' ');
  }
  return [
    `Cannot ${action} ${requestedMode}: ${activeModesMessage}.`,
    `Unsupported workflow overlap: ${overlap}.`,
    'Current state is unchanged.',
    `Clear incompatible workflow state yourself via \`omx state clear --input '{"mode":"<mode>"}' --json\`; if explicit MCP compatibility is enabled, \`omx_state.*\` tools are also acceptable.`,
  ].join(' ');
}

export function assertWorkflowTransitionAllowed(
  currentActiveModes: Iterable<string>,
  requestedMode: TrackedWorkflowMode,
  action: WorkflowTransitionAction = 'activate',
): void {
  const decision = evaluateWorkflowTransition(currentActiveModes, requestedMode);
  if (decision.allowed) return;
  throw new Error(buildWorkflowTransitionError(currentActiveModes, requestedMode, action));
}

export async function readActiveWorkflowModes(
  cwd: string,
  sessionId?: string,
): Promise<TrackedWorkflowMode[]> {
  const activeModes: TrackedWorkflowMode[] = [];

  for (const mode of TRACKED_WORKFLOW_MODES) {
    const candidatePaths = await getAuthoritativeActiveStatePaths(mode, cwd, sessionId);
    for (const candidatePath of candidatePaths) {
      if (!existsSync(candidatePath)) continue;
      try {
        const parsed = JSON.parse(await readFile(candidatePath, 'utf-8')) as { active?: unknown };
        if (parsed.active === true) {
          activeModes.push(mode);
        }
        break;
      } catch {
        throw new Error(
          `Cannot read ${mode} workflow state at ${candidatePath}. Repair or clear that workflow state yourself via \`omx state clear --input '{"mode":"${mode}"}' --json\`; if explicit MCP compatibility is enabled, \`omx_state.*\` tools are also acceptable.`,
        );
      }
    }
  }

  return activeModes;
}

export function pickPrimaryWorkflowMode(
  currentPrimary: unknown,
  resultingModes: readonly string[],
  fallbackMode: string,
): string {
  const normalizedCurrent = safeString(currentPrimary).trim();
  if (normalizedCurrent && resultingModes.includes(normalizedCurrent)) {
    return normalizedCurrent;
  }
  return resultingModes[0] || fallbackMode;
}
