import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { routeModel, summarizeSpend, type RouterConfig } from '../model/router.js';

const CFG: RouterConfig = {
  oss: { providerId: 'groq:qwen-3' },
  frontier: { providerId: 'anthropic:sonnet-4-6' },
  escalateMechanicalAfter: 2,
};

describe('bumpkin/model-router', () => {
  it('routes upgrade-planner to frontier', () => {
    const d = routeModel({ role: 'upgrade-planner' }, CFG);
    assert.equal(d.tier, 'frontier');
    assert.equal(d.providerId, 'anthropic:sonnet-4-6');
  });

  it('routes llm-reviewer to frontier regardless of failure count', () => {
    const d = routeModel({ role: 'llm-reviewer', failureCount: 0 }, CFG);
    assert.equal(d.tier, 'frontier');
  });

  it('routes mechanical fixer to OSS on first attempt', () => {
    const d = routeModel({ role: 'breakage-fixer-mechanical', failureCount: 0 }, CFG);
    assert.equal(d.tier, 'oss');
    assert.equal(d.providerId, 'groq:qwen-3');
  });

  it('routes mechanical fixer to OSS on retry within threshold', () => {
    const d = routeModel({ role: 'breakage-fixer-mechanical', failureCount: 1 }, CFG);
    assert.equal(d.tier, 'oss');
  });

  it('escalates mechanical fixer to frontier at threshold', () => {
    const d = routeModel({ role: 'breakage-fixer-mechanical', failureCount: 2 }, CFG);
    assert.equal(d.tier, 'frontier');
    assert.match(d.reason, /escalated after 2/);
  });

  it('routes reasoning fixer always to frontier', () => {
    const d = routeModel({ role: 'breakage-fixer-reasoning', failureCount: 0 }, CFG);
    assert.equal(d.tier, 'frontier');
  });

  it('routes test-validator and release-notes-reader to OSS', () => {
    assert.equal(routeModel({ role: 'test-validator' }, CFG).tier, 'oss');
    assert.equal(routeModel({ role: 'release-notes-reader' }, CFG).tier, 'oss');
  });

  it('forces frontier when repo is marked safety-critical', () => {
    const d = routeModel(
      { role: 'breakage-fixer-mechanical', failureCount: 0, repoSafetyCritical: true },
      CFG,
    );
    assert.equal(d.tier, 'frontier');
    assert.match(d.reason, /safety-critical/);
  });

  it('summarizeSpend computes oss share correctly', () => {
    const s = summarizeSpend([
      { tier: 'oss', tokens: 700 },
      { tier: 'frontier', tokens: 300 },
    ]);
    assert.equal(s.ossTokens, 700);
    assert.equal(s.frontierTokens, 300);
    assert.equal(s.ossShare, 0.7);
  });

  it('summarizeSpend handles empty entries', () => {
    const s = summarizeSpend([]);
    assert.equal(s.ossShare, 0);
  });
});
