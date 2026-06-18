import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMergeAgents } from '../agents-merge-mode.js';

describe('resolveMergeAgents', () => {
	it('merges by default when no flags are passed', () => {
		assert.equal(resolveMergeAgents(new Set()), true);
	});

	it('merges when --merge-agents is passed explicitly', () => {
		assert.equal(resolveMergeAgents(new Set(['--merge-agents'])), true);
	});

	it('disables merge when --no-merge-agents is passed', () => {
		assert.equal(resolveMergeAgents(new Set(['--no-merge-agents'])), false);
	});

	it('disables merge when --force is passed (full reinstall overwrites)', () => {
		assert.equal(resolveMergeAgents(new Set(['--force'])), false);
	});

	it('lets --merge-agents re-enable merge alongside --force', () => {
		assert.equal(
			resolveMergeAgents(new Set(['--force', '--merge-agents'])),
			true,
		);
	});

	it('lets --no-merge-agents win over --merge-agents when both are passed', () => {
		assert.equal(
			resolveMergeAgents(new Set(['--merge-agents', '--no-merge-agents'])),
			false,
		);
	});
});
