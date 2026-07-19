import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { omxStateDir } from '../utils/paths.js';
import { writeAtomic } from './state.js';

export const TEAM_NOTICE_LEDGER_MARKER_PREFIX = '[omx:team-notice-ledger:';
export const TEAM_NOTICE_CLASSES = ['mailbox', 'all_idle', 'worker_idle', 'leader_stale', 'worker_stop', 'terminal'] as const;

export type TeamNoticeClass = typeof TEAM_NOTICE_CLASSES[number];
export type TeamNoticeGeneration = string | number;

export interface TeamNoticeRegistration {
  stateRoot?: string;
  cwd?: string;
  targetId: string;
  teamName: string;
  noticeClass: TeamNoticeClass;
  generation: TeamNoticeGeneration;
  source: { kind: string; detail?: string };
}

export interface TeamNoticeRegistrationResult {
  generation: string;
  queued: boolean;
  prompt: string | null;
  targetKey: string;
  wakeId: string | null;
}

export interface TeamNoticeContext {
  targetKey: string;
  teamName: string;
  noticeClass: TeamNoticeClass;
  generation: string;
  source: { kind: string; detail?: string };
}

export interface ReconcileTeamNoticeOptions {
  stateRoot?: string;
  cwd?: string;
  targetKey: string;
  beforePresent?: (context: readonly TeamNoticeContext[]) => Promise<void> | void;
}

export interface ReconcileTeamNoticeResult {
  context: TeamNoticeContext[];
  presented: number;
  discarded: number;
}

interface LedgerNotice extends TeamNoticeContext {
  createdAt: string;
  presentedAt?: string;
}

interface WakeLease {
  wakeId: string;
  createdAtMs: number;
}

interface NoticeLedger {
  schemaVersion: 2;
  notices: Record<string, LedgerNotice>;
  wakes: Record<string, WakeLease>;
}

const LOCK_STALE_MS = 30_000;
const WAKE_STALE_MS = 30_000;
const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
const TERMINAL_PHASES = new Set(['complete', 'completed', 'failed', 'cancelled', 'terminated', 'shutdown']);
const TARGET_KEY_PATTERN = /^[a-f0-9]{24}$/;

function resolvedStateRoot(stateRoot: string | undefined, cwd: string | undefined): string {
  return stateRoot ?? omxStateDir(cwd);
}

export function teamNoticeLedgerPath(stateRoot: string): string {
  return join(stateRoot, 'team', 'notice-ledger.json');
}

export function teamNoticeLedgerLockPath(stateRoot: string): string {
  return join(stateRoot, 'team', '.notice-ledger.lock');
}

export function teamNoticeTargetKey(targetId: string): string {
  return createHash('sha256').update(`omx-team-notice-target-v2\0${targetId}`).digest('hex').slice(0, 24);
}

export function buildTeamNoticeLedgerPrompt(targetKey: string): string {
  if (!TARGET_KEY_PATTERN.test(targetKey)) throw new Error('Invalid Team notice target key');
  return `${TEAM_NOTICE_LEDGER_MARKER_PREFIX}${targetKey}] Review current Team notices.`;
}

export function parseTeamNoticeLedgerPrompt(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^\[omx:team-notice-ledger:([a-f0-9]{24})\]\s+Review current Team notices\.(?:\s+\[OMX_TMUX_INJECT\])?$/i);
  return match?.[1]?.toLowerCase() ?? null;
}

export function isTeamNoticeLedgerPrompt(value: unknown): boolean {
  return parseTeamNoticeLedgerPrompt(value) !== null;
}

function noticeKey(targetKey: string, teamName: string, noticeClass: TeamNoticeClass, generation: TeamNoticeGeneration): string {
  return createHash('sha256')
    .update(`omx-team-notice-v2\0${targetKey}\0${teamName}\0${noticeClass}\0${String(generation)}`)
    .digest('hex');
}

function isNoticeClass(value: unknown): value is TeamNoticeClass {
  return typeof value === 'string' && (TEAM_NOTICE_CLASSES as readonly string[]).includes(value);
}

function emptyLedger(): NoticeLedger {
  return { schemaVersion: 2, notices: {}, wakes: {} };
}

