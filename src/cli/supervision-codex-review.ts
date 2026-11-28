/**
 * `omx supervision codex-review-loop`: scan open PRs and post `@codex review` on heads that
 * have no Codex review yet. Dry run by default; `--post` comments with the caller's own gh auth.
 * The decision is a pure function over fetched data; gh calls live in `ghAdapter`.
 */
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const CODEX_REVIEW_LOOP_USAGE =
  'omx supervision codex-review-loop [--repo owner/name] [--post] [--watch [seconds]] [--json]';
export const CODEX_REVIEW_COMMENT = '@codex review';
export const CODEX_LOGIN = 'chatgpt-codex-connector[bot]';
export const DEFAULT_WATCH_SECONDS = 600;
export const MAX_POSTS_PER_PASS = 10;
export const BLOCK_MS = 24 * 60 * 60 * 1000;
/** A head we already posted for is not re-triggered within this window (the ledger TTL). */
export const POSTED_TTL_MS = 6 * 60 * 60 * 1000;
export const MAX_CONSECUTIVE_FAILURES = 5;
const MAX_BACKOFF_SECONDS = 3600;
const GH_TIMEOUT_MS = 60_000;

/** Auth, missing repo, or unparseable output: retrying cannot help, so the command exits non-zero. */
export class FatalReviewLoopError extends Error {}

export interface PrReview { login: string; commitId: string }
export interface PrComment { login: string; body: string; createdAt: string }
export interface PrSnapshot {
  number: number;
  draft: boolean;
  headSha: string;
  headCommittedAt: string;
  reviews: PrReview[];
  comments: PrComment[];
  /** Set when this PR's details could not be fetched; it becomes an `error` decision. */
  error?: string;
}
export interface PostedEntry { repo: string; pr: number; headSha: string; postedAt: string }

export type DecisionKind = 'skip-reviewed' | 'skip-posted' | 'skip-pending' | 'post' | 'posted' | 'blocked' | 'capped' | 'error';
export interface PrDecision { number: number; headSha: string; draft: boolean; decision: DecisionKind; reason: string }
export interface LoopPlan { decisions: PrDecision[]; blockedUntil: string | null; computedBlockUntil: string | null }

const isCodex = (login: string): boolean => login === CODEX_LOGIN;
const ms = (iso: string): number => Date.parse(iso);

const TRIGGER_RE = /^\s*@codex(\s+review)?\b/im;
const isTrigger = (c: PrComment): boolean => !isCodex(c.login) && TRIGGER_RE.test(c.body);
const isLimitReply = (c: PrComment): boolean => isCodex(c.login) && /usage limits/i.test(c.body);

/** Usage-limit replies on one PR, each paired with the nearest preceding unanswered `@codex` trigger. */
function limitReplies(comments: readonly PrComment[]): { trigger: PrComment; reply: PrComment }[] {
  const sorted = [...comments].sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
  const out: { trigger: PrComment; reply: PrComment }[] = [];
  let last: PrComment | null = null;
  for (const c of sorted) {
    if (isTrigger(c)) last = c;
    else if (isLimitReply(c) && last) { out.push({ trigger: last, reply: c }); last = null; }
  }
  return out;
}

/** Newest usage-limit reply to one of `login`'s own triggers, +24h. Quota is per triggering account; unrelated newer triggers do not clear it. */
export function computeBlockUntil(prs: readonly PrSnapshot[], login: string): string | null {
  let newest = -Infinity;
  for (const pr of prs) {
    for (const { trigger, reply } of limitReplies(pr.comments)) {
      if (trigger.login === login) newest = Math.max(newest, ms(reply.createdAt));
    }
  }
  return Number.isFinite(newest) ? new Date(newest + BLOCK_MS).toISOString() : null;
}

export const wasPosted = (posted: readonly PostedEntry[], repo: string, pr: number, headSha: string, now: number): boolean =>
  posted.some((p) => p.repo === repo && p.pr === pr && p.headSha === headSha && now - ms(p.postedAt) < POSTED_TTL_MS);

