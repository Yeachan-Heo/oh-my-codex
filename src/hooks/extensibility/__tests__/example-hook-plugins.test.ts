import assert from 'node:assert/strict';
import { readFile } from 'node:fs';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { dispatchHookEvent } from '../dispatcher.js';
import { buildHookEvent } from '../events.js';

const ALL_EVENTS = [
  'session-start',
  'session-end',
  'session-idle',
  'turn-complete',
  'needs-input',
  'pre-tool-use',
  'post-tool-use',
] as const;

const DERIVED_EVENTS = new Set<string>(['needs-input', 'pre-tool-use', 'post-tool-use']);

function examplePluginSource(expectedEvent: string): string {
  return `const EXPECTED_EVENT = ${JSON.stringify(expectedEvent)};

export async function onHookEvent(event, sdk) {
  if (event.event !== EXPECTED_EVENT) return;
  const runId = String((event.context && event.context.run_id) || 'unknown');
  const seenKey = 'seen_count';
  const prev = Number((await sdk.state.read(seenKey)) ?? 0);
  const next = Number.isFinite(prev) ? prev + 1 : 1;
  await sdk.state.write(seenKey, next);
  await sdk.state.write('last_event', event.event);
  await sdk.state.write('last_source', event.source);
  await sdk.state.write('last_run_id', runId);
  await sdk.state.write(\`run:\${runId}\`, { event: event.event, source: event.source, at: event.timestamp });
  await sdk.log.info('example hook fired', {
    expected: EXPECTED_EVENT,
    seen_count: next,
    source: event.source,
    run_id: runId,
  });
}
`;
}

async function setupExamplePlugins(cwd: string): Promise<void> {
  const hooksDir = join(cwd, '.omx', 'hooks');
  await mkdir(hooksDir, { recursive: true });

  for (const eventName of ALL_EVENTS) {
    const filePath = join(hooksDir, `example-${eventName}.mjs`);
    await writeFile(filePath, examplePluginSource(eventName), 'utf-8');
  }
}

function pluginDataPath(cwd: string, eventName: string): string {
  return join(cwd, '.omx', 'state', 'hooks', 'plugins', `example-${eventName}`, 'data.json');
}

async function readPluginData(cwd: string, eventName: string): Promise<Record<string, unknown> | null> {
  const path = pluginDataPath(cwd, eventName);
  try {
    await access(path);
  } catch {
    return null;
  }

  const raw = await new Promise<string>((resolve, reject) => {
    readFile(path, 'utf-8', (err, data) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(data);
    });
  });

  return JSON.parse(raw) as Record<string, unknown>;
}

describe('example hook plugins', () => {
  it('dispatches only the matching example plugin for a single event', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-examples-'));

    try {
      await setupExamplePlugins(cwd);

      const event = buildHookEvent('session-start', {
        timestamp: '2026-01-01T00:00:00.000Z',
        context: { run_id: 'run-session-start' },
      });

      const result = await dispatchHookEvent(event, {
        cwd,
        env: {
          ...process.env,
          OMX_HOOK_PLUGINS: '1',
        },
      });

      assert.equal(result.enabled, true);
      assert.equal(result.plugin_count, ALL_EVENTS.length);
      assert.equal(result.results.length, ALL_EVENTS.length);

      const matched = result.results.find((item) => item.plugin === 'example-session-start');
      assert.ok(matched);
      assert.equal(matched.ok, true);

      for (const eventName of ALL_EVENTS) {
        const data = await readPluginData(cwd, eventName);
        if (eventName === 'session-start') {
          assert.ok(data);
          assert.equal(data.seen_count, 1);
          assert.equal(data.last_event, 'session-start');
        } else {
          assert.equal(data, null);
        }
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('covers all example plugin event types with deterministic state assertions', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-examples-all-'));

    try {
      await setupExamplePlugins(cwd);

      for (const eventName of ALL_EVENTS) {
        const timestamp = `2026-01-01T00:00:00.${String(ALL_EVENTS.indexOf(eventName)).padStart(3, '0')}Z`;
        const runId = `run-${eventName}`;
        const envelope = buildHookEvent(eventName, {
          timestamp,
          context: { run_id: runId },
        });

        const result = await dispatchHookEvent(envelope, {
          cwd,
          env: {
            ...process.env,
            OMX_HOOK_PLUGINS: '1',
          },
        });

        const matched = result.results.find((item) => item.plugin === `example-${eventName}`);
        assert.ok(matched);
        assert.equal(matched.ok, true);
      }

      for (const eventName of ALL_EVENTS) {
        const data = await readPluginData(cwd, eventName);
        const runId = `run-${eventName}`;
        const expectedSource = DERIVED_EVENTS.has(eventName) ? 'derived' : 'native';

        assert.ok(data);
        assert.equal(data.seen_count, 1);
        assert.equal(data.last_event, eventName);
        assert.equal(data.last_source, expectedSource);
        assert.equal(data.last_run_id, runId);
        assert.deepEqual(data[`run:${runId}`], {
          event: eventName,
          source: expectedSource,
          at: `2026-01-01T00:00:00.${String(ALL_EVENTS.indexOf(eventName)).padStart(3, '0')}Z`,
        });
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
