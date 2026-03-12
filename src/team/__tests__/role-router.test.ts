import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadRolePrompt,
  isKnownRole,
  listAvailableRoles,
  routeTaskToRole,
} from '../role-router.js';

describe('role-router', () => {
  // ─── Layer 1: Prompt Loading ──────────────────────────────────────

  describe('loadRolePrompt', () => {
    it('returns prompt content for an existing role', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'omx-role-router-'));
      try {
        await writeFile(join(dir, 'executor.md'), '# Executor\n\nYou are an executor agent.');
        const content = await loadRolePrompt('executor', dir);
        assert.ok(content);
        assert.match(content, /executor agent/i);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns null for a missing role', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'omx-role-router-'));
      try {
        const content = await loadRolePrompt('nonexistent', dir);
        assert.equal(content, null);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns null for an empty prompt file', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'omx-role-router-'));
      try {
        await writeFile(join(dir, 'empty.md'), '   \n  ');
        const content = await loadRolePrompt('empty', dir);
        assert.equal(content, null);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('isKnownRole', () => {
    it('returns true when prompt file exists', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'omx-role-router-'));
      try {
        await writeFile(join(dir, 'designer.md'), '# Designer');
        assert.equal(isKnownRole('designer', dir), true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns false when prompt file does not exist', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'omx-role-router-'));
      try {
        assert.equal(isKnownRole('missing-role', dir), false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('listAvailableRoles', () => {
    it('lists all roles from prompt files', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'omx-role-router-'));
      try {
        await writeFile(join(dir, 'executor.md'), '# Executor');
        await writeFile(join(dir, 'designer.md'), '# Designer');
        await writeFile(join(dir, 'test-engineer.md'), '# Test Engineer');
        await writeFile(join(dir, 'README.txt'), 'not a prompt');
        const roles = await listAvailableRoles(dir);
        assert.deepEqual(roles, ['designer', 'executor', 'test-engineer']);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns empty array for missing directory', async () => {
      const roles = await listAvailableRoles('/tmp/nonexistent-dir-' + Date.now());
      assert.deepEqual(roles, []);
    });
  });

  // ─── Layer 2: Heuristic Role Routing ──────────────────────────────

  describe('routeTaskToRole', () => {
    it('routes test-related tasks to test-engineer with high confidence', () => {
      const result = routeTaskToRole('Write unit tests', 'Add jest test coverage for the auth module', 'team-exec', 'executor');
      assert.equal(result.role, 'test-engineer');
      assert.equal(result.confidence, 'high');
    });

    it('routes UI tasks to designer with high confidence', () => {
      const result = routeTaskToRole('Build UI component', 'Create a responsive layout with CSS and Tailwind', 'team-exec', 'executor');
      assert.equal(result.role, 'designer');
      assert.equal(result.confidence, 'high');
    });

    it('routes build error tasks to build-fixer', () => {
      const result = routeTaskToRole('Fix build', 'Resolve tsc type errors in the compile step', 'team-fix', 'executor');
      assert.equal(result.role, 'build-fixer');
      assert.equal(result.confidence, 'high');
    });

    it('routes debug tasks to debugger', () => {
      const result = routeTaskToRole('Investigate regression', 'Debug the root cause of the stack trace failure', 'team-fix', 'executor');
      assert.equal(result.role, 'debugger');
      assert.equal(result.confidence, 'high');
    });

    it('routes documentation tasks to writer', () => {
      const result = routeTaskToRole('Update docs', 'Write README and migration guide for the new API', 'team-exec', 'executor');
      assert.equal(result.role, 'writer');
      assert.equal(result.confidence, 'high');
    });

    it('routes security tasks to security-reviewer', () => {
      const result = routeTaskToRole('Security audit', 'Check for XSS and injection vulnerabilities', 'team-verify', 'executor');
      assert.equal(result.role, 'security-reviewer');
      assert.equal(result.confidence, 'high');
    });

    it('keeps implementation-heavy auth work on the implementation fallback lane', () => {
      const result = routeTaskToRole('Implement auth session refresh', 'Add authentication refresh handling and authorization checks to the login flow', 'team-exec', 'executor');
      assert.equal(result.role, 'executor');
      assert.equal(result.confidence, 'medium');
      assert.match(result.reason, /implementation/i);
    });

    it('routes refactoring tasks to code-simplifier', () => {
      const result = routeTaskToRole('Refactor auth', 'Simplify and clean up the authentication module', 'team-exec', 'executor');
      assert.equal(result.role, 'code-simplifier');
      assert.equal(result.confidence, 'high');
    });

    it('returns medium confidence for single keyword match', () => {
      const result = routeTaskToRole('Run tests', 'Execute the test suite', 'team-exec', 'executor');
      assert.equal(result.role, 'test-engineer');
      assert.equal(result.confidence, 'medium');
    });

    it('falls back to fallbackRole when no keywords match', () => {
      const result = routeTaskToRole('Do the thing', 'Make it work properly', 'team-exec', 'executor');
      assert.equal(result.role, 'executor');
      assert.equal(result.confidence, 'low');
    });

    it('falls back to fallbackRole for low confidence even with phase context', () => {
      const result = routeTaskToRole('Process data', 'Transform the input', 'team-verify', 'executor');
      assert.equal(result.role, 'executor');
      assert.equal(result.confidence, 'low');
    });

    it('is deterministic for the same inputs', () => {
      const r1 = routeTaskToRole('Write tests', 'Add test coverage', 'team-exec', 'executor');
      const r2 = routeTaskToRole('Write tests', 'Add test coverage', 'team-exec', 'executor');
      assert.equal(r1.role, r2.role);
      assert.equal(r1.confidence, r2.confidence);
    });

    it('recognizes common Korean documentation/test signals', () => {
      const docs = routeTaskToRole('문서 업데이트', '배포 가이드와 README 문서를 정리', 'team-exec', 'executor');
      const tests = routeTaskToRole('테스트 추가', '로그인 흐름 테스트와 커버리지 추가', 'team-exec', 'executor');
      assert.equal(docs.role, 'writer');
      assert.equal(tests.role, 'test-engineer');
    });

    it('handles null phase gracefully', () => {
      const result = routeTaskToRole('Generic task', 'Do something', null, 'executor');
      assert.equal(result.role, 'executor');
      assert.equal(result.confidence, 'low');
    });
  });

  describe('path traversal protection', () => {
    it('loadRolePrompt rejects path traversal attempts', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'omx-role-router-'));
      try {
        const content = await loadRolePrompt('../../../etc/passwd', dir);
        assert.equal(content, null);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('isKnownRole rejects path traversal attempts', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'omx-role-router-'));
      try {
        assert.equal(isKnownRole('../../../etc/passwd', dir), false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('loadRolePrompt rejects uppercase role names', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'omx-role-router-'));
      try {
        await writeFile(join(dir, 'Executor.md'), '# Executor');
        const content = await loadRolePrompt('Executor', dir);
        assert.equal(content, null);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('loadRolePrompt rejects role names with dots', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'omx-role-router-'));
      try {
        const content = await loadRolePrompt('foo.bar', dir);
        assert.equal(content, null);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('loadRolePrompt accepts valid hyphenated role names', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'omx-role-router-'));
      try {
        await writeFile(join(dir, 'test-engineer.md'), '# Test Engineer');
        const content = await loadRolePrompt('test-engineer', dir);
        assert.ok(content);
        assert.match(content, /Test Engineer/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
