import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function readSource(relativePath: string): Promise<string> {
  return readFile(join(process.cwd(), relativePath), 'utf8');
}

describe('error-handling warning guards', () => {
  it('removes silent shutdown mode-state swallow in team command', async () => {
    const source = await readSource('src/cli/team.ts');
    assert.match(source, /failed to persist team mode shutdown state/);
    assert.ok(!source.includes("completed_at: new Date().toISOString(),\n    }).catch(() => {});"));
  });

  it('uses warning logs for watcher lifecycle best-effort failures', async () => {
    const source = await readSource('src/cli/index.ts');

    assert.ok(!source.includes("await mkdir(join(cwd, '.omx', 'state'), { recursive: true }).catch(() => {});"));
    assert.ok(!source.includes('await unlink(pidPath).catch(() => {});'));

    const esrchGuardCount =
      source.match(/if \(!hasErrnoCode\(error, ['"]ESRCH['"]\)\)/g)?.length ?? 0;
    assert.equal(esrchGuardCount, 1);
    assert.match(source, /export async function reapStaleNotifyFallbackWatcher/);
    assert.match(source, /failed to stop stale notify fallback watcher/);
    assert.match(source, /failed to write notify fallback watcher pid file/);
    assert.match(source, /failed to write hook-derived watcher pid file/);
    assert.match(source, /failed to remove notify fallback watcher pid file/);
    assert.match(source, /failed to remove hook-derived watcher pid file/);
    assert.match(source, /buildWindowsMsysBackgroundHelperBootstrapScript/);
    assert.match(source, /detached:\s*shouldDetachBackgroundHelper\(options\.env,\s*process\.platform\),\s+stdio: "ignore",\s+windowsHide: true,/);
    assert.match(source, /stdio: "ignore",\s+timeout: 3000,\s+windowsHide: true,/);
  });

  it('hides Windows child windows for prompt and notification helpers', async () => {
    const starPromptSource = await readSource('src/cli/star-prompt.ts');
    const updateSource = await readSource('src/cli/update.ts');
    const notifierSource = await readSource('src/notifications/notifier.ts');
    const replyListenerSource = await readSource('src/notifications/reply-listener.ts');

    assert.match(starPromptSource, /windowsHide: true/);
    assert.match(updateSource, /windowsHide: true/);
    assert.match(notifierSource, /execFileAsync\(cmd, args, \{ windowsHide: true \}\)/);
    assert.match(replyListenerSource, /detached: true,\s+stdio: 'ignore',\s+windowsHide: true,/);
  });

  it('replaces silent log-write catches with warning logs', async () => {
    const loggingSource = await readSource('src/hooks/extensibility/logging.ts');
    const dispatchSource = await readSource('src/hooks/extensibility/dispatcher.ts');
    const keywordSource = await readSource('src/hooks/keyword-detector.ts');

    assert.ok(!loggingSource.includes('.catch(() => {});'));
    assert.ok(!dispatchSource.includes('.catch(() => {});'));
    assert.ok(!keywordSource.includes('.catch(() => {});'));

    assert.match(loggingSource, /failed to append hook plugin log entry/);
    assert.match(dispatchSource, /failed to append hook dispatch log entry/);
    assert.match(keywordSource, /failed to persist keyword activation state/);
  });
});
