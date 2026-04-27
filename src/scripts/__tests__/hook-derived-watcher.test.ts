import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

function todaySessionDir(baseHome: string): string {
  const now = new Date();
  return join(
    baseHome,
    '.codex',
    'sessions',
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number = 3000, stepMs: number = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(stepMs);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe('hook-derived-watcher', () => {
  it('uses offset-bounded rollout reads instead of re-reading whole tracked files', async () => {
    const source = await readFile(new URL('../hook-derived-watcher.js', import.meta.url), 'utf-8');

    assert.match(source, /async function readFileDelta/);
    assert.match(source, /while \(totalBytesRead < length\)/);
    assert.match(source, /nextOffset: offset \+ totalBytesRead/);
    assert.match(source, /new StringDecoder\('utf8'\)/);
    assert.match(source, /decoder\.write\(bytes\)/);
    assert.match(source, /const fileStat = await stat\(path\)\.catch\(\(\) => null\);\s*if \(!fileStat\)\s*continue;/);
    assert.match(source, /if \(currentSize < meta\.offset\) \{\s*meta\.offset = 0;\s*meta\.partial = '';/);
    assert.doesNotMatch(source, /const content = await readFile\(path, 'utf-8'\)[\s\S]*const delta = content\.slice\(meta\.offset\)/);
    assert.doesNotMatch(source, /stat\(path\)\.catch\(\(\) => \(\{ size: 0 \}\)\)/);
  });

  it('dispatches needs-input for assistant_message content arrays', async () => {
    const base = await mkdtemp(join(tmpdir(), 'omx-hook-derived-array-'));
    const homeDir = join(base, 'home');
    const cwd = join(base, 'cwd');
    const hookLogPath = join(cwd, '.omx', 'hook-events.jsonl');

    try {
      await mkdir(todaySessionDir(homeDir), { recursive: true });
      await mkdir(join(cwd, '.omx', 'hooks'), { recursive: true });

      await writeFile(
        join(cwd, '.omx', 'hooks', 'capture-needs-input.mjs'),
        `import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function onHookEvent(event) {
  await mkdir(dirname(${JSON.stringify(hookLogPath)}), { recursive: true });
  await appendFile(${JSON.stringify(hookLogPath)}, JSON.stringify(event) + '\\n');
}
`,
      );

      const rolloutPath = join(todaySessionDir(homeDir), 'rollout-hook-derived-array.jsonl');
      await writeFile(
        rolloutPath,
        [
          JSON.stringify({
            type: 'session_meta',
            payload: {
              id: 'thread-hook-array',
              cwd,
            },
          }),
          JSON.stringify({
            timestamp: new Date().toISOString(),
            type: 'event_msg',
            payload: {
              type: 'assistant_message',
              turn_id: 'turn-hook-array',
              content: [
                {
                  type: 'output_text',
                  text: 'Would you like me to continue with the cleanup?',
                },
                {
                  type: 'output_text',
                  text: 'I need your approval before I keep going.',
                },
              ],
            },
          }),
          '',
        ].join('\n'),
      );

      const watcherScript = new URL('../hook-derived-watcher.js', import.meta.url).pathname;
      const result = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', cwd, '--poll-ms', '250'],
        {
          cwd,
          env: {
            ...process.env,
            HOME: homeDir,
            OMX_HOOK_DERIVED_SIGNALS: '1',
            OMX_HOOK_PLUGINS: '1',
          },
          encoding: 'utf8',
        },
      );

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(existsSync(hookLogPath), true, 'expected needs-input hook log to be written');

      const events = (await readFile(hookLogPath, 'utf-8'))
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      assert.equal(events.length, 1);
      assert.equal(events[0].event, 'needs-input');
      assert.equal(events[0].source, 'derived');
      assert.equal(events[0].parser_reason, 'assistant_message_heuristic_question');
      assert.match(String((events[0].context as Record<string, unknown>)?.preview ?? ''), /Would you like me to continue/i);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('preserves multibyte assistant text split across polling reads', async () => {
    const base = await mkdtemp(join(tmpdir(), 'omx-hook-derived-utf8-'));
    const homeDir = join(base, 'home');
    const cwd = join(base, 'cwd');
    const hookLogPath = join(cwd, '.omx', 'hook-events.jsonl');

    try {
      await mkdir(todaySessionDir(homeDir), { recursive: true });
      await mkdir(join(cwd, '.omx', 'hooks'), { recursive: true });

      await writeFile(
        join(cwd, '.omx', 'hooks', 'capture-needs-input.mjs'),
        `import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function onHookEvent(event) {
  await mkdir(dirname(${JSON.stringify(hookLogPath)}), { recursive: true });
  await appendFile(${JSON.stringify(hookLogPath)}, JSON.stringify(event) + '\\n');
}
`,
      );

      const rolloutPath = join(todaySessionDir(homeDir), 'rollout-hook-derived-utf8.jsonl');
      await writeFile(
        rolloutPath,
        `${JSON.stringify({
          type: 'session_meta',
          payload: {
            id: 'thread-hook-utf8',
            cwd,
          },
        })}\n`,
      );

      const watcherScript = new URL('../hook-derived-watcher.js', import.meta.url).pathname;
      const child = spawn(
        process.execPath,
        [watcherScript, '--cwd', cwd, '--poll-ms', '75'],
        {
          cwd,
          stdio: 'ignore',
          env: {
            ...process.env,
            HOME: homeDir,
            OMX_HOOK_DERIVED_SIGNALS: '1',
            OMX_HOOK_PLUGINS: '1',
          },
        },
      );

      const watcherStatePath = join(cwd, '.omx', 'state', 'hook-derived-watcher-state.json');
      await waitFor(async () => {
        try {
          const state = JSON.parse(await readFile(watcherStatePath, 'utf-8'));
          return state.tracked_files === 1;
        } catch {
          return false;
        }
      });

      const questionText = 'Can you preserve split emoji 🧪 please?';
      const eventLine = `${JSON.stringify({
        timestamp: new Date().toISOString(),
        type: 'event_msg',
        payload: {
          type: 'assistant_message',
          turn_id: 'turn-hook-utf8',
          content: [{ type: 'output_text', text: questionText }],
        },
      })}\n`;
      const bytes = Buffer.from(eventLine, 'utf8');
      const emojiOffset = bytes.indexOf(Buffer.from('🧪', 'utf8'));
      assert.ok(emojiOffset > 0, 'expected test payload to contain emoji bytes');

      await appendFile(rolloutPath, bytes.subarray(0, emojiOffset + 1));
      await sleep(250);
      assert.equal(existsSync(hookLogPath), false, 'incomplete UTF-8 and JSON line should not dispatch');

      const hiddenRolloutPath = `${rolloutPath}.missing`;
      await rename(rolloutPath, hiddenRolloutPath);
      await sleep(250);
      assert.equal(existsSync(hookLogPath), false, 'transient missing file should preserve buffered bytes');
      await rename(hiddenRolloutPath, rolloutPath);

      await appendFile(rolloutPath, bytes.subarray(emojiOffset + 1));
      await waitFor(async () => {
        if (!existsSync(hookLogPath)) return false;
        const raw = await readFile(hookLogPath, 'utf-8');
        return raw.includes('turn-hook-utf8') && raw.includes(questionText);
      }, 4000, 75);

      child.kill('SIGTERM');
      await once(child, 'exit');

      const raw = await readFile(hookLogPath, 'utf-8');
      assert.match(raw, /turn-hook-utf8/);
      assert.match(raw, /Can you preserve split emoji 🧪 please\?/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
