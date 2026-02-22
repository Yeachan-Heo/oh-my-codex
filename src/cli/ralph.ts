import { startMode, updateModeState } from '../modes/base.js';
import { ensureCanonicalRalphArtifacts } from '../ralph/persistence.js';

const RALPH_HELP = `omx ralph - Launch Codex with ralph persistence mode active

Usage:
  omx ralph [codex-args...]   Initialize ralph state and launch Codex

Options:
  --help, -h    Show this help message

Ralph persistence mode initializes state tracking so the OMC ralph loop
can maintain context across Codex sessions.
`;

export async function ralphCommand(args: string[]): Promise<void> {
  const cwd = process.cwd();

  if (args[0] === '--help' || args[0] === '-h') {
    console.log(RALPH_HELP);
    return;
  }

  // Initialize ralph persistence artifacts (state dirs, legacy PRD/progress migration)
  const artifacts = await ensureCanonicalRalphArtifacts(cwd);

  // Write initial ralph mode state
  const task = args.filter((a) => !a.startsWith('-')).join(' ') || 'ralph-cli-launch';
  await startMode('ralph', task, 50);
  await updateModeState('ralph', {
    current_phase: 'starting',
    canonical_progress_path: artifacts.canonicalProgressPath,
    ...(artifacts.canonicalPrdPath ? { canonical_prd_path: artifacts.canonicalPrdPath } : {}),
  });

  if (artifacts.migratedPrd) {
    console.log(`[ralph] Migrated legacy PRD -> ${artifacts.canonicalPrdPath}`);
  }
  if (artifacts.migratedProgress) {
    console.log(`[ralph] Migrated legacy progress -> ${artifacts.canonicalProgressPath}`);
  }

  console.log('[ralph] Ralph persistence mode active. Launching Codex...');

  // Dynamic import avoids a circular dependency with index.ts
  const { launchWithHud } = await import('./index.js');
  await launchWithHud(args);
}