export function decideReviewLoop(
  prs: readonly PrSnapshot[],
  opts: { now: number; login: string; repo?: string; stateBlockedUntil?: string | null; posted?: readonly PostedEntry[]; cap?: number },
): LoopPlan {
  const cap = opts.cap ?? MAX_POSTS_PER_PASS;
  const computed = computeBlockUntil(prs, opts.login);
  const until = Math.max(computed ? ms(computed) : -Infinity, opts.stateBlockedUntil ? ms(opts.stateBlockedUntil) : -Infinity);
  const blocked = until > opts.now;
  let posts = 0;
  const decisions = prs.map((pr): PrDecision => {
    const base = { number: pr.number, headSha: pr.headSha, draft: pr.draft };
    if (pr.error) return { ...base, decision: 'error', reason: pr.error };
    if (pr.reviews.some((r) => isCodex(r.login) && r.commitId === pr.headSha)) {
      return { ...base, decision: 'skip-reviewed', reason: 'Codex review exists on this head' };
    }
    if (wasPosted(opts.posted ?? [], opts.repo ?? '', pr.number, pr.headSha, opts.now)) {
      return { ...base, decision: 'skip-posted', reason: 'already posted for this head within the last 6h' };
    }
    const committed = ms(pr.headCommittedAt);
    const stale = new Set(limitReplies(pr.comments).map((x) => x.trigger));
    const pending = pr.comments.some((t) => isTrigger(t) && ms(t.createdAt) > committed && !stale.has(t));
    if (pending) return { ...base, decision: 'skip-pending', reason: 'trigger posted after head commit, no usage-limit reply' };
    if (blocked) return { ...base, decision: 'blocked', reason: `blocked until ${new Date(until).toISOString()}` };
    if (posts >= cap) return { ...base, decision: 'capped', reason: `post cap ${cap} reached this pass` };
    posts += 1;
    return { ...base, decision: 'post', reason: 'no Codex review or live trigger on this head' };
  });
  return { decisions, blockedUntil: blocked ? new Date(until).toISOString() : null, computedBlockUntil: computed };
}

// ---------------------------------------------------------------------------
// gh adapter
// ---------------------------------------------------------------------------

export interface ReviewLoopAdapter {
  currentLogin(): Promise<string>;
  fetchPrs(repo: string): Promise<PrSnapshot[]>;
  postComment(repo: string, number: number, body: string): Promise<void>;
}

const FATAL_GH = /HTTP (401|403|404|410)|gh auth login|not logged in|bad credentials|could not resolve to a repository/i;

function classifyGhError(args: string[], e: unknown): Error {
  const err = e as { code?: unknown; killed?: boolean; stderr?: string; message?: string };
  const label = `gh ${args.slice(0, 2).join(' ')}`;
  if (err.code === 'ENOENT') return new FatalReviewLoopError(`${label}: gh is not installed`);
  if (err.killed) return new Error(`${label} timed out after ${GH_TIMEOUT_MS / 1000}s`);
  const text = `${err.stderr ?? ''}\n${err.message ?? ''}`.trim();
  // A 403 that is a rate limit is transient; any other 401/403/404 will not heal by retrying.
  if (!/rate limit/i.test(text) && FATAL_GH.test(text)) return new FatalReviewLoopError(`${label}: ${text}`);
  return new Error(`${label}: ${text}`);
}

async function gh(args: string[], input?: string): Promise<string> {
  const child = execFileAsync('gh', args, { maxBuffer: 64 * 1024 * 1024, timeout: GH_TIMEOUT_MS });
  if (input !== undefined) child.child.stdin?.end(input);
  try {
    return (await child).stdout;
  } catch (e) {
    throw classifyGhError(args, e);
  }
}

function parseJson<T>(text: string, what: string): T {
  try { return JSON.parse(text) as T; } catch { throw new FatalReviewLoopError(`could not parse gh output for ${what}`); }
}

