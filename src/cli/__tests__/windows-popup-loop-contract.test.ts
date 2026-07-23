import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..', '..');
const cliIndex = readFileSync(join(repoRoot, 'src', 'cli', 'index.ts'), 'utf-8');
const starPrompt = readFileSync(join(repoRoot, 'src', 'cli', 'star-prompt.ts'), 'utf-8');
const updateSource = readFileSync(join(repoRoot, 'src', 'cli', 'update.ts'), 'utf-8');
const notifierSource = readFileSync(join(repoRoot, 'src', 'notifications', 'notifier.ts'), 'utf-8');
const replyListenerSource = readFileSync(join(repoRoot, 'src', 'notifications', 'reply-listener.ts'), 'utf-8');
const fallbackWatcherSource = readFileSync(join(repoRoot, 'src', 'scripts', 'notify-fallback-watcher.ts'), 'utf-8');
const launchFallbackSource = readFileSync(join(repoRoot, 'src', 'cli', '__tests__', 'launch-fallback.test.ts'), 'utf-8');

describe('Windows popup loop contracts', () => {
  it('keeps Windows helper spawns hidden', () => {
    assert.match(cliIndex, /buildWindowsMsysBackgroundHelperBootstrapScript/);
    assert.match(
      cliIndex,
      /const pidPath = notifyFallbackPidPath\(cwd\);\s+const reapResult = await reapStaleNotifyFallbackWatcher\(pidPath\);\s+if \(reapResult === "recent_active"\) return;\s+if \(!shouldEnableNotifyFallbackWatcher\(process\.env,\s*process\.platform\)\) return;/,
    );
    assert.match(cliIndex, /detached:\s*shouldDetachBackgroundHelper\(options\.env,\s*process\.platform\),\s*[\s\S]*?stdio:\s*"ignore",\s*[\s\S]*?windowsHide:\s*true/);
    assert.match(cliIndex, /spawnSync\([\s\S]*?buildWindowsMsysBackgroundHelperBootstrapScript\([\s\S]*?windowsHide:\s*true/);
    assert.match(cliIndex, /detached:\s*true,\s*stdio:\s*'ignore',\s*windowsHide:\s*true/);
    assert.match(cliIndex, /spawnSync\(\s*process\.execPath,\s*\[watcherScript,\s*"--once",\s*"--cwd",\s*cwd,\s*"--notify-script",\s*notifyScript\],\s*\{[\s\S]*?windowsHide:\s*true/);
    assert.match(cliIndex, /spawnSync\(process\.execPath,\s*\[watcherScript,\s*"--once",\s*"--cwd",\s*cwd\],\s*\{[\s\S]*?windowsHide:\s*true/);
    assert.match(starPrompt, /spawnSyncFn\('gh',\s*\['api',[\s\S]*?windowsHide:\s*true/);
    assert.match(updateSource, /runNpmCommand\(\s*ownership\.npmCommand,[\s\S]*?windowsHide:\s*true/);
    assert.match(notifierSource, /execFileAsync\(cmd,\s*args,\s*\{\s*windowsHide:\s*true\s*\}\)/);
    assert.match(replyListenerSource, /spawn\('node',\s*\['-e',\s*daemonScript\],\s*\{[\s\S]*?windowsHide:\s*true/);
    assert.match(fallbackWatcherSource, /spawnPlatformCommandSync\(\s*'tmux',\s*\[\s*'if-shell',\s*'-F',\s*'-t',\s*binding\.paneId,\s*ralphInputAuthorityCondition\(binding\),\s*success,\s*denied\s*\]/);
    assert.match(fallbackWatcherSource, /const success = `\$\{args\.map[\s\S]*?display-message -p \$\{receipt\}`/);
    assert.match(fallbackWatcherSource, /sendKeys\(\['send-keys', '-t', binding\.paneId/);
    assert.doesNotMatch(fallbackWatcherSource, /spawnSync\('tmux'/);
  });
});

describe('detached tmux authority contract', () => {
  it('binds bootstrap and HUD-target finalization mutations to immutable detached authorities', () => {
    assert.match(
      cliIndex,
      /function captureDetachedLeaderAuthority[\s\S]*?#\{session_name\}\\t#\{session_id\}\\t#\{session_created\}\\t#\{window_index\}\\t#\{window_id\}\\t#\{pane_id\}\\t#\{pane_pid\}/,
    );
    assert.match(cliIndex, /type DetachedHudAuthority = \{[\s\S]*?panePid: number;[\s\S]*?sessionId: string;[\s\S]*?windowId: string;[\s\S]*?operationMarker: string;/);
    assert.match(cliIndex, /splitArgs\[formatIndex \+ 1\] = `#\{pane_id\}\\t#\{pane_pid\}\\t#\{session_id\}\\t#\{window_id\}\\t\$\{receipt\}`/);
    assert.match(cliIndex, /function detachedHudAuthorityCondition[\s\S]*?#\{==:#\{pane_pid\},\$\{authority\.panePid\}\}[\s\S]*?#\{==:#\{session_id\},\$\{authority\.sessionId\}\}[\s\S]*?#\{==:#\{window_id\},\$\{authority\.windowId\}\}[\s\S]*?OMX_DETACHED_HUD_OPERATION=\$\{authority\.operationMarker\}/);
    assert.match(cliIndex, /function runDetachedHudMutation[\s\S]*?if-shell -F -t \$\{quoteShellArg\(hudAuthority\.paneId\)\}[\s\S]*?detachedLeaderAuthorityCondition\(leaderAuthority\)/);
    assert.match(cliIndex, /function guardDetachedHudDeferredMutation[\s\S]*?buildDeferredDetachedHudGuard\(leaderAuthority, hudAuthority/);
    assert.match(cliIndex, /let detachedHudAuthority: DetachedHudAuthority \| null = null;/);
    assert.match(cliIndex, /detachedHudAuthority = runDetachedLeaderSplit\(authority, step\.args\)/);
    assert.match(cliIndex, /if \(targetsHudPane\) runDetachedHudMutation\(authority, detachedHudAuthority, guardDetachedHudDeferredMutation\(authority, detachedHudAuthority, finalizeStep\.args\)\)/);
    assert.match(cliIndex, /publishDetachedReleaseMarker\(releaseMarkerPath, detachedLaunchNonce, sessionId, sessionName, detachedLeaderPid, detachedHudAuthority \?\? undefined\)/);
    assert.match(cliIndex, /runDetachedLeaderMutation\(detachedLeaderAuthority, step\.args\)/);
    assert.ok(cliIndex.includes('splitArgs[commandIndex] = `env OMX_DETACHED_HUD_OPERATION=${operationMarker} ${splitArgs[commandIndex]}`;'));
  });

  it('does not route runtime detached HUD or rollback mutations through raw step arguments', () => {
    assert.doesNotMatch(cliIndex, /execTmuxFileSync\(step\.args, \{ stdio: "ignore" \}\)/);
    assert.doesNotMatch(cliIndex, /execTmuxFileSync\(finalizeStep\.args, \{ stdio: "ignore" \}\)/);
  });

  it('executes a created-HUD recycling denial fixture rather than only declaring one', () => {
    const recyclingTest = launchFallbackSource.match(
      /it\('denies detached HUD finalization when the receipted pane id is recycled'[\s\S]*?\n  \}\);/,
    )?.[0];
    assert.ok(recyclingTest, 'named detached HUD recycling test must exist');
    assert.match(recyclingTest, /OMX_TEST_DETACHED_RECYCLE: 'finalization'/);
    assert.match(recyclingTest, /assert\.equal\(result\.status, 0, result\.error \|\| result\.stderr \|\| result\.stdout\)/);
    assert.match(recyclingTest, /__nested_hud_guard_denied__ %99 999 \\\$2 @2/);
    assert.match(recyclingTest, /assert\.doesNotMatch\(tmuxLog, \/\^tmux:resize-pane \.\*%99\/m\)/);
  });
});
