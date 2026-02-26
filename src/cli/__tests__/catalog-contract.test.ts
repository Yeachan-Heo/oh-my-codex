import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getCatalogExpectations, getCatalogHeadlineCounts } from '../catalog-contract.js';

describe('cli/catalog-contract', () => {
  it('derives expectations from current manifest counts', () => {
    const headline = getCatalogHeadlineCounts();
    assert.ok(headline, 'expected catalog headline counts when manifest exists');

    const expectations = getCatalogExpectations();
    assert.equal(expectations.promptMin, Math.max(1, headline!.prompts - 2));
    assert.equal(expectations.skillMin, Math.max(1, headline!.skills - 2));
  });

  it('never returns non-positive minimum expectations', () => {
    const expectations = getCatalogExpectations();
    assert.ok(expectations.promptMin >= 1);
    assert.ok(expectations.skillMin >= 1);
  });
});
