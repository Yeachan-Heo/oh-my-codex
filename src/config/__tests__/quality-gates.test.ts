import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import { mkdtemp, rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import {
  validateSkillName,
  readQualityGatesConfig,
  getGatesForStage,
  validateAllQualityGates,
  type QualityGatesConfig,
} from '../quality-gates.js';

const mkdtempAsync = promisify(mkdtemp);

describe('quality gates config', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtempAsync(join(tmpdir(), 'omx-quality-gates-'));
  });

  afterEach(async () => {
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('validateSkillName', () => {
    it('accepts valid kebab-case skill names', () => {
      const validSkills = ['my-custom-gate', 'foo-bar-baz', 'test123', 'analysis-check', 'my-review-v2'];
      for (const skill of validSkills) {
        const result = validateSkillName(skill);
        assert.strictEqual(result.valid, true, `Expected "${skill}" to be valid`);
      }
    });

    it('accepts skill names with $ prefix', () => {
      const validSkills = ['$my-custom-skill', '$analyze', '$ask'];
      for (const skill of validSkills) {
        const result = validateSkillName(skill);
        assert.strictEqual(result.valid, true, `Expected "${skill}" to be valid`);
      }
    });

    it('rejects non-kebab-case skill names', () => {
      const invalidSkills = ['MySkill', 'my_skill', 'my skill', 'my.skill', '-my-skill', 'my-skill-'];
      for (const skill of invalidSkills) {
        const result = validateSkillName(skill);
        assert.strictEqual(result.valid, false, `Expected "${skill}" to be invalid`);
        assert.ok(result.error, `Expected error message for "${skill}"`);
      }
    });

    it('rejects reserved skill names', () => {
      const reserved = ['deep-interview', 'code-review', 'verification', 'ai-slop-cleaner'];
      for (const skill of reserved) {
        const result = validateSkillName(skill);
        assert.strictEqual(result.valid, false, `Expected "${skill}" to be reserved`);
        assert.match(result.error!, /reserved/i);
      }
    });

    it('rejects sunset skill names from sunset-stub', () => {
      // These are from REMOVED_SKILLS in sunset-stub.ts
      const sunsetSkills = ['ask-claude', 'deepsearch', 'ecomode', 'ralph'];
      for (const skill of sunsetSkills) {
        const result = validateSkillName(skill);
        assert.strictEqual(result.valid, false, `Expected "${skill}" to be sunset`);
        assert.match(result.error!, /deprecated|sunset/i);
      }
    });

    it('rejects empty or non-string skill names', () => {
      const result1 = validateSkillName('');
      assert.strictEqual(result1.valid, false);

      const result2 = validateSkillName(null as unknown as string);
      assert.strictEqual(result2.valid, false);
    });
  });

  describe('readQualityGatesConfig', () => {
    it('returns null for missing config file', () => {
      const result = readQualityGatesConfig(testDir);
      assert.strictEqual(result, null);
    });

    it('reads valid config file with minimal schema', () => {
      const config: QualityGatesConfig = {
        'deep-interview': ['my-interview-gate'],
        'ralplan': ['my-plan-gate'],
        'code-review': ['my-review-gate'],
      };
      writeFileSync(
        join(testDir, '.omx-config.json'),
        JSON.stringify({ qualityGates: config }, null, 2),
      );

      const result = readQualityGatesConfig(testDir);
      assert.deepStrictEqual(result, config);
    });

    it('returns null for invalid config file', () => {
      writeFileSync(join(testDir, '.omx-config.json'), 'invalid json');
      const result = readQualityGatesConfig(testDir);
      assert.strictEqual(result, null);
    });

    it('returns null when qualityGates is missing', () => {
      writeFileSync(
        join(testDir, '.omx-config.json'),
        JSON.stringify({ otherConfig: {} }, null, 2),
      );
      const result = readQualityGatesConfig(testDir);
      assert.strictEqual(result, null);
    });
  });

  describe('getGatesForStage', () => {
    it('returns gates for the specified stage', () => {
      const config: QualityGatesConfig = {
        'deep-interview': ['interview-gate'],
        'ralplan': ['plan-gate'],
        'code-review': ['review-gate'],
      };
      writeFileSync(
        join(testDir, '.omx-config.json'),
        JSON.stringify({ qualityGates: config }, null, 2),
      );

      const interviewGates = getGatesForStage('deep-interview', testDir);
      assert.deepStrictEqual(interviewGates, ['interview-gate']);

      const planGates = getGatesForStage('ralplan', testDir);
      assert.deepStrictEqual(planGates, ['plan-gate']);

      const reviewGates = getGatesForStage('code-review', testDir);
      assert.deepStrictEqual(reviewGates, ['review-gate']);
    });

    it('returns empty array for missing stage', () => {
      const config: QualityGatesConfig = {
        'deep-interview': ['interview-gate'],
      };
      writeFileSync(
        join(testDir, '.omx-config.json'),
        JSON.stringify({ qualityGates: config }, null, 2),
      );

      const planGates = getGatesForStage('ralplan', testDir);
      assert.deepStrictEqual(planGates, []);
    });

    it('filters out invalid skill names', () => {
      const config: QualityGatesConfig = {
        'ralplan': ['valid-gate', 'MyInvalidGate', 'deep-interview'],
      };
      writeFileSync(
        join(testDir, '.omx-config.json'),
        JSON.stringify({ qualityGates: config }, null, 2),
      );

      const gates = getGatesForStage('ralplan', testDir);
      // Only valid-gate should be returned; MyInvalidGate is not kebab-case; deep-interview is reserved
      assert.deepStrictEqual(gates, ['valid-gate']);
    });
  });

  describe('validateAllQualityGates', () => {
    it('validates gates across all stages', () => {
      const config: QualityGatesConfig = {
        'deep-interview': ['interview-gate'],
        'ralplan': ['plan-gate'],
        'code-review': ['review-gate'],
      };
      writeFileSync(
        join(testDir, '.omx-config.json'),
        JSON.stringify({ qualityGates: config }, null, 2),
      );

      const result = validateAllQualityGates(testDir);
      assert.strictEqual(result.gates.length, 3);
      assert.strictEqual(result.errors.length, 0);
    });

    it('collects validation errors across stages', () => {
      const config: QualityGatesConfig = {
        'deep-interview': ['valid-gate'],
        'ralplan': ['MyInvalidGate', 'deep-interview'],
        'code-review': ['another-valid-gate'],
      };
      writeFileSync(
        join(testDir, '.omx-config.json'),
        JSON.stringify({ qualityGates: config }, null, 2),
      );

      const result = validateAllQualityGates(testDir);
      assert.strictEqual(result.gates.length, 2);
      assert.strictEqual(result.errors.length, 2);
      assert.ok(result.errors.some(e => e.skill === 'MyInvalidGate'));
      assert.ok(result.errors.some(e => e.skill === 'deep-interview'));
    });

    it('handles non-string gate entries', () => {
      const config = {
        'ralplan': ['valid-gate', 123, null, { skill: 'object-gate' }],
      };
      writeFileSync(
        join(testDir, '.omx-config.json'),
        JSON.stringify({ qualityGates: config }, null, 2),
      );

      const result = validateAllQualityGates(testDir);
      assert.strictEqual(result.gates.length, 1);
      assert.strictEqual(result.gates[0], 'valid-gate');
      assert.strictEqual(result.errors.length, 3);
    });
  });
});
