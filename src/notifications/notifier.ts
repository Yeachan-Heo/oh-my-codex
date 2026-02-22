/**
 * Notification system for oh-my-codex
 * Supports desktop notifications, Discord webhooks, and Telegram bots
 */

import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface NotificationConfig {
  desktop?: boolean;
  discord?: {
    webhookUrl: string;
  };
  telegram?: {
    botToken: string;
    chatId: string;
  };
}

export interface NotificationPayload {
  title: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
  mode?: string;
  projectPath?: string;
}

/**
 * Load notification config from .omx/notifications.json
 */
export async function loadNotificationConfig(projectRoot?: string): Promise<NotificationConfig | null> {
  const configPath = join(projectRoot || process.cwd(), '.omx', 'notifications.json');
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(await readFile(configPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Send notification via all configured channels
 */
export async function notify(payload: NotificationPayload, config?: NotificationConfig | null): Promise<void> {
  if (!config) {
    config = await loadNotificationConfig();
    if (!config) return;
  }

  const promises: Promise<void>[] = [];

  if (config.desktop) {
    promises.push(sendDesktopNotification(payload));
  }

  if (config.discord?.webhookUrl) {
    promises.push(sendDiscordNotification(payload, config.discord.webhookUrl));
  }

  if (config.telegram?.botToken && config.telegram?.chatId) {
    promises.push(sendTelegramNotification(payload, config.telegram.botToken, config.telegram.chatId));
  }

  await Promise.allSettled(promises);
}

/**
 * Build the execFile command and args for a desktop notification.
 * Exported for unit testing.
 */
export function _buildDesktopArgs(
  title: string,
  message: string,
  platform: string,
): [string, string[]] | null {
  if (platform === 'darwin') {
    // Escape backslashes then double-quotes for AppleScript string context
    const safeTitle = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const safeMessage = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return ['osascript', ['-e', `display notification "${safeMessage}" with title "${safeTitle}"`]];
  } else if (platform === 'linux') {
    // execFile passes args directly — no shell, no escaping needed
    return ['notify-send', [title, message]];
  } else if (platform === 'win32') {
    // Escape single-quotes for PowerShell single-quoted string context (double them)
    const safeTitle = title.replace(/'/g, "''");
    const safeMessage = message.replace(/'/g, "''");
    const ps =
      `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; ` +
      `$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(0); ` +
      `$text = $xml.GetElementsByTagName('text'); ` +
      `$text[0].AppendChild($xml.CreateTextNode('${safeTitle}')) > $null; ` +
      `$text[1].AppendChild($xml.CreateTextNode('${safeMessage}')) > $null; ` +
      `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('oh-my-codex').Show($xml)`;
    return ['powershell', ['-Command', ps]];
  }
  return null;
}

async function sendDesktopNotification(payload: NotificationPayload): Promise<void> {
  const result = _buildDesktopArgs(payload.title, payload.message, process.platform);
  if (!result) return;
  const [cmd, args] = result;
  try {
    await execFileAsync(cmd, args);
  } catch {
    // Desktop notification is best-effort
  }
}

async function sendDiscordNotification(payload: NotificationPayload, webhookUrl: string): Promise<void> {
  const colorMap = { info: 3447003, success: 3066993, warning: 15105570, error: 15158332 };
  const body = JSON.stringify({
    embeds: [{
      title: `[OMX] ${payload.title}`,
      description: payload.message,
      color: colorMap[payload.type],
      footer: { text: `oh-my-codex | ${payload.mode || 'general'}` },
      timestamp: new Date().toISOString(),
    }],
  });

  try {
    const { default: https } = await import('https');
    await new Promise<void>((resolve, reject) => {
      const url = new URL(webhookUrl);
      const req = https.request({
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  } catch {
    // Discord notification is best-effort
  }
}

async function sendTelegramNotification(
  payload: NotificationPayload,
  botToken: string,
  chatId: string
): Promise<void> {
  const iconMap = { info: 'info', success: 'white_check_mark', warning: 'warning', error: 'x' };
  const text = `*[OMX] ${payload.title}*\n${payload.message}`;

  try {
    const { default: https } = await import('https');
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' });
    await new Promise<void>((resolve, reject) => {
      const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${botToken}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  } catch {
    // Telegram notification is best-effort
  }
}
