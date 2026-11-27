import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const previous = process.env.OMX_MCP_SERVER_DISABLE_AUTO_START;
process.env.OMX_MCP_SERVER_DISABLE_AUTO_START = '1';
const { handleMemoryToolCall, filterActiveDirectives } = await import('../memory-server.js');
if (previous === undefined) delete process.env.OMX_MCP_SERVER_DISABLE_AUTO_START;
else process.env.OMX_MCP_SERVER_DISABLE_AUTO_START = previous;

function call(cwd: string, name: string, args: Record<string, unknown>) {
  return handleMemoryToolCall({ params: { name, arguments: { workingDirectory: cwd, ...args } } });
}

function extractText(response: unknown): any {
  if (typeof response === 'object' && response !== null && 'content' in response) {
    const content = (response as any).content;
    if (Array.isArray(content) && content.length > 0 && 'text' in content[0]) {
      return JSON.parse((content as any)[0].text);
    }
  }
  return null;
}

describe('directive lifecycle (list, remove, expiry)', () => {
  it('lists all active directives', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-directives-list-'));
    try {
      // Add some directives
      await call(cwd, 'project_memory_add_directive', { directive: 'First directive', priority: 'high' });
      await call(cwd, 'project_memory_add_directive', { directive: 'Second directive', priority: 'normal' });
      await call(cwd, 'project_memory_add_directive', { directive: 'Third directive', priority: 'high' });

      // List all directives
      const response = await call(cwd, 'project_memory_list_directives', {});
      const result = extractText(response);

      assert.ok(result, 'should return a response');
      assert.ok(Array.isArray(result.directives), 'should have directives array');
      assert.equal(result.directives.length, 3, 'should have 3 directives');
      assert.equal(result.active, 3, 'should show 3 active directives');
      assert.equal(result.expired, 0, 'should show 0 expired directives');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('filters directives by priority', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-directives-priority-'));
    try {
      // Add directives with different priorities
      await call(cwd, 'project_memory_add_directive', { directive: 'High priority 1', priority: 'high' });
      await call(cwd, 'project_memory_add_directive', { directive: 'Normal priority', priority: 'normal' });
      await call(cwd, 'project_memory_add_directive', { directive: 'High priority 2', priority: 'high' });

      // List only high-priority directives
      const response = await call(cwd, 'project_memory_list_directives', { priority: 'high' });
      const result = extractText(response);

      assert.ok(result, 'should return a response');
      assert.equal(result.directives.length, 2, 'should have 2 high-priority directives');
      assert.equal(result.active, 3, 'should show 3 total active directives');

      // List only normal-priority directives
      const response2 = await call(cwd, 'project_memory_list_directives', { priority: 'normal' });
      const result2 = extractText(response2);
      assert.equal(result2.directives.length, 1, 'should have 1 normal-priority directive');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('removes directive by index', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-directives-remove-'));
    try {
      // Add some directives
      await call(cwd, 'project_memory_add_directive', { directive: 'Remove me', priority: 'normal' });
      await call(cwd, 'project_memory_add_directive', { directive: 'Keep me', priority: 'normal' });

      // List to get index
      const listResponse = await call(cwd, 'project_memory_list_directives', {});
      const listResult = extractText(listResponse);
      assert.equal(listResult.directives.length, 2);

      // Remove by index
      const removeResponse = await call(cwd, 'project_memory_remove_directive', { index: 0 });
      const removeResult = extractText(removeResponse);

      assert.ok(removeResult.success, 'remove should succeed');
      assert.equal(removeResult.removed.directive, 'Remove me');
      assert.equal(removeResult.remaining, 1);

      // Verify only one directive remains
      const verifyResponse = await call(cwd, 'project_memory_list_directives', {});
      const verifyResult = extractText(verifyResponse);
      assert.equal(verifyResult.directives.length, 1);
      assert.equal(verifyResult.directives[0].directive, 'Keep me');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('removes directive by text match', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-directives-remove-text-'));
    try {
      // Add some directives
      await call(cwd, 'project_memory_add_directive', { directive: 'Find and remove this one', priority: 'normal' });
      await call(cwd, 'project_memory_add_directive', { directive: 'Keep this one', priority: 'normal' });

      // Remove by text match
      const removeResponse = await call(cwd, 'project_memory_remove_directive', { text: 'Find and remove' });
      const removeResult = extractText(removeResponse);

      assert.ok(removeResult.success, 'remove should succeed');
      assert.ok(removeResult.removed.directive.includes('Find and remove'));

      // Verify only one directive remains
      const verifyResponse = await call(cwd, 'project_memory_list_directives', {});
      const verifyResult = extractText(verifyResponse);
      assert.equal(verifyResult.directives.length, 1);
      assert.equal(verifyResult.directives[0].directive, 'Keep this one');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('supports directive expiry timestamps', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-directives-expiry-'));
    try {
      const now = new Date();
      const future = new Date(now.getTime() + 10 * 60 * 1000); // 10 minutes from now
      const past = new Date(now.getTime() - 10 * 60 * 1000); // 10 minutes ago

      // Add directives with different expiry times
      await call(cwd, 'project_memory_add_directive', {
        directive: 'Active directive (no expiry)',
        priority: 'normal',
      });
      await call(cwd, 'project_memory_add_directive', {
        directive: 'Future expiry directive',
        priority: 'normal',
        expiresAt: future.toISOString(),
      });
      await call(cwd, 'project_memory_add_directive', {
        directive: 'Expired directive',
        priority: 'normal',
        expiresAt: past.toISOString(),
      });

      // List directives - should exclude expired ones
      const response = await call(cwd, 'project_memory_list_directives', {});
      const result = extractText(response);

      assert.equal(result.active, 2, 'should have 2 active directives');
      assert.equal(result.expired, 1, 'should have 1 expired directive');
      assert.equal(result.directives.length, 2, 'list should only show active directives');

      // Verify expired directive is excluded
      const directiveTexts = result.directives.map((d: any) => d.directive);
      assert.ok(directiveTexts.some((t: string) => t.includes('Active directive')));
      assert.ok(directiveTexts.some((t: string) => t.includes('Future expiry')));
      assert.ok(!directiveTexts.some((t: string) => t.includes('Expired')));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('running session sees updated directives immediately', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-directives-session-'));
    try {
      // Add initial directive
      await call(cwd, 'project_memory_add_directive', { directive: 'Initial directive', priority: 'normal' });

      // List directives
      const response1 = await call(cwd, 'project_memory_list_directives', {});
      const result1 = extractText(response1);
      assert.equal(result1.active, 1);

      // Add another directive
      await call(cwd, 'project_memory_add_directive', { directive: 'Added directive', priority: 'high' });

      // List again - should immediately see the new directive
      const response2 = await call(cwd, 'project_memory_list_directives', {});
      const result2 = extractText(response2);
      assert.equal(result2.active, 2, 'session should immediately see new directive');

      // Remove a directive
      await call(cwd, 'project_memory_remove_directive', { index: 0 });

      // List again - should immediately reflect the removal
      const response3 = await call(cwd, 'project_memory_list_directives', {});
      const result3 = extractText(response3);
      assert.equal(result3.active, 1, 'session should immediately see directive removal');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('filters out expired directives in read operation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-directives-read-filter-'));
    try {
      const now = new Date();
      const past = new Date(now.getTime() - 10 * 60 * 1000);

      // Create memory with expired and active directives
      const memPath = join(cwd, '.omx', 'project-memory.json');
      await mkdir(join(cwd, '.omx'), { recursive: true });
      await writeFile(memPath, JSON.stringify({
        directives: [
          { directive: 'Active', priority: 'normal', timestamp: now.toISOString() },
          { directive: 'Expired', priority: 'normal', timestamp: now.toISOString(), expiresAt: past.toISOString() },
        ],
      }), 'utf8');

      // Read and check filtering
      const response = await call(cwd, 'project_memory_read', { section: 'directives' });
      const result = extractText(response);

      // Raw read should include all directives
      assert.equal(result.length, 2, 'raw read shows all directives');

      // But list operation should filter
      const listResponse = await call(cwd, 'project_memory_list_directives', {});
      const listResult = extractText(listResponse);
      assert.equal(listResult.active, 1, 'list operation shows only active directives');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('filterActiveDirectives utility function works correctly', () => {
    const now = new Date();
    const future = new Date(now.getTime() + 10 * 60 * 1000);
    const past = new Date(now.getTime() - 10 * 60 * 1000);

    const directives = [
      { directive: 'Active 1', priority: 'normal', timestamp: now.toISOString() },
      { directive: 'Active 2', priority: 'high', timestamp: now.toISOString(), expiresAt: future.toISOString() },
      { directive: 'Expired', priority: 'normal', timestamp: now.toISOString(), expiresAt: past.toISOString() },
    ] as any;

    const filtered = filterActiveDirectives(directives);
    assert.equal(filtered.length, 2, 'should have 2 active directives');
    assert.ok(filtered.every((d: any) => !d.expiresAt || d.expiresAt > now.toISOString()));
  });

  it('handles empty directives list', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-directives-empty-'));
    try {
      // List from empty memory
      const response = await call(cwd, 'project_memory_list_directives', {});
      const result = extractText(response);

      assert.equal(result.directives.length, 0);
      assert.equal(result.active, 0);
      assert.equal(result.expired, 0);

      // Try to remove from empty list
      const removeResponse = await call(cwd, 'project_memory_remove_directive', { index: 0 });
      const removeResult = extractText(removeResponse);
      assert.equal(removeResult.success, false);
      assert.ok(removeResult.message.includes('No') && (removeResult.message.includes('found') || removeResult.message.includes('matching')));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
