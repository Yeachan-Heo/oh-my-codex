#!/usr/bin/env node

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const DEFAULT_CONFIG_PATH = 'docs/testing/rust-parity-suite.json';
const DEFAULT_TIMEOUT_MS = 20_000;

function printUsage() {
  console.error([
    'Usage: node scripts/compat/run-rust-parity.js [--config <path>] [--case <id>] [--list]',
    '',
    'Config format:',
    '  {',
    '    "baseline_command": ["./bin/omx"],',
    '    "candidate_command": ["${OMX_RUST_BIN:-./target/debug/omx}"],',
    '    "defaults": { "mode": "byte-exact", "timeout_ms": 20000 },',
    '    "cases": [{ "id": "help", "argv": ["--help"] }]',
    '  }',
  ].join('\n'));
}

function parseCli(argv) {
  const parsed = {
    configPath: DEFAULT_CONFIG_PATH,
    caseIds: [],
    listOnly: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--config') {
      parsed.configPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (token?.startsWith('--config=')) {
      parsed.configPath = token.slice('--config='.length);
      continue;
    }
    if (token === '--case') {
      parsed.caseIds.push(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token?.startsWith('--case=')) {
      parsed.caseIds.push(token.slice('--case='.length));
      continue;
    }
    if (token === '--list') {
      parsed.listOnly = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      printUsage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  if (!parsed.configPath) {
    throw new Error('Missing --config value.');
  }

  return parsed;
}

function expandEnvValue(value) {
  return value.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/gi, (_, name, fallback = '') => {
    const envValue = process.env[name];
    return envValue && envValue.length > 0 ? envValue : fallback;
  });
}

function expandStringArray(values, label) {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== 'string')) {
    throw new Error(`${label} must be a non-empty string array.`);
  }
  return values.map((value) => expandEnvValue(value));
}

