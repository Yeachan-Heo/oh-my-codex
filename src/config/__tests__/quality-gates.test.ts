import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import { mkdtemp, rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import {
  validateGateName,
  validateCustomGate,
  readQualityGatesConfig,
  readValidatedQualityGates,
  getGatesForStage,
  getAdvisoryGatesForStage,
  getBlockingGatesForStage,
  type CustomQualityGate,
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

  describe('validateGateName', () => {
    it('accepts valid kebab-case names', () => {
      const validNames = ['my-gate', 'foo-bar-baz', 'test123', 'gate-2-check'];
      for (const name of validNames) {
        const result = validateGateName(name);
        assert.strictEqual(result.valid, true, `Expected "${name}" to be valid`);
      }
    });

    it('rejects non-kebab-case names', () => {
      const invalidNames = ['MyGate', 'my_gate', 'my gate', 'my.gate', '-my-gate', 'my-gate-'];
      for (const name of invalidNames) {
        const result = validateGateName(name);
        assert.strictEqual(result.valid, false, `Expected "${name}" to be invalid`);
        assert.ok(result.error, `Expected error message for "${name}"`);
      }
    });

    it('rejects reserved gate names', () => {
      const reserved = ['ai-slop-cleaner', 'verification', 'code-review', 'architecture-invariant-gate'];
      for (const name of reserved) {
        const result = validateGateName(name);
        assert.strictEqual(result.valid, false, `Expected "${name}" to be reserved`);
        assert.match(result.error!, /reserved/i);
      }
    });

    it('rejects sunset/deprecated gate names', () => {
      const sunset = ['legacy-review', 'deprecated-lint', 'obsolete-test'];
      for (const name of sunset) {
        const result = validateGateName(name);
        assert.strictEqual(result.valid, false, `Expected "${name}" to be sunset`);
        assert.match(result.error!, /deprecated|sunset/i);
      }
    });

    it('rejects empty or non-string names', () => {
      const result1 = validateGateName('');
      assert.strictEqual(result1.valid, false);

      const result2 = validateGateName(null as unknown as string);
      assert.strictEqual(result2.valid, false);
    });
  });

  describe('validateCustomGate', () => {
    const validGate: CustomQualityGate = {
      name: 'my-custom-gate',
      label: 'My Custom Gate',
      level: 'advisory',
      stages: ['interview', 'plan'],
    };

    it('accepts valid custom gate', () => {
      const result = validateCustomGate(validGate);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
    });

    it('accepts gate with all optional properties', () => {
      const gate: CustomQualityGate = {
        ...validGate,
        description: 'Gate for testing',
        skill: 'my-skill',
      };
      const result = validateCustomGate(gate);
      assert.strictEqual(result.valid, true);
    });

    it('requires name property', () => {
      const gate = { ...validGate, name: undefined };
      const result = validateCustomGate(gate);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('name')));
    });

    it('requires label property', () => {
      const gate = { ...validGate, label: undefined };
      const result = validateCustomGate(gate);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('label')));
    });

    it('requires valid level (advisory or blocking)', () => {
      const gate = { ...validGate, level: 'invalid' };
      const result = validateCustomGate(gate);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('level')));
    });

    it('requires non-empty stages array', () => {
      const gate = { ...validGate, stages: [] };
      const result = validateCustomGate(gate);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('stages')));
    });

    it('validates stage names', () => {
      const gate = { ...validGate, stages: ['invalid-stage'] };
      const result = validateCustomGate(gate);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('stage')));
    });

    it('accepts valid stage names', () => {
      const validStages = ['interview', 'plan', 'codeReview'];
      for (const stage of validStages) {
        const gate = { ...validGate, stages: [stage as any] };
        const result = validateCustomGate(gate);
        // Only check stages if other fields are valid
        assert.ok(!result.errors.some((e) => e.includes(`"${stage}"`)));
      }
    });

    it('rejects reserved gate names', () => {
      const gate = { ...validGate, name: 'ai-slop-cleaner' };
      const result = validateCustomGate(gate);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('reserved')));
    });

    it('rejects sunset gate names', () => {
      const gate = { ...validGate, name: 'legacy-review' };
      const result = validateCustomGate(gate);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('deprecated')));
    });

    it('validates optional skill as string', () => {
      const gate = { ...validGate, skill: 123 as unknown as string };
      const result = validateCustomGate(gate);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('skill')));
    });
  });

  describe('readQualityGatesConfig', () => {
    it('returns null when config file does not exist', () => {
      const result = readQualityGatesConfig(testDir);
      assert.strictEqual(result, null);
    });

    it('reads quality gates from .omx-config.json', () => {
      const config = {
        qualityGates: {
          gates: [
            {
              name: 'test-gate',
              label: 'Test Gate',
              level: 'advisory',
              stages: ['interview'],
            },
          ],
        },
      };
      writeFileSync(join(testDir, '.omx-config.json'), JSON.stringify(config));

      const result = readQualityGatesConfig(testDir);
      assert.ok(result);
      assert.ok(Array.isArray(result.gates));
      assert.strictEqual(result.gates.length, 1);
      assert.strictEqual(result.gates[0].name, 'test-gate');
    });

    it('returns null for invalid config file', () => {
      writeFileSync(join(testDir, '.omx-config.json'), 'invalid json');
      const result = readQualityGatesConfig(testDir);
      assert.strictEqual(result, null);
    });

    it('returns null when qualityGates is not an object', () => {
      const config = { qualityGates: 'not-an-object' };
      writeFileSync(join(testDir, '.omx-config.json'), JSON.stringify(config));

      const result = readQualityGatesConfig(testDir);
      assert.strictEqual(result, null);
    });
  });

  describe('readValidatedQualityGates', () => {
    it('returns empty arrays when no config', () => {
      const result = readValidatedQualityGates(testDir);
      assert.deepStrictEqual(result.gates, []);
      assert.deepStrictEqual(result.errors, []);
    });

    it('validates all gates and reports errors', () => {
      const config = {
        qualityGates: {
          gates: [
            {
              name: 'valid-gate',
              label: 'Valid Gate',
              level: 'blocking',
              stages: ['plan'],
            },
            {
              name: 'invalid-gate',
              label: 'Invalid Gate',
              // Missing required 'level'
              stages: ['interview'],
            },
            {
              name: 'ai-slop-cleaner', // Reserved name
              label: 'Reserved Gate',
              level: 'advisory',
              stages: ['codeReview'],
            },
          ],
        },
      };
      writeFileSync(join(testDir, '.omx-config.json'), JSON.stringify(config));

      const result = readValidatedQualityGates(testDir);
      assert.strictEqual(result.gates.length, 1);
      assert.strictEqual(result.gates[0].name, 'valid-gate');
      assert.strictEqual(result.errors.length, 2);
    });
  });

  describe('stage-based filtering', () => {
    beforeEach(async () => {
      const config = {
        qualityGates: {
          gates: [
            {
              name: 'interview-gate',
              label: 'Interview Gate',
              level: 'advisory',
              stages: ['interview'],
            },
            {
              name: 'blocking-gate',
              label: 'Blocking Gate',
              level: 'blocking',
              stages: ['interview', 'plan'],
            },
            {
              name: 'review-gate',
              label: 'Review Gate',
              level: 'advisory',
              stages: ['codeReview'],
            },
          ],
        },
      };
      writeFileSync(join(testDir, '.omx-config.json'), JSON.stringify(config));
    });

    it('getGatesForStage returns gates matching stage', () => {
      const interviewGates = getGatesForStage('interview', testDir);
      assert.strictEqual(interviewGates.length, 2);
      assert.ok(interviewGates.some((g) => g.name === 'interview-gate'));
      assert.ok(interviewGates.some((g) => g.name === 'blocking-gate'));

      const planGates = getGatesForStage('plan', testDir);
      assert.strictEqual(planGates.length, 1);
      assert.strictEqual(planGates[0].name, 'blocking-gate');

      const reviewGates = getGatesForStage('codeReview', testDir);
      assert.strictEqual(reviewGates.length, 1);
      assert.strictEqual(reviewGates[0].name, 'review-gate');
    });

    it('getAdvisoryGatesForStage filters by level', () => {
      const advisoryGates = getAdvisoryGatesForStage('interview', testDir);
      assert.strictEqual(advisoryGates.length, 1);
      assert.strictEqual(advisoryGates[0].name, 'interview-gate');
    });

    it('getBlockingGatesForStage filters by level', () => {
      const blockingGates = getBlockingGatesForStage('interview', testDir);
      assert.strictEqual(blockingGates.length, 1);
      assert.strictEqual(blockingGates[0].name, 'blocking-gate');
    });
  });

  describe('missing skill validation', () => {
    it('accepts gates with skill reference', () => {
      const gate: CustomQualityGate = {
        name: 'skill-gate',
        label: 'Skill Gate',
        level: 'blocking',
        stages: ['interview'],
        skill: 'my-skill',
      };
      const result = validateCustomGate(gate);
      assert.strictEqual(result.valid, true);
    });

    it('accepts gates without skill reference', () => {
      const gate: CustomQualityGate = {
        name: 'no-skill-gate',
        label: 'No Skill Gate',
        level: 'advisory',
        stages: ['plan'],
      };
      const result = validateCustomGate(gate);
      assert.strictEqual(result.valid, true);
    });
  });
});
