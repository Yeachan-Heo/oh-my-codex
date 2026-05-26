#!/usr/bin/env node
import { existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, isAbsolute, join, resolve } from 'path';
import process from 'process';
import { spawnSync } from 'child_process';
import { CLAUDE_SKIP_PERMISSIONS_FLAG } from '../cli/constants.js';

const PROVIDER_BINARIES: Record<string, string> = {
  claude: 'claude',
  gemini: 'gemini',
  antigravity: 'acpx',
};
const ASK_ORIGINAL_TASK_ENV = 'OMX_ASK_ORIGINAL_TASK';
const ISSUE_WORK_PROMPT_PATTERNS = [
  /\bgh\s+issue\b/i,
  /\b(?:fix|work on|work|investigate|implement|triage|debug|review|handle)\s+issue\s*#?\d+\b/i,
  /\bissue\s*#\d+\b/i,
];

function usage(): void {
  console.error('Usage: omx ask <claude|gemini|antigravity> "<prompt>"');
  console.error('Legacy direct usage: node scripts/run-provider-advisor.js <claude|gemini> <prompt...>');
  console.error('                 or: node scripts/run-provider-advisor.js claude --print "<prompt>"');
  console.error('                 or: node scripts/run-provider-advisor.js gemini --prompt "<prompt>"');
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'task';
}

