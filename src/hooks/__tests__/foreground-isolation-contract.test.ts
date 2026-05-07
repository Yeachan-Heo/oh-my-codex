import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

describe('foreground isolation contract for hook background helpers', () => {
  it('keeps notify-hook subprocess probes hidden while capturing output', async () => {
    const source = await readFile(join(process.cwd(), 'dist', 'scripts', 'notify-hook', 'process-runner.js'), 'utf-8');
    assert.match(source, /stdio:\s*\[\s*['"]ignore['"],\s*['"]pipe['"],\s*['"]pipe['"]\s*\]/);
    assert.match(source, /windowsHide:\s*true/);
  });

  it('keeps hook plugin runner subprocesses hidden while capturing output', async () => {
    const source = await readFile(join(process.cwd(), 'dist', 'hooks', 'extensibility', 'dispatcher.js'), 'utf-8');
    assert.match(source, /stdio:\s*\[\s*['"]pipe['"],\s*['"]pipe['"],\s*['"]pipe['"]\s*\]/);
    assert.match(source, /windowsHide:\s*true/);
  });

  it('does not print managed-tmux pane-instance fallbacks into notify/native hook stderr', async () => {
    const source = await readFile(join(process.cwd(), 'dist', 'scripts', 'notify-hook', 'managed-tmux.js'), 'utf-8');
    const fallbackFunction = source.match(/function warnPaneInstanceFallback[\s\S]*?^}/m)?.[0] ?? '';
    assert.notEqual(fallbackFunction, '');
    assert.doesNotMatch(fallbackFunction, /console\.(?:warn|error|log)/);
  });

  it('logs notify-hook fatal errors instead of printing them to foreground stderr', async () => {
    const source = await readFile(join(process.cwd(), 'dist', 'scripts', 'notify-hook.js'), 'utf-8');
    assert.match(source, /notify_hook_fatal_error/);
    assert.doesNotMatch(source, /console\.error\(\s*['"]\[notify-hook]/);
  });
});
