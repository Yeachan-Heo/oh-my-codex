import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const FORBIDDEN_PRODUCTION_TOKENS = [
  'monitorTeam',
  'getTeamSummary',
  'teamReadConfig',
  'runHudAuthorityTick',
  'runAuthorityTick',
  'authority',
  'notify-fallback-authority',
  'acquireTeamTaskClaim',
  'writeTeamTask',
  'writeTeamPhase',
  'appendTeamEvent',
  'writeWorkerStatus',
  'writeWorkerHeartbeat',
  'dispatchTeamWorkerRequest',
];

async function productionFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await productionFiles(path));
    else if (entry.isFile() && (/\.(ts|js)$/.test(path))) files.push(path);
  }
  return files;
}

describe('sidecar mutation boundary', () => {
  it('does not import known mutating team/HUD authority APIs', async () => {
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    const files = await productionFiles(root);
    assert.ok(files.length > 0, 'expected sidecar production files to scan');
    for (const file of files) {
      const text = await readFile(file, 'utf-8');
      for (const token of FORBIDDEN_PRODUCTION_TOKENS) {
        assert.ok(!text.includes(token), `${file} must not reference ${token}`);
      }
    }
  });
});
