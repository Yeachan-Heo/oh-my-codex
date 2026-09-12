import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  buildPromptInventory,
  buildRepositorySizeInventory,
  checkPromptInvariantDuplicates,
  listPromptSurfacePaths,
  renderPromptInventoryMarkdown,
  runPromptInventoryCli,
} from '../prompt-inventory.js';

describe('prompt inventory', () => {
  it('counts prompt surfaces, absolute directives, markers, and duplicate fragments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-prompt-inventory-'));
    try {
      await mkdir(join(root, 'templates'), { recursive: true });
      await mkdir(join(root, 'prompts'), { recursive: true });
      await mkdir(join(root, 'skills', 'worker'), { recursive: true });
      await mkdir(join(root, 'docs', 'prompt-guidance-fragments'), { recursive: true });
      await mkdir(join(root, 'src', 'hooks'), { recursive: true });
      await mkdir(join(root, 'src', 'config'), { recursive: true });
      await mkdir(join(root, 'src', 'cli'), { recursive: true });

      const repeated = 'AUTO-CONTINUE for clear, already-requested, low-risk, reversible local work with evidence.';
      await writeFile(join(root, 'AGENTS.md'), `# Root\n${repeated}\n<!-- omx:generated:agents-md -->\n`);
      await writeFile(
        join(root, 'templates', 'AGENTS.md'),
        `# Template\nMUST preserve markers.\n${repeated}\n<!-- OMX:RUNTIME:START -->\n<!-- OMX:RUNTIME:END -->\n`,
      );
      await writeFile(join(root, 'prompts', 'executor.md'), `# Executor\nDO NOT stop early.\n${repeated}\n`);
      await writeFile(join(root, 'skills', 'worker', 'SKILL.md'), '# Worker\nALWAYS claim tasks.\n');
      await writeFile(join(root, 'docs', 'prompt-guidance-contract.md'), '# Contract\n');
      await writeFile(join(root, 'docs', 'guidance-schema.md'), '# Schema\n');
      await writeFile(join(root, 'docs', 'prompt-guidance-fragments', 'core.md'), 'fragment\n');
      await writeFile(join(root, 'src', 'hooks', 'prompt-guidance-contract.ts'), 'export {};\n');
      await writeFile(join(root, 'src', 'config', 'generator.ts'), 'export {};\n');
      await writeFile(join(root, 'src', 'cli', 'setup.ts'), 'export {};\n');

      const paths = listPromptSurfacePaths(root);
      assert.deepEqual(paths, [
        'AGENTS.md',
        'docs/guidance-schema.md',
        'docs/prompt-guidance-contract.md',
        'docs/prompt-guidance-fragments/core.md',
        'prompts/executor.md',
        'skills/worker/SKILL.md',
        'src/cli/setup.ts',
        'src/config/generator.ts',
        'src/hooks/prompt-guidance-contract.ts',
        'templates/AGENTS.md',
      ]);

      const report = buildPromptInventory(root, '2026-01-01T00:00:00.000Z');
      assert.equal(report.totals.files, paths.length);
      assert.ok(report.totals.lines > 0);
      assert.ok(report.totals.approximateTokens > 0);
      assert.equal(report.totals.absoluteDirectiveCount, 6);
      assert.equal(
        report.surfaces.find((surface) => surface.path === 'templates/AGENTS.md')?.markers['<!-- OMX:RUNTIME:START -->'],
        1,
      );
      assert.equal(report.duplicateFragmentFamilies[0]?.count, 3);
      assert.match(renderPromptInventoryMarkdown(report), /# Prompt Inventory/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('checks only explicit durable invariant phrases and reports skill duplicates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-prompt-invariant-check-'));
    const statePhrase = 'compatibility discovery is read-only';
    try {
      await mkdir(join(root, 'skills', 'one'), { recursive: true });
      await mkdir(join(root, 'skills', 'two'), { recursive: true });
      await mkdir(join(root, 'skills', 'generic'), { recursive: true });
      await mkdir(join(root, 'templates'), { recursive: true });
      await writeFile(join(root, 'templates', 'AGENTS.md'), `# SSOT\n${statePhrase}\n`);
      await writeFile(join(root, 'skills', 'one', 'SKILL.md'), `---\nname: one\n---\n${statePhrase}\n`);
      await writeFile(join(root, 'skills', 'two', 'SKILL.md'), `---\nname: two\n---\n${statePhrase}\n`);
      await writeFile(join(root, 'skills', 'generic', 'SKILL.md'), 'This skill discusses state and team behavior without durable invariant wording.\n');

      const report = checkPromptInvariantDuplicates(root);
      assert.equal(report.ok, false);
      assert.deepEqual(report.checkedPaths, [
        'skills/generic/SKILL.md',
        'skills/one/SKILL.md',
        'skills/two/SKILL.md',
      ]);
      assert.deepEqual(report.duplicates, [{
        ruleId: 'state-ownership',
        phrase: statePhrase,
        paths: ['skills/one/SKILL.md', 'skills/two/SKILL.md'],
      }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('passes clean checks, ignores the authorized SSOT, and returns actionable CLI status', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-prompt-invariant-clean-'));
    const output: string[] = [];
    const originalLog = console.log;
    try {
      await mkdir(join(root, 'skills', 'one'), { recursive: true });
      await mkdir(join(root, 'skills', 'two'), { recursive: true });
      await mkdir(join(root, 'templates'), { recursive: true });
      await writeFile(join(root, 'templates', 'AGENTS.md'), 'Hooks own normal skill activation\n');
      await writeFile(join(root, 'skills', 'one', 'SKILL.md'), 'This skill says state must remain scoped.\n');
      await writeFile(join(root, 'skills', 'two', 'SKILL.md'), 'This skill says state must remain scoped too.\n');
      console.log = (...args: unknown[]) => output.push(args.join(' '));

      const report = checkPromptInvariantDuplicates(root);
      assert.equal(report.ok, true);
      assert.deepEqual(report.duplicates, []);
      assert.equal(runPromptInventoryCli(['--check', '--root', root], root), 0);
      assert.match(output.join('\n'), /prompt invariant check ok/);
      assert.equal(runPromptInventoryCli(['--check', '--root'], root), 1);
    } finally {
      console.log = originalLog;
      await rm(root, { recursive: true, force: true });
    }
  });
});


describe('repository size inventory', () => {
  it('separates canonical instructions, source, tests and Rust without counting mirrors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-size-inventory-'));
    try {
      const files: Record<string, string> = {
        'src/a.ts': 'a\r\n\r\nb\r\n',
        'src/empty.ts': '',
        'src/b.mjs': 'b',
        'src/scripts/run.sh': 'run\n',
        'src/a.test.ts': 'test\nassert\n',
        'src/b.spec.ts': 'spec',
        'src/__tests__/helper.ts': 'helper\n',
        'crates/example/src/lib.rs': 'fn main() {}\n// test\n',
        'skills/one/SKILL.md': '# Skill\nDo it.\n',
        'skills/one/references/notes.md': 'not a canonical card\n',
        'prompts/executor.md': '# Executor\n',
        'templates/AGENTS.md': '# Contract\nRules.\n',
        'src/generated/example.ts': 'generated\n',
        'src/node_modules/example/index.ts': 'dependency\n',
        'crates/example/target/generated.rs': 'build output\n',
        'crates/example/.omx/state/fixture.rs': 'runtime artifact\n',
        'plugins/oh-my-codex/skills/one/SKILL.md': 'mirror\n',
        '.codex/skills/external/SKILL.md': 'third party\n',
        'dist/index.js': 'compiled\n',
      };
      for (const [path, content] of Object.entries(files)) {
        const fullPath = join(root, path);
        await mkdir(join(fullPath, '..'), { recursive: true });
        await writeFile(fullPath, content);
      }
      const report = buildRepositorySizeInventory(root);
      assert.equal(report.schemaVersion, 1);
      assert.deepEqual(Object.fromEntries(Object.entries(report.groups).map(([name, group]) => [name, [group.files, group.physicalLines]])), {
        nonTestSource: [4, 5],
        testSource: [3, 4],
        rustSourceIncludingTests: [1, 2],
        skillCards: [1, 2],
        agentPrompts: [1, 1],
        agentTemplate: [1, 2],
      });
      assert.equal(report.groups.nonTestSource.bytes, Buffer.byteLength('a\r\n\r\nb\r\n' + 'b' + 'run\n'));
      assert.equal(report.largestNonTestFiles[0]?.path, 'src/a.ts');
      assert.deepEqual(report, buildRepositorySizeInventory(root));
      assert.deepEqual(buildPromptInventory(root, 'fixed').repositorySize, report);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not follow nested symlinks and orders equal-size hotspots by path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-size-links-'));
    try {
      await mkdir(join(root, 'src'));
      await mkdir(join(root, 'external'));
      await writeFile(join(root, 'src/z.ts'), 'z\n');
      await writeFile(join(root, 'src/a.ts'), 'a\n');
      await writeFile(join(root, 'external/foreign.ts'), 'foreign\n');
      await symlink(join(root, 'external'), join(root, 'src/dependency'), 'junction');
      await mkdir(join(root, 'templates'));
      await symlink(join(root, 'src/a.ts'), join(root, 'templates/AGENTS.md'));
      const report = buildRepositorySizeInventory(root);
      assert.equal(report.groups.agentTemplate.files, 0);
      assert.equal(report.groups.nonTestSource.files, 2);
      assert.deepEqual(report.largestNonTestFiles.map((file) => file.path), ['src/a.ts', 'src/z.ts']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports empty groups for an empty root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-size-empty-'));
    try {
      const report = buildRepositorySizeInventory(root);
      assert.ok(Object.values(report.groups).every((group) => group.files === 0 && group.physicalLines === 0 && group.bytes === 0));
      assert.deepEqual(report.largestNonTestFiles, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
