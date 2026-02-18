/**
 * One-time GitHub star prompt shown at OMX startup.
 * Skipped when no TTY or when gh CLI is not installed.
 * State stored globally (~/.omx/state/star-prompt.json) so it shows once per user.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';
import { createInterface } from 'readline/promises';

const REPO = 'Yeachan-Heo/oh-my-codex';

interface StarPromptState {
  prompted_at: string;
}

export function starPromptStatePath(): string {
  return join(homedir(), '.omx', 'state', 'star-prompt.json');
}

export async function hasBeenPrompted(): Promise<boolean> {
  const path = starPromptStatePath();
  if (!existsSync(path)) return false;
  try {
    const content = await readFile(path, 'utf-8');
    const state = JSON.parse(content) as StarPromptState;
    return typeof state.prompted_at === 'string';
  } catch {
    return false;
  }
}

export async function markPrompted(): Promise<void> {
  const stateDir = join(homedir(), '.omx', 'state');
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    starPromptStatePath(),
    JSON.stringify({ prompted_at: new Date().toISOString() }, null, 2),
  );
}

export function isGhInstalled(): boolean {
  const result = spawnSync('gh', ['--version'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: 3000,
  });
  return !result.error && result.status === 0;
}

function starRepo(): void {
  spawnSync('gh', ['api', '-X', 'PUT', `/user/starred/${REPO}`], {
    encoding: 'utf-8',
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: 10000,
  });
}

async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

export async function maybePromptGithubStar(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;
  if (await hasBeenPrompted()) return;
  if (!isGhInstalled()) return;

  // Mark as prompted before asking so we never prompt again even if interrupted.
  await markPrompted();

  const approved = await askYesNo('[omx] Enjoying oh-my-codex? Star it on GitHub? [Y/n] ');
  if (!approved) return;

  starRepo();
  console.log('[omx] Thanks for the star!');
}
