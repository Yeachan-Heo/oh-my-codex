import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';
import { join } from 'path';

function collectExports(source: string): Set<string> {
  const out = new Set<string>();
  const re = /^\s*export\s+(?:const|function)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) out.add(match[1]);
  return out;
}

describe('tmux-hook-engine declaration sync', () => {
  it('covers all runtime exports in src/types/tmux-hook-engine.d.ts', async () => {
    const root = process.cwd();
    const runtimeSource = await readFile(join(root, 'scripts', 'tmux-hook-engine.js'), 'utf-8');
    const declSource = await readFile(join(root, 'src', 'types', 'tmux-hook-engine.d.ts'), 'utf-8');

    const runtimeExports = collectExports(runtimeSource);
    const declaredExports = collectExports(declSource);

    const missing = [...runtimeExports].filter((name) => !declaredExports.has(name));
    assert.deepEqual(missing, [], `Missing declaration exports: ${missing.join(', ')}`);
  });
});
