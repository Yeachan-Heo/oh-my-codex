import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = process.cwd();

async function readSource(relativePath: string): Promise<string> {
  return readFile(join(ROOT, relativePath), 'utf-8');
}

async function readOptionalSource(relativePath: string): Promise<string> {
  const path = join(ROOT, relativePath);
  return existsSync(path) ? readFile(path, 'utf-8') : '';
}

function functionBody(source: string, functionName: string): string {
  const start = source.indexOf(functionName);
  assert.notEqual(start, -1, `${functionName} should exist`);
  const brace = source.indexOf('{', start);
  assert.notEqual(brace, -1, `${functionName} should have a body`);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return source.slice(brace, index + 1);
  }
  assert.fail(`${functionName} body should close`);
}

function assertNoForbiddenGitStrategy(source: string, label: string): void {
  assert.doesNotMatch(source, /-X\s*(?:ours|theirs)\b/, `${label} must not use -X ours/theirs`);
  assert.doesNotMatch(source, /--strategy-option[=\s](?:ours|theirs)\b/, `${label} must not use ours/theirs strategy options`);
}

function assertNoFinalHistoryRewriteAutomation(source: string, label: string): void {
  assert.doesNotMatch(source, /git[^\n]*(?:rebase\s+-i|filter-branch|commit\s+--amend|reset\s+--soft)/, `${label} must not automate final history rewrite`);
}

describe('hook-primary PostToolUse E2E contract guardrails', () => {
  it('keeps buildNativePostToolUseOutput synchronous and free of async worker bridge side effects', async () => {
    const source = await readSource('src/scripts/codex-native-pre-post.ts');
    assert.match(source, /export function buildNativePostToolUseOutput\s*\(/);
    assert.doesNotMatch(source, /export async function buildNativePostToolUseOutput\s*\(/);

    const body = functionBody(source, 'buildNativePostToolUseOutput');
    assert.doesNotMatch(body, /handleTeamWorkerPostToolUseSuccess|team-worker-posttooluse/);
  });

  it('preserves fallback team monitoring instead of removing polling/runtime recovery', async () => {
    const runtimeSource = await readSource('src/team/runtime.ts');
    const notifyWorkerSource = await readSource('src/scripts/notify-hook/team-worker.ts');

    assert.match(runtimeSource, /export async function monitorTeam\s*\(/);
    assert.match(runtimeSource, /autoCommitDirtyWorktree/);
    assert.match(notifyWorkerSource, /maybeNotifyLeaderWorkerIdle|updateWorkerHeartbeat/);
  });

  it('does not add conflict auto-repair or final-history rewrite automation to the hook path', async () => {
    const hookSources = [
      ['codex-native-hook', await readSource('src/scripts/codex-native-hook.ts')],
      ['notify-hook/team-worker', await readSource('src/scripts/notify-hook/team-worker.ts')],
      ['notify-hook/team-worker-posttooluse', await readOptionalSource('src/scripts/notify-hook/team-worker-posttooluse.ts')],
    ] as const;

    for (const [label, source] of hookSources) {
      assertNoForbiddenGitStrategy(source, label);
      assertNoFinalHistoryRewriteAutomation(source, label);
    }
  });

  it('keeps any worker PostToolUse bridge constrained to successful Bash events', async () => {
    const bridgeSource = await readOptionalSource('src/scripts/notify-hook/team-worker-posttooluse.ts');
    if (!bridgeSource) {
      assert.equal(bridgeSource, '', 'bridge source absent in this worktree; dispatch tests cover current no-op path');
      return;
    }

    assert.match(bridgeSource, /hook_event_name/);
    assert.match(bridgeSource, /PostToolUse/);
    assert.match(bridgeSource, /tool_name/);
    assert.match(bridgeSource, /Bash/);
    assert.match(bridgeSource, /exit_code|exitCode/);
    assert.match(bridgeSource, /===\s*0|!==\s*0/);
  });
});
