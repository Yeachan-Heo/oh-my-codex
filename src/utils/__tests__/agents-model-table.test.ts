import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAgentsModelTable,
  OMX_MODELS_END_MARKER,
  OMX_MODELS_START_MARKER,
  resolveAgentsModelTableContext,
  upsertAgentsModelTable,
} from '../agents-model-table.js';

const originalFrontierEnv = process.env.OMX_DEFAULT_FRONTIER_MODEL;
const originalStandardEnv = process.env.OMX_DEFAULT_STANDARD_MODEL;
const originalSparkEnv = process.env.OMX_DEFAULT_SPARK_MODEL;
const originalLegacySparkEnv = process.env.OMX_SPARK_MODEL;
let tempDirs: string[] = [];

beforeEach(() => {
  tempDirs = [];
  delete process.env.OMX_DEFAULT_FRONTIER_MODEL;
  delete process.env.OMX_DEFAULT_STANDARD_MODEL;
  delete process.env.OMX_DEFAULT_SPARK_MODEL;
  delete process.env.OMX_SPARK_MODEL;
});

afterEach(() => {
  if (typeof originalFrontierEnv === 'string') {
    process.env.OMX_DEFAULT_FRONTIER_MODEL = originalFrontierEnv;
  } else {
    delete process.env.OMX_DEFAULT_FRONTIER_MODEL;
  }
  if (typeof originalStandardEnv === 'string') {
    process.env.OMX_DEFAULT_STANDARD_MODEL = originalStandardEnv;
  } else {
    delete process.env.OMX_DEFAULT_STANDARD_MODEL;
  }
  if (typeof originalSparkEnv === 'string') {
    process.env.OMX_DEFAULT_SPARK_MODEL = originalSparkEnv;
  } else {
    delete process.env.OMX_DEFAULT_SPARK_MODEL;
  }
  if (typeof originalLegacySparkEnv === 'string') {
    process.env.OMX_SPARK_MODEL = originalLegacySparkEnv;
  } else {
    delete process.env.OMX_SPARK_MODEL;
  }
  return Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))).then(
    () => undefined,
  );
});

describe('agents model table', () => {
  it('resolves frontier from config.toml, standard from environment, and spark from environment', () => {
    process.env.OMX_DEFAULT_FRONTIER_MODEL = 'frontier-env';
    process.env.OMX_DEFAULT_STANDARD_MODEL = 'standard-env';
    process.env.OMX_DEFAULT_SPARK_MODEL = 'spark-env';

    const context = resolveAgentsModelTableContext('model = "frontier-config"\n');

    assert.deepEqual(context, {
      frontierModel: 'frontier-config',
      sparkModel: 'spark-env',
      subagentDefaultModel: 'standard-env',
      agentModelOverrides: {},
    });
  });

  it('uses the configured frontier model as the standard subagent default when no standard override exists', () => {
    const context = resolveAgentsModelTableContext('model = "frontier-config"\n');

    assert.deepEqual(context, {
      frontierModel: 'frontier-config',
      sparkModel: 'gpt-5.3-codex-spark',
      subagentDefaultModel: 'frontier-config',
      agentModelOverrides: {},
    });
  });

  it('reads per-agent model overrides into table context', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'omx-agents-model-table-'));
    tempDirs.push(codexHome);
    await writeFile(join(codexHome, '.omx-config.json'), JSON.stringify({
      agentModels: {
        Architect: 'gpt-5.5',
      },
    }));

    const context = resolveAgentsModelTableContext('model = "frontier-config"\n', {
      codexHomeOverride: codexHome,
    });

    assert.equal(context.agentModelOverrides?.architect, 'gpt-5.5');
  });

  it('builds table rows for summary roles, exact pins, and posture/modelClass-driven recommendations', () => {
    const table = buildAgentsModelTable({
      frontierModel: 'gpt-frontier',
      sparkModel: 'gpt-spark',
      subagentDefaultModel: 'gpt-standard',
      agentModelOverrides: {},
    });

    assert.match(table, /\| Frontier \(leader\) \| `gpt-frontier` \| high \|/);
    assert.match(table, /\| Spark \(explorer\/fast\) \| `gpt-spark` \| low \|/);
    assert.match(table, /\| Standard \(subagent default\) \| `gpt-standard` \| high \|/);
    assert.match(table, /\| `explore` \| `gpt-spark` \| low \| Fast codebase search and file\/symbol mapping \(fast-lane, fast\) \|/);
    assert.match(table, /\| `planner` \| `gpt-5\.4-mini` \| high \| Task sequencing, execution plans, risk flags \(frontier-orchestrator, frontier\) \|/);
    assert.match(table, /\| `architect` \| `gpt-5\.4-mini` \| high \| System design, boundaries, interfaces, long-horizon tradeoffs \(frontier-orchestrator, frontier\) \|/);
    assert.doesNotMatch(table, /\| `security-reviewer` \|/);
    assert.doesNotMatch(table, /\| `build-fixer` \|/);
    assert.match(table, /\| `code-reviewer` \| `gpt-frontier` \| high \| Comprehensive review across all concerns \(frontier-orchestrator, frontier\) \|/);
    assert.match(table, /\| `critic` \| `gpt-frontier` \| high \| Plan\/design critical challenge and review \(frontier-orchestrator, frontier\) \|/);
    assert.match(table, /\| `writer` \| `gpt-standard` \| high \| Documentation, migration notes, user guidance \(fast-lane, standard\) \|/);
    assert.match(table, /\| `executor` \| `gpt-frontier` \| medium \| Code implementation, refactoring, feature work \(deep-worker, standard\) \|/);
  });

  it('applies per-agent model overrides in role rows', () => {
    const table = buildAgentsModelTable({
      frontierModel: 'gpt-frontier',
      sparkModel: 'gpt-spark',
      subagentDefaultModel: 'gpt-standard',
      agentModelOverrides: {
        architect: 'gpt-5.5',
        writer: 'gpt-writer',
      },
    });

    assert.match(table, /\| `architect` \| `gpt-5\.5` \| high \|/);
    assert.match(table, /\| `writer` \| `gpt-writer` \| high \|/);
    assert.doesNotMatch(table, /\| `architect` \| `gpt-5\.4-mini` \|/);
  });

  it('replaces existing marker-bounded content and inserts the block after team_model_resolution when missing', () => {
    const context = {
      frontierModel: 'gpt-frontier',
      sparkModel: 'gpt-spark',
      subagentDefaultModel: 'gpt-frontier',
      agentModelOverrides: {},
    };

    const withMarkers = [
      'before',
      OMX_MODELS_START_MARKER,
      'stale',
      OMX_MODELS_END_MARKER,
      'after',
    ].join('\n');
    const replaced = upsertAgentsModelTable(withMarkers, context);
    assert.match(replaced, /## Model Capability Table/);
    assert.doesNotMatch(replaced, /stale/);

    const withoutMarkers = [
      '<team_model_resolution>',
      'content',
      '</team_model_resolution>',
      '',
      '---',
      '',
      '<verification>',
    ].join('\n');
    const inserted = upsertAgentsModelTable(withoutMarkers, context);
    assert.match(
      inserted,
      /<\/team_model_resolution>\n\n<!-- OMX:MODELS:START -->[\s\S]*<!-- OMX:MODELS:END -->\n\n---/,
    );
  });
});
