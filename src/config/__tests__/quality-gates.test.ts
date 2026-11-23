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
  normalizeGateEntry,
  type QualityGatesConfig,
  type NormalizedGate,
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

  describe('normalizeGateEntry', () => {
    it('normalizes string gate entries', () => {
      const result = normalizeGateEntry('my-gate');
      assert.deepStrictEqual(result, { skill: 'my-gate', mode: 'blocking' });
    });

    it('normalizes object gate entries with defaults', () => {
      const result = normalizeGateEntry({ skill: 'my-gate' });
      assert.deepStrictEqual(result, { skill: 'my-gate', mode: 'blocking' });
    });

    it('normalizes object gate entries with explicit blocking mode', () => {
      const result = normalizeGateEntry({ skill: 'my-gate', mode: 'blocking' });
      assert.deepStrictEqual(result, { skill: 'my-gate', mode: 'blocking' });
    });

    it('normalizes object gate entries with advisory mode', () => {
      const result = normalizeGateEntry({ skill: 'my-gate', mode: 'advisory' });
      assert.deepStrictEqual(result, { skill: 'my-gate', mode: 'advisory' });
    });

    it('preserves optional model in object entries', () => {
      const result = normalizeGateEntry({ skill: 'my-gate', model: 'claude-opus' });
      assert.deepStrictEqual(result, { skill: 'my-gate', mode: 'blocking', model: 'claude-opus' });
    });

    it('preserves mode and model together', () => {
      const result = normalizeGateEntry({ skill: 'my-gate', mode: 'advisory', model: 'claude-opus' });
      assert.deepStrictEqual(result, { skill: 'my-gate', mode: 'advisory', model: 'claude-opus' });
    });

    it('rejects invalid mode', () => {
      const result = normalizeGateEntry({ skill: 'my-gate', mode: 'invalid' as any });
      assert.strictEqual(result, null);
    });

    it('rejects invalid skill names', () => {
      const result = normalizeGateEntry('MyInvalidGate');
      assert.strictEqual(result, null);
    });

    it('rejects reserved skill names', () => {
      const result = normalizeGateEntry('deep-interview');
      assert.strictEqual(result, null);
    });

    it('rejects non-string, non-object entries', () => {
      assert.strictEqual(normalizeGateEntry(123 as any), null);
      assert.strictEqual(normalizeGateEntry(null as any), null);
      assert.strictEqual(normalizeGateEntry([] as any), null);
    });

    it('rejects object without skill property', () => {
      const result = normalizeGateEntry({ mode: 'blocking' } as any);
      assert.strictEqual(result, null);
    });
  });

  describe('readQualityGatesConfig', () => {
    it('returns null for missing config file', () => {
      const result = readQualityGatesConfig(testDir);
      assert.strictEqual(result, null);
    });

    it('reads valid config file with string entries', () => {
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

    it('reads valid config file with object entries', () => {
      const config: QualityGatesConfig = {
        'ralplan': [
          'simple-gate',
          { skill: 'my-gate', mode: 'advisory' },
          { skill: 'another-gate', model: 'claude-opus' },
        ],
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
    it('returns normalized gates for string entries', () => {
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
      assert.deepStrictEqual(interviewGates, [{ skill: 'interview-gate', mode: 'blocking' }]);

      const planGates = getGatesForStage('ralplan', testDir);
      assert.deepStrictEqual(planGates, [{ skill: 'plan-gate', mode: 'blocking' }]);

      const reviewGates = getGatesForStage('code-review', testDir);
      assert.deepStrictEqual(reviewGates, [{ skill: 'review-gate', mode: 'blocking' }]);
    });

    it('returns normalized gates for object entries', () => {
      const config: QualityGatesConfig = {
        'ralplan': [
          { skill: 'blocking-gate', mode: 'blocking' },
          { skill: 'advisory-gate', mode: 'advisory' },
          { skill: 'model-gate', model: 'claude-opus' },
        ],
      };
      writeFileSync(
        join(testDir, '.omx-config.json'),
        JSON.stringify({ qualityGates: config }, null, 2),
      );

      const gates = getGatesForStage('ralplan', testDir);
      assert.strictEqual(gates.length, 3);
      assert.deepStrictEqual(gates[0], { skill: 'blocking-gate', mode: 'blocking' });
      assert.deepStrictEqual(gates[1], { skill: 'advisory-gate', mode: 'advisory' });
      assert.deepStrictEqual(gates[2], { skill: 'model-gate', mode: 'blocking', model: 'claude-opus' });
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
      assert.deepStrictEqual(gates, [{ skill: 'valid-gate', mode: 'blocking' }]);
    });

    it('filters out invalid object entries', () => {
      const config = {
        'ralplan': [
          'valid-gate',
          { skill: 'MyInvalidGate' },
          { skill: 'valid-advisory', mode: 'advisory' },
          { mode: 'blocking' }, // Missing skill
        ],
      };
      writeFileSync(
        join(testDir, '.omx-config.json'),
        JSON.stringify({ qualityGates: config }, null, 2),
      );

      const gates = getGatesForStage('ralplan', testDir);
      // Should include only valid entries
      assert.strictEqual(gates.length, 2);
      assert.deepStrictEqual(gates[0], { skill: 'valid-gate', mode: 'blocking' });
      assert.deepStrictEqual(gates[1], { skill: 'valid-advisory', mode: 'advisory' });
    });
  });

  describe('validateAllQualityGates', () => {
    it('validates string and object gates across all stages', () => {
      const config: QualityGatesConfig = {
        'deep-interview': ['interview-gate'],
        'ralplan': [
          'plan-gate',
          { skill: 'advisory-plan', mode: 'advisory' },
        ],
        'code-review': ['review-gate'],
      };
      writeFileSync(
        join(testDir, '.omx-config.json'),
        JSON.stringify({ qualityGates: config }, null, 2),
      );

      const result = validateAllQualityGates(testDir);
      assert.strictEqual(result.gates.length, 4);
      assert.strictEqual(result.errors.length, 0);
      assert.deepStrictEqual(result.gates[0], { skill: 'interview-gate', mode: 'blocking' });
      assert.deepStrictEqual(result.gates[1], { skill: 'plan-gate', mode: 'blocking' });
      assert.deepStrictEqual(result.gates[2], { skill: 'advisory-plan', mode: 'advisory' });
      assert.deepStrictEqual(result.gates[3], { skill: 'review-gate', mode: 'blocking' });
    });

    it('collects validation errors across stages', () => {
      const config: QualityGatesConfig = {
        'deep-interview': ['valid-gate'],
        'ralplan': ['MyInvalidGate', 'deep-interview', { skill: 'valid-obj' }],
        'code-review': ['another-valid-gate'],
      };
      writeFileSync(
        join(testDir, '.omx-config.json'),
        JSON.stringify({ qualityGates: config }, null, 2),
      );

      const result = validateAllQualityGates(testDir);
      assert.strictEqual(result.gates.length, 3);
      assert.strictEqual(result.errors.length, 2);
      assert.ok(result.errors.some(e => e.entry === 'MyInvalidGate'));
      assert.ok(result.errors.some(e => e.entry === 'deep-interview'));
    });

    it('validates object mode property', () => {
      const config = {
        'ralplan': [
          { skill: 'valid-gate', mode: 'blocking' },
          { skill: 'another-gate', mode: 'invalid' as any },
        ],
      };
      writeFileSync(
        join(testDir, '.omx-config.json'),
        JSON.stringify({ qualityGates: config }, null, 2),
      );

      const result = validateAllQualityGates(testDir);
      assert.strictEqual(result.gates.length, 1);
      assert.strictEqual(result.errors.length, 1);
      assert.match(result.errors[0].error, /Invalid mode/);
    });

    it('handles non-string and non-object gate entries', () => {
      const config = {
        'ralplan': ['valid-gate', 123, null, { skill: 'valid-obj' }],
      };
      writeFileSync(
        join(testDir, '.omx-config.json'),
        JSON.stringify({ qualityGates: config }, null, 2),
      );

      const result = validateAllQualityGates(testDir);
      assert.strictEqual(result.gates.length, 2);
      assert.deepStrictEqual(result.gates[0], { skill: 'valid-gate', mode: 'blocking' });
      assert.deepStrictEqual(result.gates[1], { skill: 'valid-obj', mode: 'blocking' });
      assert.strictEqual(result.errors.length, 2);
    });

    it('handles object without skill property', () => {
      const config = {
        'ralplan': [
          'valid-gate',
          { mode: 'blocking' } as any,
        ],
      };
      writeFileSync(
        join(testDir, '.omx-config.json'),
        JSON.stringify({ qualityGates: config }, null, 2),
      );

      const result = validateAllQualityGates(testDir);
      assert.strictEqual(result.gates.length, 1);
      assert.strictEqual(result.errors.length, 1);
      assert.match(result.errors[0].error, /must have a "skill" property/);
    });

    it('preserves model in validated gates', () => {
      const config: QualityGatesConfig = {
        'ralplan': [
          { skill: 'model-gate', model: 'claude-opus', mode: 'advisory' },
        ],
      };
      writeFileSync(
        join(testDir, '.omx-config.json'),
        JSON.stringify({ qualityGates: config }, null, 2),
      );

      const result = validateAllQualityGates(testDir);
      assert.strictEqual(result.gates.length, 1);
      assert.deepStrictEqual(result.gates[0], {
        skill: 'model-gate',
        mode: 'advisory',
        model: 'claude-opus',
      });
      assert.strictEqual(result.errors.length, 0);
    });
  });

  describe('config resolution: project vs CODEX_HOME precedence', () => {
    let projectDir: string;
    let codexHomeDir: string;

    beforeEach(async () => {
      projectDir = await mkdtempAsync(join(tmpdir(), 'omx-project-'));
      codexHomeDir = await mkdtempAsync(join(tmpdir(), 'omx-codex-home-'));
    });

    afterEach(() => {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(codexHomeDir, { recursive: true, force: true });
    });

    it('reads only project config when CODEX_HOME has no config', () => {
      const projectConfig: QualityGatesConfig = {
        'ralplan': ['project-gate'],
      };
      writeFileSync(
        join(projectDir, '.omx-config.json'),
        JSON.stringify({ qualityGates: projectConfig }, null, 2),
      );
      // codexHomeDir is empty, so no config there

      const gates = getGatesForStage('ralplan', codexHomeDir, projectDir);
      assert.deepStrictEqual(gates, [{ skill: 'project-gate', mode: 'blocking' }]);
    });

    it('reads only CODEX_HOME config when project has no config', () => {
      const codexHomeConfig: QualityGatesConfig = {
        'ralplan': ['codex-gate'],
      };
      writeFileSync(
        join(codexHomeDir, '.omx-config.json'),
        JSON.stringify({ qualityGates: codexHomeConfig }, null, 2),
      );
      // projectDir is empty, so no config there

      const gates = getGatesForStage('ralplan', codexHomeDir, projectDir);
      assert.deepStrictEqual(gates, [{ skill: 'codex-gate', mode: 'blocking' }]);
    });

    it('merges project and CODEX_HOME configs with project taking precedence for same stage', () => {
      const projectConfig: QualityGatesConfig = {
        'ralplan': ['project-gate'],
        'deep-interview': ['project-interview-gate'],
      };
      const codexHomeConfig: QualityGatesConfig = {
        'ralplan': ['codex-gate'],
        'code-review': ['codex-review-gate'],
      };

      writeFileSync(
        join(projectDir, '.omx-config.json'),
        JSON.stringify({ qualityGates: projectConfig }, null, 2),
      );
      writeFileSync(
        join(codexHomeDir, '.omx-config.json'),
        JSON.stringify({ qualityGates: codexHomeConfig }, null, 2),
      );

      // Project ralplan should override CODEX_HOME ralplan
      const ralplanGates = getGatesForStage('ralplan', codexHomeDir, projectDir);
      assert.deepStrictEqual(ralplanGates, [{ skill: 'project-gate', mode: 'blocking' }]);

      // Project deep-interview (from project only)
      const interviewGates = getGatesForStage('deep-interview', codexHomeDir, projectDir);
      assert.deepStrictEqual(interviewGates, [{ skill: 'project-interview-gate', mode: 'blocking' }]);

      // Code-review (from CODEX_HOME only)
      const reviewGates = getGatesForStage('code-review', codexHomeDir, projectDir);
      assert.deepStrictEqual(reviewGates, [{ skill: 'codex-review-gate', mode: 'blocking' }]);
    });

    it('handles readQualityGatesConfig with both sources', () => {
      const projectConfig: QualityGatesConfig = {
        'ralplan': ['project-gate', { skill: 'project-model-gate', model: 'claude-opus' }],
      };
      const codexHomeConfig: QualityGatesConfig = {
        'ralplan': ['codex-gate'],
        'code-review': ['codex-review-gate'],
      };

      writeFileSync(
        join(projectDir, '.omx-config.json'),
        JSON.stringify({ qualityGates: projectConfig }, null, 2),
      );
      writeFileSync(
        join(codexHomeDir, '.omx-config.json'),
        JSON.stringify({ qualityGates: codexHomeConfig }, null, 2),
      );

      const config = readQualityGatesConfig(codexHomeDir, projectDir);
      assert.ok(config, 'Config should not be null');
      assert.deepStrictEqual(
        config?.ralplan,
        ['project-gate', { skill: 'project-model-gate', model: 'claude-opus' }],
        'Project ralplan should override CODEX_HOME',
      );
      assert.deepStrictEqual(
        config?.['code-review'],
        ['codex-review-gate'],
        'Code-review should come from CODEX_HOME',
      );
    });
  });
});
