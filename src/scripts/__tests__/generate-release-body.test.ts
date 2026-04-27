import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import {
  buildFullChangelogLine,
  generateReleaseBody,
  renderContributorsSection,
  verifyCompareRange,
  type Contributor,
} from '../generate-release-body.js';

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return String(result.stdout || '').trim();
}

const TEMPLATE = `# oh-my-codex v0.0.0

## Summary

Custom summary that must stay intact.

## Fixed

- Keep this handwritten section.

## Verification

- npm test

## Contributors

Outdated contributor text.

**Full Changelog**: [\`v0.0.0...v0.0.1\`](https://github.com/example/compare/v0.0.0...v0.0.1)
`;

describe('generate-release-body', () => {
  it('preserves custom sections while refreshing contributors and compare metadata from git', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-generate-release-body-'));
    const originalGitHubRepository = process.env.GITHUB_REPOSITORY;
    try {
      git(root, ['init']);
      git(root, ['config', 'user.name', 'Release Bot']);
      git(root, ['config', 'user.email', 'release@example.com']);
      git(root, ['remote', 'add', 'origin', 'https://github.com/example/oh-my-codex.git']);

      await writeFile(join(root, 'RELEASE_BODY.md'), TEMPLATE);
      await writeFile(join(root, 'notes.txt'), 'base\n');
      git(root, ['add', '.']);
      git(root, ['commit', '-m', 'base']);
      git(root, ['tag', 'v0.12.0']);

      await writeFile(join(root, 'notes.txt'), 'alice\n');
      git(root, ['add', 'notes.txt']);
      git(root, ['commit', '-m', 'alice change'], { GIT_AUTHOR_NAME: 'Alice Example', GIT_AUTHOR_EMAIL: 'alice@example.com' });

      await writeFile(join(root, 'notes.txt'), 'bob\n');
      git(root, ['add', 'notes.txt']);
      git(root, ['commit', '-m', 'bob change'], { GIT_AUTHOR_NAME: 'Bob Example', GIT_AUTHOR_EMAIL: 'bob@example.com' });
      git(root, ['tag', 'v0.13.0']);

      delete process.env.GITHUB_REPOSITORY;
      await generateReleaseBody({
        cwd: root,
        templatePath: 'RELEASE_BODY.md',
        outPath: 'RELEASE_BODY.generated.md',
        currentTag: 'v0.13.0',
      });

      const generated = await readFile(join(root, 'RELEASE_BODY.generated.md'), 'utf-8');
      assert.match(generated, /^# oh-my-codex v0.13.0/m);
      assert.match(generated, /Custom summary that must stay intact\./);
      assert.match(generated, /Keep this handwritten section\./);
      assert.match(generated, /## Contributors\n\nThanks to Alice Example and Bob Example for contributing to this release\./);
      assert.match(generated, /\*\*Full Changelog\*\*: \[`v0\.12\.0\.\.\.v0\.13\.0`\]\(https:\/\/github\.com\/example\/oh-my-codex\/compare\/v0\.12\.0\.\.\.v0\.13\.0\)/);
    } finally {
      if (originalGitHubRepository === undefined) {
        delete process.env.GITHUB_REPOSITORY;
      } else {
        process.env.GITHUB_REPOSITORY = originalGitHubRepository;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it('prefers GitHub contributor handles when compare metadata is available', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-generate-release-body-gh-'));
    try {
      git(root, ['init']);
      git(root, ['config', 'user.name', 'Release Bot']);
      git(root, ['config', 'user.email', 'release@example.com']);
      await writeFile(join(root, 'notes.txt'), 'base\n');
      git(root, ['add', '.']);
      git(root, ['commit', '-m', 'base']);
      git(root, ['tag', 'v0.13.0']);
      await writeFile(join(root, 'notes.txt'), 'release\n');
      git(root, ['add', 'notes.txt']);
      git(root, ['commit', '-m', 'release']);
      git(root, ['tag', 'v0.13.1']);

      await writeFile(join(root, 'RELEASE_BODY.md'), TEMPLATE);
      const originalFetch = global.fetch;
      global.fetch = (async () => new Response(JSON.stringify({
        commits: [
          { author: { login: 'alice', html_url: 'https://github.com/alice' } },
          { author: { login: 'bob', html_url: 'https://github.com/bob' } },
          { author: { login: 'alice', html_url: 'https://github.com/alice' } },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

      try {
        await generateReleaseBody({
          cwd: root,
          templatePath: 'RELEASE_BODY.md',
          outPath: 'RELEASE_BODY.generated.md',
          currentTag: 'v0.13.1',
          previousTag: 'v0.13.0',
          repo: 'example/oh-my-codex',
          githubToken: 'test-token',
        });
      } finally {
        global.fetch = originalFetch;
      }

      const generated = await readFile(join(root, 'RELEASE_BODY.generated.md'), 'utf-8');
      assert.match(generated, /Thanks to \[@alice\]\(https:\/\/github\.com\/alice\) and \[@bob\]\(https:\/\/github\.com\/bob\) for contributing to this release\./);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });


  it('rejects missing or inverted compare refs before rendering a compare link', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-generate-release-body-range-'));
    try {
      git(root, ['init']);
      git(root, ['config', 'user.name', 'Release Bot']);
      git(root, ['config', 'user.email', 'release@example.com']);
      await writeFile(join(root, 'notes.txt'), 'base\n');
      git(root, ['add', '.']);
      git(root, ['commit', '-m', 'base']);
      git(root, ['tag', 'v0.13.0']);
      await writeFile(join(root, 'notes.txt'), 'release\n');
      git(root, ['add', 'notes.txt']);
      git(root, ['commit', '-m', 'release']);
      git(root, ['tag', 'v0.13.1']);

      assert.doesNotThrow(() => verifyCompareRange(root, 'v0.13.1', 'v0.13.0'));
      assert.throws(
        () => verifyCompareRange(root, 'v0.13.1', 'v9.99.9'),
        /unable to verify previous tag ref for release compare: v9\.99\.9/,
      );
      assert.throws(
        () => verifyCompareRange(root, 'v0.13.0', 'v0.13.1'),
        /invalid release compare range: v0\.13\.1 is not an ancestor of v0\.13\.0/,
      );

      await writeFile(join(root, 'RELEASE_BODY.md'), TEMPLATE);
      await assert.rejects(
        generateReleaseBody({
          cwd: root,
          templatePath: 'RELEASE_BODY.md',
          outPath: 'RELEASE_BODY.generated.md',
          currentTag: 'v0.13.1',
          previousTag: 'v9.99.9',
          repo: 'example/oh-my-codex',
        }),
        /unable to verify previous tag ref for release compare: v9\.99\.9/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });


  it('fails validation when the template is missing required metadata anchors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-generate-release-body-invalid-'));
    try {
      git(root, ['init']);
      git(root, ['config', 'user.name', 'Release Bot']);
      git(root, ['config', 'user.email', 'release@example.com']);
      await writeFile(join(root, 'notes.txt'), 'base\n');
      git(root, ['add', '.']);
      git(root, ['commit', '-m', 'base']);
      git(root, ['tag', 'v0.13.0']);
      await writeFile(join(root, 'notes.txt'), 'release\n');
      git(root, ['add', 'notes.txt']);
      git(root, ['commit', '-m', 'release']);
      git(root, ['tag', 'v0.13.1']);

      await writeFile(join(root, 'RELEASE_BODY.md'), `# oh-my-codex v0.0.0

## Summary

Missing required sections.
`);
      await assert.rejects(
        generateReleaseBody({
          cwd: root,
          templatePath: 'RELEASE_BODY.md',
          outPath: 'RELEASE_BODY.generated.md',
          currentTag: 'v0.13.1',
          previousTag: 'v0.13.0',
          repo: 'example/oh-my-codex',
        }),
        /missing section: ## Contributors|missing the Full Changelog line/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('renders contributor and changelog helpers for edge cases', () => {
    const contributors: Contributor[] = [];
    assert.equal(renderContributorsSection(contributors), 'Thanks to the contributors who made this release possible.');
    assert.equal(
      buildFullChangelogLine('example/oh-my-codex', 'v0.13.1', 'v0.13.0'),
      '**Full Changelog**: [`v0.13.0...v0.13.1`](https://github.com/example/oh-my-codex/compare/v0.13.0...v0.13.1)',
    );
    assert.equal(
      buildFullChangelogLine('example/oh-my-codex', 'v0.1.0'),
      '**Full Changelog**: [`v0.1.0`](https://github.com/example/oh-my-codex/releases/tag/v0.1.0)',
    );
  });
});
