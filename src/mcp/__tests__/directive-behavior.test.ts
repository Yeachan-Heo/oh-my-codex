import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
      
      // Add a mix: 1 normal + 5 high-priority directives that exceed the max 3
      await call(cwd, 'project_memory_add_directive', {
        directive: 'Normal priority directive (should be absent from both)',
        priority: 'normal',
      });
      
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

      // Extract high-priority directives from both (max 3 each, newest first)
      // Note: hook uses lowercase "directive:" while overlay uses capital "Directive:"
      const getHighPriorityDirectives = (text: string): string[] => {
        const lines = text.split('\n');
        const directives: string[] = [];
        for (const line of lines) {
          if (line.includes('High priority directive')) {
            // Normalize to lowercase for comparison
            const normalized = line.trim().toLowerCase();
            directives.push(normalized);
          }
        }
        return directives;
      };
      
      const overlayDirectives = getHighPriorityDirectives(overlay);
      const hookDirectives = getHighPriorityDirectives(hookOutput);

      // Both should have exactly 3 high-priority directives
      assert.equal(overlayDirectives.length, 3, 'overlay should have exactly 3 high-priority directives');
      assert.equal(hookDirectives.length, 3, 'hook should have exactly 3 high-priority directives');
      
      // Both should have the same directives in the same order (newest first)
      // Extract just the directive IDs to verify they match in the same order
      const extractDirectiveIds = (lines: string[]): string[] => {
        return lines.map(line => {
          const match = line.match(/dir-[0-9a-f]{8}/);
          return match ? match[0] : '';
        }).filter(Boolean);
      };
      
      const overlayIds = extractDirectiveIds(overlayDirectives);
      const hookIds = extractDirectiveIds(hookDirectives);
      
      assert.deepEqual(
        overlayIds,
        hookIds,
        'hook and overlay should contain identical directive lists in identical order'
      );
      
      // Normal priority directive should be absent from both
      assert.ok(
        !overlay.includes('Normal priority directive'),
        'overlay should not contain normal priority directives'
      );
      assert.ok(
        !hookOutput.includes('Normal priority directive'),
        'hook should not contain normal priority directives'
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  /**
   * Instant (not string) comparison: '2099-01-01T10:00:00+09:00' is 01:00Z, earlier than
   * '2099-01-01T05:00:00Z', although it sorts later as a string.
   */
  it('getEarliestFutureExpiry compares instants across offsets, not strings', () => {
    const ts = new Date().toISOString();
    const offsetEarlier = '2099-01-01T10:00:00+09:00';
    const zuluLater = '2099-01-01T05:00:00Z';
    assert.ok(zuluLater < offsetEarlier, 'fixture: string order disagrees with instant order');
    for (const order of [[zuluLater, offsetEarlier], [offsetEarlier, zuluLater]]) {
      const directives: ProjectDirective[] = order.map((expiresAt, i) => ({ directive: `d${i}`, priority: 'normal', timestamp: ts, expiresAt }));
      assert.equal(getEarliestFutureExpiry(directives), offsetEarlier);
    }
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
   * Time-only expiry: project-memory.json is NOT rewritten; the cached environment.md must still
   * be rebuilt once its earliestDirectiveExpiry passes (src/wiki/lifecycle.ts feedProjectMemory).
   */
  it('rebuilds environment.md when a directive expires without project memory changing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-directive-time-expiry-'));
    try {
      const { onSessionStart } = await import('../../wiki/lifecycle.js');
      const { ensureWikiDir } = await import('../../wiki/storage.js');
      const now = Date.now();
      await writeFile(join(cwd, 'project-memory.json'), JSON.stringify({
        techStack: 'TypeScript',
        directives: [
          { directive: 'TIME-EXPIRING directive', priority: 'high', timestamp: new Date(now).toISOString(), expiresAt: new Date(now + 1500).toISOString() },
          { directive: 'PERMANENT directive', priority: 'high', timestamp: new Date(now).toISOString() },
        ],
      }));
      await writeFile(join(cwd, '.omx-config.json'), JSON.stringify({ wiki: { enabled: true, feedProjectMemoryOnStart: true } }));
      ensureWikiDir(cwd);
      const envPath = join(cwd, 'omx_wiki', 'environment.md');

      onSessionStart({ cwd });
      const first = await readFile(envPath, 'utf-8');
      assert.match(first, /TIME-EXPIRING directive/);

      await new Promise((resolve) => setTimeout(resolve, 1700));
      onSessionStart({ cwd });
      const second = await readFile(envPath, 'utf-8');
      assert.doesNotMatch(second, /TIME-EXPIRING directive/, 'expired directive must be dropped on the next SessionStart');
      assert.match(second, /PERMANENT directive/);
      assert.doesNotMatch(second, /earliestDirectiveExpiry/, 'no future expiry remains, so the field is omitted');
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
