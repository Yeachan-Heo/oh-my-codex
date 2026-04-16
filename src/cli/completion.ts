import { buildCompletionCatalog } from './completion/catalog.js';
import { installCompletion, type SupportedShell } from './completion/install.js';
import {
  renderBashCompletion,
  renderFishCompletion,
  renderPowerShellCompletion,
  renderZshCompletion,
} from './completion/render.js';

export const SUPPORTED_COMPLETION_SHELLS = ['bash', 'zsh', 'fish', 'powershell'] as const;

export const COMPLETION_USAGE = [
  'Usage: omx completion <bash|zsh|fish|powershell>',
  '',
  'Install OMX shell completion directly into the target shell load point.',
  'Re-running the command updates prior OMX-managed completion content instead of duplicating it.',
].join('\n');

function asSupportedShell(value: string): SupportedShell | null {
  return (SUPPORTED_COMPLETION_SHELLS as readonly string[]).includes(value)
    ? (value as SupportedShell)
    : null;
}

function usageError(reason: string): Error {
  return new Error(`${reason}\n${COMPLETION_USAGE}`);
}

function renderCompletionScript(shell: SupportedShell, catalog: Awaited<ReturnType<typeof buildCompletionCatalog>>): string {
  switch (shell) {
    case 'bash':
      return renderBashCompletion(catalog);
    case 'zsh':
      return renderZshCompletion(catalog);
    case 'fish':
      return renderFishCompletion(catalog);
    case 'powershell':
      return renderPowerShellCompletion(catalog);
  }
}

export async function completionCommand(args: string[]): Promise<void> {
  const first = (args[0] || '').toLowerCase();
  if (!first || first === '--help' || first === '-h' || first === 'help') {
    console.log(COMPLETION_USAGE);
    return;
  }

  const shell = asSupportedShell(first);
  if (!shell) {
    throw usageError(`Unsupported shell "${args[0]}".`);
  }
  if (args.length > 1) {
    throw usageError(`Unexpected arguments after shell: ${args.slice(1).join(' ')}`);
  }

  const catalog = await buildCompletionCatalog();
  const script = renderCompletionScript(shell, catalog);
  const result = await installCompletion(shell, script);

  if (result.changedPaths.length === 0) {
    console.log(`omx ${shell} completion is already up to date.`);
    return;
  }

  console.log(`Installed omx ${shell} completion.`);
  console.log('Updated paths:');
  for (const path of result.changedPaths) {
    console.log(`  - ${path}`);
  }
  if (result.backupPaths.length > 0) {
    console.log('Backups:');
    for (const path of result.backupPaths) {
      console.log(`  - ${path}`);
    }
  }
}
