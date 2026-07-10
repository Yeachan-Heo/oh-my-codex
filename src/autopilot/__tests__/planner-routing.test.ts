import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getDefaultPlannerModel,
  isCheapOrMiniModelName,
  resolveAutopilotPlannerRouting,
} from '../planner-routing.js';

async function writeConfig(codexHome: string, config: Record<string, unknown>): Promise<void> {
  await writeFile(join(codexHome, '.omx-config.json'), JSON.stringify(config));
}

describe('autopilot planner routing', () => {
  let tempDir: string;
  let originalCodexHome: string | undefined;
  let originalFrontier: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'omx-autopilot-planner-routing-'));
    originalCodexHome = process.env.CODEX_HOME;
    originalFrontier = process.env.OMX_DEFAULT_FRONTIER_MODEL;
    process.env.CODEX_HOME = tempDir;
    delete process.env.OMX_DEFAULT_FRONTIER_MODEL;
  });

  afterEach(async () => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    if (originalFrontier === undefined) delete process.env.OMX_DEFAULT_FRONTIER_MODEL;
    else process.env.OMX_DEFAULT_FRONTIER_MODEL = originalFrontier;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('classifies canonical cheap lanes before generic cheap-or-mini tokens', () => {
    assert.equal(isCheapOrMiniModelName('gpt-5.6-terra'), true);
    assert.equal(isCheapOrMiniModelName('gpt-5.6-luna'), true);
    assert.equal(isCheapOrMiniModelName('gpt-5.6-sol'), false);
    assert.equal(isCheapOrMiniModelName('o4-mini'), true);
    assert.equal(isCheapOrMiniModelName('vendor/cheap-router'), true);
    assert.equal(isCheapOrMiniModelName('dominican-router'), false);
  });

  it('keeps planning on main when autopilot main is not cheap and no planner override exists', async () => {
    await writeConfig(tempDir, { models: { autopilot: 'gpt-5.6-sol' } });

    assert.deepEqual(resolveAutopilotPlannerRouting(tempDir), {
      owner: 'main',
      mainModel: 'gpt-5.6-sol',
      plannerModel: 'gpt-5.6-sol',
      reason: 'main_not_cheap_or_mini',
      explicitPlannerOverride: false,
    });
  });

  it('routes complex autopilot planning to planner when autopilot main is cheap or mini', async () => {
    await writeConfig(tempDir, { models: { autopilot: 'o4-mini' } });

    assert.deepEqual(resolveAutopilotPlannerRouting(tempDir), {
      owner: 'planner',
      mainModel: 'o4-mini',
      plannerModel: 'gpt-5.6-sol',
      reason: 'main_is_cheap_or_mini',
      explicitPlannerOverride: false,
    });
  });

  it('routes Autopilot planning to planner when its model is gpt-5.6-terra', async () => {
    await writeConfig(tempDir, { models: { autopilot: 'gpt-5.6-terra' } });

    const decision = resolveAutopilotPlannerRouting(tempDir);
    assert.equal(decision.owner, 'planner');
    assert.equal(decision.reason, 'main_is_cheap_or_mini');
  });

  it('lets agentModels.planner explicitly opt into dedicated planner ownership', async () => {
    await writeConfig(tempDir, {
      models: { autopilot: 'gpt-5.6-sol' },
      agentModels: { planner: 'gpt-5.6-sol-planner' },
    });

    assert.deepEqual(resolveAutopilotPlannerRouting(tempDir), {
      owner: 'planner',
      mainModel: 'gpt-5.6-sol',
      plannerModel: 'gpt-5.6-sol-planner',
      reason: 'explicit_planner_override',
      explicitPlannerOverride: true,
    });
    assert.equal(getDefaultPlannerModel(tempDir), 'gpt-5.6-sol-planner');
  });
});
