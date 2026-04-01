/**
 * CLI command: `omx providers`
 *
 * Displays all configured providers with their status, token usage,
 * limits, and failover priority.
 */

import { spawnSync } from 'child_process';
import { loadFailoverConfig } from '../failover/config.js';
import { ProviderTracker } from '../failover/tracker.js';
import type { FailoverProvider } from '../failover/types.js';

const PROVIDER_BINARIES: Record<FailoverProvider, string> = {
  codex: 'codex',
  claude: 'claude',
  gemini: 'gemini',
  qwen: 'qwen',
  grok: 'grok',
};

const PROVIDER_ENV_KEYS: Record<FailoverProvider, string> = {
  codex: 'OPENAI_API_KEY',
  claude: 'ANTHROPIC_API_KEY',
  gemini: 'GOOGLE_API_KEY',
  qwen: 'DASHSCOPE_API_KEY',
  grok: 'XAI_API_KEY',
};

function checkBinaryAvailable(binary: string): boolean {
  try {
    const result = spawnSync(binary, ['--version'], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5_000,
    });
    if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function checkApiKeyPresent(provider: FailoverProvider, env: NodeJS.ProcessEnv): boolean {
  const key = PROVIDER_ENV_KEYS[provider];
  return Boolean(env[key]?.trim());
}

export interface ProviderDisplayInfo {
  provider: FailoverProvider;
  priority: number;
  binaryInstalled: boolean;
  apiKeySet: boolean;
  status: 'ready' | 'no-binary' | 'no-api-key' | 'unavailable';
  failoverEnabled: boolean;
}

export function getProviderDisplayInfo(
  env: NodeJS.ProcessEnv = process.env,
): ProviderDisplayInfo[] {
  const config = loadFailoverConfig(env);
  const allProviders: FailoverProvider[] = ['codex', 'claude', 'gemini', 'qwen', 'grok'];

  return allProviders.map((provider) => {
    const priority = config.order.indexOf(provider);
    const binaryInstalled = checkBinaryAvailable(PROVIDER_BINARIES[provider]);
    const apiKeySet = checkApiKeyPresent(provider, env);

    let status: ProviderDisplayInfo['status'];
    if (!binaryInstalled) {
      status = 'no-binary';
    } else if (!apiKeySet) {
      status = 'no-api-key';
    } else {
      status = 'ready';
    }

    return {
      provider,
      priority: priority >= 0 ? priority + 1 : -1,
      binaryInstalled,
      apiKeySet,
      status,
      failoverEnabled: config.enabled,
    };
  });
}

export function formatProvidersTable(infos: ProviderDisplayInfo[]): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('  Provider Status');
  lines.push('  ' + '-'.repeat(70));
  lines.push(
    '  ' +
    'Provider'.padEnd(12) +
    'Priority'.padEnd(10) +
    'Binary'.padEnd(12) +
    'API Key'.padEnd(12) +
    'Status'.padEnd(16),
  );
  lines.push('  ' + '-'.repeat(70));

  for (const info of infos) {
    const priorityStr = info.priority > 0 ? `#${info.priority}` : 'N/A';
    const binaryStr = info.binaryInstalled ? 'installed' : 'missing';
    const apiKeyStr = info.apiKeySet ? 'set' : 'missing';
    const statusStr = info.status === 'ready' ? 'READY' :
      info.status === 'no-binary' ? 'NO BINARY' :
      info.status === 'no-api-key' ? 'NO API KEY' : 'UNAVAILABLE';

    lines.push(
      '  ' +
      info.provider.padEnd(12) +
      priorityStr.padEnd(10) +
      binaryStr.padEnd(12) +
      apiKeyStr.padEnd(12) +
      statusStr.padEnd(16),
    );
  }

  lines.push('  ' + '-'.repeat(70));

  const failoverEnabled = infos[0]?.failoverEnabled ?? false;
  lines.push(`  Failover: ${failoverEnabled ? 'ENABLED' : 'DISABLED'}`);
  lines.push('');

  return lines.join('\n');
}

export async function providersCommand(args: string[]): Promise<void> {
  if (args[0] === '--help' || args[0] === '-h') {
    console.log('Usage: omx providers');
    console.log('  Show all providers with status, token usage, limits, and priority.');
    return;
  }

  const infos = getProviderDisplayInfo();
  console.log(formatProvidersTable(infos));
}
