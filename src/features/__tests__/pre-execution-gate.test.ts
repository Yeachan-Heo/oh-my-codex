import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  isExecutionSkill,
  validateExecutionArtifacts,
  generatePreExecutionGateSection,
} from '../pre-execution-gate.js';

describe('pre-execution gate', () => {
  describe('isExecutionSkill', () => {
    it('identifies execution skills', () => {
      assert.equal(isExecutionSkill('ralph'), true);
      assert.equal(isExecutionSkill('$ralph'), true);
      assert.equal(isExecutionSkill('team'), true);
      assert.equal(isExecutionSkill('autopilot'), true);
      assert.equal(isExecutionSkill('ultrawork'), true);
      assert.equal(isExecutionSkill('ecomode'), true);
    });

    it('rejects non-execution skills', () => {
      assert.equal(isExecutionSkill('plan'), false);
      assert.equal(isExecutionSkill('analyze'), false);
      assert.equal(isExecutionSkill('cancel'), false);
      assert.equal(isExecutionSkill(null), false);
      assert.equal(isExecutionSkill(''), false);
    });
  });

  describe('validateExecutionArtifacts', () => {
    it('fails when no plans directory exists', () => {
      const root = mkdtempSync(join(tmpdir(), 'omx-gate-'));
      const result = validateExecutionArtifacts(root);
      assert.equal(result.ok, false);
      assert.ok(result.missing.length > 0);
      assert.match(result.message, /No approved plan artifacts/);
    });

    it('fails when plan is missing PRD Scope', () => {
      const root = mkdtempSync(join(tmpdir(), 'omx-gate-'));
      const plansDir = join(root, '.omx', 'plans');
      mkdirSync(plansDir, { recursive: true });
      writeFileSync(join(plansDir, 'plan.md'), '# Plan\n\n## Test Spec\n- unit\n');

      const result = validateExecutionArtifacts(root);
      assert.equal(result.ok, false);
      assert.ok(result.missing.includes('## PRD Scope section'));
    });

    it('fails when plan is missing Test Spec', () => {
      const root = mkdtempSync(join(tmpdir(), 'omx-gate-'));
      const plansDir = join(root, '.omx', 'plans');
      mkdirSync(plansDir, { recursive: true });
      writeFileSync(join(plansDir, 'plan.md'), '# Plan\n\n## PRD Scope\n- scope\n');

      const result = validateExecutionArtifacts(root);
      assert.equal(result.ok, false);
      assert.ok(result.missing.includes('## Test Spec section'));
    });

    it('passes when plan has both PRD Scope and Test Spec', () => {
      const root = mkdtempSync(join(tmpdir(), 'omx-gate-'));
      const plansDir = join(root, '.omx', 'plans');
      mkdirSync(plansDir, { recursive: true });
      writeFileSync(
        join(plansDir, 'plan.md'),
        '# Plan\n\n## PRD Scope\n- scope\n\n## Test Spec\n- unit\n- integration\n',
      );

      const result = validateExecutionArtifacts(root);
      assert.equal(result.ok, true);
      assert.equal(result.missing.length, 0);
    });

    it('accepts "Test Specification" as equivalent to "Test Spec"', () => {
      const root = mkdtempSync(join(tmpdir(), 'omx-gate-'));
      const plansDir = join(root, '.omx', 'plans');
      mkdirSync(plansDir, { recursive: true });
      writeFileSync(
        join(plansDir, 'plan.md'),
        '# Plan\n\n## PRD Scope\n- in scope\n\n## Test Specification\n- tests\n',
      );

      const result = validateExecutionArtifacts(root);
      assert.equal(result.ok, true);
    });

    it('uses latest plan by mtime', () => {
      const root = mkdtempSync(join(tmpdir(), 'omx-gate-'));
      const plansDir = join(root, '.omx', 'plans');
      mkdirSync(plansDir, { recursive: true });

      // Old plan: incomplete
      writeFileSync(join(plansDir, 'old.md'), '# Old\n');

      // New plan: complete (written after, so newer mtime)
      writeFileSync(
        join(plansDir, 'new.md'),
        '# New\n\n## PRD Scope\n- s\n\n## Test Spec\n- t\n',
      );

      const result = validateExecutionArtifacts(root);
      assert.equal(result.ok, true);
      assert.match(result.planPath!, /new\.md$/);
    });
  });

  describe('generatePreExecutionGateSection', () => {
    it('generates AGENTS.md section with required keywords', () => {
      const section = generatePreExecutionGateSection();
      assert.match(section, /pre_execution_gate/);
      assert.match(section, /PRD Scope/);
      assert.match(section, /Test Spec/);
      assert.match(section, /\$ralplan/);
    });
  });
});
