import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { listVscodeLogs, pathInsideWorkspace, realPathInsideWorkspace } from '../workspaceStatus';

describe('workspace status helpers', () => {
  it('lists recent VSCode logs without creating state', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'omx-vscode-status-'));
    assert.deepEqual(await listVscodeLogs(cwd), []);
    const logDir = path.join(cwd, '.omx', 'logs', 'vscode');
    await mkdir(logDir, { recursive: true });
    await writeFile(path.join(logDir, 'a.log'), 'first');
    await writeFile(path.join(logDir, 'ignore.txt'), 'nope');
    const logs = await listVscodeLogs(cwd);
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.name, 'a.log');
    assert.equal(logs[0]?.size, 5);
  });

  it('keeps direct log paths scoped to the workspace', () => {
    const cwd = path.join(tmpdir(), 'omx-vscode-status');
    assert.equal(pathInsideWorkspace(cwd, path.join(cwd, '.omx', 'logs', 'vscode', 'a.log')), true);
    assert.equal(pathInsideWorkspace(cwd, path.join(cwd, '..', 'outside.log')), false);
  });

  it('rejects symlinked log paths that escape the workspace', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'omx-vscode-status-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'omx-vscode-outside-'));
    await mkdir(path.join(cwd, '.omx', 'logs', 'vscode'), { recursive: true });
    const outsideLog = path.join(outside, 'run.log');
    const linkedLog = path.join(cwd, '.omx', 'logs', 'vscode', 'linked.log');
    await writeFile(outsideLog, 'outside');
    await symlink(outsideLog, linkedLog);
    assert.equal(await realPathInsideWorkspace(cwd, linkedLog), false);
  });
});
