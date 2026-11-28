import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CODEX_LOGIN,
  CODEX_REVIEW_LOOP_USAGE,
  FatalReviewLoopError,
  MAX_CONSECUTIVE_FAILURES,
  MAX_POSTS_PER_PASS,
  POSTED_TTL_MS,
  codexReviewLoopCommand,
  decideReviewLoop,
  ghAdapter,
  originRepo,
  parseCodexReviewLoopArgs,
  type PrSnapshot,
  type ReviewLoopAdapter,
  type ReviewLoopDeps,
} from '../supervision-codex-review.js';
import { supervisionCommand } from '../supervision.js';

const NOW = Date.parse('2026-11-28T00:00:00Z');
const pr = (over: Partial<PrSnapshot> = {}): PrSnapshot => ({
  number: 1, draft: false, headSha: 'bbbb', headCommittedAt: '2026-11-27T10:00:00Z', reviews: [], comments: [], ...over,
});
const ME = 'iqdoctor';
const trigger = (createdAt: string, login = ME, body = '@codex review') => ({ login, body, createdAt });
// Real connector reply text (first line of the usage-limit comment seen on PR #4235).
const LIMIT_TEXT = 'You have reached your Codex usage limits. You can see your limits in the [Codex usage dashboard](https://chatgpt.com/codex/cloud/settings/usage).';
const limit = (createdAt: string, login = CODEX_LOGIN) => ({ login, body: LIMIT_TEXT, createdAt });
const kinds = (prs: PrSnapshot[], o: Partial<Parameters<typeof decideReviewLoop>[1]> = {}) =>
  decideReviewLoop(prs, { now: NOW, login: ME, repo: 'o/r', ...o }).decisions.map((d) => d.decision);

