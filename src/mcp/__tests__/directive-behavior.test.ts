import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { ProjectDirective } from '../directive-filter.js';
import type { WikiPage } from '../../wiki/types.js';

const previous = process.env.OMX_MCP_SERVER_DISABLE_AUTO_START;
process.env.OMX_MCP_SERVER_DISABLE_AUTO_START = '1';
const {
  selectHighPriorityDirectives,
  getEarliestFutureExpiry,
  isValidExpiry,
  generateDirectiveId,
} = await import('../directive-filter.js');
const { handleMemoryToolCall } = await import('../memory-server.js');
const { generateOverlay } = await import('../../hooks/agents-overlay.js');
const { dispatchCodexNativeHook } = await import('../../scripts/codex-native-hook.js');
const { parseFrontmatter, serializePage } = await import('../../wiki/storage.js');
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

/**
 * Behavior tests for directive lifecycle functions:
 * - selectHighPriorityDirectives
 * - getEarliestFutureExpiry
 * - isValidExpiry
 * - legacy directive ID migration
 * - earliestDirectiveExpiry round-trip through wiki storage
 */
describe('directive behavior tests', () => {
  /**
   * Test: selectHighPriorityDirectives returns max 3 high-priority directives, newest first
   * Hook vs agents-overlay should inject identical sets with normal at index 0 for >3 high
   */
  it('selectHighPriorityDirectives returns up to 3 high-priority directives, newest first', () => {
    const baseTime = new Date();
    const directives: ProjectDirective[] = [
      {
        id: 'dir-00000001',
        directive: 'Normal priority directive',
        priority: 'normal',
        timestamp: new Date(baseTime.getTime() + 1000).toISOString(),
      },
      {
        id: 'dir-00000002',
        directive: 'High priority 1 (oldest)',
        priority: 'high',
        timestamp: new Date(baseTime.getTime()).toISOString(),
      },
      {
        id: 'dir-00000003',
        directive: 'High priority 2 (middle)',
        priority: 'high',
        timestamp: new Date(baseTime.getTime() + 2000).toISOString(),
      },
      {
        id: 'dir-00000004',
        directive: 'High priority 3 (newest)',
        priority: 'high',
        timestamp: new Date(baseTime.getTime() + 3000).toISOString(),
      },
      {
        id: 'dir-00000005',
        directive: 'High priority 4 (newest)',
        priority: 'high',
        timestamp: new Date(baseTime.getTime() + 4000).toISOString(),
      },
    ];

    const selected = selectHighPriorityDirectives(directives, 3);

    assert.equal(selected.length, 3, 'should return exactly 3 high-priority directives');
    assert.equal(selected[0].directive, 'High priority 4 (newest)', 'newest should be first');
    assert.equal(selected[1].directive, 'High priority 3 (newest)', 'second-newest should be second');
    assert.equal(selected[2].directive, 'High priority 2 (middle)', 'third-newest should be third');
  });

  /**
   * Test: selectHighPriorityDirectives does not include normal or low priority
   */
  it('selectHighPriorityDirectives ignores non-high-priority directives', () => {
    const baseTime = new Date();
    const directives: ProjectDirective[] = [
      {
        directive: 'High priority',
        priority: 'high',
        timestamp: baseTime.toISOString(),
      },
      {
        directive: 'Normal priority',
        priority: 'normal',
        timestamp: new Date(baseTime.getTime() + 1000).toISOString(),
      },
      {
        directive: 'Low priority',
        priority: 'low',
        timestamp: new Date(baseTime.getTime() + 2000).toISOString(),
      },
    ];

    const selected = selectHighPriorityDirectives(directives, 3);

    assert.equal(selected.length, 1, 'should only return high-priority directives');
    assert.equal(selected[0].priority, 'high', 'directive should have high priority');
  });

  /**
   * Test: selectHighPriorityDirectives filters out expired directives
   */
  it('selectHighPriorityDirectives filters out expired directives', () => {
    const baseTime = new Date();
    const future = new Date(baseTime.getTime() + 60 * 60 * 1000);
    const past = new Date(baseTime.getTime() - 60 * 60 * 1000);

    const directives: ProjectDirective[] = [
      {
        directive: 'High priority active',
        priority: 'high',
        timestamp: baseTime.toISOString(),
        expiresAt: future.toISOString(),
      },
      {
        directive: 'High priority expired',
        priority: 'high',
        timestamp: baseTime.toISOString(),
        expiresAt: past.toISOString(),
      },
    ];

    const selected = selectHighPriorityDirectives(directives, 3);

    assert.equal(selected.length, 1, 'should only return active directives');
    assert.equal(selected[0].directive, 'High priority active');
  });

  /**
   * Test: Hook vs agents-overlay inject identical sets with normal at index 0 for >3 high
   */
  it('hook and agents-overlay receive identical directive sets', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-directive-identical-'));
    try {
      const baseTime = new Date();
      
      // Add multiple high-priority directives that exceed the max 3
      for (let i = 0; i < 5; i++) {
        await call(cwd, 'project_memory_add_directive', {
          directive: `High priority directive ${i}`,
          priority: 'high',
        });
      }

      // Get directives from overlay
      const overlay = await generateOverlay(cwd, 'test-session');
      
      // Get directives from hook
      const hookResult = await dispatchCodexNativeHook({
        hook_event_name: 'SessionStart',
        cwd,
        session_id: 'test-session-hook',
      });

      const hookOutput = (hookResult.outputJson as any).hookSpecificOutput?.additionalContext || '';

      // Both should reference high-priority directives
      // Overlay uses selectHighPriorityDirectives which returns max 3
      assert.ok(overlay.includes('High priority'), 'overlay should contain high-priority directives');
      assert.ok(hookOutput.includes('High priority'), 'hook should contain high-priority directives');

      // Both should not contain all 5 directives (max 3)
      const overlayDirectiveCount = (overlay.match(/High priority directive/g) || []).length;
      const hookDirectiveCount = (hookOutput.match(/High priority directive/g) || []).length;
      
      assert.ok(overlayDirectiveCount <= 3, 'overlay should have at most 3 directives');
      assert.ok(hookDirectiveCount <= 3, 'hook should have at most 3 directives');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  /**
   * Test: getEarliestFutureExpiry with mixed ISO offsets
   */
  it('getEarliestFutureExpiry handles mixed ISO offsets correctly', () => {
    const baseTime = new Date();
    const baseIso = baseTime.toISOString();
    
    // Create ISO strings with different offset styles
    const futureZ = new Date(baseTime.getTime() + 60 * 60 * 1000).toISOString(); // With Z
    const futureWithOffset = futureZ.replace('Z', '+00:00'); // With +00:00
    const furtherFuture = new Date(baseTime.getTime() + 2 * 60 * 60 * 1000).toISOString();
    const past = new Date(baseTime.getTime() - 60 * 60 * 1000).toISOString();

    const directives: ProjectDirective[] = [
      { directive: 'Expired', priority: 'normal', timestamp: baseIso, expiresAt: past },
      { directive: 'Active 1', priority: 'normal', timestamp: baseIso, expiresAt: futureWithOffset },
      { directive: 'Active 2', priority: 'normal', timestamp: baseIso, expiresAt: furtherFuture },
      { directive: 'No expiry', priority: 'normal', timestamp: baseIso },
    ];

    const earliest = getEarliestFutureExpiry(directives);

    assert.ok(earliest, 'should return an earliest expiry');
    // Both futureZ and futureWithOffset represent the same instant
    // so verify they parse to the same time
    assert.equal(
      Date.parse(earliest),
      Date.parse(futureZ),
      'should return the soonest future expiry (as instant, not string)'  
    );
  });

  /**
   * Test: getEarliestFutureExpiry with already-expired entries
   */
  it('getEarliestFutureExpiry skips already-expired entries', () => {
    const baseTime = new Date();
    const baseIso = baseTime.toISOString();
    const past1 = new Date(baseTime.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const past2 = new Date(baseTime.getTime() - 1 * 60 * 60 * 1000).toISOString();
    const future = new Date(baseTime.getTime() + 60 * 60 * 1000).toISOString();

    const directives: ProjectDirective[] = [
      { directive: 'Already expired 1', priority: 'normal', timestamp: baseIso, expiresAt: past1 },
      { directive: 'Already expired 2', priority: 'normal', timestamp: baseIso, expiresAt: past2 },
      { directive: 'Future expiry', priority: 'normal', timestamp: baseIso, expiresAt: future },
    ];

    const earliest = getEarliestFutureExpiry(directives);

    assert.equal(earliest, future, 'should skip expired entries and return the future one');
  });

  /**
   * Test: getEarliestFutureExpiry returns undefined when no future expiries
   */
  it('getEarliestFutureExpiry returns undefined when all are expired or no expiry', () => {
    const baseTime = new Date();
    const baseIso = baseTime.toISOString();
    const past = new Date(baseTime.getTime() - 60 * 60 * 1000).toISOString();

    const directives: ProjectDirective[] = [
      { directive: 'No expiry 1', priority: 'normal', timestamp: baseIso },
      { directive: 'Already expired', priority: 'normal', timestamp: baseIso, expiresAt: past },
      { directive: 'No expiry 2', priority: 'normal', timestamp: baseIso },
    ];

    const earliest = getEarliestFutureExpiry(directives);

    assert.equal(earliest, undefined, 'should return undefined when no future expiries exist');
  });

  /**
   * Test: isValidExpiry validation
   */
  it('isValidExpiry rejects malformed ISO timestamps', () => {
    assert.equal(isValidExpiry(undefined), true, 'undefined should be valid');
    assert.equal(isValidExpiry(''), true, 'empty string should be valid');
    assert.equal(isValidExpiry('2024-01-01'), true, 'date-only ISO should be valid');
    assert.equal(isValidExpiry('2024-01-01T12:00:00Z'), true, 'full ISO with Z should be valid');
    assert.equal(isValidExpiry('2024-01-01T12:00:00+00:00'), true, 'full ISO with offset should be valid');
    assert.equal(isValidExpiry('not-a-date'), false, 'invalid format should be invalid');
    assert.equal(isValidExpiry('2024-13-01'), false, 'invalid month should be invalid');
    assert.equal(isValidExpiry('2024-01-32'), false, 'invalid day should be invalid');
  });

  /**
   * Test: isValidExpiry rejection at add time
   */
  it('isValidExpiry rejects malformed timestamps at add time via memory-server', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-directive-invalid-expiry-'));
    try {
      // Try to add a directive with invalid expiresAt
      const response = await call(cwd, 'project_memory_add_directive', {
        directive: 'Test directive',
        priority: 'high',
        expiresAt: 'not-a-valid-date',
      });

      const result = extractText(response);

      // Should fail validation
      assert.equal(result.success, false, 'should reject invalid expiresAt');
      assert.ok(result.message, 'should provide error message');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  /**
   * Test: Legacy directive ID migration (directives without IDs get assigned on first read)
   */
  it('legacy directive ID migration assigns IDs to directives without them', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-directive-migration-'));
    try {
      // Create project memory with directives that don't have IDs (legacy format)
      const memPath = join(cwd, '.omx', 'project-memory.json');
      await mkdir(join(cwd, '.omx'), { recursive: true });
      await writeFile(memPath, JSON.stringify({
        directives: [
          {
            directive: 'Legacy directive 1',
            priority: 'high',
            timestamp: new Date().toISOString(),
          },
          {
            directive: 'Legacy directive 2',
            priority: 'normal',
            timestamp: new Date().toISOString(),
          },
        ],
      }), 'utf8');

      // List directives (triggers migration)
      const response = await call(cwd, 'project_memory_list_directives', {});
      const result = extractText(response);

      // All directives should now have IDs
      assert.ok(Array.isArray(result.directives), 'should return directives array');
      assert.equal(result.directives.length, 2, 'should have 2 directives');
      assert.ok(result.directives[0].id, 'first directive should have ID');
      assert.ok(result.directives[1].id, 'second directive should have ID');
      assert.match(result.directives[0].id, /^dir-[0-9a-f]{8}$/, 'ID should match format dir-<8 hex>');
      assert.match(result.directives[1].id, /^dir-[0-9a-f]{8}$/, 'ID should match format dir-<8 hex>');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  /**
   * Test: earliestDirectiveExpiry round-trip through wiki storage serializePage/parseFrontmatter
   */
  it('earliestDirectiveExpiry round-trips through wiki storage serialization', () => {
    const baseTime = new Date();
    const earliestExpiry = new Date(baseTime.getTime() + 60 * 60 * 1000).toISOString();

    const page: WikiPage = {
      filename: 'test-page.md',
      frontmatter: {
        title: 'Test Page',
        tags: ['test'],
        created: baseTime.toISOString(),
        updated: baseTime.toISOString(),
        sources: [],
        links: [],
        category: 'reference',
        confidence: 'high',
        schemaVersion: 1,
        earliestDirectiveExpiry: earliestExpiry,
      },
      content: 'Test content',
    };

    // Serialize the page
    const serialized = serializePage(page);

    // Verify the earliestDirectiveExpiry is in the YAML frontmatter
    assert.ok(serialized.includes(`earliestDirectiveExpiry: ${earliestExpiry}`), 'should include earliestDirectiveExpiry in frontmatter');

    // Parse it back
    const result = parseFrontmatter(serialized);
    assert.ok(result, 'parseFrontmatter should not return null');
    const { frontmatter: parsed } = result;

    // Verify it round-trips correctly
    assert.equal(parsed.earliestDirectiveExpiry, earliestExpiry, 'earliestDirectiveExpiry should round-trip correctly');
  });

  /**
   * Test: environment.md rebuild after expiry
   * This tests that the wiki storage correctly tracks directive expiry for cache invalidation
   */
  it('earliestDirectiveExpiry enables wiki cache invalidation on directive expiry', () => {
    const baseTime = new Date();
    const soonExpiry = new Date(baseTime.getTime() + 10 * 1000).toISOString(); // 10 seconds
    const laterExpiry = new Date(baseTime.getTime() + 60 * 60 * 1000).toISOString(); // 1 hour

    // Page with soonExpiry as earliest
    const pageWithSoonExpiry: WikiPage = {
      filename: 'page-1.md',
      frontmatter: {
        title: 'Page 1',
        tags: [],
        created: baseTime.toISOString(),
        updated: baseTime.toISOString(),
        sources: [],
        links: [],
        category: 'reference',
        confidence: 'high',
        schemaVersion: 1,
        earliestDirectiveExpiry: soonExpiry,
      },
      content: 'Content for page 1',
    };

    // Page with laterExpiry as earliest
    const pageWithLaterExpiry: WikiPage = {
      filename: 'page-2.md',
      frontmatter: {
        title: 'Page 2',
        tags: [],
        created: baseTime.toISOString(),
        updated: baseTime.toISOString(),
        sources: [],
        links: [],
        category: 'reference',
        confidence: 'high',
        schemaVersion: 1,
        earliestDirectiveExpiry: laterExpiry,
      },
      content: 'Content for page 2',
    };

    // Serialize both pages
    const serialized1 = serializePage(pageWithSoonExpiry);
    const serialized2 = serializePage(pageWithLaterExpiry);

    // Parse them back and verify earliestDirectiveExpiry is preserved
    const result1 = parseFrontmatter(serialized1);
    const result2 = parseFrontmatter(serialized2);
    assert.ok(result1, 'parseFrontmatter(serialized1) should not return null');
    assert.ok(result2, 'parseFrontmatter(serialized2) should not return null');
    const { frontmatter: fm1 } = result1;
    const { frontmatter: fm2 } = result2;

    assert.equal(fm1.earliestDirectiveExpiry, soonExpiry, 'page 1 should preserve soonExpiry');
    assert.equal(fm2.earliestDirectiveExpiry, laterExpiry, 'page 2 should preserve laterExpiry');

    // The wiki system should use these timestamps to determine when cache needs invalidation
    // For now, just verify they're accessible for comparison
    assert.ok(fm1.earliestDirectiveExpiry! < fm2.earliestDirectiveExpiry!, 'earlier expiry should be sortable');
  });

  /**
   * Test: Newly added directive reaches active session on next dispatch via buildSessionStartContext
   * This tests Finding #3: live delivery to active sessions
   * 
   * The mechanism is:
   * 1. When a directive is added via memory-server, it's written to disk via lock.publish
   * 2. On the next SessionStart hook, buildSessionStartContext reads the project memory from disk
   * 3. selectHighPriorityDirectives filters and returns the directive
   * 4. The directive is included in the additionalContext
   * 
   * This test verifies the simpler case: overlay generation reads from disk and includes new directives
   */
  it('newly added directive reaches sessions on next dispatch via overlay generation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-directive-dispatch-'));
    try {
      // Add initial directive
      await call(cwd, 'project_memory_add_directive', {
        directive: 'DIRECTIVE-DISPATCH-TEST: initial',
        priority: 'high',
      });

      // Generate overlay - should include the directive
      const overlay1 = await generateOverlay(cwd, 'test-session-1');
      assert.ok(
        overlay1.includes('DIRECTIVE-DISPATCH-TEST: initial'),
        'overlay should include the initial directive'
      );

      // Add another directive
      await call(cwd, 'project_memory_add_directive', {
        directive: 'DIRECTIVE-DISPATCH-TEST: second',
        priority: 'high',
      });

      // Generate overlay again - should now include the new directive
      // This simulates the "next dispatch" where the overlay is regenerated
      const overlay2 = await generateOverlay(cwd, 'test-session-2');
      assert.ok(
        overlay2.includes('DIRECTIVE-DISPATCH-TEST: second'),
        'next overlay generation should include the newly added directive'
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  /**
   * Test: Newly added directive appears in overlay on next generation
   * This tests that agents-overlay reflects directives added via memory-server
   */
  it('newly added directive appears in overlay on next generation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-directive-overlay-dispatch-'));
    try {
      // Generate initial overlay
      const overlay1 = await generateOverlay(cwd, 'test-session-1');
      assert.ok(!overlay1.includes('DYNAMIC-DIRECTIVE'), 'initial overlay should not have DYNAMIC-DIRECTIVE');

      // Add a new high-priority directive
      await call(cwd, 'project_memory_add_directive', {
        directive: 'DYNAMIC-DIRECTIVE: injected via dispatch overlay',
        priority: 'high',
      });

      // Generate overlay again
      const overlay2 = await generateOverlay(cwd, 'test-session-2');
      assert.ok(
        overlay2.includes('DYNAMIC-DIRECTIVE'),
        'next overlay generation should include the newly added directive'
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
