import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import { mkdtemp, rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import {
  validateSkillName,
  validateQualityGate,
  readQualityGatesConfig,
  readValidatedQualityGates,
  getGatesForStage,
  getAdvisoryGatesForStage,
  getBlockingGatesForStage,
  validateAllQualityGates,
  type QualityGate,
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

  describe('validateQualityGate', () => {
    const validGate: QualityGate = {
      skill: 'my-custom-skill',
      mode: 'advisory',
    };

    it('accepts valid quality gate', () => {
      const result = validateQualityGate(validGate);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
    });

    it('accepts gate with optional model', () => {
      const gate: QualityGate = {
        ...validGate,
        model: 'gpt-6-astra',
      };
      const result = validateQualityGate(gate);
      assert.strictEqual(result.valid, true);
    });

    it('accepts blocking gate', () => {
      const gate: QualityGate = {
        skill: 'my-blocking-gate',
        mode: 'blocking',
      };
      const result = validateQualityGate(gate);
      assert.strictEqual(result.valid, true);
    });

    it('requires skill property', () => {
      const gate = { mode: 'advisory' } as unknown;
      const result = validateQualityGate(gate);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('skill')));
    });

    it('requires mode property', () => {
      const gate = { skill: 'my-skill' } as unknown;
      const result = validateQualityGate(gate);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('mode')));
    });

    it('rejects invalid mode values', () => {
      const gate = { skill: 'my-skill', mode: 'invalid' } as unknown;
      const result = validateQualityGate(gate);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('advisory') || e.includes('blocking')));
    });

    it('rejects invalid skill names', () => {
      const gate = { skill: 'MySkill', mode: 'advisory' };
      const result = validateQualityGate(gate);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('skill')));
    });

    it('rejects non-object gates', () => {
      const result = validateQualityGate('not an object');
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.length > 0);
    });
  });

  describe('readQualityGatesConfig', () => {
    it('returns null for missing config file', () => {
      const result = readQualityGatesConfig(testDir);
      assert.strictEqual(result, null);
    });

    it('reads valid config file', () => {
      const config: QualityGatesConfig = {
        interview: [{ skill: 'my-interview-gate', mode: 'advisory' }],
        plan: [{ skill: 'my-plan-gate', mode: 'blocking' }],
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

  describe('readValidatedQualityGates', () => {
    it('returns empty array for missing config', () => {
      const result = readValidatedQualityGates('interview', testDir);
      assert.deepStrictEqual(result.gates, []);
      assert.deepStrictEqual(result.errors, []);
    });

    it('validates gates for specific stage', () => {
      const config: QualityGatesConfig = {
        interview: [
          { skill: 'valid-gate', mode: 'advisory' },
          { skill: 'invalid-mode', mode: 'invalid' } as unknown as QualityGate,
        ],
      };
      writeFileSync(
        join(testDir, '.omx-config.json'),
        JSON.stringify({ qualityGates: config }, null, 2),
      );

      const result = readValidatedQualityGates('interview', testDir);
      assert.strictEqual(result.gates.length, 1);
      assert.strictEqual(result.errors.length, 1);
      assert.strictEqual(result.gates[0].skill, 'valid-gate');
    });

    it('returns empty array for non-existent stage', () => {
      const config: QualityGatesConfig = {
        interview: [{ skill: 'my-gate', mode: 'advisory' }],
      };
      writeFileSync(
        join(testDir, '.omx-config.json'),
        JSON.stringify({ qualityGates: config }, null, 2),
      );

      const result = readValidatedQualityGates('codeReview', testDir);
      assert.deepStrictEqual(result.gates, []);
      assert.deepStrictEqual(result.errors, []);
    });
  });

  describe('getGatesForStage', () => {
    it('returns gates for the specified stage', () => {
      const config: QualityGatesConfig = {
        interview: [{ skill: 'interview-gate', mode: 'advisory' }],
        plan: [{ skill: 'plan-gate', mode: 'blocking' }],
        codeReview: [{ skill: 'review-gate', mode: 'advisory' }],
      };
      writeFileSync(
        join(testDir, '.omx-config.json'),
        JSON.stringify({ qualityGates: config }, null, 2),
      );

      const interviewGates = getGatesForStage('interview', testDir);
      assert.strictEqual(interviewGates.length, 1);
      assert.strictEqual(interviewGates[0].skill, 'interview-gate');

      const planGates = getGatesForStage('plan', testDir);
      assert.strictEqual(planGates.length, 1);
      assert.strictEqual(planGates[0].skill, 'plan-gate');

      const reviewGates = getGatesForStage('codeReview', testDir);
      assert.strictEqual(reviewGates.length, 1);
      assert.strictEqual(reviewGates[0].skill, 'review-gate');
    });
  });

  describe('getAdvisoryGatesForStage', () => {
    it('filters gates by advisory mode', () => {
      const config: QualityGatesConfig = {
        interview: [
          { skill: 'advisory-gate', mode: 'advisory' },
          { skill: 'blocking-gate', mode: 'blocking' },
        ],
      };
      writeFileSync(
        join(testDir, '.omx-config.json'),
        JSON.stringify({ qualityGates: config }, null, 2),
      );

      const advisoryGates = getAdvisoryGatesForStage('interview', testDir);
      assert.strictEqual(advisoryGates.length, 1);
      assert.strictEqual(advisoryGates[0].skill, 'advisory-gate');
    });
  });

  describe('getBlockingGatesForStage', () => {
    it('filters gates by blocking mode', () => {
      const config: QualityGatesConfig = {
        interview: [
          { skill: 'advisory-gate', mode: 'advisory' },
          { skill: 'blocking-gate', mode: 'blocking' },
        ],
      };
      writeFileSync(
        join(testDir, '.omx-config.json'),
        JSON.stringify({ qualityGates: config }, null, 2),
      );

      const blockingGates = getBlockingGatesForStage('interview', testDir);
      assert.strictEqual(blockingGates.length, 1);
      assert.strictEqual(blockingGates[0].skill, 'blocking-gate');
    });
  });

  describe('validateAllQualityGates', () => {
    it('validates gates across all stages', () => {
      const config: QualityGatesConfig = {
        interview: [{ skill: 'interview-gate', mode: 'advisory' }],
        plan: [{ skill: 'plan-gate', mode: 'blocking' }],
        codeReview: [{ skill: 'review-gate', mode: 'advisory' }],
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
        interview: [{ skill: 'valid-gate', mode: 'advisory' }],
        plan: [{ skill: 'invalid-mode', mode: 'invalid' } as unknown as QualityGate],
        codeReview: [{ skill: 'MyGate', mode: 'blocking' }],
      };
      writeFileSync(
        join(testDir, '.omx-config.json'),
        JSON.stringify({ qualityGates: config }, null, 2),
      );

      const result = validateAllQualityGates(testDir);
      assert.strictEqual(result.gates.length, 1);
      assert.strictEqual(result.errors.length, 2);
    });
  });
});
