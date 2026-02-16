/**
 * Reply Listener Daemon
 *
 * Background daemon that polls Discord and Telegram for replies to notification messages,
 * sanitizes input, verifies the target pane, and injects reply text via sendToPane().
 *
 * Security considerations:
 * - State/PID/log files use restrictive permissions (0600)
 * - Bot tokens stored in state file, NOT in environment variables
 * - Two-layer input sanitization (sanitizeReplyInput + sanitizeForTmux)
 * - Pane verification via analyzePaneContent before every injection
 * - Authorization: only configured user IDs (Discord) / chat ID (Telegram) can inject
 * - Rate limiting to prevent spam/abuse
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, chmodSync, statSync, appendFileSync, renameSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { spawn } from 'child_process';
import { request as httpsRequest } from 'https';
import {
  capturePaneContent,
  analyzePaneContent,
  sendToPane,
  isTmuxAvailable,
} from './tmux-detector.js';
import {
  lookupByMessageId,
  removeMessagesByPane,
  pruneStale,
} from './session-registry.js';
import type { ReplyConfig } from './types.js';

const __filename = fileURLToPath(import.meta.url);

const SECURE_FILE_MODE = 0o600;
const MAX_LOG_SIZE_BYTES = 1 * 1024 * 1024;

const DAEMON_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USERPROFILE',
  'USER', 'USERNAME', 'LOGNAME',
  'LANG', 'LC_ALL', 'LC_CTYPE',
  'TERM', 'TMUX', 'TMUX_PANE',
  'TMPDIR', 'TMP', 'TEMP',
  'XDG_RUNTIME_DIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME',
  'SHELL',
  'NODE_ENV',
  'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy',
  'SystemRoot', 'SYSTEMROOT', 'windir', 'COMSPEC',
] as const;

const DEFAULT_STATE_DIR = join(homedir(), '.omx', 'state');
const PID_FILE_PATH = join(DEFAULT_STATE_DIR, 'reply-listener.pid');
const STATE_FILE_PATH = join(DEFAULT_STATE_DIR, 'reply-listener-state.json');
const LOG_FILE_PATH = join(DEFAULT_STATE_DIR, 'reply-listener.log');

export interface ReplyListenerState {
  isRunning: boolean;
  pid: number | null;
  startedAt: string | null;
  lastPollAt: string | null;
  telegramLastUpdateId: number | null;
  discordLastMessageId: string | null;
  messagesInjected: number;
  errors: number;
  lastError?: string;
}

export interface ReplyListenerDaemonConfig extends ReplyConfig {
  telegramBotToken?: string;
  telegramChatId?: string;
  discordBotToken?: string;
  discordChannelId?: string;
}

export interface DaemonResponse {
  success: boolean;
  message: string;
  state?: ReplyListenerState;
  error?: string;
}

function createMinimalDaemonEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of DAEMON_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  return env;
}

function ensureStateDir(): void {
  if (!existsSync(DEFAULT_STATE_DIR)) {
    mkdirSync(DEFAULT_STATE_DIR, { recursive: true, mode: 0o700 });
  }
}

function writeSecureFile(filePath: string, content: string): void {
  ensureStateDir();
  writeFileSync(filePath, content, { mode: SECURE_FILE_MODE });
  try {
    chmodSync(filePath, SECURE_FILE_MODE);
  } catch {
    // Ignore permission errors
  }
}

function rotateLogIfNeeded(logPath: string): void {
  try {
    if (!existsSync(logPath)) return;
    const stats = statSync(logPath);
    if (stats.size > MAX_LOG_SIZE_BYTES) {
      const backupPath = `${logPath}.old`;
      if (existsSync(backupPath)) {
        unlinkSync(backupPath);
      }
      renameSync(logPath, backupPath);
    }
  } catch {
    // Ignore rotation errors
  }
}

function log(message: string): void {
  try {
    ensureStateDir();
    rotateLogIfNeeded(LOG_FILE_PATH);
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${message}\n`;
    appendFileSync(LOG_FILE_PATH, logLine, { mode: SECURE_FILE_MODE });
  } catch {
    // Ignore log write errors
  }
}

function readDaemonState(): ReplyListenerState | null {
  try {
    if (!existsSync(STATE_FILE_PATH)) return null;
    const content = readFileSync(STATE_FILE_PATH, 'utf-8');
    return JSON.parse(content) as ReplyListenerState;
  } catch {
    return null;
  }
}

function writeDaemonState(state: ReplyListenerState): void {
  writeSecureFile(STATE_FILE_PATH, JSON.stringify(state, null, 2));
}

function readDaemonConfig(): ReplyListenerDaemonConfig | null {
  try {
    const configPath = join(DEFAULT_STATE_DIR, 'reply-listener-config.json');
    if (!existsSync(configPath)) return null;
    const content = readFileSync(configPath, 'utf-8');
    return JSON.parse(content) as ReplyListenerDaemonConfig;
  } catch {
    return null;
  }
}

function writeDaemonConfig(config: ReplyListenerDaemonConfig): void {
  const configPath = join(DEFAULT_STATE_DIR, 'reply-listener-config.json');
  writeSecureFile(configPath, JSON.stringify(config, null, 2));
}

function readPidFile(): number | null {
  try {
    if (!existsSync(PID_FILE_PATH)) return null;
    const content = readFileSync(PID_FILE_PATH, 'utf-8');
    return parseInt(content.trim(), 10);
  } catch {
    return null;
  }
}

function writePidFile(pid: number): void {
  writeSecureFile(PID_FILE_PATH, String(pid));
}

function removePidFile(): void {
  if (existsSync(PID_FILE_PATH)) {
    unlinkSync(PID_FILE_PATH);
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isDaemonRunning(): boolean {
  const pid = readPidFile();
  if (pid === null) return false;

  if (!isProcessRunning(pid)) {
    removePidFile();
    return false;
  }

  return true;
}

// ============================================================================
// Input Sanitization
// ============================================================================

export function sanitizeReplyInput(text: string): string {
  return text
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\r?\n/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\(/g, '\\$(')
    .replace(/\$\{/g, '\\${')
    .trim();
}

// ============================================================================
// Rate Limiting
// ============================================================================

class RateLimiter {
  private timestamps: number[] = [];
  private readonly windowMs = 60 * 1000;

  constructor(private readonly maxPerMinute: number) {}

  canProceed(): boolean {
    const now = Date.now();
    this.timestamps = this.timestamps.filter(t => now - t < this.windowMs);
    if (this.timestamps.length >= this.maxPerMinute) return false;
    this.timestamps.push(now);
    return true;
  }

  reset(): void {
    this.timestamps = [];
  }
}

// ============================================================================
// Injection
// ============================================================================

function injectReply(
  paneId: string,
  text: string,
  platform: string,
  config: ReplyListenerDaemonConfig,
): boolean {
  const content = capturePaneContent(paneId, 15);
  const analysis = analyzePaneContent(content);

  if (analysis.confidence < 0.4) {
    log(`WARN: Pane ${paneId} does not appear to be running Codex CLI (confidence: ${analysis.confidence}). Skipping injection, removing stale mapping.`);
    removeMessagesByPane(paneId);
    return false;
  }

  const prefix = config.includePrefix ? `[reply:${platform}] ` : '';
  const sanitized = sanitizeReplyInput(prefix + text);
  const truncated = sanitized.slice(0, config.maxMessageLength);
  const success = sendToPane(paneId, truncated, true);

  if (success) {
    log(`Injected reply from ${platform} into pane ${paneId}: "${truncated.slice(0, 50)}${truncated.length > 50 ? '...' : ''}"`);
  } else {
    log(`ERROR: Failed to inject reply into pane ${paneId}`);
  }

  return success;
}

// ============================================================================
// Discord Polling
// ============================================================================

let discordBackoffUntil = 0;

async function pollDiscord(
  config: ReplyListenerDaemonConfig,
  state: ReplyListenerState,
  rateLimiter: RateLimiter,
): Promise<void> {
  if (!config.discordBotToken || !config.discordChannelId) return;
  if (config.authorizedDiscordUserIds.length === 0) return;
  if (Date.now() < discordBackoffUntil) return;

  try {
    const after = state.discordLastMessageId ? `?after=${state.discordLastMessageId}&limit=10` : '?limit=10';
    const url = `https://discord.com/api/v10/channels/${config.discordChannelId}/messages${after}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bot ${config.discordBotToken}` },
      signal: AbortSignal.timeout(10000),
    });

    const remaining = response.headers.get('x-ratelimit-remaining');
    const reset = response.headers.get('x-ratelimit-reset');
    if (remaining !== null && parseInt(remaining, 10) < 2) {
      const resetTime = reset ? parseFloat(reset) * 1000 : Date.now() + 10_000;
      discordBackoffUntil = resetTime;
      log(`WARN: Discord rate limit low (remaining: ${remaining}), backing off until ${new Date(resetTime).toISOString()}`);
    }

    if (!response.ok) {
      log(`Discord API error: HTTP ${response.status}`);
      return;
    }

    const messages = await response.json() as Array<{
      id: string;
      author: { id: string };
      content: string;
      message_reference?: { message_id: string };
    }>;

    if (!Array.isArray(messages) || messages.length === 0) return;

    const sorted = [...messages].reverse();

    for (const msg of sorted) {
      if (!msg.message_reference?.message_id) {
        state.discordLastMessageId = msg.id;
        writeDaemonState(state);
        continue;
      }

      if (!config.authorizedDiscordUserIds.includes(msg.author.id)) {
        state.discordLastMessageId = msg.id;
        writeDaemonState(state);
        continue;
      }

      const mapping = lookupByMessageId('discord-bot', msg.message_reference.message_id);
      if (!mapping) {
        state.discordLastMessageId = msg.id;
        writeDaemonState(state);
        continue;
      }

      if (!rateLimiter.canProceed()) {
        log(`WARN: Rate limit exceeded, dropping Discord message ${msg.id}`);
        state.discordLastMessageId = msg.id;
        writeDaemonState(state);
        state.errors++;
        continue;
      }

      state.discordLastMessageId = msg.id;
      writeDaemonState(state);

      const success = injectReply(mapping.tmuxPaneId, msg.content, 'discord', config);
      if (success) {
        state.messagesInjected++;
        try {
          await fetch(
            `https://discord.com/api/v10/channels/${config.discordChannelId}/messages/${msg.id}/reactions/%E2%9C%85/@me`,
            {
              method: 'PUT',
              headers: { 'Authorization': `Bot ${config.discordBotToken}` },
              signal: AbortSignal.timeout(5000),
            }
          );
        } catch (e) {
          log(`WARN: Failed to add confirmation reaction: ${e}`);
        }
      } else {
        state.errors++;
      }
    }
  } catch (error) {
    state.errors++;
    state.lastError = error instanceof Error ? error.message : String(error);
    log(`Discord polling error: ${state.lastError}`);
  }
}

// ============================================================================
// Telegram Polling
// ============================================================================

async function pollTelegram(
  config: ReplyListenerDaemonConfig,
  state: ReplyListenerState,
  rateLimiter: RateLimiter,
): Promise<void> {
  if (!config.telegramBotToken || !config.telegramChatId) return;

  try {
    const offset = state.telegramLastUpdateId ? state.telegramLastUpdateId + 1 : 0;
    const path = `/bot${config.telegramBotToken}/getUpdates?offset=${offset}&timeout=0`;

    const updates = await new Promise<any[]>((resolve, reject) => {
      const req = httpsRequest(
        {
          hostname: 'api.telegram.org',
          path,
          method: 'GET',
          family: 4,
          timeout: 10000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
              if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                resolve(body.result || []);
              } else {
                reject(new Error(`HTTP ${res.statusCode}`));
              }
            } catch (e) {
              reject(e);
            }
          });
        }
      );

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.end();
    });

    for (const update of updates) {
      const msg = update.message;
      if (!msg) {
        state.telegramLastUpdateId = update.update_id;
        writeDaemonState(state);
        continue;
      }

      if (!msg.reply_to_message?.message_id) {
        state.telegramLastUpdateId = update.update_id;
        writeDaemonState(state);
        continue;
      }

      if (String(msg.chat.id) !== config.telegramChatId) {
        state.telegramLastUpdateId = update.update_id;
        writeDaemonState(state);
        continue;
      }

      const mapping = lookupByMessageId('telegram', String(msg.reply_to_message.message_id));
      if (!mapping) {
        state.telegramLastUpdateId = update.update_id;
        writeDaemonState(state);
        continue;
      }

      const text = msg.text || '';
      if (!text) {
        state.telegramLastUpdateId = update.update_id;
        writeDaemonState(state);
        continue;
      }

      if (!rateLimiter.canProceed()) {
        log(`WARN: Rate limit exceeded, dropping Telegram message ${msg.message_id}`);
        state.telegramLastUpdateId = update.update_id;
        writeDaemonState(state);
        state.errors++;
        continue;
      }

      state.telegramLastUpdateId = update.update_id;
      writeDaemonState(state);

      const success = injectReply(mapping.tmuxPaneId, text, 'telegram', config);
      if (success) {
        state.messagesInjected++;
        try {
          const replyBody = JSON.stringify({
            chat_id: config.telegramChatId,
            text: 'Injected into Codex CLI session.',
            reply_to_message_id: msg.message_id,
          });

          await new Promise<void>((resolve) => {
            const replyReq = httpsRequest(
              {
                hostname: 'api.telegram.org',
                path: `/bot${config.telegramBotToken}/sendMessage`,
                method: 'POST',
                family: 4,
                headers: {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(replyBody),
                },
                timeout: 5000,
              },
              (res) => {
                res.resume();
                resolve();
              }
            );

            replyReq.on('error', () => resolve());
            replyReq.on('timeout', () => {
              replyReq.destroy();
              resolve();
            });

            replyReq.write(replyBody);
            replyReq.end();
          });
        } catch (e) {
          log(`WARN: Failed to send confirmation reply: ${e}`);
        }
      } else {
        state.errors++;
      }
    }
  } catch (error) {
    state.errors++;
    state.lastError = error instanceof Error ? error.message : String(error);
    log(`Telegram polling error: ${state.lastError}`);
  }
}

// ============================================================================
// Main Daemon Loop
// ============================================================================

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

async function pollLoop(): Promise<void> {
  log('Reply listener daemon starting poll loop');

  const config = readDaemonConfig();
  if (!config) {
    log('ERROR: No daemon config found, exiting');
    process.exit(1);
  }

  const state = readDaemonState() || {
    isRunning: true,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    lastPollAt: null,
    telegramLastUpdateId: null,
    discordLastMessageId: null,
    messagesInjected: 0,
    errors: 0,
  };

  state.isRunning = true;
  state.pid = process.pid;

  const rateLimiter = new RateLimiter(config.rateLimitPerMinute);
  let lastPruneAt = Date.now();

  const shutdown = () => {
    log('Shutdown signal received');
    state.isRunning = false;
    writeDaemonState(state);
    removePidFile();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  try {
    pruneStale();
    log('Pruned stale registry entries');
  } catch (e) {
    log(`WARN: Failed to prune stale entries: ${e}`);
  }

  while (state.isRunning) {
    try {
      state.lastPollAt = new Date().toISOString();

      await pollDiscord(config, state, rateLimiter);
      await pollTelegram(config, state, rateLimiter);

      if (Date.now() - lastPruneAt > PRUNE_INTERVAL_MS) {
        try {
          pruneStale();
          lastPruneAt = Date.now();
          log('Pruned stale registry entries');
        } catch (e) {
          log(`WARN: Prune failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      writeDaemonState(state);
      await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
    } catch (error) {
      state.errors++;
      state.lastError = error instanceof Error ? error.message : String(error);
      log(`Poll error: ${state.lastError}`);
      writeDaemonState(state);
      await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs * 2));
    }
  }

  log('Poll loop ended');
}

// ============================================================================
// Daemon Control
// ============================================================================

export function startReplyListener(config: ReplyListenerDaemonConfig): DaemonResponse {
  if (isDaemonRunning()) {
    const state = readDaemonState();
    return {
      success: true,
      message: 'Reply listener daemon is already running',
      state: state ?? undefined,
    };
  }

  if (!isTmuxAvailable()) {
    return {
      success: false,
      message: 'tmux not available - reply injection requires tmux',
    };
  }

  writeDaemonConfig(config);
  ensureStateDir();

  const modulePath = __filename.replace(/\.ts$/, '.js');
  const daemonScript = `
    import('${modulePath}').then(({ pollLoop }) => {
      return pollLoop();
    }).catch((err) => { console.error(err); process.exit(1); });
  `;

  try {
    const child = spawn('node', ['-e', daemonScript], {
      detached: true,
      stdio: 'ignore',
      cwd: process.cwd(),
      env: createMinimalDaemonEnv(),
    });

    child.unref();

    const pid = child.pid;
    if (pid) {
      writePidFile(pid);

      const state: ReplyListenerState = {
        isRunning: true,
        pid,
        startedAt: new Date().toISOString(),
        lastPollAt: null,
        telegramLastUpdateId: null,
        discordLastMessageId: null,
        messagesInjected: 0,
        errors: 0,
      };
      writeDaemonState(state);
      log(`Reply listener daemon started with PID ${pid}`);

      return {
        success: true,
        message: `Reply listener daemon started with PID ${pid}`,
        state,
      };
    }

    return {
      success: false,
      message: 'Failed to start daemon process',
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to start daemon',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function stopReplyListener(): DaemonResponse {
  const pid = readPidFile();

  if (pid === null) {
    return {
      success: true,
      message: 'Reply listener daemon is not running',
    };
  }

  if (!isProcessRunning(pid)) {
    removePidFile();
    return {
      success: true,
      message: 'Reply listener daemon was not running (cleaned up stale PID file)',
    };
  }

  try {
    process.kill(pid, 'SIGTERM');
    removePidFile();

    const state = readDaemonState();
    if (state) {
      state.isRunning = false;
      state.pid = null;
      writeDaemonState(state);
    }

    log(`Reply listener daemon stopped (PID ${pid})`);

    return {
      success: true,
      message: `Reply listener daemon stopped (PID ${pid})`,
      state: state ?? undefined,
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to stop daemon',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function getReplyListenerStatus(): DaemonResponse {
  const state = readDaemonState();
  const running = isDaemonRunning();

  if (!running && !state) {
    return {
      success: true,
      message: 'Reply listener daemon has never been started',
    };
  }

  if (!running && state) {
    return {
      success: true,
      message: 'Reply listener daemon is not running',
      state: { ...state, isRunning: false, pid: null },
    };
  }

  return {
    success: true,
    message: 'Reply listener daemon is running',
    state: state ?? undefined,
  };
}

export { pollLoop };