describe('decideReviewLoop', () => {
  it('skips a PR reviewed on the head', () => {
    assert.deepEqual(kinds([pr({ reviews: [{ login: CODEX_LOGIN, commitId: 'bbbb' }] })]), ['skip-reviewed']);
  });
  it('posts when the review is only on an older head', () => {
    assert.deepEqual(kinds([pr({ reviews: [{ login: CODEX_LOGIN, commitId: 'aaaa' }] })]), ['post']);
  });
  it('only the exact codex connector login counts as a Codex review or reply', () => {
    assert.deepEqual(kinds([pr({ reviews: [{ login: 'codex-fan', commitId: 'bbbb' }] })]), ['post']);
    const prs = [pr({ comments: [trigger('2026-11-27T11:00:00Z'), limit('2026-11-27T11:01:00Z', 'codex-impostor')] }), pr({ number: 2 })];
    assert.equal(decideReviewLoop(prs, { now: NOW, login: ME }).computedBlockUntil, null);
  });
  it('skips pending trigger posted after the head commit', () => {
    assert.deepEqual(kinds([pr({ comments: [trigger('2026-11-27T11:00:00Z')] })]), ['skip-pending']);
    assert.deepEqual(kinds([pr({ comments: [trigger('2026-11-27T11:00:00Z', ME, '  @codex')] })]), ['skip-pending']);
  });
  it('only an anchored @codex trigger counts: prose, backtick and mid-line mentions do not', () => {
    for (const body of ['thanks @codex for the review', 'try `@codex review` later', 'cc @codex review', 'email@codex.io']) {
      assert.deepEqual(kinds([pr({ comments: [trigger('2026-11-27T11:00:00Z', ME, body)] })]), ['post'], body);
    }
  });
  it('ignores a trigger older than the head commit', () => {
    assert.deepEqual(kinds([pr({ comments: [trigger('2026-11-27T09:00:00Z')] })]), ['post']);
  });
  it('usage-limit reply makes the trigger stale and sets the block', () => {
    const plan = decideReviewLoop([pr({ comments: [trigger('2026-11-27T11:00:00Z'), limit('2026-11-27T11:01:00Z')] }), pr({ number: 2 })], { now: NOW, login: ME });
    assert.equal(plan.decisions[0]?.decision, 'blocked');
    assert.equal(plan.decisions[1]?.decision, 'blocked');
    assert.equal(plan.computedBlockUntil, '2026-11-28T11:01:00.000Z');
    assert.equal(plan.blockedUntil, '2026-11-28T11:01:00.000Z');
  });
  it('a newer unrelated trigger on another PR does not clear the block', () => {
    const prs = [
      pr({ comments: [trigger('2026-11-27T11:00:00Z'), limit('2026-11-27T11:01:00Z')] }),
      pr({ number: 2, comments: [trigger('2026-11-27T12:00:00Z')] }),
      pr({ number: 3 }),
    ];
    const plan = decideReviewLoop(prs, { now: NOW, login: ME });
    assert.equal(plan.computedBlockUntil, '2026-11-28T11:01:00.000Z');
    assert.equal(plan.decisions[2]?.decision, 'blocked');
  });
  it('a limit reply is bound to the trigger it answers, not to a later foreign trigger', () => {
    const prs = [pr({ comments: [trigger('2026-11-27T11:00:00Z'), limit('2026-11-27T11:01:00Z'), trigger('2026-11-27T11:30:00Z', 'someone-else')] })];
    assert.equal(decideReviewLoop(prs, { now: NOW, login: ME }).computedBlockUntil, '2026-11-28T11:01:00.000Z');
    assert.equal(decideReviewLoop(prs, { now: NOW, login: 'someone-else' }).computedBlockUntil, null);
  });
  it('block expires after 24h', () => {
    const plan = decideReviewLoop([pr({ comments: [trigger('2026-11-25T11:00:00Z'), limit('2026-11-25T11:01:00Z')] })], { now: NOW, login: ME });
    assert.equal(plan.blockedUntil, null);
    assert.equal(plan.decisions[0]?.decision, 'post');
  });
  it('honours a stored block and ignores an expired stored block', () => {
    assert.deepEqual(kinds([pr()], { stateBlockedUntil: '2026-11-28T14:30:00Z' }), ['blocked']);
    assert.deepEqual(kinds([pr()], { stateBlockedUntil: '2026-11-27T14:30:00Z' }), ['post']);
  });
  it("another account's usage limit does not block the caller", () => {
    const prs = [pr({ comments: [trigger('2026-11-27T11:00:00Z', 'someone-else'), limit('2026-11-27T11:01:00Z')] }), pr({ number: 2 })];
    const plan = decideReviewLoop(prs, { now: NOW, login: ME });
    assert.equal(plan.computedBlockUntil, null);
    assert.equal(plan.decisions[1]?.decision, 'post');
  });
  it("another account's limited trigger is not pending, an unanswered one is", () => {
    const limited = pr({ comments: [trigger('2026-11-27T11:00:00Z', 'someone-else'), limit('2026-11-27T11:01:00Z')] });
    assert.deepEqual(kinds([limited]), ['post']);
    assert.deepEqual(kinds([pr({ comments: [trigger('2026-11-27T11:00:00Z', 'someone-else')] })]), ['skip-pending']);
  });
  it('caps posts per pass', () => {
    const prs = Array.from({ length: MAX_POSTS_PER_PASS + 2 }, (_, i) => pr({ number: i + 1 }));
    const k = kinds(prs);
    assert.equal(k.filter((x) => x === 'post').length, MAX_POSTS_PER_PASS);
    assert.equal(k.filter((x) => x === 'capped').length, 2);
  });
  it('includes drafts', () => {
    assert.deepEqual(kinds([pr({ draft: true })]), ['post']);
  });
  it('skips a head already posted within the TTL, but not an older post, other head, or other repo', () => {
    const at = (offset: number) => new Date(NOW - offset).toISOString();
    const entry = (over = {}, offset = 1000) => ({ repo: 'o/r', pr: 1, headSha: 'bbbb', postedAt: at(offset), ...over });
    assert.deepEqual(kinds([pr()], { posted: [entry()] }), ['skip-posted']);
    assert.deepEqual(kinds([pr()], { posted: [entry({}, POSTED_TTL_MS + 1)] }), ['post']);
    assert.deepEqual(kinds([pr()], { posted: [entry({ headSha: 'aaaa' })] }), ['post']);
    assert.deepEqual(kinds([pr()], { posted: [entry({ repo: 'o/other' })] }), ['post']);
  });
  it('a PR whose fetch failed is an error decision and does not abort the others', () => {
    const k = kinds([pr({ number: 1, error: 'gh api: HTTP 404' }), pr({ number: 2 })]);
    assert.deepEqual(k, ['error', 'post']);
  });
});

