import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
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

beforeEach(() => {
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
    });
  });

  it('builds table rows for summary roles and posture/modelClass-driven agent recommendations', () => {
    const table = buildAgentsModelTable({
      frontierModel: 'gpt-frontier',
      sparkModel: 'gpt-spark',
      subagentDefaultModel: 'gpt-standard',
    });

    assert.match(table, /\| Frontier \(leader\) \| `gpt-frontier` \| high \|/);
    assert.match(table, /\| Spark \(explorer\/fast\) \| `gpt-spark` \| low \|/);
    assert.match(table, /\| Standard \(subagent default\) \| `gpt-standard` \| high \|/);
    assert.match(table, /\| `explore` \| `gpt-spark` \| low \| Fast codebase search and file\/symbol mapping \(fast-lane, fast\) \|/);
    assert.match(table, /\| `architect` \| `gpt-frontier` \| high \| System design, boundaries, interfaces, long-horizon tradeoffs \(frontier-orchestrator, frontier\) \|/);
    assert.match(table, /\| `security-reviewer` \| `gpt-frontier` \| medium \| Vulnerabilities, trust boundaries, authn\/authz \(frontier-orchestrator, frontier\) \|/);
    assert.match(table, /\| `writer` \| `gpt-standard` \| high \| Documentation, migration notes, user guidance \(fast-lane, standard\) \|/);
    assert.match(table, /\| `executor` \| `gpt-frontier` \| medium \| Code implementation, refactoring, feature work \(deep-worker, standard\) \|/);
  });

  it('replaces existing marker-bounded content and inserts the block after team_model_resolution when missing', () => {
    const context = {
      frontierModel: 'gpt-frontier',
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