function normalizeLedger(raw: unknown): NoticeLedger {
  if (!raw || typeof raw !== 'object') throw new Error('invalid_team_notice_ledger');
  const parsed = raw as Partial<NoticeLedger>;
  if (parsed.schemaVersion !== 2 || !parsed.notices || typeof parsed.notices !== 'object' || !parsed.wakes || typeof parsed.wakes !== 'object') {
    throw new Error('invalid_team_notice_ledger_schema');
  }
  const ledger = emptyLedger();
  for (const [key, rawNotice] of Object.entries(parsed.notices)) {
    if (!rawNotice || typeof rawNotice !== 'object') throw new Error('invalid_team_notice_record');
    const notice = rawNotice as Partial<LedgerNotice>;
    if (!TARGET_KEY_PATTERN.test(String(notice.targetKey ?? '')) || typeof notice.teamName !== 'string'
      || !isNoticeClass(notice.noticeClass) || typeof notice.generation !== 'string'
      || !notice.source || typeof notice.source.kind !== 'string' || typeof notice.createdAt !== 'string'
      || (notice.presentedAt !== undefined && typeof notice.presentedAt !== 'string')) {
      throw new Error('invalid_team_notice_record');
    }
    ledger.notices[key] = {
      targetKey: notice.targetKey!, teamName: notice.teamName, noticeClass: notice.noticeClass,
      generation: notice.generation, source: typeof notice.source.detail === 'string'
        ? { kind: notice.source.kind, detail: notice.source.detail }
        : { kind: notice.source.kind }, createdAt: notice.createdAt,
      ...(notice.presentedAt ? { presentedAt: notice.presentedAt } : {}),
    };
  }
  for (const [targetKey, rawWake] of Object.entries(parsed.wakes)) {
    if (!TARGET_KEY_PATTERN.test(targetKey) || !rawWake || typeof rawWake !== 'object') throw new Error('invalid_team_notice_wake');
    const wake = rawWake as Partial<WakeLease>;
    if (typeof wake.wakeId !== 'string' || typeof wake.createdAtMs !== 'number' || !Number.isSafeInteger(wake.createdAtMs)) {
      throw new Error('invalid_team_notice_wake');
    }
    ledger.wakes[targetKey] = { wakeId: wake.wakeId, createdAtMs: wake.createdAtMs };
  }
  return ledger;
}

