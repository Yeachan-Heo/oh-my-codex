import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { loadSurface } from './prompt-guidance-test-helpers.js';

for (const surface of ['AGENTS.md', 'templates/AGENTS.md']) {
  describe(`${surface} team-vs-non-team routing guardrails`, () => {
    it('routes non-team implementation work to executor instead of worker', () => {
      assert.match(
        loadSurface(surface),
        /Outside active `team`\/`swarm` mode, use `executor`.*do not invoke `worker`/i,
      );
    });

    it('reserves worker for active team sessions', () => {
      assert.match(
        loadSurface(surface),
        /Reserve `worker` strictly for active `team`\/`swarm` sessions/i,
      );
      assert.match(
        loadSurface(surface),
        /`worker` is a team-runtime surface, not a general-purpose child role/i,
      );
    });
  });
}