describe('parseCodexReviewLoopArgs', () => {
  it('parses --watch with and without seconds', () => {
    assert.equal(parseCodexReviewLoopArgs(['--watch']).watch, 600);
    assert.equal(parseCodexReviewLoopArgs(['--watch', '30', '--json']).watch, 30);
    assert.equal(parseCodexReviewLoopArgs(['--watch', '--post']).watch, 600);
    assert.throws(() => parseCodexReviewLoopArgs(['--bogus']), /Unknown option/);
  });
  it('rejects an invalid --watch value with a value error, not "Unknown option"', () => {
    for (const bad of ['-1', 'abc', '0']) {
      assert.throws(() => parseCodexReviewLoopArgs(['--watch', bad]), /--watch expects positive seconds/, bad);
    }
  });
});

describe('codex-review-loop CLI', () => {
  const adapter = (posted: number[], prs: PrSnapshot[] = [pr({ number: 7 })]): ReviewLoopAdapter => ({
    currentLogin: async () => ME,
    fetchPrs: async () => prs,
    postComment: async (_r, n) => { posted.push(n); },
  });
  const withTmp = async (fn: (dir: string, stateFile: string) => Promise<void>): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), 'crl-'));
    try { await fn(dir, join(dir, 'state', 'codex-review-loop.json')); } finally { await rm(dir, { recursive: true, force: true }); }
  };
  const deps = (dir: string, stateFile: string, over: Partial<ReviewLoopDeps> = {}): Partial<ReviewLoopDeps> =>
    ({ cwd: dir, stateFile, now: () => NOW, log: () => {}, error: () => {}, sleep: async () => {}, ...over });
  const exists = async (p: string): Promise<boolean> => stat(p).then(() => true, () => false);
  const readJson = async (p: string) => JSON.parse(await readFile(p, 'utf-8'));

  it('dry run never posts and never writes state, even when a block is computed', async () => {
    await withTmp(async (dir, stateFile) => {
      const posted: number[] = [];
      const out: string[] = [];
      const limited = [pr({ number: 7, comments: [trigger('2026-11-27T23:00:00Z'), limit('2026-11-27T23:30:00Z')] })];
      await codexReviewLoopCommand(['--repo', 'o/r'], deps(dir, stateFile, { adapter: adapter(posted), log: (s) => out.push(s) }));
      await codexReviewLoopCommand(['--repo', 'o/r'], deps(dir, stateFile, { adapter: adapter(posted, limited) }));
      assert.deepEqual(posted, []);
      assert.match(out.join('\n'), /#7 bbbb post/);
      assert.equal(await exists(stateFile), false);
      assert.deepEqual(await readdir(dir), []); // nothing anywhere under the temp tree
    });
  });

  it('--post comments, logs each post, and records the ledger; the next pass skips that head', async () => {
    await withTmp(async (dir, stateFile) => {
      const posted: number[] = [];
      const out: string[] = [];
      await codexReviewLoopCommand(['--repo', 'o/r', '--post'], deps(dir, stateFile, { adapter: adapter(posted), log: (s) => out.push(s) }));
      assert.deepEqual(posted, [7]);
      assert.match(out[0] ?? '', /^posted @codex review on o\/r#7 bbbb/);
      assert.match(out.join('\n'), /#7 bbbb posted/);
      const state = await readJson(stateFile);
      assert.deepEqual(state[ME].posted, [{ repo: 'o/r', pr: 7, headSha: 'bbbb', postedAt: '2026-11-28T00:00:00.000Z' }]);
      await codexReviewLoopCommand(['--repo', 'o/r', '--post'], deps(dir, stateFile, { adapter: adapter(posted) }));
      assert.deepEqual(posted, [7]);
    });
  });

  it('--post persists max(stored, computed) block and never downgrades it', async () => {
    await withTmp(async (dir, stateFile) => {
      const blocked = (replyAt: string): ReviewLoopAdapter => ({
        currentLogin: async () => ME,
        fetchPrs: async () => [pr({ comments: [trigger('2026-11-27T22:00:00Z'), limit(replyAt)] })],
        postComment: async () => { throw new Error('must not post'); },
      });
      await codexReviewLoopCommand(['--repo', 'o/r', '--post'], deps(dir, stateFile, { adapter: blocked('2026-11-27T23:30:00Z') }));
      assert.equal((await readJson(stateFile))[ME].blocked_until, '2026-11-28T23:30:00.000Z');
      await codexReviewLoopCommand(['--repo', 'o/r', '--post'], deps(dir, stateFile, { adapter: blocked('2026-11-27T22:30:00Z') }));
      assert.equal((await readJson(stateFile))[ME].blocked_until, '2026-11-28T23:30:00.000Z');
    });
  });

  it('a block recorded by another run mid-pass stops the remaining posts', async () => {
    await withTmp(async (dir, stateFile) => {
      const posted: number[] = [];
      const racing: ReviewLoopAdapter = {
        currentLogin: async () => ME,
        fetchPrs: async () => [pr({ number: 1 }), pr({ number: 2 }), pr({ number: 3 })],
        postComment: async (_r, n) => {
          posted.push(n);
          await mkdir(join(dir, 'state'), { recursive: true });
          await writeFile(stateFile, JSON.stringify({ [ME]: { blocked_until: '2026-11-28T10:00:00.000Z' } }));
        },
      };
      const out: string[] = [];
      await codexReviewLoopCommand(['--repo', 'o/r', '--post', '--json'], deps(dir, stateFile, { adapter: racing, log: (s) => out.push(s) }));
      assert.deepEqual(posted, [1]);
      const plan = JSON.parse(out[out.length - 1] as string);
      assert.deepEqual(plan.decisions.map((d: { decision: string }) => d.decision), ['posted', 'blocked', 'blocked']);
    });
  });

  it('a failed post is an error decision for that PR; the rest of the pass continues', async () => {
    await withTmp(async (dir, stateFile) => {
      const posted: number[] = [];
      const flaky: ReviewLoopAdapter = {
        currentLogin: async () => ME,
        fetchPrs: async () => [pr({ number: 1 }), pr({ number: 2 }), pr({ number: 3 })],
        postComment: async (_r, n) => { if (n === 2) throw new Error('boom'); posted.push(n); },
      };
      const out: string[] = [];
      await codexReviewLoopCommand(['--repo', 'o/r', '--post'], deps(dir, stateFile, { adapter: flaky, log: (s) => out.push(s) }));
      assert.deepEqual(posted, [1, 3]);
      assert.match(out.join('\n'), /#2 bbbb error: post failed: boom/);
      assert.deepEqual((await readJson(stateFile))[ME].posted.map((p: { pr: number }) => p.pr), [1, 3]);
    });
  });

  it('--json emits one compact JSON object per pass (NDJSON)', async () => {
    await withTmp(async (dir, stateFile) => {
      const out: string[] = [];
      let passes = 0;
      const ac: ReviewLoopAdapter = { ...adapter([]), fetchPrs: async () => { passes += 1; return [pr()]; } };
      await codexReviewLoopCommand(['--repo', 'o/r', '--json', '--watch', '5'], deps(dir, stateFile, {
        adapter: ac,
        log: (s) => out.push(s),
        sleep: async () => { if (passes >= 2) (process.listeners('SIGINT').at(-1) as () => void)(); },
      }));
      assert.equal(out.length, 2);
      for (const line of out) { assert.ok(!line.includes('\n')); assert.equal(JSON.parse(line).repo, 'o/r'); }
    });
  });

  it('fails closed on corrupt or unreadable state instead of treating it as empty', async () => {
    await withTmp(async (dir, stateFile) => {
      await mkdir(join(dir, 'state'), { recursive: true });
      await writeFile(stateFile, '{not json');
      await assert.rejects(codexReviewLoopCommand(['--repo', 'o/r'], deps(dir, stateFile, { adapter: adapter([]) })), /corrupt state/);
      await writeFile(stateFile, '[]');
      await assert.rejects(codexReviewLoopCommand(['--repo', 'o/r'], deps(dir, stateFile, { adapter: adapter([]) })), /corrupt state/);
      await rm(stateFile);
      await mkdir(stateFile); // a directory: EISDIR, not ENOENT
      await assert.rejects(codexReviewLoopCommand(['--repo', 'o/r'], deps(dir, stateFile, { adapter: adapter([]) })), /cannot read state/);
    });
  });

  it('state writes are atomic: no temp file is left behind', async () => {
    await withTmp(async (dir, stateFile) => {
      await codexReviewLoopCommand(['--repo', 'o/r', '--post'], deps(dir, stateFile, { adapter: adapter([]) }));
      assert.deepEqual(await readdir(join(dir, 'state')), ['codex-review-loop.json']);
    });
  });

  describe('--watch', () => {
    it('exits non-zero immediately on a fatal error', async () => {
      await withTmp(async (dir, stateFile) => {
        let calls = 0;
        const fatal: ReviewLoopAdapter = { ...adapter([]), currentLogin: async () => { calls += 1; throw new FatalReviewLoopError('gh auth login'); } };
        await assert.rejects(codexReviewLoopCommand(['--repo', 'o/r', '--watch', '5'], deps(dir, stateFile, { adapter: fatal })), FatalReviewLoopError);
        assert.equal(calls, 1);
      });
    });

    it('backs off on transient errors, logs via the injected logger, gives up at the failure cap', async () => {
      await withTmp(async (dir, stateFile) => {
        let calls = 0;
        const sleeps: number[] = [];
        const errs: string[] = [];
        const flaky: ReviewLoopAdapter = { ...adapter([]), currentLogin: async () => { calls += 1; throw new Error('HTTP 502'); } };
        await assert.rejects(
          codexReviewLoopCommand(['--repo', 'o/r', '--watch', '5'], deps(dir, stateFile, { adapter: flaky, error: (s) => errs.push(s), sleep: async (ms) => { sleeps.push(ms); } })),
          /giving up after 5 consecutive failures: HTTP 502/,
        );
        assert.equal(calls, MAX_CONSECUTIVE_FAILURES);
        assert.deepEqual(sleeps, [10_000, 20_000, 40_000, 80_000]);
        assert.equal(errs.length, MAX_CONSECUTIVE_FAILURES);
        assert.match(errs[0] as string, /pass failed \(1\/5\): HTTP 502/);
      });
    });

    it('a success resets the failure count', async () => {
      await withTmp(async (dir, stateFile) => {
        let calls = 0;
        const script = [false, false, false, false, true, false, false, false, false, true];
        const a: ReviewLoopAdapter = {
          ...adapter([]),
          currentLogin: async () => { if (!script[calls++]) throw new Error('HTTP 502'); return ME; },
        };
        const sleep = async (): Promise<void> => { if (calls >= script.length) (process.listeners('SIGINT').at(-1) as () => void)(); };
        await codexReviewLoopCommand(['--repo', 'o/r', '--watch', '5'], deps(dir, stateFile, { adapter: a, sleep }));
        assert.equal(calls, script.length);
      });
    });

    it('SIGINT ends the sleep: no timer survives and the listener is removed', async () => {
      await withTmp(async (dir, stateFile) => {
        const timers = (): number => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
        const baseTimers = timers();
        const baseListeners = process.listeners('SIGINT').length;
        let started: () => void = () => {};
        const inFirstPass = new Promise<void>((r) => { started = r; });
        const a: ReviewLoopAdapter = { ...adapter([]), fetchPrs: async () => { started(); return [pr()]; } };
        const d = deps(dir, stateFile, { adapter: a });
        delete d.sleep; // real abortable sleep
        const run = codexReviewLoopCommand(['--repo', 'o/r', '--watch', '3600'], d);
        await inFirstPass;
        await new Promise((r) => setImmediate(r));
        const ours = process.listeners('SIGINT').at(-1) as () => void;
        assert.equal(process.listeners('SIGINT').length, baseListeners + 1);
        // Call our handler directly: process.emit would also reach the test runner's own SIGINT handler.
        ours();
        await run;
        assert.equal(process.listeners('SIGINT').length, baseListeners);
        assert.equal(timers(), baseTimers);
      });
    });
  });

  it('is dispatched from `omx supervision codex-review-loop`', async () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (s: unknown) => { lines.push(String(s)); };
    try { await supervisionCommand(['codex-review-loop', '--help']); } finally { console.log = orig; }
    assert.ok(lines[0]?.includes(CODEX_REVIEW_LOOP_USAGE));
  });
});

describe('gh adapter (fake gh on PATH)', () => {
  const FAKE_GH = `#!/bin/sh
args="$*"
case "$args" in
  "api user --jq .login") echo "${ME}" ;;
  *"repos/o/missing/pulls"*) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
  *"repos/o/flaky/pulls"*) echo "gh: Bad Gateway (HTTP 502)" >&2; exit 1 ;;
  *"repos/o/r/pulls?state=open"*)
    echo '{"number":1,"draft":false,"head":{"sha":"aaa"}}'
    echo '{"number":2,"draft":true,"head":{"sha":"bbb"}}' ;;
  *"repos/o/r/pulls/1/reviews"*) echo '{"user":{"login":"${CODEX_LOGIN}"},"commit_id":"aaa"}' ;;
  *"repos/o/r/issues/1/comments"*"-F"*) cat > "$GH_FAKE_LOG" ;;
  *"repos/o/r/issues/1/comments"*) echo '{"user":{"login":"${ME}"},"body":"@codex review","created_at":"2026-11-27T11:00:00Z"}' ;;
  *"repos/o/r/commits/aaa"*) echo '{"commit":{"committer":{"date":"2026-11-27T10:00:00Z"}}}' ;;
  *"repos/o/r/pulls/2/reviews"*) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
  *) echo '[]' ;;
esac
`;
  const withFakeGh = async (fn: (dir: string) => Promise<void>): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), 'crl-gh-'));
    const oldPath = process.env.PATH;
    try {
      await writeFile(join(dir, 'gh'), FAKE_GH);
      await chmod(join(dir, 'gh'), 0o755);
      process.env.PATH = `${dir}:${oldPath ?? ''}`;
      process.env.GH_FAKE_LOG = join(dir, 'posted.txt');
      await fn(dir);
    } finally {
      process.env.PATH = oldPath;
      delete process.env.GH_FAKE_LOG;
      await rm(dir, { recursive: true, force: true });
    }
  };

  it('maps the list fields, isolates a per-PR failure, and posts the comment body via stdin', async () => {
    await withFakeGh(async (dir) => {
      assert.equal(await ghAdapter.currentLogin(), ME);
      const prs = await ghAdapter.fetchPrs('o/r');
      assert.equal(prs.length, 2);
      assert.deepEqual(
        { n: prs[0]?.number, d: prs[0]?.draft, sha: prs[0]?.headSha, at: prs[0]?.headCommittedAt, r: prs[0]?.reviews, c: prs[0]?.comments.length },
        { n: 1, d: false, sha: 'aaa', at: '2026-11-27T10:00:00Z', r: [{ login: CODEX_LOGIN, commitId: 'aaa' }], c: 1 },
      );
      assert.equal(prs[1]?.draft, true);
      assert.match(prs[1]?.error ?? '', /HTTP 404/);
      await ghAdapter.postComment('o/r', 1, '@codex review');
      assert.equal(await readFile(join(dir, 'posted.txt'), 'utf-8'), '@codex review');
    });
  });

  it('classifies 404 as fatal and 5xx as transient', async () => {
    await withFakeGh(async () => {
      await assert.rejects(ghAdapter.fetchPrs('o/missing'), FatalReviewLoopError);
      await assert.rejects(ghAdapter.fetchPrs('o/flaky'), (e: Error) => !(e instanceof FatalReviewLoopError) && /502/.test(e.message));
    });
  });

  it('a missing gh binary is fatal', async () => {
    const oldPath = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try { await assert.rejects(ghAdapter.currentLogin(), FatalReviewLoopError); } finally { process.env.PATH = oldPath; }
  });
});

describe('originRepo', () => {
  it('derives owner/name from the origin remote', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crl-git-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:Yeachan-Heo/oh-my-codex.git'], { cwd: dir });
      assert.equal(originRepo(dir), 'Yeachan-Heo/oh-my-codex');
      execFileSync('git', ['remote', 'set-url', 'origin', 'https://example.com/x/y.git'], { cwd: dir });
      assert.throws(() => originRepo(dir), /not a GitHub repo/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
