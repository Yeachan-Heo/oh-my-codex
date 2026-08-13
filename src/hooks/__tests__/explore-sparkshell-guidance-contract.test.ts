import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { listTrackedAgentSurfaces, loadSurface } from './prompt-guidance-test-helpers.js';

function expectPatterns(path: string, patterns: RegExp[]): void {
  const content = loadSurface(path);
  for (const pattern of patterns) {
    assert.match(content, pattern, `${path} missing required pattern: ${pattern}`);
  }
}

describe('explore + sparkshell guidance contract', () => {
  it('keeps AGENTS root and template aligned on supported repository-lookup routing and opt-in sparkshell guidance without the removed explore command', () => {
    const requiredPatterns = [
      /normal Codex repository inspection/i,
      /omx sparkshell --tmux-pane/i,
      /explicit opt-?in/i,
      /When to use what/i,
    ];

    for (const surface of listTrackedAgentSurfaces()) {
      const content = loadSurface(surface);
      expectPatterns(surface, requiredPatterns);
      assert.doesNotMatch(content, /omx explore/i, `${surface} still references the removed omx explore command`);
      assert.doesNotMatch(content, /USE_OMX_EXPLORE_CMD/i, `${surface} still references the deprecated USE_OMX_EXPLORE_CMD override`);
    }
  });

  it('keeps explore surfaces explicit about richer-path fallback', () => {
    expectPatterns('prompts/explore.md', [
      /`omx explore --prompt \.\.\.` is deprecated/i,
      /compatibility-only/i,
      /richer normal path/i,
    ]);

    expectPatterns('prompts/explore-harness.md', [
      /simple read-only repository lookup tasks/i,
      /deprecated and compatibility-only/i,
      /richer normal path/i,
    ]);
  });

  it('keeps execution and planning surfaces explicit about deprecated explore routing', () => {
    // Slim role cards keep their role contract without repeating repository-routing prose.
    for (const surface of ['prompts/planner.md', 'prompts/executor.md']) {
      const content = loadSurface(surface);
      assert.doesNotMatch(content, /omx explore --prompt/i, `${surface} must not invoke the removed explore command`);
      assert.doesNotMatch(content, /USE_OMX_EXPLORE_CMD/i, `${surface} must not carry the removed explore override`);
    }

    expectPatterns('skills/plan/SKILL.md', [
      /omx explore.*deprecated/i,
      /normal repository inspection/i,
      /omx sparkshell/i,
    ]);
    assert.match(loadSurface('skills/ralph/SKILL.md'), /was removed/i);
    assert.match(loadSurface('skills/ralph/SKILL.md'), /\$ultragoal/i);
    const deepInterview = loadSurface('skills/deep-interview/SKILL.md');
    assert.match(deepInterview, /omx explore.*deprecated/i);
    assert.match(deepInterview, /normal repository inspection/i);
    assert.match(deepInterview, /omx sparkshell/i);
    assert.match(deepInterview, /Socratic deep interview/i);

    const ralplan = loadSurface('skills/ralplan/SKILL.md');
    assert.match(ralplan, /omx explore.*deprecated/i);
    assert.match(ralplan, /normal repository inspection/i);
    assert.match(ralplan, /omx sparkshell/i);
  });

  it('keeps QA evidence raw while Team remains a slim runtime card', () => {
    expectPatterns('prompts/qa-tester.md', [
      /optional operator aid/i,
      /does not replace raw `tmux capture-pane` evidence/i,
      /explicit opt-?in/i,
    ]);

    const teamSkill = loadSurface('skills/team/SKILL.md');
    assert.match(teamSkill, /tmux|Team state/i);
  });
});