/** `--paginate --jq` prints one compact JSON object per line (old gh concatenates raw arrays). */
async function ghList<T>(path: string, jq = '.[]'): Promise<T[]> {
  const out = await gh(['api', '--paginate', path, '--jq', jq]);
  return out.split('\n').filter((l) => l.trim()).map((l) => parseJson<T>(l, path));
}

export const ghAdapter: ReviewLoopAdapter = {
  async currentLogin() {
    const login = (await gh(['api', 'user', '--jq', '.login'])).trim();
    if (!login) throw new FatalReviewLoopError('could not resolve the gh login (gh api user)');
    return login;
  },
  async fetchPrs(repo) {
    const open = await ghList<{ number: number; draft?: boolean; head: { sha: string } }>(
      `repos/${repo}/pulls?state=open&per_page=100`,
      '.[] | {number, draft, head: {sha: .head.sha}}',
    );
    const out: PrSnapshot[] = [];
    for (const { number, draft, head } of open) {
      const base = { number, draft: Boolean(draft), headSha: head.sha };
      try {
        const [reviews, comments, commit] = await Promise.all([
          ghList<{ user?: { login: string } | null; commit_id: string }>(`repos/${repo}/pulls/${number}/reviews?per_page=100`),
          ghList<{ user?: { login: string } | null; body?: string; created_at: string }>(`repos/${repo}/issues/${number}/comments?per_page=100`),
          gh(['api', `repos/${repo}/commits/${head.sha}`]).then((s) => parseJson<{ commit: { committer: { date: string } } }>(s, `commit ${head.sha}`)),
        ]);
        out.push({
          ...base,
          headCommittedAt: commit.commit.committer.date,
          reviews: reviews.map((r) => ({ login: r.user?.login ?? '', commitId: r.commit_id })),
          comments: comments.map((c) => ({ login: c.user?.login ?? '', body: c.body ?? '', createdAt: c.created_at })),
        });
      } catch (e) {
        out.push({ ...base, headCommittedAt: '', reviews: [], comments: [], error: e instanceof Error ? e.message : String(e) });
      }
    }
    return out;
  },
  async postComment(repo, number, body) {
    await gh(['api', `repos/${repo}/issues/${number}/comments`, '-F', 'body=@-'], body);
  },
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CodexReviewLoopOptions { repo?: string; post: boolean; watch: number | null; json: boolean; help: boolean }

export function parseCodexReviewLoopArgs(args: readonly string[]): CodexReviewLoopOptions {
  const o: CodexReviewLoopOptions = { post: false, watch: null, json: false, help: false };
  for (let i = 0; i < args.length; i += 1) {
    const t = args[i] as string;
    if (t === '--post') o.post = true;
    else if (t === '--json') o.json = true;
    else if (t === '--help' || t === '-h') o.help = true;
    else if (t === '--repo' || t.startsWith('--repo=')) {
      const v = t === '--repo' ? args[++i] : t.slice('--repo='.length);
      if (!v || !/^[\w.-]+\/[\w.-]+$/.test(v)) throw new Error(`--repo expects owner/name, got: ${v ?? '(missing)'}`);
      o.repo = v;
    } else if (t === '--watch' || t.startsWith('--watch=')) {
      let raw: string | undefined = t.startsWith('--watch=') ? t.slice('--watch='.length) : undefined;
      if (raw === undefined && /^(-?\d+|[^-].*)$/.test(args[i + 1] ?? '')) raw = args[++i];
      const n = raw === undefined ? DEFAULT_WATCH_SECONDS : Number(raw);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`--watch expects positive seconds, got: ${raw}`);
      o.watch = n;
    } else throw new Error(`Unknown option for codex-review-loop: ${t}\nUsage: ${CODEX_REVIEW_LOOP_USAGE}`);
  }
  return o;
}

