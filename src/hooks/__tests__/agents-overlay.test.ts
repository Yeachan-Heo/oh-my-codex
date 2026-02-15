/**
 * Tests for AGENTS.md Runtime Overlay
 *
 * Covers: overlay generation, apply/strip roundtrip, idempotency,
 * size cap enforcement, and graceful handling of missing state.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  generateOverlay,
  applyOverlay,
  stripOverlay,
  hasOverlay,
  writeSessionModelInstructionsFile,
  removeSessionModelInstructionsFile,
  sessionModelInstructionsPath,
} from '../agents-overlay.js';

const RUNTIME_START = '<!-- OMX:RUNTIME:START -->';
const RUNTIME_END = '<!-- OMX:RUNTIME:END -->';
const WORKER_START = '<!-- OMX:TEAM:WORKER:START -->';
const WORKER_END = '<!-- OMX:TEAM:WORKER:END -->';

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

  it('uses deterministic overflow policy under size cap', async () => {
    // Inflate optional sections so overflow behavior is exercised.
    for (let i = 0; i < 40; i++) {
      await writeFile(
        join(tempDir, '.omx', 'state', `mode-${i}-state.json`),
        JSON.stringify({ active: true, iteration: i + 1, max_iterations: 99, current_phase: 'run' })
      );
    }
    await writeFile(join(tempDir, '.omx', 'notepad.md'), `## PRIORITY\n${'N'.repeat(8000)}`);
    await writeFile(
      join(tempDir, '.omx', 'project-memory.json'),
      JSON.stringify({
        techStack: 'T'.repeat(9000),
        conventions: 'C'.repeat(9000),
        directives: [{ directive: 'D'.repeat(3000), priority: 'high' }],
      })
    );

    const overlay1 = await generateOverlay(tempDir, 'overflow-session');
    const overlay2 = await generateOverlay(tempDir, 'overflow-session');

    for (const overlay of [overlay1, overlay2]) {
      assert.ok(overlay.length <= 2000, `Overlay too large: ${overlay.length} chars`);
      assert.ok(overlay.includes('**Active Modes:**'));
      assert.ok(overlay.includes('**Priority Notes:**'));
      assert.ok(overlay.includes('**Compaction Protocol:**'));
      // Lowest-priority section is dropped first.
      assert.ok(!overlay.includes('**Project Context:**'));
    }
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

  it('stripOverlay removes runtime overlay and preserves worker overlay (runtime->worker order)', async () => {
    const agentsMd = join(tempDir, 'AGENTS-stacked-rw.md');
    await writeFile(agentsMd, originalContent);

    const runtimeOverlay = await generateOverlay(tempDir, 'stacked-rw');
    await applyOverlay(agentsMd, runtimeOverlay, tempDir);

    const workerOverlay = `${WORKER_START}
<team_worker_protocol>
worker protocol body
</team_worker_protocol>
${WORKER_END}
`;
    const withRuntime = await readFile(agentsMd, 'utf-8');
    await writeFile(agentsMd, `${withRuntime.trimEnd()}\n\n${workerOverlay}`);

    await stripOverlay(agentsMd, tempDir);
    const result = await readFile(agentsMd, 'utf-8');
    assert.ok(!result.includes(RUNTIME_START));
    assert.ok(!result.includes(RUNTIME_END));
    assert.ok(result.includes(WORKER_START));
    assert.ok(result.includes(WORKER_END));
  });

  it('stripOverlay removes runtime overlay and preserves worker overlay (worker->runtime order)', async () => {
    const agentsMd = join(tempDir, 'AGENTS-stacked-wr.md');
    const workerOverlay = `${WORKER_START}
<team_worker_protocol>
worker protocol body
</team_worker_protocol>
${WORKER_END}
`;
    await writeFile(agentsMd, `${originalContent.trimEnd()}\n\n${workerOverlay}`);

    const runtimeOverlay = await generateOverlay(tempDir, 'stacked-wr');
    await applyOverlay(agentsMd, runtimeOverlay, tempDir);

    await stripOverlay(agentsMd, tempDir);
    const result = await readFile(agentsMd, 'utf-8');
    assert.ok(!result.includes(RUNTIME_START));
    assert.ok(!result.includes(RUNTIME_END));
    assert.ok(result.includes(WORKER_START));
    assert.ok(result.includes(WORKER_END));
  });

  it('stripOverlay removes duplicate runtime marker blocks', async () => {
    const agentsMd = join(tempDir, 'AGENTS-duplicate-runtime.md');
    const dup = `${originalContent.trimEnd()}

${RUNTIME_START}
<session_context>first</session_context>
${RUNTIME_END}

${RUNTIME_START}
<session_context>second</session_context>
${RUNTIME_END}
`;
    await writeFile(agentsMd, dup);
    await stripOverlay(agentsMd, tempDir);
    const result = await readFile(agentsMd, 'utf-8');
    assert.ok(!result.includes(RUNTIME_START));
    assert.ok(!result.includes(RUNTIME_END));
    assert.equal(result.trim(), originalContent.trim());
  });

  it('stripOverlay handles malformed runtime start marker without deleting worker overlay', async () => {
    const agentsMd = join(tempDir, 'AGENTS-malformed-runtime.md');
    const malformed = `${originalContent.trimEnd()}

${RUNTIME_START}
<session_context>
incomplete runtime block

${WORKER_START}
<team_worker_protocol>
worker protocol body
</team_worker_protocol>
${WORKER_END}
`;
    await writeFile(agentsMd, malformed);
    await stripOverlay(agentsMd, tempDir);
    const result = await readFile(agentsMd, 'utf-8');
    assert.ok(!result.includes(RUNTIME_START));
    assert.ok(result.includes(WORKER_START));
    assert.ok(result.includes(WORKER_END));
  });
});

describe('session-scoped model instructions file', () => {
  let tempDir: string;

  before(async () => { tempDir = await makeTempDir(); });
  after(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('writes project AGENTS.md + runtime overlay into session-scoped file', async () => {
    const projectAgentsMd = join(tempDir, 'AGENTS.md');
    const projectContent = '# Project instructions\n\nStay in scope.\n';
    await writeFile(projectAgentsMd, projectContent);

    const overlay = await generateOverlay(tempDir, 'session-a');
    const writtenPath = await writeSessionModelInstructionsFile(tempDir, 'session-a', overlay);
    const sessionContent = await readFile(writtenPath, 'utf-8');
    const projectAfter = await readFile(projectAgentsMd, 'utf-8');

    assert.equal(writtenPath, sessionModelInstructionsPath(tempDir, 'session-a'));
    assert.match(sessionContent, /# Project instructions/);
    assert.match(sessionContent, /<!-- OMX:RUNTIME:START -->/);
    assert.equal(projectAfter, projectContent);
  });

  it('writes overlay-only session file when project AGENTS.md is missing', async () => {
    await rm(join(tempDir, 'AGENTS.md'), { force: true });
    const overlay = await generateOverlay(tempDir, 'session-b');
    const writtenPath = await writeSessionModelInstructionsFile(tempDir, 'session-b', overlay);
    const sessionContent = await readFile(writtenPath, 'utf-8');

    assert.ok(sessionContent.includes('<!-- OMX:RUNTIME:START -->'));
    assert.ok(sessionContent.includes('<!-- OMX:RUNTIME:END -->'));
  });

  it('removes session-scoped file without touching project AGENTS.md', async () => {
    const projectAgentsMd = join(tempDir, 'AGENTS.md');
    const projectContent = '# Keep me unchanged\n';
    await writeFile(projectAgentsMd, projectContent);

    const overlay = await generateOverlay(tempDir, 'session-c');
    const writtenPath = await writeSessionModelInstructionsFile(tempDir, 'session-c', overlay);
    await removeSessionModelInstructionsFile(tempDir, 'session-c');

    assert.equal(existsSync(writtenPath), false);
    assert.equal(await readFile(projectAgentsMd, 'utf-8'), projectContent);
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
