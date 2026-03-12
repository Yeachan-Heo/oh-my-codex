import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';

describe('state-server team_* MCP deprecation', () => {
  it('does not expose team_* tools from ListTools output', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { buildStateServerTools } = await import('../state-server.js');

    const tools = buildStateServerTools();
    const teamTools = tools.filter((tool: { name: string }) => tool.name.startsWith('team_'));
    assert.equal(teamTools.length, 0);

    const stateTools = tools.filter((tool: { name: string }) => tool.name.startsWith('state_'));
    assert.ok(stateTools.length > 0);
  });

  it('returns hard-deprecation error + CLI hint when team_* tool is called', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const resp = await handleStateToolCall({
      params: {
        name: 'team_send_message',
        arguments: {
          team_name: 'alpha-team',
          from_worker: 'worker-1',
          to_worker: 'leader-fixed',
          body: 'ack',
        },
      },
    });

    assert.equal(resp.isError, true);
    const body = JSON.parse(resp.content[0]?.text ?? '{}') as { code?: string; error?: string; hint?: string };
    assert.equal(body.code, 'deprecated_cli_only');
    assert.match(body.error ?? '', /hard-deprecated/i);
    assert.match(body.hint ?? '', /omx team api send-message/);
    assert.match(body.hint ?? '', /--json/);
  });
});