function timestampToken(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

function parseArgs(argv: string[]): { provider: string; prompt: string } {
  const [providerRaw, ...rest] = argv;
  const provider = (providerRaw || '').toLowerCase();

  if (!provider || !(provider in PROVIDER_BINARIES)) {
    usage();
    process.exit(1);
  }

  if (rest.length === 0) {
    usage();
    process.exit(1);
  }

  if (rest[0] === '-p' || rest[0] === '--print' || rest[0] === '--prompt') {
    const prompt = rest.slice(1).join(' ').trim();
    if (!prompt) {
      usage();
      process.exit(1);
    }
    return { provider, prompt };
  }

  return { provider, prompt: rest.join(' ').trim() };
}


function findUp(start: string, relativePath: string): string | null {
  let current = resolve(start);
  while (true) {
    const candidate = join(current, relativePath);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveAntigravityAcpAgent(cwd = process.cwd()): string {
  const override = process.env.OMX_ANTIGRAVITY_ACP_AGENT?.trim();
  if (override) return isAbsolute(override) ? override : resolve(cwd, override);

  const executableNames = process.platform === 'win32' ? ['agy-acp.exe', 'agy-acp'] : ['agy-acp', 'agy-acp.exe'];
  for (const executableName of executableNames) {
    const release = findUp(cwd, `tools/agy-acp/target/release/${executableName}`);
    if (release) return release;

    const debug = findUp(cwd, `tools/agy-acp/target/debug/${executableName}`);
    if (debug) return debug;
  }

  return resolve(cwd, `tools/agy-acp/target/release/${executableNames[0]}`);
}

function resolveAntigravitySessionName() {
  return process.env.OMX_ANTIGRAVITY_SESSION?.trim() || 'antigravity';
}

function normalizeAntigravityModelTier(value?: string): 'low' | 'medium' | 'high' | '' {
  const normalized = (value || '').trim().toLowerCase();
  if (normalized === 'med') return 'medium';
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high') return normalized;
  return '';
}

function inferAntigravityModelTier(prompt: string, originalTask = prompt): 'low' | 'medium' | 'high' {
  const modelAsTier = normalizeAntigravityModelTier(process.env.OMX_ANTIGRAVITY_MODEL);
  const explicit = modelAsTier
    || normalizeAntigravityModelTier(process.env.OMX_ANTIGRAVITY_MODEL_TIER)
    || normalizeAntigravityModelTier(process.env.OMX_ANTIGRAVITY_MODEL_SETTING)
    || normalizeAntigravityModelTier(process.env.OMX_ANTIGRAVITY_PROFILE)
    || normalizeAntigravityModelTier(process.env.OMX_ANTIGRAVITY_EFFORT);
  if (explicit) return explicit;

  const text = originalTask.toLowerCase();
  if (/\b(high|deep|thorough|audit|architecture|critical|security|root cause|complex|hard|comprehensive)\b/.test(text)) {
    return 'high';
  }
  if (/\b(low|quick|fast|simple|small|trivial|light|brief)\b/.test(text)) {
    return 'low';
  }
  return 'medium';
}

function resolveAntigravityBaseModel(): string {
  const requested = process.env.OMX_ANTIGRAVITY_MODEL?.trim();
  if (requested && !normalizeAntigravityModelTier(requested)) return requested;
  return 'gemini-3.5-flash';
}

function buildAntigravityModelSelection(prompt: string, originalTask = prompt): string {
  const model = resolveAntigravityBaseModel();
  const tier = inferAntigravityModelTier(prompt, originalTask);
  if (/\b(low|medium|med|high)\b/i.test(model)) return model;
  return `${model} (${tier})`;
}

function buildAntigravityPrompt(prompt: string, originalTask = prompt): string {
  const modelSelection = buildAntigravityModelSelection(prompt, originalTask);
  return [
    '<omx_antigravity_routing>',
    `Requested model setting: ${modelSelection}`,
    'Low/medium/high is part of the model selection, not a separate reasoning-effort knob.',
    'Use this exact model selection in Antigravity if the model selector or runtime exposes it.',
    'If hard model selection is unavailable in the current agy CLI session, continue with the closest available Gemini 3.5 Flash model and say if the actual selected model is visible.',
    '</omx_antigravity_routing>',
    '',
    prompt,
  ].join('\n');
}

function resolveAntigravityAcpBaseArgs() {
  const agent = resolveAntigravityAcpAgent();
  if (!existsSync(agent)) {
    console.error('[ask-antigravity] Missing agy-acp adapter binary. Build it with: cd tools/agy-acp && cargo build --release');
    console.error(`[ask-antigravity] Expected adapter: ${agent}`);
    process.exit(1);
  }
  if (!process.env.AGY_BIN?.trim()) {
    const defaultAgy = join(process.env.HOME || '', '.local', 'bin', 'agy');
    if (existsSync(defaultAgy)) process.env.AGY_BIN = defaultAgy;
  }
  if (!process.env.AGY_TIMEOUT_SECONDS?.trim()) {
    process.env.AGY_TIMEOUT_SECONDS = '900';
  }
  if (!process.env.AGY_OUTPUT_MODE?.trim()) {
    process.env.AGY_OUTPUT_MODE = 'cumulative-delta';
  }
  const timeout = process.env.OMX_ANTIGRAVITY_ACPX_TIMEOUT_SECONDS?.trim() || '960';
  return ['--agent', agent, '--cwd', process.cwd(), '--timeout', timeout, '--format', 'text'];
}

function buildAntigravityEnsureSessionArgs() {
  return [...resolveAntigravityAcpBaseArgs(), 'sessions', 'ensure', '--name', resolveAntigravitySessionName()];
}

function buildAntigravityLaunchArgs(prompt: string, originalTask = prompt) {
  return [...resolveAntigravityAcpBaseArgs(), 'prompt', '-s', resolveAntigravitySessionName(), '--', buildAntigravityPrompt(prompt, originalTask)];
}

function ensureBinary(binary: string): void {
  const probe = spawnSync(binary, ['--version'], {
    stdio: 'ignore',
    encoding: 'utf8',
      windowsHide: true,
    });

  if (probe.error && (probe.error as NodeJS.ErrnoException).code === 'ENOENT') {
    const verify = `${binary} --version`;
    console.error(`[ask-${binary}] Missing required local CLI binary: ${binary}`);
    console.error(`[ask-${binary}] Install/configure ${binary} CLI, then verify with: ${verify}`);
    process.exit(1);
  }
}

function shouldUseClaudeIssuePermissionsBypass(provider: string, prompt: string): boolean {
  if (provider !== 'claude') return false;
  const trimmed = prompt.trim();
  if (trimmed === '') return false;
  return ISSUE_WORK_PROMPT_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function buildProviderLaunchArgs(provider: string, prompt: string, originalTask: string): string[] {
  if (provider === 'antigravity') {
    return buildAntigravityLaunchArgs(prompt, originalTask);
  }

  const promptArgs = provider === 'claude'
    ? ['-p', '--', prompt]
    : ['-p', prompt];

  return shouldUseClaudeIssuePermissionsBypass(provider, originalTask)
    ? [CLAUDE_SKIP_PERMISSIONS_FLAG, ...promptArgs]
    : promptArgs;
}

function buildSummary(exitCode: number, output: string): string {
  if (exitCode === 0) {
    return 'Provider completed successfully. Review the raw output for details.';
  }

  const firstLine = output
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);

  return firstLine
    ? `Provider command failed (exit ${exitCode}): ${firstLine}`
    : `Provider command failed with exit code ${exitCode}.`;
}

function buildActionItems(exitCode: number): string[] {
  if (exitCode === 0) {
    return ['Review the response and extract decisions you want to apply.', 'Capture follow-up implementation tasks if needed.'];
  }

  return ['Inspect the raw output error details.', 'Fix CLI/auth/environment issues and rerun the command.'];
}

async function writeArtifact({ provider, originalTask, finalPrompt, rawOutput, exitCode }: {
  provider: string;
  originalTask: string;
  finalPrompt: string;
  rawOutput: string;
  exitCode: number;
}): Promise<string> {
  const root = process.cwd();
  const artifactDir = join(root, '.omx', 'artifacts');
  const slug = slugify(originalTask);
  const timestamp = timestampToken();
  const artifactPath = join(artifactDir, `${provider}-${slug}-${timestamp}.md`);

  const summary = buildSummary(exitCode, rawOutput);
  const actionItems = buildActionItems(exitCode);

  const body = [
    `# ${provider} advisor artifact`,
    '',
    `- Provider: ${provider}`,
    `- Exit code: ${exitCode}`,
    `- Created at: ${new Date().toISOString()}`,
    '',
    '## Original task',
    '',
    originalTask,
    '',
    '## Final prompt',
    '',
    finalPrompt,
    '',
    '## Raw output',
    '',
    '```text',
    rawOutput || '(no output)',
    '```',
    '',
    '## Concise summary',
    '',
    summary,
    '',
    '## Action items',
    '',
    ...actionItems.map((item) => `- ${item}`),
    '',
  ].join('\n');

  await mkdir(artifactDir, { recursive: true });
  await writeFile(artifactPath, body, 'utf8');
  return artifactPath;
}

async function main(): Promise<void> {
  const { provider, prompt } = parseArgs(process.argv.slice(2));
  const binary = PROVIDER_BINARIES[provider];
  const originalTask = process.env[ASK_ORIGINAL_TASK_ENV] ?? prompt;

  ensureBinary(binary);

  if (provider === 'antigravity') {
    const ensureRun = spawnSync(binary, buildAntigravityEnsureSessionArgs(), {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    if (ensureRun.error) {
      console.error(`[ask-antigravity] ${ensureRun.error.message}`);
      process.exit(1);
    }
    if (typeof ensureRun.status === 'number' && ensureRun.status !== 0) {
      const ensureOutput = [ensureRun.stdout || '', ensureRun.stderr || ''].filter(Boolean).join('\n\n');
      console.error(ensureOutput || `[ask-antigravity] failed to ensure session ${resolveAntigravitySessionName()}`);
      process.exit(ensureRun.status);
    }
  }

  const launchArgs = buildProviderLaunchArgs(provider, prompt, originalTask);

  const run = spawnSync(binary, launchArgs, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });

  const stdout = run.stdout || '';
  const stderr = run.stderr || '';
  const rawOutput = [stdout, stderr].filter(Boolean).join(stdout && stderr ? '\n\n' : '');
  const exitCode = typeof run.status === 'number' ? run.status : 1;

  const artifactPath = await writeArtifact({
    provider,
    originalTask,
    finalPrompt: provider === 'antigravity' ? buildAntigravityPrompt(prompt, originalTask) : prompt,
    rawOutput,
    exitCode,
  });

  console.log(artifactPath);

  if (run.error) {
    console.error(`[ask-${provider}] ${run.error.message}`);
  }

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

main().catch((error) => {
  console.error(`[run-provider-advisor] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
