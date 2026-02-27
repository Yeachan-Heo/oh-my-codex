import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyTaskSize,
  countWords,
  detectEscapeHatch,
  hasSmallTaskSignals,
  hasLargeTaskSignals,
  isHeavyMode,
  HEAVY_MODE_KEYWORDS,
  DEFAULT_THRESHOLDS,
} from '../task-size-detector.js';

describe('task-size-detector', () => {
  describe('countWords', () => {
    it('counts words correctly', () => {
      assert.equal(countWords('hello world'), 2);
    });

    it('handles leading/trailing whitespace', () => {
      assert.equal(countWords('  hello world  '), 2);
    });

    it('handles multiple spaces between words', () => {
      assert.equal(countWords('hello   world'), 2);
    });

    it('handles empty string', () => {
      assert.equal(countWords(''), 0);
    });

    it('handles single word', () => {
      assert.equal(countWords('hello'), 1);
    });

    it('handles newlines and tabs', () => {
      assert.equal(countWords('hello\nworld\ttab'), 3);
    });
  });

  describe('detectEscapeHatch', () => {
    it('detects quick: prefix', () => {
      assert.equal(detectEscapeHatch('quick: fix the typo'), 'quick:');
    });

    it('detects simple: prefix', () => {
      assert.equal(detectEscapeHatch('simple: rename the variable'), 'simple:');
    });

    it('detects tiny: prefix', () => {
      assert.equal(detectEscapeHatch('tiny: add a comment'), 'tiny:');
    });

    it('detects minor: prefix', () => {
      assert.equal(detectEscapeHatch('minor: update README'), 'minor:');
    });

    it('detects small: prefix', () => {
      assert.equal(detectEscapeHatch('small: fix lint warning'), 'small:');
    });

    it('detects just: prefix', () => {
      assert.equal(detectEscapeHatch('just: update the version number'), 'just:');
    });

    it('detects only: prefix', () => {
      assert.equal(detectEscapeHatch('only: add a missing semicolon'), 'only:');
    });

    it('is case-insensitive', () => {
      assert.equal(detectEscapeHatch('Quick: fix this'), 'quick:');
      assert.equal(detectEscapeHatch('SIMPLE: rename'), 'simple:');
    });

    it('returns null when no escape hatch', () => {
      assert.equal(detectEscapeHatch('fix the authentication bug'), null);
    });

    it('returns null for partial prefix match', () => {
      assert.equal(detectEscapeHatch('quickly fix the bug'), null);
    });

    it('returns null for empty string', () => {
      assert.equal(detectEscapeHatch(''), null);
    });
  });

  describe('hasSmallTaskSignals', () => {
    it('detects typo signal', () => {
      assert.equal(hasSmallTaskSignals('fix the typo in README'), true);
    });

    it('detects spelling signal', () => {
      assert.equal(hasSmallTaskSignals('fix spelling error'), true);
    });

    it('detects rename signal', () => {
      assert.equal(hasSmallTaskSignals('rename foo to bar'), true);
    });

    it('detects single file signal', () => {
      assert.equal(hasSmallTaskSignals('change this in single file'), true);
    });

    it('detects "in this file" signal', () => {
      assert.equal(hasSmallTaskSignals('update the config in this file'), true);
    });

    it('detects "this function" signal', () => {
      assert.equal(hasSmallTaskSignals('fix this function to return null'), true);
    });

    it('detects minor fix signal', () => {
      assert.equal(hasSmallTaskSignals('minor fix needed in the handler'), true);
    });

    it('detects quick fix signal', () => {
      assert.equal(hasSmallTaskSignals('quick fix for the login bug'), true);
    });

    it('detects whitespace signal', () => {
      assert.equal(hasSmallTaskSignals('remove extra whitespace'), true);
    });

    it('detects indentation signal', () => {
      assert.equal(hasSmallTaskSignals('fix indentation in the block'), true);
    });

    it('detects add comment signal', () => {
      assert.equal(hasSmallTaskSignals('add a comment to this block'), true);
    });

    it('detects bump version signal', () => {
      assert.equal(hasSmallTaskSignals('bump version to 2.0.0'), true);
    });

    it('returns false for regular task', () => {
      assert.equal(hasSmallTaskSignals('implement user authentication flow'), false);
    });

    it('returns false for empty string', () => {
      assert.equal(hasSmallTaskSignals(''), false);
    });
  });

  describe('hasLargeTaskSignals', () => {
    it('detects architecture signal', () => {
      assert.equal(hasLargeTaskSignals('redesign the architecture of the auth system'), true);
    });

    it('detects refactor signal', () => {
      assert.equal(hasLargeTaskSignals('refactor the entire module'), true);
    });

    it('detects redesign signal', () => {
      assert.equal(hasLargeTaskSignals('redesign the API layer'), true);
    });

    it('detects "entire codebase" signal', () => {
      assert.equal(hasLargeTaskSignals('update imports across the entire codebase'), true);
    });

    it('detects "all files" signal', () => {
      assert.equal(hasLargeTaskSignals('update all files to use ESM'), true);
    });

    it('detects "multiple files" signal', () => {
      assert.equal(hasLargeTaskSignals('change imports across multiple files'), true);
    });

    it('detects migration signal', () => {
      assert.equal(hasLargeTaskSignals('migrate the database schema'), true);
    });

    it('detects "from scratch" signal', () => {
      assert.equal(hasLargeTaskSignals('rewrite the parser from scratch'), true);
    });

    it('detects "end-to-end" signal', () => {
      assert.equal(hasLargeTaskSignals('implement end-to-end testing'), true);
    });

    it('detects overhaul signal', () => {
      assert.equal(hasLargeTaskSignals('overhaul the permissions system'), true);
    });

    it('detects comprehensive signal', () => {
      assert.equal(hasLargeTaskSignals('do a comprehensive review'), true);
    });

    it('returns false for small task', () => {
      assert.equal(hasLargeTaskSignals('fix the typo'), false);
    });

    it('returns false for medium task', () => {
      assert.equal(hasLargeTaskSignals('add error handling to the login handler'), false);
    });

    it('returns false for empty string', () => {
      assert.equal(hasLargeTaskSignals(''), false);
    });
  });

  describe('classifyTaskSize', () => {
    describe('escape hatch detection', () => {
      it('classifies as small when quick: prefix present', () => {
        const result = classifyTaskSize('quick: refactor the entire auth system');
        assert.equal(result.size, 'small');
        assert.equal(result.hasEscapeHatch, true);
        assert.equal(result.escapePrefixUsed, 'quick:');
      });

      it('classifies as small for simple: prefix even with large signals', () => {
        const result = classifyTaskSize('simple: redesign the entire architecture');
        assert.equal(result.size, 'small');
        assert.equal(result.hasEscapeHatch, true);
      });

      it('includes the escape prefix in result', () => {
        const result = classifyTaskSize('tiny: fix the return type');
        assert.equal(result.escapePrefixUsed, 'tiny:');
      });
    });

    describe('small task classification', () => {
      it('classifies short prompt as small', () => {
        const result = classifyTaskSize('Fix the typo in the README.');
        assert.equal(result.size, 'small');
      });

      it('classifies prompt with small signals as small', () => {
        const result = classifyTaskSize('Rename the getUserById function to fetchUserById in this file');
        assert.equal(result.size, 'small');
      });

      it('classifies typo fix as small', () => {
        const result = classifyTaskSize('fix a typo in the login error message');
        assert.equal(result.size, 'small');
      });

      it('classifies minor change as small', () => {
        const result = classifyTaskSize('minor fix: update the comment in the validator');
        assert.equal(result.size, 'small');
      });

      it('includes word count in result', () => {
        const result = classifyTaskSize('fix typo');
        assert.equal(result.wordCount, 2);
      });

      it('hasEscapeHatch is false for organic small task', () => {
        const result = classifyTaskSize('fix the typo');
        assert.equal(result.hasEscapeHatch, false);
      });
    });

    describe('large task classification', () => {
      it('classifies prompt with large signals as large', () => {
        const result = classifyTaskSize(
          'Refactor the authentication module to support OAuth2 and clean up the token management'
        );
        assert.equal(result.size, 'large');
      });

      it('classifies very long prompt as large', () => {
        const longPrompt = Array(250).fill('word').join(' ');
        const result = classifyTaskSize(longPrompt);
        assert.equal(result.size, 'large');
      });

      it('classifies "entire codebase" task as large', () => {
        const result = classifyTaskSize('Update all imports across the entire codebase to use path aliases');
        assert.equal(result.size, 'large');
      });

      it('classifies migration as large even if short', () => {
        const text = 'migrate the database schema to the new format using the updated ORM models and fix related tests';
        const result = classifyTaskSize(text);
        assert.equal(result.size, 'large');
      });
    });

    describe('medium task classification', () => {
      it('classifies medium-length prompt with no special signals as medium', () => {
        const words = Array(80).fill('word').join(' ');
        const result = classifyTaskSize(`Add error handling to the login handler. ${words}`);
        assert.equal(result.size, 'medium');
      });

      it('returns medium when between limits and no signals', () => {
        const text = Array(75).fill('update').join(' ');
        const result = classifyTaskSize(text);
        assert.equal(result.size, 'medium');
      });
    });

    describe('custom thresholds', () => {
      it('uses custom smallWordLimit', () => {
        const result = classifyTaskSize('word '.repeat(30).trim(), {
          smallWordLimit: 100,
          largeWordLimit: 200,
        });
        assert.equal(result.size, 'small');
      });

      it('uses custom largeWordLimit', () => {
        const result = classifyTaskSize('word '.repeat(60).trim(), {
          smallWordLimit: 10,
          largeWordLimit: 50,
        });
        assert.equal(result.size, 'large');
      });
    });

    describe('reason field', () => {
      it('includes reason for escape hatch', () => {
        const result = classifyTaskSize('quick: fix this');
        assert.ok(result.reason.includes('quick:'));
      });

      it('includes reason for large signals', () => {
        const result = classifyTaskSize(
          'Refactor the entire architecture of the application including all modules and cross-cutting concerns to support microservices'
        );
        assert.ok(result.reason.toLowerCase().includes('large'));
      });

      it('includes word count in reason for word-count-based decisions', () => {
        const shortText = 'fix the bug';
        const result = classifyTaskSize(shortText);
        assert.ok(result.reason.includes(String(result.wordCount)));
      });
    });
  });

  describe('isHeavyMode', () => {
    it('returns true for ralph', () => {
      assert.equal(isHeavyMode('ralph'), true);
    });

    it('returns true for autopilot', () => {
      assert.equal(isHeavyMode('autopilot'), true);
    });

    it('returns true for team', () => {
      assert.equal(isHeavyMode('team'), true);
    });

    it('returns true for ultrawork', () => {
      assert.equal(isHeavyMode('ultrawork'), true);
    });

    it('returns true for swarm', () => {
      assert.equal(isHeavyMode('swarm'), true);
    });

    it('returns true for ralplan', () => {
      assert.equal(isHeavyMode('ralplan'), true);
    });

    it('returns true for ccg', () => {
      assert.equal(isHeavyMode('ccg'), true);
    });

    it('returns false for cancel', () => {
      assert.equal(isHeavyMode('cancel'), false);
    });

    it('returns false for plan', () => {
      assert.equal(isHeavyMode('plan'), false);
    });

    it('returns false for tdd', () => {
      assert.equal(isHeavyMode('tdd'), false);
    });

    it('returns false for ultrathink', () => {
      assert.equal(isHeavyMode('ultrathink'), false);
    });

    it('returns false for deepsearch', () => {
      assert.equal(isHeavyMode('deepsearch'), false);
    });

    it('returns false for analyze', () => {
      assert.equal(isHeavyMode('analyze'), false);
    });

    it('returns false for codex', () => {
      assert.equal(isHeavyMode('codex'), false);
    });

    it('returns false for gemini', () => {
      assert.equal(isHeavyMode('gemini'), false);
    });

    it('returns false for unknown keyword', () => {
      assert.equal(isHeavyMode('unknown-mode'), false);
    });
  });

  describe('HEAVY_MODE_KEYWORDS set', () => {
    it('contains expected heavy modes', () => {
      const expected = ['ralph', 'autopilot', 'team', 'ultrawork', 'swarm', 'ralplan', 'ccg'];
      for (const mode of expected) {
        assert.ok(HEAVY_MODE_KEYWORDS.has(mode), `Expected HEAVY_MODE_KEYWORDS to contain "${mode}"`);
      }
    });

    it('does not contain lightweight modes', () => {
      const lightweight = ['cancel', 'plan', 'tdd', 'ultrathink', 'deepsearch', 'analyze', 'codex', 'gemini'];
      for (const mode of lightweight) {
        assert.ok(!HEAVY_MODE_KEYWORDS.has(mode), `Expected HEAVY_MODE_KEYWORDS NOT to contain "${mode}"`);
      }
    });
  });

  describe('DEFAULT_THRESHOLDS', () => {
    it('has smallWordLimit of 50', () => {
      assert.equal(DEFAULT_THRESHOLDS.smallWordLimit, 50);
    });

    it('has largeWordLimit of 200', () => {
      assert.equal(DEFAULT_THRESHOLDS.largeWordLimit, 200);
    });
  });
});
