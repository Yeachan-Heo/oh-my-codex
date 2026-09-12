import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, stat, type FileHandle, unlink, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';
import {
  formatProcessOwnerToken,
  hashHistoricalProcessStartIdentity,
  hashProcessStartIdentity,
  parseProcessOwnerToken,
  readHistoricalProcessStartIdentity,
  readProcessStartIdentity,
} from './process-identity.js';

const INITIAL_RETRY_MS = 20;
const MAX_RETRY_MS = 500;
const PARTIAL_OWNER_STALE_MS = 5_000;
type Identity = { dev: number; ino: number };
type OwnerIdentity = Identity & { size: number; mtimeMs: number; ctimeMs: number };
type OwnerRecord = { name: string; token: string; identity: OwnerIdentity; claimantToken?: string };
type PinnedRecord = { kind: 'valid' | 'partial'; owner: OwnerRecord } | { kind: 'missing' | 'changed' | 'invalid' };
type OwnerState = { kind: 'valid' | 'recoverable'; owner: OwnerRecord }
  | { kind: 'ownerless' }
  | { kind: 'interrupted'; displaced: OwnerRecord }
  | { kind: 'preparing'; candidate: OwnerRecord; candidateComplete: boolean; displaced: OwnerRecord }
  | { kind: 'published'; owner: OwnerRecord; displaced: OwnerRecord }
  | { kind: 'partial-published'; owner: OwnerRecord; displaced: OwnerRecord }
  | { kind: 'unstable' }
  | { kind: 'ambiguous'; reason: string };

function respond(value: Record<string, unknown>): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
function sameIdentity(value: Identity, expected: Identity): boolean {
  return value.dev === expected.dev && value.ino === expected.ino;
}

function validOwnerToken(value: string): boolean {
  return parseProcessOwnerToken(value) !== null;
}