async function readLedger(stateRoot: string): Promise<NoticeLedger> {
  try {
    return normalizeLedger(JSON.parse(await readFile(teamNoticeLedgerPath(stateRoot), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyLedger();
    throw error;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function staleLock(lockPath: string): Promise<boolean> {
  try {
    return Date.now() - (await stat(join(lockPath, 'lease'))).mtimeMs > LOCK_STALE_MS;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }
  try { return Date.now() - (await stat(lockPath)).mtimeMs > LOCK_STALE_MS; } catch { return false; }
}

async function withLedgerLock<T>(stateRoot: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = teamNoticeLedgerLockPath(stateRoot);
  const owner = randomUUID();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  await mkdir(join(stateRoot, 'team'), { recursive: true });
  while (true) {
    try {
      await mkdir(lockPath);
      await writeFile(join(lockPath, 'owner'), owner, 'utf8');
      await writeFile(join(lockPath, 'lease'), owner, 'utf8');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await staleLock(lockPath)) { await rm(lockPath, { recursive: true, force: true }); continue; }
      if (Date.now() >= deadline) throw new Error('Timed out acquiring team notice ledger lock');
      await sleep(LOCK_WAIT_MS);
    }
  }
  try { return await fn(); } finally {
    try {
      if ((await readFile(join(lockPath, 'owner'), 'utf8')) === owner) await rm(lockPath, { recursive: true, force: true });
    } catch { /* recovered locks are owned by their replacement */ }
  }
}

function boundedDetail(detail: string | undefined): string | undefined {
  return detail ? detail.slice(0, 240) : undefined;
}

export async function registerTeamNotice(registration: TeamNoticeRegistration): Promise<TeamNoticeRegistrationResult> {
  const stateRoot = resolvedStateRoot(registration.stateRoot, registration.cwd);
  const generation = String(registration.generation);
  if (!registration.targetId || !registration.teamName || !generation || !isNoticeClass(registration.noticeClass) || !registration.source.kind) {
    throw new Error('Invalid team notice registration');
  }
  return await withLedgerLock(stateRoot, async () => {
    const ledger = await readLedger(stateRoot);
    const targetKey = teamNoticeTargetKey(registration.targetId);
    // A later source-proven event confirms the previous presented batch reached a model turn.
    for (const [key, notice] of Object.entries(ledger.notices)) {
      if (notice.targetKey === targetKey && notice.presentedAt) delete ledger.notices[key];
    }
    const key = noticeKey(targetKey, registration.teamName, registration.noticeClass, generation);
    if (!ledger.notices[key]) {
      ledger.notices[key] = {
        targetKey, teamName: registration.teamName, noticeClass: registration.noticeClass, generation,
        source: { kind: registration.source.kind, detail: boundedDetail(registration.source.detail) },
        createdAt: new Date().toISOString(),
      };
    }
    const now = Date.now();
    const existingWake = ledger.wakes[targetKey];
    if (existingWake && now - existingWake.createdAtMs <= WAKE_STALE_MS) {
      await writeAtomic(teamNoticeLedgerPath(stateRoot), JSON.stringify(ledger, null, 2));
      return { generation, queued: false, prompt: null, targetKey, wakeId: existingWake.wakeId };
    }
    const wakeId = randomUUID();
    ledger.wakes[targetKey] = { wakeId, createdAtMs: now };
    await writeAtomic(teamNoticeLedgerPath(stateRoot), JSON.stringify(ledger, null, 2));
    return { generation, queued: true, prompt: buildTeamNoticeLedgerPrompt(targetKey), targetKey, wakeId };
  });
}

export async function releaseTeamNoticeWake(stateRoot: string, targetKey: string, wakeId: string): Promise<boolean> {
  if (!TARGET_KEY_PATTERN.test(targetKey) || !wakeId) return false;
  return await withLedgerLock(stateRoot, async () => {
    const ledger = await readLedger(stateRoot);
    if (ledger.wakes[targetKey]?.wakeId !== wakeId) return false;
    delete ledger.wakes[targetKey];
    await writeAtomic(teamNoticeLedgerPath(stateRoot), JSON.stringify(ledger, null, 2));
    return true;
  });
}

async function teamIsLive(stateRoot: string, teamName: string): Promise<boolean> {
  const teamDir = join(stateRoot, 'team', teamName);
  try {
    if (!(await stat(teamDir)).isDirectory()) return false;
    const config = JSON.parse(await readFile(join(teamDir, 'config.json'), 'utf8')) as { name?: unknown; team_name?: unknown };
    if ((typeof config.team_name === 'string' ? config.team_name : config.name) !== teamName) return false;
  } catch { return false; }
  for (const shutdownName of ['shutdown.json', 'shutdown']) {
    try { await stat(join(teamDir, shutdownName)); return false; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
  }
  try {
    const phase = JSON.parse(await readFile(join(teamDir, 'phase.json'), 'utf8')) as { current_phase?: unknown };
    return !(typeof phase.current_phase === 'string' && TERMINAL_PHASES.has(phase.current_phase));
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
}

export async function reconcileTeamNoticeLedger(options: ReconcileTeamNoticeOptions): Promise<ReconcileTeamNoticeResult> {
  if (!TARGET_KEY_PATTERN.test(options.targetKey)) throw new Error('Invalid Team notice target key');
  const stateRoot = resolvedStateRoot(options.stateRoot, options.cwd);
  return await withLedgerLock(stateRoot, async () => {
    const ledger = await readLedger(stateRoot);
    let discarded = 0;
    for (const [key, notice] of Object.entries(ledger.notices)) {
      if (notice.targetKey === options.targetKey && !await teamIsLive(stateRoot, notice.teamName)) {
        delete ledger.notices[key];
        discarded += 1;
      }
    }
    const selected = Object.values(ledger.notices)
      .filter((notice) => notice.targetKey === options.targetKey)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const context = selected.map(({ targetKey, teamName, noticeClass, generation, source }) => ({
      targetKey, teamName, noticeClass, generation, source,
    }));
    await options.beforePresent?.(context);
    const presentedAt = new Date().toISOString();
    for (const notice of selected) notice.presentedAt ??= presentedAt;
    delete ledger.wakes[options.targetKey];
    if (discarded > 0 || selected.length > 0) await writeAtomic(teamNoticeLedgerPath(stateRoot), JSON.stringify(ledger, null, 2));
    return { context, presented: selected.length, discarded };
  });
}
