import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('MCP state/team tools path traversal prevention', () => {
  process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';

  it('rejects invalid workingDirectory inputs containing NUL bytes', async () => {
    const { handleStateToolCall } = await import('../state-server.js');
    const resp = await handleStateToolCall({
      params: {
        name: 'state_read',
        arguments: { mode: 'team', workingDirectory: 'bad\0path' },
      },
    });
    assert.equal(resp.isError, true);
    const body = JSON.parse(resp.content[0]?.text ?? '{}') as { error?: string };
    assert.match(body.error || '', /NUL byte/);
  });

  it('rejects traversal in mode for state_write', async () => {
    const { handleStateToolCall } = await import('../state-server.js');
    const wd = await mkdtemp(join(tmpdir(), 'omx-traversal-'));
    try {
      const resp = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            mode: '../../outside',
            state: { active: true },
            workingDirectory: wd,
          },
        },
      });
      assert.equal(resp.isError, true);
      const body = JSON.parse(resp.content[0]?.text ?? '{}') as { error?: string };
      assert.ok(typeof body.error === 'string' && body.error.length > 0);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects unsupported mode names for state_read', async () => {
    const { handleStateToolCall } = await import('../state-server.js');
    const wd = await mkdtemp(join(tmpdir(), 'omx-traversal-'));
    try {
      const resp = await handleStateToolCall({
        params: {
          name: 'state_read',
          arguments: {
            mode: 'custom_mode',
            workingDirectory: wd,
          },
        },
      });
      assert.equal(resp.isError, true);
      const body = JSON.parse(resp.content[0]?.text ?? '{}') as { error?: string };
      assert.ok(typeof body.error === 'string' && body.error.includes('mode must be one of'));
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('team_* tools return hard-deprecated CLI-only errors even for traversal payloads', async () => {
    const { handleStateToolCall } = await import('../state-server.js');
    const wd = await mkdtemp(join(tmpdir(), 'omx-traversal-'));
    try {
      const resp = await handleStateToolCall({
        params: {
          name: 'team_read_config',
          arguments: { team_name: '../../../etc/passwd', workingDirectory: wd },
        },
      });
      assert.equal(resp.isError, true);
      const body = JSON.parse(resp.content[0]?.text ?? '{}') as { code?: string; hint?: string };
      assert.equal(body.code, 'deprecated_cli_only');
      assert.match(body.hint ?? '', /omx team api read-config/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
