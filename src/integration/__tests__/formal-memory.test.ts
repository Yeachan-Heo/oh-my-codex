import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  appendMemoryIntakeEntry,
  buildFormalProjectMemorySummary,
  buildFormalProjectMemoryView,
  readFormalMemoryContext,
  resolveStrictMemoryConfig,
} from '../formal-memory.js';

async function makeFixture() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'omx-formal-workspace-'));
  const memoryRoot = await mkdtemp(join(tmpdir(), 'omx-formal-memory-'));
  const workspaceKey = 'workspace-123';
  const memoryHome = join(memoryRoot, 'workspaces', workspaceKey);

  await mkdir(join(memoryRoot, 'workspaces'), { recursive: true });
  await writeFile(
    join(memoryRoot, 'workspaces', 'index.json'),
    JSON.stringify(
      {
        version: 1,
        workspaces: {
          [workspaceRoot.toLowerCase()]: {
            key: workspaceKey,
            path: workspaceRoot,
          },
        },
      },
      null,
      2,
    ),
  );

  await mkdir(join(memoryRoot, 'instructions', 'company'), { recursive: true });
  await mkdir(join(memoryRoot, 'instructions', 'user'), { recursive: true });
  await mkdir(join(memoryRoot, 'instructions', 'local'), { recursive: true });
  await mkdir(join(memoryHome, 'instructions', 'repo'), { recursive: true });
  await mkdir(join(memoryHome, 'memories'), { recursive: true });
  await mkdir(join(memoryHome, 'runtime'), { recursive: true });

  await writeFile(join(memoryRoot, 'instructions', 'company', 'GUIDE.md'), '# Company\nCompany guide\n');
  await writeFile(join(memoryRoot, 'instructions', 'user', 'GUIDE.md'), '# User\nUser guide\n');
  await writeFile(join(memoryRoot, 'instructions', 'local', 'GUIDE.md'), '# Local\nLocal guide\n');
  await writeFile(join(memoryHome, 'instructions', 'repo', 'GUIDE.md'), '# Repo\nUse ESM modules.\n');
  await writeFile(join(memoryHome, 'memories', 'MEMORY.md'), '# Memory\nWorkspace durable truth.\n');
  await writeFile(join(memoryHome, 'runtime', 'active_context.md'), '# Active\nCurrent task context.\n');

  return {
    workspaceRoot,
    memoryRoot,
  };
}

describe('integration/formal-memory', () => {
  it('resolves strict config from env', () => {
    const config = resolveStrictMemoryConfig({
      OMX_STRICT_MEMORY_MODE: 'true',
      OMX_EXTERNAL_MEMORY_ROOT: '/tmp/custom-memory-root',
    });

    assert.equal(config.strictMode, true);
    assert.equal(config.memoryRoot, '/tmp/custom-memory-root');
  });

  it('reads formal memory context and summary for a registered workspace', async () => {
    const fixture = await makeFixture();

    try {
      const context = await readFormalMemoryContext(fixture.workspaceRoot, {
        OMX_STRICT_MEMORY_MODE: 'true',
        OMX_EXTERNAL_MEMORY_ROOT: fixture.memoryRoot,
      });
      const summary = buildFormalProjectMemorySummary(context);
      const view = buildFormalProjectMemoryView(context);

      assert.equal(context.workspace.registered, true);
      assert.match(summary, /Current task context/);
      assert.match(summary, /Workspace durable truth/);
      assert.match(summary, /Use ESM modules/);
      assert.equal(view.source, 'formal-memory');
    } finally {
      await rm(fixture.workspaceRoot, { recursive: true, force: true });
      await rm(fixture.memoryRoot, { recursive: true, force: true });
    }
  });

  it('falls back to shared guides when the workspace is not registered', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'omx-formal-unregistered-'));
    const memoryRoot = await mkdtemp(join(tmpdir(), 'omx-formal-shared-'));

    try {
      await mkdir(join(memoryRoot, 'instructions', 'company'), { recursive: true });
      await mkdir(join(memoryRoot, 'instructions', 'user'), { recursive: true });
      await mkdir(join(memoryRoot, 'instructions', 'local'), { recursive: true });
      await writeFile(join(memoryRoot, 'instructions', 'company', 'GUIDE.md'), '# Company\nShared company guidance.\n');
      await writeFile(join(memoryRoot, 'instructions', 'user', 'GUIDE.md'), '# User\nShared user guidance.\n');
      await writeFile(join(memoryRoot, 'instructions', 'local', 'GUIDE.md'), '# Local\nShared local guidance.\n');

      const context = await readFormalMemoryContext(workspaceRoot, {
        OMX_STRICT_MEMORY_MODE: 'true',
        OMX_EXTERNAL_MEMORY_ROOT: memoryRoot,
      });
      const summary = buildFormalProjectMemorySummary(context);

      assert.equal(context.workspace.registered, false);
      assert.match(summary, /Shared company guidance/);
      assert.match(summary, /Shared user guidance/);
      assert.match(summary, /Shared local guidance/);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(memoryRoot, { recursive: true, force: true });
    }
  });

  it('downgrades durable candidates into a run-local intake queue', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'omx-formal-intake-'));

    try {
      const result = await appendMemoryIntakeEntry({
        cwd: workspaceRoot,
        kind: 'note',
        content: 'Queue this observation.',
        metadata: { category: 'architecture' },
        source: 'test',
      });

      assert.equal(existsSync(result.path), true);
      const raw = await readFile(result.path, 'utf-8');
      assert.match(raw, /Queue this observation/);
      assert.match(raw, /"kind":"note"/);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
