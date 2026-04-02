/**
 * TS Runtime Bridge — thin wrapper over omx-runtime binary.
 *
 * All semantic state mutations route through `execCommand()`.
 * All state queries read Rust-authored compatibility JSON files.
 * Set OMX_RUNTIME_BRIDGE=0 to disable bridge (fallback to TS-direct).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { omxStateDir } from '../utils/paths.js';

const __bridge_dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Types matching Rust JSON schema
// ---------------------------------------------------------------------------

export interface RuntimeSnapshot {
  schema_version: number;
  authority: AuthoritySnapshot;
  backlog: BacklogSnapshot;
  replay: ReplaySnapshot;
  readiness: ReadinessSnapshot;
}

export interface AuthoritySnapshot {
  owner: string | null;
  lease_id: string | null;
  leased_until: string | null;
  stale: boolean;
  stale_reason: string | null;
}

export interface BacklogSnapshot {
  pending: number;
  notified: number;
  delivered: number;
  failed: number;
}

export interface ReplaySnapshot {
  cursor: string | null;
  pending_events: number;
  last_replayed_event_id: string | null;
  deferred_leader_notification: boolean;
}

export interface ReadinessSnapshot {
  ready: boolean;
  reasons: string[];
}

// Rust RuntimeCommand variants (serde tag="command")
export type RuntimeCommand =
  | { command: 'AcquireAuthority'; owner: string; lease_id: string; leased_until: string }
  | { command: 'RenewAuthority'; owner: string; lease_id: string; leased_until: string }
  | { command: 'QueueDispatch'; request_id: string; target: string; metadata?: Record<string, unknown> }
  | { command: 'MarkNotified'; request_id: string; channel: string }
  | { command: 'MarkDelivered'; request_id: string }
  | { command: 'MarkFailed'; request_id: string; reason: string }
  | { command: 'RequestReplay'; cursor?: string }
  | { command: 'CaptureSnapshot' }
  | { command: 'CreateMailboxMessage'; message_id: string; from_worker: string; to_worker: string; body: string }
  | { command: 'MarkMailboxNotified'; message_id: string }
  | { command: 'MarkMailboxDelivered'; message_id: string };

// Rust RuntimeEvent variants (serde tag="event")
export type RuntimeEvent =
  | { event: 'AuthorityAcquired'; owner: string; lease_id: string; leased_until: string }
  | { event: 'AuthorityRenewed'; owner: string; lease_id: string; leased_until: string }
  | { event: 'DispatchQueued'; request_id: string; target: string; metadata?: Record<string, unknown> }
  | { event: 'DispatchNotified'; request_id: string; channel: string }
  | { event: 'DispatchDelivered'; request_id: string }
  | { event: 'DispatchFailed'; request_id: string; reason: string }
  | { event: 'ReplayRequested'; cursor?: string }
  | { event: 'SnapshotCaptured' }
  | { event: 'MailboxMessageCreated'; message_id: string; from_worker: string; to_worker: string }
  | { event: 'MailboxNotified'; message_id: string }
  | { event: 'MailboxDelivered'; message_id: string };

export interface DispatchRecord {
  request_id: string;
  target: string;
  status: 'pending' | 'notified' | 'delivered' | 'failed';
  created_at: string;
  notified_at: string | null;
  delivered_at: string | null;
  failed_at: string | null;
  reason: string | null;
  metadata: Record<string, unknown> | null;
}

export interface MailboxRecord {
  message_id: string;
  from_worker: string;
  to_worker: string;
  body: string;
  created_at: string;
  notified_at: string | null;
  delivered_at: string | null;
}

// ---------------------------------------------------------------------------
// Bridge class
// ---------------------------------------------------------------------------

let schemaValidated = false;

export interface RuntimeBinaryDiscoveryOptions {
  debugPath?: string;
  releasePath?: string;
  fallbackBinary?: string;
  exists?: (path: string) => boolean;
}

export function resolveRuntimeBinaryPath(options: RuntimeBinaryDiscoveryOptions = {}): string {
  const exists = options.exists ?? existsSync;
  const envOverride = process.env.OMX_RUNTIME_BINARY?.trim();
  if (envOverride) return envOverride;

  const workspaceDebug = options.debugPath ?? resolve(__bridge_dirname, '../../target/debug/omx-runtime');
  if (exists(workspaceDebug)) return workspaceDebug;

  const workspaceRelease = options.releasePath ?? resolve(__bridge_dirname, '../../target/release/omx-runtime');
  if (exists(workspaceRelease)) return workspaceRelease;

  return options.fallbackBinary ?? 'omx-runtime';
}

export function resolveBridgeStateDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OMX_TEAM_STATE_ROOT;
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return resolve(cwd, explicit.trim());
  }
  return omxStateDir(cwd);
}

export class RuntimeBridge {
  private binaryPath: string;
  private stateDir: string | undefined;
  private enabled: boolean;

  constructor(options: { stateDir?: string; binaryPath?: string } = {}) {
    this.enabled = process.env.OMX_RUNTIME_BRIDGE !== '0';
    this.stateDir = options.stateDir;
    this.binaryPath = options.binaryPath ?? resolveRuntimeBinaryPath();
  }

  /** Whether the bridge is enabled (OMX_RUNTIME_BRIDGE != '0'). */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Execute a RuntimeCommand and return the resulting RuntimeEvent. */
  execCommand(cmd: RuntimeCommand, options?: { compact?: boolean }): RuntimeEvent {
    this.validateSchemaOnce();
    const json = JSON.stringify(cmd);
    const args = ['exec', json];
    if (this.stateDir) args.push(`--state-dir=${this.stateDir}`);
    if (options?.compact) args.push('--compact');
    const stdout = this.run(args);
    return JSON.parse(stdout) as RuntimeEvent;
  }

  /** Read the current RuntimeSnapshot. */
  readSnapshot(): RuntimeSnapshot {
    const args = ['snapshot', '--json'];
    if (this.stateDir) args.push(`--state-dir=${this.stateDir}`);
    const stdout = this.run(args);
    return JSON.parse(stdout) as RuntimeSnapshot;
  }

  /** Initialize a fresh state directory. */
  initStateDir(dir: string): void {
    this.run(['init', dir]);
    this.stateDir = dir;
  }

  /** Read a Rust-authored compatibility file as typed JSON. */
  readCompatFile<T>(filename: string): T | null {
    if (!this.stateDir) return null;
    const filePath = join(this.stateDir, filename);
    if (!existsSync(filePath)) return null;
    const content = readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as T;
  }

  /** Read authority snapshot from compatibility file. */
  readAuthority(): AuthoritySnapshot | null {
    return this.readCompatFile<AuthoritySnapshot>('authority.json');
  }

  /** Read readiness snapshot from compatibility file. */
  readReadiness(): ReadinessSnapshot | null {
    return this.readCompatFile<ReadinessSnapshot>('readiness.json');
  }

  /** Read backlog snapshot from compatibility file. */
  readBacklog(): BacklogSnapshot | null {
    return this.readCompatFile<BacklogSnapshot>('backlog.json');
  }

  /**
   * Read dispatch records from compatibility file.
   * Transforms Rust format ({ records: [...] }) to flat array,
   * and maps `target` → `to_worker` + merges metadata fields.
   */
  readDispatchRecords(): DispatchRecord[] {
    const raw = this.readCompatFile<{ records: DispatchRecord[] }>('dispatch.json');
    if (!raw?.records) return [];
    return raw.records;
  }

  /** Read mailbox records from compatibility file. */
  readMailboxRecords(): MailboxRecord[] {
    const raw = this.readCompatFile<{ records: MailboxRecord[] }>('mailbox.json');
    if (!raw?.records) return [];
    return raw.records;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private validateSchemaOnce(): void {
    if (schemaValidated) return;
    try {
      const stdout = this.run(['schema', '--json']);
      const schema = JSON.parse(stdout);
      const expectedCommands = [
        'acquire-authority', 'renew-authority', 'queue-dispatch',
        'mark-notified', 'mark-delivered', 'mark-failed',
        'request-replay', 'capture-snapshot',
      ];
      const missing = expectedCommands.filter(
        (c) => !schema.commands?.includes(c),
      );
      if (missing.length > 0) {
        throw new Error(
          `omx-runtime schema missing commands: ${missing.join(', ')}. ` +
          `Bridge types may be out of sync with the Rust binary.`,
        );
      }
      schemaValidated = true;
    } catch (err) {
      if (err instanceof Error && err.message.includes('schema missing')) throw err;
      // Binary not available — schema validation skipped
      schemaValidated = true;
    }
  }

  private run(args: string[]): string {
    try {
      const result = execFileSync(this.binaryPath, args, {
        encoding: 'utf-8',
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
      return result;
    } catch (err: unknown) {
      const execErr = err as { stderr?: string; message?: string };
      const stderr = execErr.stderr?.trim() ?? execErr.message ?? 'unknown error';
      throw new Error(`omx-runtime ${args[0]} failed: ${stderr}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton for convenience
// ---------------------------------------------------------------------------

let _defaultBridge: RuntimeBridge | undefined;

export function getDefaultBridge(stateDir?: string): RuntimeBridge {
  if (stateDir) {
    return new RuntimeBridge({ stateDir });
  }
  if (!_defaultBridge) {
    _defaultBridge = new RuntimeBridge({ stateDir });
  }
  return _defaultBridge;
}

export function isBridgeEnabled(): boolean {
  return process.env.OMX_RUNTIME_BRIDGE !== '0';
}
