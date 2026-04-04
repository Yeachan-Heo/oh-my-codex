import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

async function makeFixture() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'omx-memory-server-workspace-'));
  const memoryRoot = await mkdtemp(join(tmpdir(), 'omx-memory-server-memory-'));
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

  await mkdir(join(memoryHome, 'instructions', 'repo'), { recursive: true });
  await mkdir(join(memoryHome, 'memories'), { recursive: true });
  await mkdir(join(memoryHome, 'runtime'), { recursive: true });
  await writeFile(join(memoryHome, 'instructions', 'repo', 'GUIDE.md'), '# Repo\nUse pnpm.\n');
  await writeFile(join(memoryHome, 'memories', 'MEMORY.md'), '# Memory\nWorkspace durable truth.\n');
  await writeFile(join(memoryHome, 'runtime', 'active_context.md'), '# Active\nCurrent task context.\n');
  await mkdir(join(workspaceRoot, '.omx'), { recursive: true });
  await writeFile(
    join(workspaceRoot, '.omx', 'project-memory.json'),
    JSON.stringify({ techStack: 'Legacy local memory' }, null, 2),
  );

  return {
    workspaceRoot,
    memoryRoot,
  };
}

async function loadMemoryServerModule() {
  const previous = process.env.OMX_MEMORY_SERVER_DISABLE_AUTO_START;
  process.env.OMX_MEMORY_SERVER_DISABLE_AUTO_START = '1';
  try {
    return await import(`../memory-server.js?strict-memory-test=${Date.now()}-${Math.random()}`);
  } finally {
    if (typeof previous === 'string') process.env.OMX_MEMORY_SERVER_DISABLE_AUTO_START = previous;
    else delete process.env.OMX_MEMORY_SERVER_DISABLE_AUTO_START;
  }
}

function parseToolPayload(result: { content: Array<{ text: string }>; isError?: boolean }) {
  return {
    ...result,
    data: JSON.parse(result.content[0].text),
  };
}

describe('mcp/memory-server strict mode behavior', () => {
  it('reads formal memory instead of local project-memory.json in strict mode', async () => {
    const fixture = await makeFixture();

    try {
      const mod = await loadMemoryServerModule();
      const result = parseToolPayload(
        await mod.handleMemoryToolCall(
          'project_memory_read',
          {
            workingDirectory: fixture.workspaceRoot,
          },
          {
            OMX_STRICT_MEMORY_MODE: 'true',
            OMX_EXTERNAL_MEMORY_ROOT: fixture.memoryRoot,
          },
        ),
      );

      assert.equal(result.isError, undefined);
      assert.equal(result.data.source, 'formal-memory');
      assert.match(result.data.summary, /Current task context/);
      assert.doesNotMatch(JSON.stringify(result.data), /Legacy local memory/);
    } finally {
      await rm(fixture.workspaceRoot, { recursive: true, force: true });
      await rm(fixture.memoryRoot, { recursive: true, force: true });
    }
  });

  it('denies direct project_memory_write in strict mode', async () => {
    const fixture = await makeFixture();

    try {
      const mod = await loadMemoryServerModule();
      const result = parseToolPayload(
        await mod.handleMemoryToolCall(
          'project_memory_write',
          {
            workingDirectory: fixture.workspaceRoot,
            memory: { should: 'not persist' },
          },
          {
            OMX_STRICT_MEMORY_MODE: 'true',
            OMX_EXTERNAL_MEMORY_ROOT: fixture.memoryRoot,
          },
        ),
      );

      assert.equal(result.isError, true);
      assert.equal(result.data.decision, 'deny');

      const localRaw = await readFile(join(fixture.workspaceRoot, '.omx', 'project-memory.json'), 'utf-8');
      assert.match(localRaw, /Legacy local memory/);
      assert.doesNotMatch(localRaw, /should/);
    } finally {
      await rm(fixture.workspaceRoot, { recursive: true, force: true });
      await rm(fixture.memoryRoot, { recursive: true, force: true });
    }
  });

  it('downgrades project_memory_add_note into memory-intake.jsonl in strict mode', async () => {
    const fixture = await makeFixture();

    try {
      const mod = await loadMemoryServerModule();
      const result = parseToolPayload(
        await mod.handleMemoryToolCall(
          'project_memory_add_note',
          {
            workingDirectory: fixture.workspaceRoot,
            category: 'architecture',
            content: 'Queue this note.',
          },
          {
            OMX_STRICT_MEMORY_MODE: 'true',
            OMX_EXTERNAL_MEMORY_ROOT: fixture.memoryRoot,
          },
        ),
      );

      assert.equal(result.data.decision, 'downgrade');
      assert.equal(existsSync(join(fixture.workspaceRoot, '.omx', 'memory-intake.jsonl')), true);
      const intakeRaw = await readFile(join(fixture.workspaceRoot, '.omx', 'memory-intake.jsonl'), 'utf-8');
      assert.match(intakeRaw, /Queue this note/);
    } finally {
      await rm(fixture.workspaceRoot, { recursive: true, force: true });
      await rm(fixture.memoryRoot, { recursive: true, force: true });
    }
  });

  it('downgrades project_memory_add_directive into memory-intake.jsonl in strict mode', async () => {
    const fixture = await makeFixture();

    try {
      const mod = await loadMemoryServerModule();
      const result = parseToolPayload(
        await mod.handleMemoryToolCall(
          'project_memory_add_directive',
          {
            workingDirectory: fixture.workspaceRoot,
            directive: 'Keep promotion gated.',
            priority: 'high',
            context: 'review',
          },
          {
            OMX_STRICT_MEMORY_MODE: 'true',
            OMX_EXTERNAL_MEMORY_ROOT: fixture.memoryRoot,
          },
        ),
      );

      assert.equal(result.data.decision, 'downgrade');
      const intakeRaw = await readFile(join(fixture.workspaceRoot, '.omx', 'memory-intake.jsonl'), 'utf-8');
      assert.match(intakeRaw, /Keep promotion gated/);
      assert.match(intakeRaw, /"kind":"directive"/);
    } finally {
      await rm(fixture.workspaceRoot, { recursive: true, force: true });
      await rm(fixture.memoryRoot, { recursive: true, force: true });
    }
  });
});
