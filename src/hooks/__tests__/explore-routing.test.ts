import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExploreRoutingGuidance,
  isExploreCommandRoutingEnabled,
  isSimpleExplorationPrompt,
} from '../explore-routing.js';

describe('explore-routing', () => {
  it('defaults USE_OMX_EXPLORE_CMD to enabled and only disables explicit opt-out values', () => {
    assert.equal(isExploreCommandRoutingEnabled({}), true);
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

  it('builds advisory guidance whenever routing is not explicitly disabled', () => {
    const guidance = buildExploreRoutingGuidance({});
    assert.ok(
      guidance.startsWith('Syntax: omx explore --prompt "<prompt>" or omx explore --prompt-file <file>. Never use omx explore "<prompt>".'),
    );
    assert.match(guidance, /USE_OMX_EXPLORE_CMD/);
    assert.match(guidance, /default-on; opt out/i);
    assert.match(guidance, /agents SHOULD treat `omx explore` as the default first stop/i);
    assert.match(guidance, /use `omx explore` FIRST before attempting full code analysis/i);
    assert.match(guidance, /Explore examples:/);
    assert.match(guidance, /SparkShell examples:/);
    assert.match(guidance, /--prompt-file/);
    assert.match(guidance, /shell-only allowlisted read-only path/i);
    assert.match(guidance, /gracefully fall back to the normal path/i);
    assert.equal(buildExploreRoutingGuidance({ USE_OMX_EXPLORE_CMD: 'off' }), '');
  });
});
