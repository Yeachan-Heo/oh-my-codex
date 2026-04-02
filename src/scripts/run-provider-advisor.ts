#!/usr/bin/env node
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import process from 'process';
import { spawnSync } from 'child_process';

const PROVIDER_BINARIES: Record<string, string> = {
  claude: 'claude',
  gemini: 'gemini',
};

const MINIMAX_BASE_URL = process.env.MINIMAX_BASE_URL ?? 'https://api.minimax.io/v1';
const MINIMAX_DEFAULT_MODEL = 'MiniMax-M2.7';
const ASK_ORIGINAL_TASK_ENV = 'OMX_ASK_ORIGINAL_TASK';

function usage(): void {
  console.error('Usage: omx ask <claude|gemini|minimax> "<prompt>"');
  console.error('Legacy direct usage: node scripts/run-provider-advisor.js <claude|gemini|minimax> <prompt...>');
  console.error('                 or: node scripts/run-provider-advisor.js claude --print "<prompt>"');
  console.error('                 or: node scripts/run-provider-advisor.js gemini --prompt "<prompt>"');
  console.error('                 or: node scripts/run-provider-advisor.js minimax --prompt "<prompt>"');
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

const VALID_PROVIDERS = new Set([...Object.keys(PROVIDER_BINARIES), 'minimax']);

function parseArgs(argv: string[]): { provider: string; prompt: string } {
  const [providerRaw, ...rest] = argv;
  const provider = (providerRaw || '').toLowerCase();

  if (!provider || !VALID_PROVIDERS.has(provider)) {
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

function ensureBinary(binary: string): void {
  const probe = spawnSync(binary, ['--version'], {
    stdio: 'ignore',
    encoding: 'utf8',
  });

  if (probe.error && (probe.error as NodeJS.ErrnoException).code === 'ENOENT') {
    const verify = `${binary} --version`;
    console.error(`[ask-${binary}] Missing required local CLI binary: ${binary}`);
    console.error(`[ask-${binary}] Install/configure ${binary} CLI, then verify with: ${verify}`);
    process.exit(1);
  }
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

async function callMinimaxApi(prompt: string): Promise<{ rawOutput: string; exitCode: number }> {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    console.error('[ask-minimax] MINIMAX_API_KEY environment variable is not set.');
    console.error('[ask-minimax] Get your key at https://platform.minimaxi.com and set MINIMAX_API_KEY.');
    process.exit(1);
  }

  const model = process.env.MINIMAX_MODEL ?? MINIMAX_DEFAULT_MODEL;
  const url = `${MINIMAX_BASE_URL}/chat/completions`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { rawOutput: `[network error] ${msg}`, exitCode: 1 };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return { rawOutput: `[HTTP ${response.status}] ${body}`, exitCode: 1 };
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return { rawOutput: '[error] Failed to parse MiniMax API response as JSON.', exitCode: 1 };
  }

  type ApiResponse = { choices?: Array<{ message?: { content?: string } }> };
  const typed = data as ApiResponse;
  const content = typed?.choices?.[0]?.message?.content ?? '';
  // Strip <think>...</think> blocks from reasoning output
  const stripped = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  return { rawOutput: stripped, exitCode: 0 };
}

async function main(): Promise<void> {
  const { provider, prompt } = parseArgs(process.argv.slice(2));

  if (provider === 'minimax') {
    const { rawOutput, exitCode } = await callMinimaxApi(prompt);

    const artifactPath = await writeArtifact({
      provider,
      originalTask: process.env[ASK_ORIGINAL_TASK_ENV] ?? prompt,
      finalPrompt: prompt,
      rawOutput,
      exitCode,
    });

    console.log(artifactPath);

    if (exitCode !== 0) {
      process.exit(exitCode);
    }
    return;
  }

  const binary = PROVIDER_BINARIES[provider];

  ensureBinary(binary);

  const run = spawnSync(binary, ['-p', prompt], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });

  const stdout = run.stdout || '';
  const stderr = run.stderr || '';
  const rawOutput = [stdout, stderr].filter(Boolean).join(stdout && stderr ? '\n\n' : '');
  const exitCode = typeof run.status === 'number' ? run.status : 1;

  const artifactPath = await writeArtifact({
    provider,
    originalTask: process.env[ASK_ORIGINAL_TASK_ENV] ?? prompt,
    finalPrompt: prompt,
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
