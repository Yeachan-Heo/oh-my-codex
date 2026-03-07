#!/usr/bin/env node
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import process from 'process';
import { spawnSync } from 'child_process';

const PROVIDER_BINARIES = {
  claude: 'claude',
  gemini: 'gemini',
};
const ASK_ORIGINAL_TASK_ENV = 'OMX_ASK_ORIGINAL_TASK';

function resolveBinaryOnWindows(binary) {
  const probe = spawnSync('where.exe', [binary], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (probe.status !== 0 || !probe.stdout) return binary;
  const resolved = probe.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return resolved || binary;
}

function buildLaunchSpec(binary, args) {
  if (process.platform === 'win32') {
    const resolvedBinary = resolveBinaryOnWindows(binary);
    const psCommand = [`& '${resolvedBinary.replace(/'/g, "''")}'`]
      .concat(args.map((part) => `'${String(part).replace(/'/g, "''")}'`))
      .join(' ');
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-Command', psCommand],
    };
  }
  return { command: binary, args };
}

function usage() {
  console.error('Usage: omx ask <claude|gemini> "<prompt>"');
  console.error('Legacy direct usage: node scripts/run-provider-advisor.js <claude|gemini> <prompt...>');
  console.error('                 or: node scripts/run-provider-advisor.js claude --print "<prompt>"');
  console.error('                 or: node scripts/run-provider-advisor.js gemini --prompt "<prompt>"');
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'task';
}

function timestampToken(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function parseArgs(argv) {
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

function ensureBinary(binary) {
  const launch = buildLaunchSpec(binary, ['--version']);
  const probe = spawnSync(launch.command, launch.args, {
    stdio: 'ignore',
    encoding: 'utf8',
  });

  if (probe.error && probe.error.code === 'ENOENT') {
    const verify = `${binary} --version`;
    console.error(`[ask-${binary}] Missing required local CLI binary: ${binary}`);
    console.error(`[ask-${binary}] Install/configure ${binary} CLI, then verify with: ${verify}`);
    process.exit(1);
  }
}

function buildSummary(exitCode, output) {
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

function buildActionItems(exitCode) {
  if (exitCode === 0) {
    return ['Review the response and extract decisions you want to apply.', 'Capture follow-up implementation tasks if needed.'];
  }

  return ['Inspect the raw output error details.', 'Fix CLI/auth/environment issues and rerun the command.'];
}

async function writeArtifact({ provider, originalTask, finalPrompt, rawOutput, exitCode }) {
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

async function main() {
  const { provider, prompt } = parseArgs(process.argv.slice(2));
  const binary = PROVIDER_BINARIES[provider];

  ensureBinary(binary);

  const launch = buildLaunchSpec(binary, ['-p', prompt]);
  const run = spawnSync(launch.command, launch.args, {
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
