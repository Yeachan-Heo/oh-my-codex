/**
 * Tests for AGENTS.md Runtime Overlay
 *
 * Covers: overlay generation, apply/strip roundtrip, idempotency,
 * size cap enforcement, and graceful handling of missing state.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  generateOverlay,
  applyOverlay,
  stripOverlay,
  hasOverlay,
} from '../agents-overlay.js';

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'omx-overlay-test-'));
  await mkdir(join(dir, '.omx', 'state'), { recursive: true });
  return dir;
}

describe('generateOverlay', () => {
  let tempDir: string;
  before(async () => { tempDir = await makeTempDir(); });
  after(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('generates overlay with no state files (empty but valid)', async () => {
    const overlay = await generateOverlay(tempDir, 'test-session-1');
    assert.ok(overlay.includes('<!-- OMX:RUNTIME:START -->'));
    assert.ok(overlay.includes('<!-- OMX:RUNTIME:END -->'));
    assert.ok(overlay.includes('test-session-1'));
    assert.ok(overlay.includes('Compaction Protocol'));
  });

  it('generates overlay with active modes', async () => {
    await writeFile(
      join(tempDir, '.omx', 'state', 'ralph-state.json'),
      JSON.stringify({ active: true, iteration: 3, max_iterations: 10, current_phase: 'execution' })
    );
    const overlay = await generateOverlay(tempDir, 'test-session-2');
    assert.ok(overlay.includes('ralph'));
    assert.ok(overlay.includes('iteration 3/10'));
  });

  it('generates overlay with session-scoped active modes for current session', async () => {
    await mkdir(join(tempDir, '.omx', 'state', 'sessions', 'sess1'), { recursive: true });
    await writeFile(
      join(tempDir, '.omx', 'state', 'sessions', 'sess1', 'team-state.json'),
      JSON.stringify({ active: true, iteration: 1, max_iterations: 5, current_phase: 'running' })
    );
    const overlay = await generateOverlay(tempDir, 'sess1');
    assert.ok(overlay.includes('team'));
    assert.ok(overlay.includes('iteration 1/5'));
  });

  it('generates overlay with notepad priority content', async () => {
    await writeFile(
      join(tempDir, '.omx', 'notepad.md'),
      '## PRIORITY\nFocus on auth module refactor.\n\n## WORKING\nSome working notes.'
    );
    const overlay = await generateOverlay(tempDir, 'test-session-3');
    assert.ok(overlay.includes('Focus on auth module refactor'));
    assert.ok(overlay.includes('Priority Notes'));
  });

  it('generates overlay with project memory summary', async () => {
    await writeFile(
      join(tempDir, '.omx', 'project-memory.json'),
      JSON.stringify({
        techStack: 'TypeScript + Node.js',
        conventions: 'ESM modules, strict mode',
        build: 'npx tsc',
        directives: [
          { directive: 'Always use strict TypeScript', priority: 'high' },
          { directive: 'Low priority thing', priority: 'normal' },
        ],
      })
    );
    const overlay = await generateOverlay(tempDir, 'test-session-4');
    assert.ok(overlay.includes('TypeScript + Node.js'));
    assert.ok(overlay.includes('Always use strict TypeScript'));
    assert.ok(!overlay.includes('Low priority thing'));
  });

  it('enforces size cap (overlay <= 2000 chars)', async () => {
    const longText = 'A'.repeat(5000);
    await writeFile(join(tempDir, '.omx', 'notepad.md'), `## PRIORITY\n${longText}`);
    await writeFile(
      join(tempDir, '.omx', 'project-memory.json'),
      JSON.stringify({ techStack: 'B'.repeat(2000), conventions: 'C'.repeat(2000) })
    );

    const overlay = await generateOverlay(tempDir, 'test-session-5');
    assert.ok(overlay.length <= 2000, `Overlay too large: ${overlay.length} chars`);
    assert.ok(overlay.includes('<!-- OMX:RUNTIME:START -->'));
    assert.ok(overlay.includes('<!-- OMX:RUNTIME:END -->'));
  });

  it('skips inactive modes', async () => {
    await writeFile(
      join(tempDir, '.omx', 'state', 'autopilot-state.json'),
      JSON.stringify({ active: false, current_phase: 'cancelled' })
    );
    const overlay = await generateOverlay(tempDir, 'test-session-6');
    assert.ok(!overlay.includes('autopilot'));
  });
});

describe('applyOverlay + stripOverlay roundtrip', () => {
  let tempDir: string;
  const originalContent = `# My AGENTS.md

This is the original content.

## Section 1
Some instructions here.
`;

  before(async () => { tempDir = await makeTempDir(); });
  after(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('apply then strip restores original (roundtrip)', async () => {
    const agentsMd = join(tempDir, 'AGENTS.md');
    await writeFile(agentsMd, originalContent);

    const overlay = await generateOverlay(tempDir, 'roundtrip-test');
    await applyOverlay(agentsMd, overlay, tempDir);

    const withOverlay = await readFile(agentsMd, 'utf-8');
    assert.ok(hasOverlay(withOverlay));
    assert.ok(withOverlay.includes('roundtrip-test'));

    await stripOverlay(agentsMd, tempDir);
    const restored = await readFile(agentsMd, 'utf-8');
    assert.ok(!hasOverlay(restored));
    assert.equal(restored.trim(), originalContent.trim());
  });

  it('applyOverlay is idempotent (apply twice, no duplication)', async () => {
    const agentsMd = join(tempDir, 'AGENTS-idem.md');
    await writeFile(agentsMd, originalContent);

    const overlay = await generateOverlay(tempDir, 'idempotent-test');
    await applyOverlay(agentsMd, overlay, tempDir);
    const firstApply = await readFile(agentsMd, 'utf-8');

    await applyOverlay(agentsMd, overlay, tempDir);
    const secondApply = await readFile(agentsMd, 'utf-8');

    assert.equal(secondApply, firstApply);
    const startCount = (secondApply.match(/<!-- OMX:RUNTIME:START -->/g) || []).length;
    assert.equal(startCount, 1);
  });

  it('handles stale markers from previous session', async () => {
    const agentsMd = join(tempDir, 'AGENTS-stale.md');
    const staleContent = originalContent +
      '\n<!-- OMX:RUNTIME:START -->\n<session_context>\nOld stale content\n</session_context>\n<!-- OMX:RUNTIME:END -->\n';
    await writeFile(agentsMd, staleContent);

    const overlay = await generateOverlay(tempDir, 'fresh-session');
    await applyOverlay(agentsMd, overlay, tempDir);

    const result = await readFile(agentsMd, 'utf-8');
    assert.ok(result.includes('fresh-session'));
    assert.ok(!result.includes('Old stale content'));
    const startCount = (result.match(/<!-- OMX:RUNTIME:START -->/g) || []).length;
    assert.equal(startCount, 1);
  });

  it('stripOverlay is no-op when no overlay exists', async () => {
    const agentsMd = join(tempDir, 'AGENTS-noop.md');
    await writeFile(agentsMd, originalContent);

    await stripOverlay(agentsMd, tempDir);
    const result = await readFile(agentsMd, 'utf-8');
    assert.equal(result, originalContent);
  });

  it('creates AGENTS.md if it does not exist during apply', async () => {
    const agentsMd = join(tempDir, 'AGENTS-new.md');
    const overlay = await generateOverlay(tempDir, 'new-file-test');
    await applyOverlay(agentsMd, overlay, tempDir);

    const result = await readFile(agentsMd, 'utf-8');
    assert.ok(hasOverlay(result));
    assert.ok(result.includes('new-file-test'));
  });
});

describe('hasOverlay', () => {
  it('returns true when both markers present', () => {
    const content = 'start\n<!-- OMX:RUNTIME:START -->\nmiddle\n<!-- OMX:RUNTIME:END -->\nend';
    assert.ok(hasOverlay(content));
  });

  it('returns false when no markers', () => {
    assert.ok(!hasOverlay('plain content'));
  });

  it('returns false when only start marker', () => {
    assert.ok(!hasOverlay('<!-- OMX:RUNTIME:START -->\nbroken'));
  });
});
