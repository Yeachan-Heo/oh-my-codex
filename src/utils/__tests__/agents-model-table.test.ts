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
let isolatedCodexHome: string;

beforeEach(async () => {
  isolatedCodexHome = await mkdtemp(join(tmpdir(), 'omx-model-table-defaults-'));
  delete process.env.OMX_DEFAULT_FRONTIER_MODEL;
  delete process.env.OMX_DEFAULT_STANDARD_MODEL;
  delete process.env.OMX_DEFAULT_SPARK_MODEL;
  delete process.env.OMX_SPARK_MODEL;
});

afterEach(async () => {
  await rm(isolatedCodexHome, { recursive: true, force: true });
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
});

describe('agents model table', () => {
  it('resolves the leader from the config.toml root model and every agent tier from its env var', () => {
    process.env.OMX_DEFAULT_FRONTIER_MODEL = 'frontier-env';
    process.env.OMX_DEFAULT_STANDARD_MODEL = 'standard-env';
    process.env.OMX_DEFAULT_SPARK_MODEL = 'spark-env';

    const context = resolveAgentsModelTableContext('model = "root-config"\n', { codexHomeOverride: isolatedCodexHome });

    assert.deepEqual(context, {
      frontierModel: 'root-config',
      frontierAgentModel: 'frontier-env',
      sparkModel: 'spark-env',
      subagentDefaultModel: 'standard-env',
    });
  });

  it('falls back to the built-in tier defaults; the root model never feeds standard or spark', () => {
    const context = resolveAgentsModelTableContext('model = "root-config"\n', { codexHomeOverride: isolatedCodexHome });

    assert.deepEqual(context, {
      frontierModel: 'root-config',
      frontierAgentModel: 'gpt-6.2-astra',
      sparkModel: 'gpt-6-luna',
      subagentDefaultModel: 'gpt-6.2-sol',
    });
  });

  it('seeds the leader row with gpt-6.2-sol when config.toml has no root model', () => {
    const context = resolveAgentsModelTableContext('', { codexHomeOverride: isolatedCodexHome });
    assert.equal(context.frontierModel, 'gpt-6.2-sol');
  });

  it('builds table rows for summary roles and tier-driven role rows', () => {
    const table = buildAgentsModelTable({
      frontierModel: 'gpt-leader',
      frontierAgentModel: 'gpt-frontier',
      sparkModel: 'gpt-spark',
      subagentDefaultModel: 'gpt-standard',
    }, undefined, { codexHomeOverride: isolatedCodexHome });

    assert.match(table, /\| Role \| Tier \| Model \| Reasoning Effort \| Use Case \|/);
    assert.match(table, /\| Leader\/main session \| config\.toml root \| `gpt-leader` \| high \| Primary leader\/orchestrator for planning, coordination, and delegation\. \|/);
    assert.doesNotMatch(table, /Spark \(explorer\/fast\)|Standard \(subagent default\)/);
    assert.match(table, /\| `explore` \| spark \| `gpt-spark` \| medium \| Fast codebase search and file\/symbol mapping \(fast-lane\) \|/);
    assert.match(table, /\| `planner` \| frontier \| `gpt-frontier` \| medium \| Task sequencing, execution plans, risk flags \(frontier-orchestrator\) \|/);
    assert.match(table, /\| `architect` \| frontier \| `gpt-frontier` \| xhigh \| System design, boundaries, interfaces, long-horizon tradeoffs \(frontier-orchestrator\) \|/);
    assert.match(table, /\| `critic` \| frontier \| `gpt-frontier` \| high \| Plan\/design critical challenge and review \(frontier-orchestrator\) \|/);
    assert.match(table, /\| `researcher` \| standard \| `gpt-standard` \| high \|/);
    assert.match(table, /\| `code-reviewer` \| standard \| `gpt-standard` \| high \| Comprehensive review across all concerns \(frontier-orchestrator\) \|/);
    assert.match(table, /\| `writer` \| standard \| `gpt-standard` \| high \| Documentation, migration notes, user guidance \(fast-lane\) \|/);
    assert.match(table, /\| `executor` \| standard \| `gpt-standard` \| medium \| Code implementation, refactoring, feature work \(deep-worker\) \|/);
    assert.match(table, /\| `vision` \| spark \| `gpt-spark` \| low \|/);
    assert.match(table, /Precedence per role: `\.omx-config\.json` `agentModels\[role\]` > tier env var/);
  });

  it('matches the built-in tier table with no env set and a different root model', () => {
    const context = resolveAgentsModelTableContext('model = "root-config"\n', { codexHomeOverride: isolatedCodexHome });
    const table = buildAgentsModelTable(context, undefined, { codexHomeOverride: isolatedCodexHome });

    assert.match(table, /\| Leader\/main session \| config\.toml root \| `root-config` \| high \|/);
    for (const role of ['planner', 'architect', 'critic']) {
      assert.match(table, new RegExp(`\\| \`${role}\` \\| frontier \\| \`gpt-6\\.2-astra\` \\|`));
    }
    for (const role of ['researcher', 'analyst', 'test-engineer', 'code-reviewer', 'code-simplifier', 'team-executor', 'executor']) {
      assert.match(table, new RegExp(`\\| \`${role}\` \\| standard \\| \`gpt-6\\.2-sol\` \\|`));
    }
    for (const role of ['explore', 'vision']) {
      assert.match(table, new RegExp(`\\| \`${role}\` \\| spark \\| \`gpt-6-luna\` \\|`));
    }
  });

  it('applies each tier env var to its own roles only, over a different root model', () => {
    process.env.OMX_DEFAULT_FRONTIER_MODEL = 'frontier-env';
    process.env.OMX_DEFAULT_STANDARD_MODEL = 'standard-env';
    process.env.OMX_DEFAULT_SPARK_MODEL = 'spark-env';
    const context = resolveAgentsModelTableContext('model = "root-config"\n', { codexHomeOverride: isolatedCodexHome });
    const table = buildAgentsModelTable(context, undefined, { codexHomeOverride: isolatedCodexHome });

    assert.match(table, /\| Leader\/main session \| config\.toml root \| `root-config` \| high \|/);
    assert.match(table, /\| `planner` \| frontier \| `frontier-env` \| medium \|/);
    assert.match(table, /\| `critic` \| frontier \| `frontier-env` \| high \|/);
    assert.match(table, /\| `researcher` \| standard \| `standard-env` \| high \|/);
    assert.match(table, /\| `executor` \| standard \| `standard-env` \| medium \|/);
    assert.match(table, /\| `code-reviewer` \| standard \| `standard-env` \| high \|/);
    assert.match(table, /\| `vision` \| spark \| `spark-env` \| low \|/);
  });

  it('orders rows leader first, then frontier, standard, and spark roles', () => {
    const context = resolveAgentsModelTableContext('', { codexHomeOverride: isolatedCodexHome });
    const table = buildAgentsModelTable(context, undefined, { codexHomeOverride: isolatedCodexHome });
    const labels = table
      .split('\n')
      .filter((line) => line.startsWith('| ') && !line.startsWith('| Role') && !line.startsWith('| ---'))
      .map((line) => line.split('|')[1].trim().replace(/`/g, ''));
    const index = (role: string) => labels.indexOf(role);

    assert.equal(labels[0], 'Leader/main session');
    assert.deepEqual(labels.slice(1, 4), ['planner', 'architect', 'critic']);
    const lastFrontier = index('critic');
    const standardIdx = ['researcher', 'executor', 'writer'].map(index);
    const sparkIdx = ['explore', 'vision'].map(index);
    assert.ok(standardIdx.every((i) => i > lastFrontier));
    assert.ok(sparkIdx.every((i) => i > Math.max(...standardIdx)));
  });

  it('reflects per-agent model and reasoning overrides', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'omx-agents-model-table-'));
    try {
      await writeFile(join(codexHome, '.omx-config.json'), JSON.stringify({
        agentModels: {
          architect: 'gpt-5.6-sol-architect',
          explore: 'gpt-5.6-sol-explore',
        },
        agentReasoning: {
          architect: 'xhigh',
          explore: 'medium',
        },
      }));

      const table = buildAgentsModelTable({
        frontierModel: 'gpt-frontier',
        frontierAgentModel: 'gpt-frontier',
        sparkModel: 'gpt-spark',
        subagentDefaultModel: 'gpt-standard',
      }, undefined, { codexHomeOverride: codexHome });

      assert.match(table, /\| `architect` \| frontier \| `gpt-5\.6-sol-architect` \| xhigh \|/);
      assert.match(table, /\| `explore` \| spark \| `gpt-5\.6-sol-explore` \| medium \|/);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('replaces existing marker-bounded content and inserts the block after team_model_resolution when missing', () => {
    const context = {
      frontierModel: 'gpt-frontier',
      frontierAgentModel: 'gpt-frontier',
      sparkModel: 'gpt-spark',
      subagentDefaultModel: 'gpt-frontier',
    };

    const withMarkers = [
      'before',
      OMX_MODELS_START_MARKER,
      'stale',
      OMX_MODELS_END_MARKER,
      'after',
    ].join('\n');
    const replaced = upsertAgentsModelTable(withMarkers, context, undefined, { codexHomeOverride: isolatedCodexHome });
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
    const inserted = upsertAgentsModelTable(withoutMarkers, context, undefined, { codexHomeOverride: isolatedCodexHome });
    assert.match(
      inserted,
      /<\/team_model_resolution>\n\n<!-- OMX:MODELS:START -->[\s\S]*<!-- OMX:MODELS:END -->\n\n---/,
    );
  });
});
