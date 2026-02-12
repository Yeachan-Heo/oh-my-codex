/**
 * oh-my-codex CLI
 * Multi-agent orchestration for OpenAI Codex CLI
 */

import { setup } from './setup.js';
import { doctor } from './doctor.js';
import { version } from './version.js';

const HELP = `
oh-my-codex (omx) - Multi-agent orchestration for Codex CLI

Usage:
  omx setup     Install skills, prompts, MCP servers, and AGENTS.md
  omx doctor    Check installation health
  omx version   Show version information
  omx help      Show this help message
  omx status    Show active modes and state
  omx cancel    Cancel active execution modes

Options:
  --force       Force reinstall (overwrite existing files)
  --dry-run     Show what would be done without doing it
  --verbose     Show detailed output
`;

export async function main(args: string[]): Promise<void> {
  const command = args[0] || 'help';
  const flags = new Set(args.filter(a => a.startsWith('--')));
  const options = {
    force: flags.has('--force'),
    dryRun: flags.has('--dry-run'),
    verbose: flags.has('--verbose'),
  };

  try {
    switch (command) {
      case 'setup':
        await setup(options);
        break;
      case 'doctor':
        await doctor(options);
        break;
      case 'version':
        version();
        break;
      case 'status':
        await showStatus();
        break;
      case 'cancel':
        await cancelModes();
        break;
      case 'help':
      case '--help':
      case '-h':
        console.log(HELP);
        break;
      default:
        console.error(`Unknown command: ${command}`);
        console.log(HELP);
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

async function showStatus(): Promise<void> {
  const { readdir, readFile } = await import('fs/promises');
  const { join } = await import('path');
  const stateDir = join(process.cwd(), '.omx', 'state');
  try {
    const files = await readdir(stateDir);
    const states = files.filter(f => f.endsWith('-state.json'));
    if (states.length === 0) {
      console.log('No active modes.');
      return;
    }
    for (const file of states) {
      const content = await readFile(join(stateDir, file), 'utf-8');
      const state = JSON.parse(content);
      const mode = file.replace('-state.json', '');
      console.log(`${mode}: ${state.active ? 'ACTIVE' : 'inactive'} (phase: ${state.current_phase || 'n/a'})`);
    }
  } catch {
    console.log('No active modes.');
  }
}

async function cancelModes(): Promise<void> {
  const { readdir, writeFile, readFile } = await import('fs/promises');
  const { join } = await import('path');
  const stateDir = join(process.cwd(), '.omx', 'state');
  try {
    const files = await readdir(stateDir);
    const states = files.filter(f => f.endsWith('-state.json'));
    let cancelled = 0;
    for (const file of states) {
      const path = join(stateDir, file);
      const content = await readFile(path, 'utf-8');
      const state = JSON.parse(content);
      if (state.active) {
        state.active = false;
        state.current_phase = 'cancelled';
        state.completed_at = new Date().toISOString();
        await writeFile(path, JSON.stringify(state, null, 2));
        cancelled++;
        console.log(`Cancelled: ${file.replace('-state.json', '')}`);
      }
    }
    if (cancelled === 0) {
      console.log('No active modes to cancel.');
    }
  } catch {
    console.log('No active modes to cancel.');
  }
}
