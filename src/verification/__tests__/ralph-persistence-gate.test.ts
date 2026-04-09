import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function repoRoot(): string {
  return join(process.cwd());
}

function mustExist(path: string): void {
  assert.equal(existsSync(path), true, `missing required artifact: ${path}`);
}

describe('ralph persistence release gate artifacts', () => {
  it('requires baseline and parity reference docs with pinned commit/hash evidence', () => {
    const root = repoRoot();
    const baselinePath = join(root, 'docs', 'reference', 'ralph-upstream-baseline.md');
    const parityPath = join(root, 'docs', 'reference', 'ralph-parity-matrix.md');
    mustExist(baselinePath);
    mustExist(parityPath);

    const baseline = readFileSync(baselinePath, 'utf-8');
    const parity = readFileSync(parityPath, 'utf-8');
    assert.match(baseline, /Pinned commit SHA:\s*`[0-9a-f]{40}`/i);
    assert.match(baseline, /SHA256 .*`[0-9a-f]{64}`/i);
    assert.match(parity, /\|\s*R1\s*\|/);
    assert.match(parity, /\|\s*R7\s*\|/);
  });

  it('requires contract and QA gate docs with V1-V10 coverage', () => {
    const root = repoRoot();
    const stateContract = join(root, 'docs', 'contracts', 'ralph-state-contract.md');
    const cancelContract = join(root, 'docs', 'contracts', 'ralph-cancel-contract.md');
    const qaGate = join(root, 'docs', 'qa', 'ralph-persistence-gate.md');
    mustExist(stateContract);
    mustExist(cancelContract);
    mustExist(qaGate);

    const state = readFileSync(stateContract, 'utf-8');
    const cancel = readFileSync(cancelContract, 'utf-8');
    const gate = readFileSync(qaGate, 'utf-8');

    for (const phase of ['starting', 'executing', 'verifying', 'fixing', 'complete', 'failed', 'cancelled']) {
      assert.match(state, new RegExp('-\\s*`' + phase + '`'));
    }
    assert.match(cancel, /MUST/);
    for (const id of ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9', 'V10']) {
      assert.match(gate, new RegExp(`\\|\\s*${id}\\s*\\|`));
    }
    assert.match(gate, /OMX_RALPH_PERSISTENCE_PORT=1/);
    assert.match(gate, /compatibility window/i);
  });

  it('requires CI workflow gate job that runs the Ralph persistence matrix tests', () => {
    const root = repoRoot();
    const workflow = join(root, '.github', 'workflows', 'ci.yml');
    mustExist(workflow);
    const ci = readFileSync(workflow, 'utf-8');

    assert.match(ci, /ralph-persistence-gate:/);
    assert.match(ci, /npm run test:ralph-persistence:compiled/);
  });
});
