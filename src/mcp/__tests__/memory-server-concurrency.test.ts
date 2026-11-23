import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { __setCrossProcessPublishBarrierForTest } from '../../subagents/tracker.js';

const previous = process.env.OMX_MCP_SERVER_DISABLE_AUTO_START;
process.env.OMX_MCP_SERVER_DISABLE_AUTO_START = '1';
const { handleMemoryToolCall } = await import('../memory-server.js');
if (previous === undefined) delete process.env.OMX_MCP_SERVER_DISABLE_AUTO_START;
else process.env.OMX_MCP_SERVER_DISABLE_AUTO_START = previous;

function call(cwd: string, name: string, args: Record<string, unknown>) {
  return handleMemoryToolCall({ params: { name, arguments: { workingDirectory: cwd, ...args } } });
}

it('preserves private memory permissions, including the unpublished staging file', { skip: process.platform === 'win32' }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-memory-private-'));
  const previousUmask = process.umask(0o022);
  try {
    await call(cwd, 'project_memory_write', { memory: { notes: [] } });
    const path = join(cwd, '.omx/project-memory.json');
    await chmod(path, 0o600);
    let inspected = false;
    __setCrossProcessPublishBarrierForTest(() => {
      const stages = readdirSync(join(cwd, '.omx')).filter((name) => name.startsWith('project-memory.json.stage.'));
      assert.equal(stages.length, 1);
      const stage = join(cwd, '.omx', stages[0]);
      assert.ok(readFileSync(stage, 'utf8').includes('private-memory-fixture'));
      assert.equal(statSync(stage).mode & 0o777, 0o600);
      inspected = true;
    });
    await call(cwd, 'project_memory_add_note', { category: 'test', content: 'private-memory-fixture' });
    assert.equal(inspected, true);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    __setCrossProcessPublishBarrierForTest(null);
    process.umask(previousUmask);
    await rm(cwd, { recursive: true, force: true });
  }
});

it('retains an existing memory file mode after atomic publication', { skip: process.platform === 'win32' }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-memory-mode-'));
  try {
    await call(cwd, 'project_memory_write', { memory: { notes: [] } });
    const path = join(cwd, '.omx/project-memory.json');
    for (const mode of [0o600, 0o640]) {
      await chmod(path, mode);
      await call(cwd, 'project_memory_add_directive', { directive: 'keep' });
      assert.equal((await stat(path)).mode & 0o777, mode);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it('preserves concurrent memory changes and independent notepad sections', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-memory-concurrent-'));
  try {
    await call(cwd, 'project_memory_write', { memory: { techStack: 'keep', notes: [] } });
    await Promise.all(Array.from({ length: 20 }, (_, index) => call(cwd, 'project_memory_add_note', { category: 'test', content: `note-${index}` })));
    const memory = JSON.parse(await readFile(join(cwd, '.omx/project-memory.json'), 'utf8'));
    assert.equal(memory.notes.length, 20);
    assert.equal(memory.techStack, 'keep');
    await Promise.all([
      call(cwd, 'notepad_write_priority', { content: 'priority' }),
      ...Array.from({ length: 10 }, (_, index) => call(cwd, 'notepad_write_manual', { content: `manual-${index}` })),
      call(cwd, 'notepad_write_working', { content: 'working' }),
    ]);
    const notepad = await readFile(join(cwd, '.omx/notepad.md'), 'utf8');
    for (const content of ['priority', 'working', ...Array.from({ length: 10 }, (_, index) => `manual-${index}`)]) assert.ok(notepad.includes(content), content);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it('preserves appends from separate MCP processes', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-memory-processes-'));
  try {
    await call(cwd, 'project_memory_write', { memory: { notes: [], directives: [], techStack: 'keep' } });
    const moduleUrl = new URL('../memory-server.js', import.meta.url).href;
    await Promise.all(Array.from({ length: 4 }, (_, worker) => new Promise<void>((resolve, reject) => {
      const code = `import {handleMemoryToolCall as call} from ${JSON.stringify(moduleUrl)}; for(let i=0;i<5;i++) { await call({params:{name:'project_memory_add_note',arguments:{workingDirectory:${JSON.stringify(cwd)},category:'test',content:${JSON.stringify(`worker-${worker}`)}+'-'+i}}}); await call({params:{name:'project_memory_add_directive',arguments:{workingDirectory:${JSON.stringify(cwd)},directive:${JSON.stringify(`worker-${worker}`)}+'-'+i}}}); await call({params:{name:'project_memory_write',arguments:{workingDirectory:${JSON.stringify(cwd)},merge:true,memory:{[${JSON.stringify(`worker-${worker}`)}]:i}}}}); await call({params:{name:'notepad_write_manual',arguments:{workingDirectory:${JSON.stringify(cwd)},content:${JSON.stringify(`worker-${worker}`)}+'-'+i}}}); }`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, OMX_MCP_SERVER_DISABLE_AUTO_START: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', (code) => code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`)));
    })));
    const memory = JSON.parse(await readFile(join(cwd, '.omx/project-memory.json'), 'utf8'));
    assert.equal(memory.notes.length, 20);
    assert.equal(memory.directives.length, 20);
    assert.equal(memory.techStack, 'keep');
    for (let worker = 0; worker < 4; worker++) assert.equal(memory[`worker-${worker}`], 4);
    const notepad = await readFile(join(cwd, '.omx/notepad.md'), 'utf8');
    assert.equal((notepad.match(/worker-\d-\d/g) ?? []).length, 20);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it('does not replace corrupt memory during an append or merge', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-memory-corrupt-'));
  try {
    await call(cwd, 'project_memory_write', { memory: {} });
    const path = join(cwd, '.omx/project-memory.json');
    for (const invalid of ['{invalid', 'null', '[]', '42']) {
      await writeFile(path, invalid);
      for (const [name, args] of [
        ['project_memory_add_note', { category: 'test', content: 'note' }],
        ['project_memory_add_directive', { directive: 'keep' }],
        ['project_memory_write', { memory: { build: 'new' }, merge: true }],
      ] as const) {
        await assert.rejects(call(cwd, name, args));
        assert.equal(await readFile(path, 'utf8'), invalid);
      }
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
