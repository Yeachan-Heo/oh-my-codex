export type McpServerName = 'state' | 'memory' | 'code_intel' | 'trace' | 'team';

const SERVER_DISABLE_ENV: Record<McpServerName, string> = {
  state: 'OMX_STATE_SERVER_DISABLE_AUTO_START',
  memory: 'OMX_MEMORY_SERVER_DISABLE_AUTO_START',
  code_intel: 'OMX_CODE_INTEL_SERVER_DISABLE_AUTO_START',
  trace: 'OMX_TRACE_SERVER_DISABLE_AUTO_START',
  team: 'OMX_TEAM_SERVER_DISABLE_AUTO_START',
};

const GLOBAL_DISABLE_ENV = 'OMX_MCP_SERVER_DISABLE_AUTO_START';

export function shouldAutoStartMcpServer(
  server: McpServerName,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const globalDisabled = env[GLOBAL_DISABLE_ENV] === '1';
  const serverDisabled = env[SERVER_DISABLE_ENV[server]] === '1';
  return !globalDisabled && !serverDisabled;
}