async function readPinnedRecord(name: string, token: string): Promise<PinnedRecord> {
  if (!validOwnerToken(token) || basename(name) !== name) return { kind: 'invalid' };
  let handle: FileHandle | null = null;
  try {
    handle = await open(name, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat();
    const visible = await lstat(name);
    if (!before.isFile() || before.nlink !== 1 || !visible.isFile() || visible.isSymbolicLink()
      || visible.nlink !== 1 || !sameIdentity(before, visible)) return { kind: 'changed' };
    const value = await handle.readFile('utf8');
    const after = await handle.stat();
    if (!sameIdentity(before, after) || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return { kind: 'changed' };
    const owner = {
      name,
      token,
      identity: {
        dev: before.dev,
        ino: before.ino,
        size: before.size,
        mtimeMs: before.mtimeMs,
        ctimeMs: before.ctimeMs,
      },
    };
    if (value === token) return { kind: 'valid', owner };
    const publishedPrefix = value.length < token.length && token.startsWith(value);
    return publishedPrefix ? { kind: 'partial', owner } : { kind: 'invalid' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw error;
  } finally { await handle?.close(); }
}

async function readPinnedOwner(): Promise<OwnerState> {
  const entries = await readdir('.');
  if (entries.length === 0) return { kind: 'ownerless' };
  const ownerNames = entries.filter((entry) => entry.startsWith('owner-'));
  const displacedNames = entries.filter((entry) => entry.startsWith('.owner-reclaim-'));
  const candidateNames = entries.filter((entry) => entry.startsWith('.owner-publish-'));
  if (ownerNames.length > 1 || displacedNames.length > 1 || candidateNames.length > 1
    || ownerNames.length + displacedNames.length + candidateNames.length !== entries.length) return { kind: 'ambiguous', reason: `entries:${entries.join(',')}` };
  const owner = ownerNames[0]
    ? await readPinnedRecord(ownerNames[0], ownerNames[0].slice('owner-'.length))
    : undefined;
  const displacedName = displacedNames[0] ? parseDisplacedName(displacedNames[0]) : null;
  const displacedRecord = displacedName
    ? await readPinnedRecord(displacedNames[0], displacedName.originalToken)
    : undefined;
  const displaced = displacedRecord && (displacedRecord.kind === 'valid' || displacedRecord.kind === 'partial')
    ? { ...displacedRecord, owner: { ...displacedRecord.owner, claimantToken: displacedName?.claimantToken } }
    : displacedRecord;
  const candidate = candidateNames[0]
    ? await readPinnedRecord(candidateNames[0], candidateNames[0].slice('.owner-publish-'.length))
    : undefined;
  if (owner?.kind === 'missing' || owner?.kind === 'changed'
    || displaced?.kind === 'missing' || displaced?.kind === 'changed'
    || candidate?.kind === 'missing' || candidate?.kind === 'changed') return { kind: 'unstable' };
  if (owner?.kind === 'invalid' || displaced?.kind === 'invalid' || candidate?.kind === 'invalid') return { kind: 'ambiguous', reason: 'invalid-record' };
  const stableOwner = presentRecord(owner) ? owner : undefined;
  const stableDisplaced = presentRecord(displaced) ? displaced : undefined;
  const stableCandidate = presentRecord(candidate) ? candidate : undefined;
  if (stableCandidate && stableOwner) return { kind: 'unstable' };
  const isDeadRecord = async (record: NonNullable<typeof stableDisplaced>) => record.kind === 'valid' && await tokenIsStaleAndDead(record.owner.token)
    || record.kind === 'partial' && isOld(record.owner) && await tokenIsStaleAndDead(record.owner.token);
  const isBoundOrDead = async (record: NonNullable<typeof stableDisplaced>) => record.owner.claimantToken !== undefined
    || await isDeadRecord(record);
  if (stableCandidate && stableDisplaced && !stableOwner) {
    if (!await isBoundOrDead(stableDisplaced)) return { kind: 'unstable' };
    if (stableDisplaced.owner.claimantToken !== stableCandidate.owner.token) return { kind: 'ambiguous', reason: 'candidate-claimant-mismatch' };
    return {
      kind: 'preparing', candidate: stableCandidate.owner, candidateComplete: stableCandidate.kind === 'valid', displaced: stableDisplaced.owner,
    };
  }
  if (stableOwner && stableDisplaced) {
    if (!await isBoundOrDead(stableDisplaced)) return { kind: 'unstable' };
    if (stableDisplaced.owner.claimantToken !== undefined && stableDisplaced.owner.claimantToken !== stableOwner.owner.token
      || stableOwner.owner.identity.dev === stableDisplaced.owner.identity.dev
        && stableOwner.owner.identity.ino === stableDisplaced.owner.identity.ino) return { kind: 'ambiguous', reason: 'published-binding-mismatch' };
    if (stableOwner.kind === 'valid') return { kind: 'published', owner: stableOwner.owner, displaced: stableDisplaced.owner };
    return isOld(stableOwner.owner) && await tokenIsStaleAndDead(stableOwner.owner.token)
      ? { kind: 'partial-published', owner: stableOwner.owner, displaced: stableDisplaced.owner }
      : { kind: 'unstable' };
  }
  if (stableDisplaced) return await isBoundOrDead(stableDisplaced)
    ? { kind: 'interrupted', displaced: stableDisplaced.owner }
    : { kind: 'unstable' };
  if (stableCandidate) return { kind: 'unstable' };
  if (stableOwner?.kind === 'valid') return { kind: 'valid', owner: stableOwner.owner };
  if (stableOwner?.kind === 'partial' && isOld(stableOwner.owner) && await tokenIsStaleAndDead(stableOwner.owner.token)) {
    return { kind: 'recoverable', owner: stableOwner.owner };
  }
  return stableOwner ? { kind: 'unstable' } : { kind: 'ownerless' };
}

function presentRecord(record: PinnedRecord | undefined): record is Extract<PinnedRecord, { kind: 'valid' | 'partial' }> {
  return record?.kind === 'valid' || record?.kind === 'partial';
}

function parseDisplacedName(name: string): { originalToken: string; claimantToken?: string } | null {
  const encoded = name.slice('.owner-reclaim-'.length);
  const separator = encoded.indexOf('~');
  const originalToken = separator < 0 ? encoded : encoded.slice(0, separator);
  const claimantToken = separator < 0 ? undefined : encoded.slice(separator + 1);
  if (!validOwnerToken(originalToken) || claimantToken !== undefined && !validOwnerToken(claimantToken)) return null;
  return { originalToken, ...(claimantToken ? { claimantToken } : {}) };
}

function isOld(owner: OwnerRecord): boolean {
  return Date.now() - owner.identity.mtimeMs >= PARTIAL_OWNER_STALE_MS;
}

function sameOwner(a: OwnerRecord, b: OwnerRecord): boolean {
  return a.name === b.name && a.token === b.token && a.claimantToken === b.claimantToken
    && a.identity.dev === b.identity.dev && a.identity.ino === b.identity.ino
    && a.identity.size === b.identity.size && a.identity.mtimeMs === b.identity.mtimeMs
    && a.identity.ctimeMs === b.identity.ctimeMs;
}

async function replaceObservedOwner(observed: OwnerRecord, replacementToken: string): Promise<boolean> {
  const quarantine = `.owner-reclaim-${observed.token}~${replacementToken}`;
  try { await rename(observed.name, quarantine); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  await maybeCrashReclaimPhase('after-quarantine');
  const moved = await lstat(quarantine);
  if (!moved.isFile() || moved.isSymbolicLink() || moved.nlink !== 1
    || moved.dev !== observed.identity.dev || moved.ino !== observed.identity.ino
    || moved.size !== observed.identity.size || moved.mtimeMs !== observed.identity.mtimeMs) {
    return false;
  }
  await publishSuccessor(replacementToken);
  const published = await readPinnedOwner();
  if (published.kind !== 'published' || published.owner.token !== replacementToken
    || published.displaced.name !== quarantine
    || published.displaced.identity.dev !== observed.identity.dev
    || published.displaced.identity.ino !== observed.identity.ino
    || published.displaced.identity.size !== observed.identity.size
    || published.displaced.identity.mtimeMs !== observed.identity.mtimeMs) {
    return false;
  }
  await maybeCrashReclaimPhase('before-cleanup');
  await unlink(quarantine);
  return true;
}

async function publishSuccessor(replacementToken: string): Promise<void> {
  const candidate = `.owner-publish-${replacementToken}`;
  await writeFile(candidate, replacementToken, { flag: 'wx', mode: 0o600 });
  const staged = await readPinnedRecord(candidate, replacementToken);
  if (staged?.kind !== 'valid') throw new Error('canonical state lock successor staging changed');
  await rename(candidate, `owner-${replacementToken}`);
  await maybeCrashReclaimPhase('after-successor-publish');
}

async function restoreDisplacedOwner(displaced: OwnerRecord): Promise<boolean> {
  try { await rename(displaced.name, `owner-${displaced.token}`); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}


async function maybeCrashReclaimPhase(phase: string): Promise<void> {
  if (process.env.OMX_TEST_MODE_BINDING_RECLAIM_CRASH_PHASE !== phase) return;
  const sentinel = process.env.OMX_TEST_MODE_BINDING_RECLAIM_CRASH_SENTINEL;
  if (!sentinel) return;
  let handle: FileHandle | null = null;
  try {
    handle = await open(sentinel, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    await handle.writeFile(phase);
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
    throw error;
  } finally { await handle?.close(); }
  process.kill(process.pid, 'SIGKILL');
}

async function ownerIsDead(value: string): Promise<boolean> {
  const parsed = parseProcessOwnerToken(value);
  if (!parsed) return false;
  try { process.kill(parsed.pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  if (parsed.version === 'v2' && parsed.processStartHash === 'unknown'
    || parsed.version === 'v3' && parsed.processStartHash === 'unavailable') return false;
  if (parsed.version === 'v2' || parsed.version === 'v3') {
    const reader = parsed.version === 'v2' ? readHistoricalProcessStartIdentity : readProcessStartIdentity;
    const hash = parsed.version === 'v2' ? hashHistoricalProcessStartIdentity : hashProcessStartIdentity;
    const current = await reader(parsed.pid);
    if (current === null || hash(current) === parsed.processStartHash) return false;
    // A live PID identity mismatch is security-sensitive: re-sample before
    // reclaim so a transient platform probe cannot evict the real owner.
    await new Promise<void>((resolve) => setTimeout(resolve, INITIAL_RETRY_MS));
    const confirmed = await reader(parsed.pid);
    return confirmed !== null
      && hash(confirmed) === hash(current)
      && hash(confirmed) !== parsed.processStartHash;
  }
  return false;
}

async function tokenIsStaleAndDead(value: string): Promise<boolean> {
  const parsed = parseProcessOwnerToken(value);
  return parsed !== null && Date.now() - parsed.issuedAtMs >= PARTIAL_OWNER_STALE_MS && await ownerIsDead(value);
}

async function runPinnedClaimMode(args: string[]): Promise<void> {
  const [lockName = '', replacementToken = '', nsDev = '', nsIno = '', lockDev = '', lockIno = ''] = args;
  if (!lockName || basename(lockName) !== lockName || !replacementToken || !nsDev || !nsIno || !lockDev || !lockIno) {
    throw new Error('invalid pinned canonical state lock claim arguments');
  }
  const namespaceIdentity = { dev: Number(nsDev), ino: Number(nsIno) };
  const lockIdentity = { dev: Number(lockDev), ino: Number(lockIno) };
  const current = await stat('.');
  const parent = await stat('..');
  if (!current.isDirectory() || !parent.isDirectory()
    || !sameIdentity(current, lockIdentity) || !sameIdentity(parent, namespaceIdentity)) {
    respond({ claimed: false }); return;
  }
  const observed = await readPinnedOwner();
  if (observed.kind === 'unstable') { respond({ claimed: false }); return; }
  if (observed.kind === 'ambiguous') {
    await new Promise<void>((resolve) => setTimeout(resolve, INITIAL_RETRY_MS));
    if ((await readPinnedOwner()).kind !== 'ambiguous') { respond({ claimed: false }); return; }
    throw new Error(`canonical state lock owner ambiguous:${observed.reason}`);
  }
  if (observed.kind === 'valid') {
    if (observed.owner.token === replacementToken) { respond({ claimed: true }); return; }
    if (!await tokenIsStaleAndDead(observed.owner.token)) { respond({ claimed: false }); return; }
  }
  if (observed.kind === 'published' && observed.owner.token !== replacementToken
    && !await tokenIsStaleAndDead(observed.owner.token)) { respond({ claimed: false }); return; }
  if (observed.kind === 'preparing' && observed.candidate.token !== replacementToken
    && !await tokenIsStaleAndDead(observed.candidate.token)) { respond({ claimed: false }); return; }
  if (observed.kind === 'interrupted' && observed.displaced.claimantToken
    && observed.displaced.claimantToken !== replacementToken
    && !await tokenIsStaleAndDead(observed.displaced.claimantToken)) { respond({ claimed: false }); return; }
  const confirmed = await readPinnedOwner();
  const changed = !sameOwnerState(confirmed, observed);
  if (changed || !sameIdentity(await stat('.'), lockIdentity) || !sameIdentity(await stat('..'), namespaceIdentity)) {
    respond({ claimed: false }); return;
  }
  if (observed.kind === 'preparing') {
    if (observed.candidate.token === replacementToken) {
      if (!observed.candidateComplete) await unlink(observed.candidate.name);
      if (observed.candidateComplete) {
        await rename(observed.candidate.name, `owner-${replacementToken}`);
        await maybeCrashReclaimPhase('after-successor-publish');
      } else {
        await publishSuccessor(replacementToken);
      }
      await maybeCrashReclaimPhase('before-cleanup');
      await unlink(observed.displaced.name);
    } else {
      await unlink(observed.candidate.name);
      await restoreDisplacedOwner(observed.displaced);
      respond({ claimed: false }); return;
    }
  } else if (observed.kind === 'partial-published') {
    await unlink(observed.owner.name);
    await restoreDisplacedOwner(observed.displaced);
    respond({ claimed: false }); return;
  } else if (observed.kind === 'published') {
    if (observed.owner.token === replacementToken) {
      await maybeCrashReclaimPhase('before-cleanup');
      await unlink(observed.displaced.name);
    } else {
      // Both recorded owners are dead. Collapse to the newer canonical owner;
      // the next retry can reclaim that single inode through the normal path.
      await unlink(observed.displaced.name);
      respond({ claimed: false }); return;
    }
  } else if (observed.kind === 'interrupted') {
    if (observed.displaced.claimantToken === replacementToken) {
      await publishSuccessor(replacementToken);
      await maybeCrashReclaimPhase('before-cleanup');
      await unlink(observed.displaced.name);
    } else {
      // A legacy quarantine or a dead claimant is restored to the canonical
      // owner name. Exactly one contender can win this rename; the next
      // rename to a claimant-bound quarantine elects the successor.
      await restoreDisplacedOwner(observed.displaced);
      respond({ claimed: false }); return;
    }
  } else if (observed.kind === 'valid' || observed.kind === 'recoverable') {
    if (!await replaceObservedOwner(observed.owner, replacementToken)) {
      respond({ claimed: false }); return;
    }
  } else if (observed.kind === 'ownerless') {
    try {
      await writeFile(`owner-${replacementToken}`, replacementToken, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      respond({ claimed: false }); return;
    }
  }
  const finalOwner = await readPinnedOwner();
  respond({ claimed: finalOwner.kind === 'valid' && finalOwner.owner.token === replacementToken });
}

function sameOwnerState(a: OwnerState, b: OwnerState): boolean {
  if (a.kind !== b.kind) return false;
  if ((a.kind === 'valid' || a.kind === 'recoverable') && (b.kind === 'valid' || b.kind === 'recoverable')) {
    return sameOwner(a.owner, b.owner);
  }
  if (a.kind === 'interrupted' && b.kind === 'interrupted') return sameOwner(a.displaced, b.displaced);
  if (a.kind === 'preparing' && b.kind === 'preparing') {
    return a.candidateComplete === b.candidateComplete
      && sameOwner(a.candidate, b.candidate) && sameOwner(a.displaced, b.displaced);
  }
  if (a.kind === 'published' && b.kind === 'published') {
    return sameOwner(a.owner, b.owner) && sameOwner(a.displaced, b.displaced);
  }
  if (a.kind === 'partial-published' && b.kind === 'partial-published') {
    return sameOwner(a.owner, b.owner) && sameOwner(a.displaced, b.displaced);
  }
  return a.kind === 'ownerless' && b.kind === 'ownerless'
    || a.kind === 'unstable' && b.kind === 'unstable'
    || a.kind === 'ambiguous' && b.kind === 'ambiguous';
}

if (process.argv[2] === '--claim-existing') {
  try { await runPinnedClaimMode(process.argv.slice(3)); } catch (error) {
    respond({ claimed: false, error: error instanceof Error ? error.message : String(error) });
  }
  process.exit(0);
}

const [key = '', nonce = '', expectedDev = '', expectedIno = ''] = process.argv.slice(2);
if (!key || basename(key) !== key || !nonce || !expectedDev || !expectedIno) {
  throw new Error('invalid canonical state lock helper arguments');
}
const [issuedAt = '', randomNonce = ''] = nonce.split('-', 2);
const processStartIdentity = await readProcessStartIdentity(process.pid);
const token = formatProcessOwnerToken({
  pid: process.pid,
  issuedAtMs: Number(issuedAt),
  nonce: randomNonce,
  processStartIdentity,
});
const lockName = `${key}.lock`;
const namespaceIdentity = { dev: Number(expectedDev), ino: Number(expectedIno) };
let lockIdentity: Identity | null = null;

async function assertPinnedNamespace(): Promise<void> {
  const current = await stat(lockIdentity ? '..' : '.');
  if (!current.isDirectory() || !sameIdentity(current, namespaceIdentity)) {
    throw new Error('canonical state lock namespace changed');
  }
}

async function assertPinnedLock(): Promise<void> {
  if (!lockIdentity) throw new Error('canonical state lock was not pinned');
  await assertPinnedNamespace();
  const pinned = await stat('.');
  let visible: Awaited<ReturnType<typeof lstat>>;
  try { visible = await lstat(`../${lockName}`); } catch { throw new Error('canonical state lock ownership lost: pinned path missing'); }
  if (!pinned.isDirectory() || !visible.isDirectory() || visible.isSymbolicLink()
    || !sameIdentity(pinned, lockIdentity) || !sameIdentity(visible, lockIdentity)) {
    throw new Error('canonical state lock ownership lost: pinned identity changed');
  }
}

async function enterPinnedLock(expected: Identity): Promise<void> {
  process.chdir(lockName);
  const pinned = await stat('.');
  const parent = await stat('..');
  if (!pinned.isDirectory() || !sameIdentity(pinned, expected) || !sameIdentity(parent, namespaceIdentity)) {
    throw new Error('canonical state lock changed while pinning');
  }
  lockIdentity = expected;
}

async function tryClaimExisting(expected: Identity): Promise<boolean> {
  const child = spawn(process.execPath, [process.argv[1], '--claim-existing', lockName, token,
    String(namespaceIdentity.dev), String(namespaceIdentity.ino), String(expected.dev), String(expected.ino)], {
    cwd: lockName, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { output += chunk; });
  const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
  if (code !== 0) return false;
  const parsed = JSON.parse(output.trim()) as { claimed?: unknown; error?: unknown };
  if (typeof parsed.error === 'string') throw new Error(parsed.error);
  return parsed.claimed === true;
}

async function acquire(): Promise<void> {
  // Keep the helper below the caller's explicit 35s initialization ceiling,
  // while leaving enough room for Darwin process-start revalidation under the
  // documented 64-contender recovery stress.
  const deadline = Date.now() + 34_000;
  let retryMs = INITIAL_RETRY_MS;
  for (;;) {
    await assertPinnedNamespace();
    try {
      await mkdir(lockName);
      const created = await lstat(lockName);
      if (!created.isDirectory() || created.isSymbolicLink()) throw new Error('canonical state lock invalid');
      const identity = { dev: created.dev, ino: created.ino };
      await enterPinnedLock(identity);
      await writeFile(`owner-${token}`, token, { flag: 'wx', mode: 0o600 });
      return;
    } catch (error) {
      if (lockIdentity) throw error;
      let visible: Awaited<ReturnType<typeof lstat>> | null = null;
      try { visible = await lstat(lockName); } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code !== 'ENOENT') throw readError;
      }
      if (visible?.isDirectory() && !visible.isSymbolicLink()) {
        const identity = { dev: visible.dev, ino: visible.ino };
        if (await tryClaimExisting(identity)) {
          const confirmed = await lstat(lockName);
          if (!confirmed.isDirectory() || confirmed.isSymbolicLink() || !sameIdentity(confirmed, identity)) {
            throw new Error('canonical state lock changed after stale claim');
          }
          await enterPinnedLock(identity);
          const claimed = await readPinnedOwner();
          if (claimed.kind !== 'valid' || claimed.owner.token !== token) throw new Error(`canonical state lock ownership lost: post-claim observed ${claimed.kind}`);
          return;
        }
      } else if (visible) {
        throw new Error('canonical state lock invalid');
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for canonical state lock: ${lockName}`);
      const jitter = Math.floor(Math.random() * retryMs);
      const remaining = Math.max(0, deadline - Date.now());
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(remaining, retryMs + jitter)));
      if (Date.now() >= deadline) throw new Error(`timed out waiting for canonical state lock: ${lockName}`);
      retryMs = Math.min(MAX_RETRY_MS, retryMs * 2);
    }
  }
}

async function release(): Promise<void> {
  await assertPinnedLock();
  const observed = await readPinnedOwner();
  if (observed.kind !== 'valid' || observed.owner.token !== token) throw new Error(`canonical state lock ownership lost: release observed ${observed.kind}`);
  await unlink(`owner-${token}`);
  // The persistent directory remains pinned; kernel mutex serialization protects
  // the full helper lifecycle across successor acquisition and release.
}

let acquired = false;
try {
  await acquire(); acquired = true;
  await new Promise<void>((resolve) => process.stdout.write(`${JSON.stringify({ id: 0, ok: true, ready: true })}\n`, () => resolve()));
} catch (error) {
  const response = { id: 0, ok: false, error: error instanceof Error ? error.message : String(error) };
  await new Promise<void>((resolve) => process.stdout.write(`${JSON.stringify(response)}\n`, () => resolve()));
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
if (!acquired) lines.close();
for await (const line of acquired ? lines : []) {
  let id: number | undefined;
  try {
    const request = JSON.parse(line) as { id?: number; op?: string };
    id = request.id;
    if (request.op === 'assert') {
      await assertPinnedLock();
      const observed = await readPinnedOwner();
      if (observed.kind !== 'valid' || observed.owner.token !== token) throw new Error(`canonical state lock ownership lost: assert observed ${observed.kind}`);
      respond({ id, ok: true });
    } else if (request.op === 'close') {
      await release(); respond({ id, ok: true }); break;
    } else throw new Error('unsupported canonical state lock operation');
  } catch (error) { respond({ id, ok: false, error: error instanceof Error ? error.message : String(error) }); }
}