function parseConfig(configPath) {
  const resolvedPath = resolve(configPath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Config not found: ${resolvedPath}`);
  }
  const parsed = JSON.parse(readFileSync(resolvedPath, 'utf8'));
  const defaults = parsed.defaults && typeof parsed.defaults === 'object' ? parsed.defaults : {};
  if (!Array.isArray(parsed.cases) || parsed.cases.length === 0) {
    throw new Error('Config must define at least one case.');
  }
  return {
    path: resolvedPath,
    baselineCommand: expandStringArray(parsed.baseline_command, 'baseline_command'),
    candidateCommand: expandStringArray(parsed.candidate_command, 'candidate_command'),
    defaults: {
      mode: typeof defaults.mode === 'string' ? defaults.mode : 'byte-exact',
      timeoutMs: Number.isInteger(defaults.timeout_ms) ? defaults.timeout_ms : DEFAULT_TIMEOUT_MS,
      cwd: typeof defaults.cwd === 'string' ? resolve(defaults.cwd) : process.cwd(),
      normalizers: Array.isArray(defaults.normalizers) ? defaults.normalizers : [],
    },
    cases: parsed.cases,
  };
}

function normalizeOutput(text, normalizers) {
  let next = text;
  for (const normalizer of normalizers) {
    switch (normalizer) {
      case 'trim-trailing-whitespace':
        next = next.replace(/[ \t]+$/gm, '');
        break;
      case 'normalize-temp-paths':
        next = next.replace(/\/(var\/folders|tmp|private\/tmp)\/[A-Za-z0-9._-]+/g, '/<TMP>');
        next = next.replace(/[A-Z]:\\[^\s"']+/g, '<WIN_PATH>');
        break;
      case 'normalize-session-ids':
        next = next.replace(/omx-[A-Za-z0-9._:-]+/g, 'omx-<SESSION>');
        break;
      case 'normalize-path-separators':
        next = next.replace(/\\/g, '/');
        break;
      default:
        throw new Error(`Unknown normalizer: ${normalizer}`);
    }
  }
  return next;
}

function runCommand(command, argv, options) {
  const [file, ...baseArgs] = command;
  return spawnSync(file, [...baseArgs, ...argv], {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: 'utf8',
    timeout: options.timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function summarizeResult(result, normalizers) {
  const status = typeof result.status === 'number' ? result.status : null;
  const signal = result.signal ?? null;
  return {
    status,
    signal,
    stdout: normalizeOutput(result.stdout ?? '', normalizers),
    stderr: normalizeOutput(result.stderr ?? '', normalizers),
    error: result.error ? result.error.message : null,
  };
}

function formatDiff(label, baseline, candidate) {
  if (baseline === candidate) return null;
  return `${label} mismatch\n--- baseline ---\n${baseline || '<empty>'}\n--- candidate ---\n${candidate || '<empty>'}`;
}

function compareCase(config, parityCase) {
  const caseId = parityCase.id;
  if (typeof caseId !== 'string' || caseId.length === 0) {
    throw new Error('Each case must include a non-empty string id.');
  }
  if (!Array.isArray(parityCase.argv) || parityCase.argv.some((value) => typeof value !== 'string')) {
    throw new Error(`Case ${caseId} must include argv as a string array.`);
  }

  const mode = parityCase.mode ?? config.defaults.mode;
  if (mode !== 'byte-exact') {
    throw new Error(`Case ${caseId} uses unsupported mode ${mode}. Supported modes: byte-exact.`);
  }

  const normalizers = parityCase.normalizers ?? config.defaults.normalizers;
  const timeoutMs = Number.isInteger(parityCase.timeout_ms) ? parityCase.timeout_ms : config.defaults.timeoutMs;
  const cwd = typeof parityCase.cwd === 'string' ? resolve(parityCase.cwd) : config.defaults.cwd;
  const env = parityCase.env && typeof parityCase.env === 'object' ? parityCase.env : {};

  const baseline = summarizeResult(runCommand(config.baselineCommand, parityCase.argv, { cwd, env, timeoutMs }), normalizers);
  const candidate = summarizeResult(runCommand(config.candidateCommand, parityCase.argv, { cwd, env, timeoutMs }), normalizers);

  const mismatches = [
    baseline.status !== candidate.status ? `status mismatch\n--- baseline ---\n${baseline.status}\n--- candidate ---\n${candidate.status}` : null,
    baseline.signal !== candidate.signal ? `signal mismatch\n--- baseline ---\n${baseline.signal}\n--- candidate ---\n${candidate.signal}` : null,
    formatDiff('stdout', baseline.stdout, candidate.stdout),
    formatDiff('stderr', baseline.stderr, candidate.stderr),
    formatDiff('spawn error', baseline.error ?? '', candidate.error ?? ''),
  ].filter(Boolean);

  return {
    id: caseId,
    argv: parityCase.argv,
    ok: mismatches.length === 0,
    mismatches,
    baseline,
    candidate,
  };
}

const cli = parseCli(process.argv.slice(2));
const config = parseConfig(cli.configPath);
const selectedCases = cli.caseIds.length === 0
  ? config.cases
  : config.cases.filter((parityCase) => cli.caseIds.includes(parityCase.id));

if (selectedCases.length === 0) {
  throw new Error(`No cases matched selection: ${cli.caseIds.join(', ')}`);
}

if (cli.listOnly) {
  for (const parityCase of selectedCases) {
    console.log(parityCase.id);
  }
  process.exit(0);
}

console.log(`# Rust parity run`);
console.log(`Config: ${config.path}`);
console.log(`Baseline: ${config.baselineCommand.join(' ')}`);
console.log(`Candidate: ${config.candidateCommand.join(' ')}`);

let hasFailure = false;
for (const parityCase of selectedCases) {
  const result = compareCase(config, parityCase);
  console.log(`\n[${result.ok ? 'PASS' : 'FAIL'}] ${result.id} :: ${result.argv.join(' ')}`);
  if (!result.ok) {
    hasFailure = true;
    for (const mismatch of result.mismatches) {
      console.log(`${mismatch}\n`);
    }
  }
}

if (hasFailure) {
  process.exitCode = 1;
}
