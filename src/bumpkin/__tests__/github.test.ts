import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  GitHubNotificationTransport,
  type GitHubCheckRunsApi,
  type GitHubCommentsApi,
} from '../github/notifications-transport.js';
import {
  handleWebhook,
  parseCommandComment,
  type WebhookEvent,
} from '../github/webhook-handler.js';
import {
  buildPullRequestSpec,
  sanitizeDependencyForBranch,
  versionBumpKind,
  type UpgradeRunResult,
} from '../github/pr-opener.js';
import type { UpgradeTarget } from '../skills/upgrade-planner.js';

function mockComments(): {
  api: GitHubCommentsApi;
  calls: Array<{ issueNumber: number; body: string }>;
} {
  const calls: Array<{ issueNumber: number; body: string }> = [];
  return {
    calls,
    api: {
      async createComment(opts) {
        calls.push(opts);
        return { id: calls.length };
      },
    },
  };
}

function mockCheckRuns(): {
  api: GitHubCheckRunsApi;
  calls: Array<Parameters<GitHubCheckRunsApi['updateCheckRun']>[0]>;
} {
  const calls: Array<Parameters<GitHubCheckRunsApi['updateCheckRun']>[0]> = [];
  return {
    calls,
    api: {
      async updateCheckRun(opts) {
        calls.push(opts);
        return { id: calls.length };
      },
    },
  };
}

