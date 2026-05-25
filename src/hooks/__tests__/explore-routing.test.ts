import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExploreRoutingGuidance,
  isExploreCommandRoutingEnabled,
  isSimpleExplorationPrompt,
} from '../explore-routing.js';

describe('explore-routing', () => {
  it('defaults USE_OMX_EXPLORE_CMD to disabled compatibility mode and honors explicit values', () => {
    assert.equal(isExploreCommandRoutingEnabled({}), false);
    assert.equal(isExploreCommandRoutingEnabled({ USE_OMX_EXPLORE_CMD: '1' }), true);
    assert.equal(isExploreCommandRoutingEnabled({ USE_OMX_EXPLORE_CMD: 'true' }), true);
    assert.equal(isExploreCommandRoutingEnabled({ USE_OMX_EXPLORE_CMD: 'yes' }), true);
    assert.equal(isExploreCommandRoutingEnabled({ USE_OMX_EXPLORE_CMD: 'on' }), true);
    assert.equal(isExploreCommandRoutingEnabled({ USE_OMX_EXPLORE_CMD: '0' }), false);
    assert.equal(isExploreCommandRoutingEnabled({ USE_OMX_EXPLORE_CMD: 'false' }), false);
    assert.equal(isExploreCommandRoutingEnabled({ USE_OMX_EXPLORE_CMD: 'no' }), false);
    assert.equal(isExploreCommandRoutingEnabled({ USE_OMX_EXPLORE_CMD: 'off' }), false);
  });

  it('detects simple exploration prompts', () => {
    assert.equal(isSimpleExplorationPrompt('find where auth is implemented'), true);
    assert.equal(isSimpleExplorationPrompt('which files contain keyword-detector'), true);
    assert.equal(isSimpleExplorationPrompt('map the relationship between team runtime and tmux session helpers'), true);
    assert.equal(isSimpleExplorationPrompt('look up which symbols use resolveCliInvocation'), true);
  });

  it('rejects implementation-heavy or ambiguous prompts', () => {
    assert.equal(isSimpleExplorationPrompt('implement auth fallback and add tests'), false);
    assert.equal(isSimpleExplorationPrompt('refactor the team runtime'), false);
    assert.equal(isSimpleExplorationPrompt('build a new routing system'), false);
    assert.equal(isSimpleExplorationPrompt('help with the routing bug'), false);
    assert.equal(isSimpleExplorationPrompt('investigate everything in this repo'), false);
  });

  it('builds deprecation guidance and never recommends explore for new work', () => {
    const guidance = buildExploreRoutingGuidance({});
    assert.ok(guidance.startsWith('**Explore Command Deprecated:**'));
    assert.match(guidance, /USE_OMX_EXPLORE_CMD/);
    assert.match(guidance, /compatibility-only/i);
    assert.match(guidance, /MUST NOT be recommended/i);
    assert.match(guidance, /normal Codex repository inspection/i);
    assert.match(guidance, /omx sparkshell -- <command>/);
    assert.match(guidance, /do not route simple lookups to `omx explore`/i);
    assert.match(buildExploreRoutingGuidance({ USE_OMX_EXPLORE_CMD: '1' }), /explicitly enabled.*still prefer the replacement path/is);
  });
});
