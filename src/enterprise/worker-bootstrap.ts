import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';

export interface EnterpriseWorkerInstructionsOptions {
  nodeId: string;
  role: 'division_lead' | 'subordinate';
  scope: string;
  stateRoot: string;
  ownerLeadId?: string | null;
}

export function generateEnterpriseWorkerInstructions(options: EnterpriseWorkerInstructionsOptions): string {
  const ownerLine = options.ownerLeadId ? `**Owner Lead:** ${options.ownerLeadId}\n` : '';
  return `# Enterprise Worker Assignment\n\n**Node ID:** ${options.nodeId}\n**Role:** ${options.role}\n${ownerLine}**Scope:** ${options.scope}\n\n## Protocol\n1. Read enterprise state under ${options.stateRoot}/enterprise\n2. Use enterprise mailbox/summary records rather than team state files\n3. Report completion/blockers through enterprise mailbox and execution updates\n4. Stay within the assigned scope\n`;
}

export async function writeEnterpriseWorkerInstructions(
  cwd: string,
  options: EnterpriseWorkerInstructionsOptions,
): Promise<string> {
  const dir = join(cwd, '.omx', 'state', 'enterprise', 'workers');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${options.nodeId}-instructions.md`);
  await writeFile(path, generateEnterpriseWorkerInstructions(options));
  return path;
}