export function originRepo(cwd: string): string {
  const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf-8' }).trim();
  const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!m) throw new Error(`origin is not a GitHub repo: ${url}`);
  return m[1] as string;
}

/** Per-account state under the home dir: one file shared by every worktree and session of the same user. */
export const defaultStateFile = (): string => join(homedir(), '.omx', 'state', 'supervision', 'codex-review-loop.json');

interface AccountState { blocked_until?: unknown; posted?: unknown }
type LoopState = Record<string, AccountState>;

/** Missing file is an empty state; unreadable or corrupt state fails closed so a lost block is never silently ignored. */
async function readState(file: string): Promise<LoopState> {
  let text: string;
  try {
    text = await readFile(file, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new FatalReviewLoopError(`cannot read state ${file}: ${(e as Error).message}`);
  }
  let v: unknown;
  try { v = JSON.parse(text); } catch { throw new FatalReviewLoopError(`corrupt state ${file}: invalid JSON; fix or delete it`); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new FatalReviewLoopError(`corrupt state ${file}: expected an object; fix or delete it`);
  return v as LoopState;
}

/** temp + rename, same shape as writeAtomicFile in src/state/operations.ts. */
async function writeStateAtomic(file: string, state: LoopState): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  await writeFile(tmp, `${JSON.stringify(state)}\n`, 'utf-8');
  try {
    await rename(tmp, file);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

function blockedUntilOf(entry: AccountState | undefined): string | null {
  const v = entry?.blocked_until;
  return typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null;
}

function postedOf(entry: AccountState | undefined): PostedEntry[] {
  if (!Array.isArray(entry?.posted)) return [];
  return (entry.posted as PostedEntry[]).filter(
    (p) => p && typeof p.repo === 'string' && typeof p.pr === 'number' && typeof p.headSha === 'string' && Number.isFinite(Date.parse(p.postedAt)),
  );
}

/** Re-read, apply, prune expired blocks and ledger entries, write atomically. No lock: single-user CLI, and callers re-check the ledger right before each post. */
async function updateAccount(file: string, login: string, now: number, fn: (e: { blocked: string | null; posted: PostedEntry[] }) => void): Promise<void> {
  const state = await readState(file);
  const cur = { blocked: blockedUntilOf(state[login]), posted: postedOf(state[login]) };
  fn(cur);
  const next: AccountState = {};
  if (cur.blocked && ms(cur.blocked) > now) next.blocked_until = cur.blocked;
  const live = cur.posted.filter((p) => now - ms(p.postedAt) < POSTED_TTL_MS);
  if (live.length > 0) next.posted = live;
  await writeStateAtomic(file, { ...state, [login]: next });
}

export interface ReviewLoopDeps {
  adapter: ReviewLoopAdapter;
  cwd: string;
  stateFile: string;
  now: () => number;
  log: (s: string) => void;
  error: (s: string) => void;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

export async function runCodexReviewLoopPass(opts: CodexReviewLoopOptions, repo: string, deps: ReviewLoopDeps): Promise<LoopPlan> {
  const login = await deps.adapter.currentLogin();
  const prs = await deps.adapter.fetchPrs(repo);
  const state = await readState(deps.stateFile);
  const stored = blockedUntilOf(state[login]);
  const plan = decideReviewLoop(prs, { now: deps.now(), login, repo, stateBlockedUntil: stored, posted: postedOf(state[login]) });
  const until = plan.computedBlockUntil;
  if (opts.post && until && (!stored || ms(until) > ms(stored)) && ms(until) > deps.now()) {
    await updateAccount(deps.stateFile, login, deps.now(), (e) => { e.blocked = until; });
  }
  if (opts.post) {
    let stop: string | null = null;
    for (const d of plan.decisions) {
      if (d.decision !== 'post') continue;
      if (!stop) {
        // Re-check just before posting: another run may have recorded a block or this head since we read state.
        const fresh = (await readState(deps.stateFile))[login];
        const freshBlock = blockedUntilOf(fresh);
        if (freshBlock && ms(freshBlock) > deps.now()) stop = `blocked until ${freshBlock}`;
        else if (wasPosted(postedOf(fresh), repo, d.number, d.headSha, deps.now())) {
          d.decision = 'skip-posted';
          d.reason = 'already posted for this head within the last 6h';
          continue;
        }
      }
      if (stop) { d.decision = 'blocked'; d.reason = stop; continue; }
      try {
        await deps.adapter.postComment(repo, d.number, CODEX_REVIEW_COMMENT);
      } catch (e) {
        d.decision = 'error';
        d.reason = `post failed: ${e instanceof Error ? e.message : String(e)}`;
        continue;
      }
      d.decision = 'posted';
      deps.log(`posted ${CODEX_REVIEW_COMMENT} on ${repo}#${d.number} ${d.headSha.slice(0, 9)}`);
      await updateAccount(deps.stateFile, login, deps.now(), (e) => {
        e.posted.push({ repo, pr: d.number, headSha: d.headSha, postedAt: new Date(deps.now()).toISOString() });
      });
    }
  }
  if (opts.json) deps.log(JSON.stringify({ repo, login, post: opts.post, ...plan }));
  else {
    deps.log(`codex-review-loop ${repo} as ${login} (${opts.post ? 'POST' : 'dry run'}), ${plan.decisions.length} open PRs`);
    if (plan.blockedUntil) deps.log(`blocked until ${plan.blockedUntil}`);
    for (const d of plan.decisions) {
      deps.log(`#${d.number}${d.draft ? ' (draft)' : ''} ${d.headSha.slice(0, 9)} ${d.decision}: ${d.reason}`);
    }
  }
  return plan;
}

const sleepUnlessAborted = async (ms: number, signal: AbortSignal): Promise<void> => {
  try { await delay(ms, undefined, { signal }); } catch (e) { if ((e as Error).name !== 'AbortError') throw e; }
};

export async function codexReviewLoopCommand(args: readonly string[], overrides: Partial<ReviewLoopDeps> = {}): Promise<void> {
  const opts = parseCodexReviewLoopArgs(args);
  if (opts.help) {
    console.log(`Usage: ${CODEX_REVIEW_LOOP_USAGE}\n\nPosts "${CODEX_REVIEW_COMMENT}" on open PRs whose head has no Codex review. Dry run (no state written) unless --post.`);
    return;
  }
  const cwd = overrides.cwd ?? process.cwd();
  const deps: ReviewLoopDeps = {
    adapter: ghAdapter, cwd, stateFile: defaultStateFile(), now: Date.now,
    log: console.log, error: console.error, sleep: sleepUnlessAborted, ...overrides,
  };
  const repo = opts.repo ?? originRepo(cwd);
  if (opts.watch === null) {
    await runCodexReviewLoopPass(opts, repo, deps);
    return;
  }
  const ac = new AbortController();
  const onSigint = (): void => ac.abort();
  process.once('SIGINT', onSigint);
  let failures = 0;
  try {
    while (!ac.signal.aborted) {
      try {
        await runCodexReviewLoopPass(opts, repo, deps);
        failures = 0;
      } catch (e) {
        if (e instanceof FatalReviewLoopError) throw e;
        failures += 1;
        const msg = e instanceof Error ? e.message : String(e);
        deps.error(`codex-review-loop pass failed (${failures}/${MAX_CONSECUTIVE_FAILURES}): ${msg}`);
        if (failures >= MAX_CONSECUTIVE_FAILURES) throw new Error(`giving up after ${failures} consecutive failures: ${msg}`);
      }
      if (ac.signal.aborted) break;
      const seconds = failures === 0 ? opts.watch : Math.min(opts.watch * 2 ** failures, Math.max(opts.watch, MAX_BACKOFF_SECONDS));
      await deps.sleep(seconds * 1000, ac.signal);
    }
  } finally {
    process.off('SIGINT', onSigint);
  }
}