describe('bumpkin/notifications-transport', () => {
  it('posts a comment formatted with title and body', async () => {
    const { api, calls } = mockComments();
    const t = new GitHubNotificationTransport({ issueNumber: 42, comments: api });
    await t.send({ kind: 'status', title: 'Phase: verify-tests', body: 'running...' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.issueNumber, 42);
    assert.match(calls[0]?.body ?? '', /\*\*Phase: verify-tests\*\*/);
    assert.match(calls[0]?.body ?? '', /running\.\.\./);
  });

  it('respects dedupeKey cooldown and drops subsequent sends within window', async () => {
    const { api, calls } = mockComments();
    let time = 1000;
    const t = new GitHubNotificationTransport({
      issueNumber: 1,
      comments: api,
      cooldownMs: 5000,
      now: () => time,
    });
    await t.send({ kind: 'status', title: 'X', body: 'Y', dedupeKey: 'k' });
    await t.send({ kind: 'status', title: 'X', body: 'Y', dedupeKey: 'k' });
    assert.equal(calls.length, 1);
    time = 10_000;
    await t.send({ kind: 'status', title: 'X', body: 'Y', dedupeKey: 'k' });
    assert.equal(calls.length, 2);
  });

  it('updates check run on summary (success) and error (failure)', async () => {
    const { api, calls } = mockComments();
    const runs = mockCheckRuns();
    const t = new GitHubNotificationTransport({
      issueNumber: 1,
      comments: api,
      checkRuns: runs.api,
      checkRunName: 'bumpkin',
    });
    await t.send({ kind: 'summary', title: 'done', body: 'b' });
    await t.send({ kind: 'error', title: 'oops', body: 'b' });
    assert.equal(calls.length, 2);
    assert.equal(runs.calls[0]?.conclusion, 'success');
    assert.equal(runs.calls[1]?.conclusion, 'failure');
  });
});

describe('bumpkin/webhook-handler', () => {
  it('parses "@bumpkin all" as kind:all scope', () => {
    assert.deepEqual(parseCommandComment('@bumpkin all'), { kind: 'all' });
    assert.deepEqual(parseCommandComment('@bumpkin'), { kind: 'all' });
  });

  it('parses all-minor and all-patch scopes', () => {
    assert.deepEqual(parseCommandComment('@bumpkin all-minor'), { kind: 'all-minor' });
    assert.deepEqual(parseCommandComment('@bumpkin all-patch'), { kind: 'all-patch' });
  });

  it('parses single-dependency scope', () => {
    assert.deepEqual(parseCommandComment('@bumpkin react'), { kind: 'single', dependency: 'react' });
  });

  it('returns null for non-command comments', () => {
    assert.equal(parseCommandComment('hi there'), null);
    assert.equal(parseCommandComment('/bumpkin all'), null);
  });

  it('installation.created → register-installation', () => {
    const event: WebhookEvent = {
      type: 'installation',
      action: 'created',
      installationId: 1,
      accountLogin: 'acme',
      repositories: [{ fullName: 'acme/web', private: true }],
    };
    const action = handleWebhook(event);
    assert.equal(action.type, 'register-installation');
    if (action.type === 'register-installation') {
      assert.equal(action.installationId, 1);
      assert.equal(action.repositories[0]?.fullName, 'acme/web');
    }
  });

  it('installation.deleted → unregister-installation', () => {
    const action = handleWebhook({
      type: 'installation',
      action: 'deleted',
      installationId: 1,
      accountLogin: 'x',
      repositories: [],
    });
    assert.equal(action.type, 'unregister-installation');
  });

  it('issue_comment with @bumpkin command → queue-upgrade-run', () => {
    const action = handleWebhook({
      type: 'issue_comment',
      action: 'created',
      installationId: 1,
      repoFullName: 'acme/web',
      issueNumber: 42,
      commenterLogin: 'alice',
      body: '@bumpkin react',
    });
    assert.equal(action.type, 'queue-upgrade-run');
    if (action.type === 'queue-upgrade-run') {
      assert.deepEqual(action.scope, { kind: 'single', dependency: 'react' });
      assert.equal(action.requestedBy, 'alice');
      assert.equal(action.issueNumber, 42);
    }
  });

  it('issue_comment without command → ignore', () => {
    const action = handleWebhook({
      type: 'issue_comment',
      action: 'created',
      installationId: 1,
      repoFullName: 'acme/web',
      issueNumber: 1,
      commenterLogin: 'x',
      body: 'some random comment',
    });
    assert.equal(action.type, 'ignore');
  });

  it('schedule → queue-upgrade-run with kind:all', () => {
    const action = handleWebhook({
      type: 'schedule',
      installationId: 1,
      repoFullName: 'acme/web',
    });
    assert.equal(action.type, 'queue-upgrade-run');
    if (action.type === 'queue-upgrade-run') {
      assert.deepEqual(action.scope, { kind: 'all' });
    }
  });

  it('pull_request.closed merged=true → record-pr-outcome merged', () => {
    const action = handleWebhook({
      type: 'pull_request',
      action: 'closed',
      installationId: 1,
      repoFullName: 'acme/web',
      prNumber: 9,
      merged: true,
    });
    assert.equal(action.type, 'record-pr-outcome');
    if (action.type === 'record-pr-outcome') {
      assert.equal(action.outcome, 'merged');
    }
  });
});

describe('bumpkin/pr-opener', () => {
  const target: UpgradeTarget = {
    name: 'lodash',
    from: '4.17.0',
    to: '4.17.21',
    rationale: 'patch bump',
    riskLevel: 'low',
  };

  const baseResult: UpgradeRunResult = {
    target,
    status: 'ready-to-ship',
    transitions: [
      { from: 'plan', to: 'prd', at: '2026-01-01T00:00:00.000Z', reason: undefined },
      { from: 'prd', to: 'exec', at: '2026-01-01T00:00:01.000Z', reason: undefined },
    ],
    gateOutcomes: [
      { gate: 'verify-tests', pass: true, reason: 'passed' },
      { gate: 'verify-types', pass: true, reason: 'passed' },
    ],
    reviewerVerdict: 'APPROVE',
    reviewerRationale: 'looks good',
    tokenSpend: { ossTokens: 7000, frontierTokens: 3000 },
    diffStats: { files: 2, lines: 20 },
    safetyCriticalPathsTouched: [],
  };

  it('sanitizeDependencyForBranch strips invalid chars', () => {
    assert.equal(sanitizeDependencyForBranch('@types/node'), '-types-node');
    assert.equal(sanitizeDependencyForBranch('my.pkg_1'), 'my.pkg_1');
  });

  it('versionBumpKind classifies patch/minor/major', () => {
    assert.equal(versionBumpKind('1.2.3', '1.2.4'), 'patch');
    assert.equal(versionBumpKind('1.2.3', '1.3.0'), 'minor');
    assert.equal(versionBumpKind('1.2.3', '2.0.0'), 'major');
    assert.equal(versionBumpKind('1.2.3', '1.2.3'), 'patch');
    assert.equal(versionBumpKind('^1.2.3', '1.2.4'), 'patch');
  });

  it('builds a standard PR spec for ready-to-ship patches', () => {
    const spec = buildPullRequestSpec(baseResult);
    assert.equal(spec.branchName, 'bumpkin/lodash-4.17.0-to-4.17.21');
    assert.equal(spec.title, 'Bump lodash from 4.17.0 to 4.17.21');
    assert.equal(spec.draft, false);
    assert.ok(spec.labels.includes('bumpkin'));
    assert.ok(spec.labels.includes('risk:low'));
    assert.match(spec.body, /\| verify-tests \| ✅ \| passed \|/);
    assert.match(spec.body, /Reviewer verdict:\*\* APPROVE/);
    assert.match(spec.body, /OSS: 7000 tokens \(70.0%\)/);
  });

  it('opts-in auto-merge only for devDep patches when enabled', () => {
    const withOption = buildPullRequestSpec(baseResult, { autoMergeDevDepPatches: true });
    assert.equal(withOption.autoMerge, true);
    const defaults = buildPullRequestSpec(baseResult);
    assert.equal(defaults.autoMerge, false);
  });

  it('never auto-merges major bumps even with the opt-in', () => {
    const majorResult: UpgradeRunResult = {
      ...baseResult,
      target: { ...target, from: '1.0.0', to: '2.0.0', riskLevel: 'high' },
    };
    const spec = buildPullRequestSpec(majorResult, { autoMergeDevDepPatches: true });
    assert.equal(spec.autoMerge, false);
    assert.ok(spec.labels.includes('major-bump'));
  });

  it('flags safety-critical PRs and disables auto-merge regardless of opt-in', () => {
    const safetyResult: UpgradeRunResult = {
      ...baseResult,
      safetyCriticalPathsTouched: ['src/auth/login.ts'],
    };
    const spec = buildPullRequestSpec(safetyResult, { autoMergeDevDepPatches: true });
    assert.equal(spec.autoMerge, false);
    assert.ok(spec.labels.includes('safety-critical'));
    assert.ok(spec.labels.includes('needs-human-review'));
    assert.match(spec.body, /Safety-critical paths touched/);
  });

  it('formats escalated PRs as drafts with the escalation reason', () => {
    const escResult: UpgradeRunResult = {
      ...baseResult,
      status: 'escalated',
      escalationReason: 'max-fix-attempts-exceeded',
    };
    const spec = buildPullRequestSpec(escResult);
    assert.equal(spec.draft, true);
    assert.equal(spec.autoMerge, false);
    assert.match(spec.title, /could not auto-upgrade/);
    assert.match(spec.body, /max-fix-attempts-exceeded/);
    assert.ok(spec.labels.includes('auto-fix-failed'));
    assert.ok(spec.labels.includes('needs-human-review'));
  });

  it('includes the phase-transition audit trail in the PR body', () => {
    const spec = buildPullRequestSpec(baseResult);
    assert.match(spec.body, /2026-01-01T00:00:00\.000Z.*plan → prd/);
    assert.match(spec.body, /2026-01-01T00:00:01\.000Z.*prd → exec/);
  });
});
