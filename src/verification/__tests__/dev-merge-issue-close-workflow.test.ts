import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildMaintainerCloseComment,
  buildMaintainerPrComment,
  collectLinkedLocalIssueNumbers,
} = require(join(process.cwd(), '.github', 'scripts', 'dev-merge-issue-close.cjs')) as {
  buildMaintainerCloseComment: ({ prNumber }: { prNumber: number }) => string;
  buildMaintainerPrComment: ({ issueNumbers }: { issueNumbers: number[] }) => string;
  collectLinkedLocalIssueNumbers: (input: {
    title?: string;
    body?: string;
    owner: string;
    repo: string;
  }) => number[];
};

describe('dev merge issue close workflow', () => {
  it('scopes automation to merged pull_request_target closures into dev with issue write permissions', () => {
    const workflowPath = join(process.cwd(), '.github', 'workflows', 'dev-merge-issue-close.yml');
    assert.equal(existsSync(workflowPath), true, `missing workflow: ${workflowPath}`);

    const workflow = readFileSync(workflowPath, 'utf-8');
    assert.match(workflow, /name:\s*Dev Merge Issue Close/);
    assert.match(workflow, /pull_request_target:\s*\n\s*types:\s*\[closed\]/);
    assert.match(workflow, /issues:\s*write/);
    assert.match(workflow, /pull-requests:\s*read/);
    assert.match(workflow, /github\.event\.pull_request\.merged == true && github\.event\.pull_request\.base\.ref == 'dev'/);
    assert.match(workflow, /require\('\.\/\.github\/scripts\/dev-merge-issue-close\.cjs'\)/);
    assert.match(workflow, /title:\s*pullRequest\.title/);
    assert.match(workflow, /body:\s*pullRequest\.body/);
    assert.match(workflow, /buildMaintainerPrComment/);
    assert.match(workflow, /issue_number:\s*pullRequest\.number/);
    assert.match(workflow, /issueNumbers:\s*closedIssueNumbers/);
    assert.doesNotMatch(workflow, /commit/i);
    assert.doesNotMatch(workflow, /discussion/i);
  });

  it('extracts only explicitly linked local issues from PR title/body close keywords', () => {
    assert.deepEqual(
      collectLinkedLocalIssueNumbers({
        title: 'Fixes #1540, #1541',
        body: 'Resolves Yeachan-Heo/oh-my-codex#1542 and closes https://github.com/Yeachan-Heo/oh-my-codex/issues/1543',
        owner: 'Yeachan-Heo',
        repo: 'oh-my-codex',
      }),
      [1540, 1541, 1542, 1543],
    );
  });

  it('ignores unrelated references without close keywords or from other repositories', () => {
    assert.deepEqual(
      collectLinkedLocalIssueNumbers({
        title: 'Refs #1540',
        body: [
          'Mentions #1541 without a close keyword.',
          'Fixes octo/example#1542',
          'Discussion says maybe close #1543 later.',
        ].join('\n'),
        owner: 'Yeachan-Heo',
        repo: 'oh-my-codex',
      }),
      [],
    );
  });

  it('dedupes repeated references and provides a standard maintainer close comment', () => {
    assert.deepEqual(
      collectLinkedLocalIssueNumbers({
        title: 'Fixes #1540',
        body: 'Closes #1540 and resolves Yeachan-Heo/oh-my-codex#1540',
        owner: 'Yeachan-Heo',
        repo: 'oh-my-codex',
      }),
      [1540],
    );
    const comment = buildMaintainerCloseComment({ prNumber: 1550 });
    assert.match(
      comment,
      /Closing automatically because PR #1550 was merged into `dev` and explicitly referenced this issue in the PR title or body\./,
    );
    assert.match(comment, /A hot-fix build is available now\./);
    assert.match(comment, /`omx update --dev`/);
    assert.match(comment, /let us know whether it resolves the issue/);
  });

  it('provides a matching PR summary comment after linked issues close', () => {
    const comment = buildMaintainerPrComment({ issueNumbers: [1540, 1541] });
    assert.match(
      comment,
      /Closed explicitly linked issues after this PR was merged into `dev`: #1540, #1541\./,
    );
    assert.match(comment, /A hot-fix build is available now\./);
    assert.match(comment, /Issue creators can try it with `omx update --dev`/);
    assert.match(comment, /let us know whether it resolves the issue/);
  });
});
