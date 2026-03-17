import { createInterface } from 'readline/promises';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { type AutoresearchKeepPolicy, parseSandboxContract, slugifyMissionName } from '../autoresearch/contracts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface InitAutoresearchOptions {
  topic: string;
  evaluatorCommand: string;
  keepPolicy: AutoresearchKeepPolicy;
  slug: string;
  repoRoot: string;
}

export interface InitAutoresearchResult {
  missionDir: string;
  slug: string;
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function buildMissionContent(topic: string): string {
  return `# Mission\n\n${topic}\n`;
}

function buildSandboxContent(evaluatorCommand: string, keepPolicy: AutoresearchKeepPolicy): string {
  // Strip newlines/carriage returns to prevent YAML injection
  const safeCommand = evaluatorCommand.replace(/[\r\n]/g, ' ').trim();
  return `---\nevaluator:\n  command: ${safeCommand}\n  format: json\n  keep_policy: ${keepPolicy}\n---\n`;
}

export async function initAutoresearchMission(opts: InitAutoresearchOptions): Promise<InitAutoresearchResult> {
  const missionsRoot = join(opts.repoRoot, 'missions');
  const missionDir = join(missionsRoot, opts.slug);

  // Defense-in-depth: ensure slug does not escape missions/ directory
  const rel = relative(missionsRoot, missionDir);
  if (!rel || rel.startsWith('..') || resolve(rel) === resolve(missionDir)) {
    throw new Error('Invalid slug: resolves outside missions/ directory.');
  }

  if (existsSync(missionDir)) {
    throw new Error(`Mission directory already exists: ${missionDir}`);
  }

  await mkdir(missionDir, { recursive: true });

  const missionContent = buildMissionContent(opts.topic);
  const sandboxContent = buildSandboxContent(opts.evaluatorCommand, opts.keepPolicy);

  // Validate before writing — ensures contract fidelity
  parseSandboxContract(sandboxContent);

  await writeFile(join(missionDir, 'mission.md'), missionContent, 'utf-8');
  await writeFile(join(missionDir, 'sandbox.md'), sandboxContent, 'utf-8');

  return { missionDir, slug: opts.slug };
}

export function parseInitArgs(args: readonly string[]): Partial<InitAutoresearchOptions> {
  const result: Partial<InitAutoresearchOptions> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if ((arg === '--topic') && next) {
      result.topic = next;
      i++;
    } else if ((arg === '--evaluator') && next) {
      result.evaluatorCommand = next;
      i++;
    } else if ((arg === '--keep-policy') && next) {
      const normalized = next.trim().toLowerCase();
      if (normalized !== 'pass_only' && normalized !== 'score_improvement') {
        throw new Error('--keep-policy must be one of: score_improvement, pass_only');
      }
      result.keepPolicy = normalized;
      i++;
    } else if ((arg === '--slug') && next) {
      result.slug = slugifyMissionName(next);
      i++;
    } else if (arg.startsWith('--topic=')) {
      result.topic = arg.slice('--topic='.length);
    } else if (arg.startsWith('--evaluator=')) {
      result.evaluatorCommand = arg.slice('--evaluator='.length);
    } else if (arg.startsWith('--keep-policy=')) {
      const normalized = arg.slice('--keep-policy='.length).trim().toLowerCase();
      if (normalized !== 'pass_only' && normalized !== 'score_improvement') {
        throw new Error('--keep-policy must be one of: score_improvement, pass_only');
      }
      result.keepPolicy = normalized;
    } else if (arg.startsWith('--slug=')) {
      result.slug = slugifyMissionName(arg.slice('--slug='.length));
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown init flag: ${arg.split('=')[0]}`);
    }
  }
  return result;
}

export async function guidedAutoresearchSetup(repoRoot: string): Promise<InitAutoresearchResult> {
  if (!process.stdin.isTTY) {
    throw new Error('Guided setup requires an interactive terminal. Use --topic, --evaluator, --keep-policy, --slug flags for non-interactive use.');
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const topic = await rl.question('Research topic/goal:\n> ');
    if (!topic.trim()) {
      throw new Error('Research topic is required.');
    }

    const evaluatorCommand = await rl.question('\nEvaluator command (shell command that outputs {pass: boolean, score?: number} JSON):\n> ');
    if (!evaluatorCommand.trim()) {
      throw new Error('Evaluator command is required.');
    }

    const keepPolicyInput = await rl.question('\nKeep policy [score_improvement/pass_only] (default: score_improvement):\n> ');
    const keepPolicy: AutoresearchKeepPolicy = keepPolicyInput.trim().toLowerCase() === 'pass_only' ? 'pass_only' : 'score_improvement';

    const suggestedSlug = slugifyMissionName(topic);
    const slugInput = await rl.question(`\nMission slug (default: ${suggestedSlug}):\n> `);
    const slug = slugInput.trim() ? slugifyMissionName(slugInput.trim()) : suggestedSlug;

    return initAutoresearchMission({
      topic: topic.trim(),
      evaluatorCommand: evaluatorCommand.trim(),
      keepPolicy,
      slug,
      repoRoot,
    });
  } finally {
    rl.close();
  }
}

export function checkTmuxAvailable(): boolean {
  const result = spawnSync('tmux', ['-V'], { stdio: 'pipe' });
  return result.status === 0;
}

export function spawnAutoresearchTmux(missionDir: string, slug: string): void {
  if (!checkTmuxAvailable()) {
    throw new Error('tmux is required for background autoresearch execution. Install tmux and try again.');
  }

  const sessionName = `omx-autoresearch-${slug}`;

  // Check for session name collision
  const hasSession = spawnSync('tmux', ['has-session', '-t', sessionName], { stdio: 'pipe' });
  if (hasSession.status === 0) {
    throw new Error(
      `tmux session "${sessionName}" already exists.\n` +
      `  Attach: tmux attach -t ${sessionName}\n` +
      `  Kill:   tmux kill-session -t ${sessionName}`,
    );
  }

  const omxPath = resolve(join(__dirname, '..', '..', 'bin', 'omx.js'));
  // Shell-quote all path components to handle spaces and special characters
  const cmd = `${shellQuote(process.execPath)} ${shellQuote(omxPath)} autoresearch ${shellQuote(missionDir)}`;

  execFileSync('tmux', ['new-session', '-d', '-s', sessionName, cmd], { stdio: 'ignore' });

  console.log(`\nAutoresearch launched in background tmux session.`);
  console.log(`  Session:  ${sessionName}`);
  console.log(`  Mission:  ${missionDir}`);
  console.log(`  Attach:   tmux attach -t ${sessionName}`);
}
