import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractFromSource } from '../safety/api-surface-extractor.js';
import { diffSurface, verifyApiSurfaceUnchanged } from '../safety/api-surface-differ.js';

describe('bumpkin/api-surface-extractor', () => {
  it('extracts exported functions with their signatures', () => {
    const snapshot = extractFromSource(
      'file.ts',
      `export function greet(name: string): string { return "hi " + name; }`,
    );
    assert.ok(snapshot.greet);
    assert.match(snapshot.greet, /function greet/);
    assert.match(snapshot.greet, /string/);
  });

  it('extracts exported const values', () => {
    const snapshot = extractFromSource(
      'file.ts',
      `export const VERSION: string = "1.0.0";`,
    );
    assert.ok(snapshot.VERSION);
  });

  it('extracts exported interfaces and type aliases', () => {
    const snapshot = extractFromSource(
      'file.ts',
      `
      export interface User { id: number; name: string; }
      export type UserId = User["id"];
      `,
    );
    assert.ok(snapshot.User);
    assert.ok(snapshot.UserId);
    assert.match(snapshot.User, /interface User/);
  });

  it('ignores non-exported declarations', () => {
    const snapshot = extractFromSource(
      'file.ts',
      `
      function internal() {}
      export function exported() {}
      `,
    );
    assert.ok(!('internal' in snapshot));
    assert.ok('exported' in snapshot);
  });

  it('integrates with diffSurface to flag new exports as added', () => {
    const before = extractFromSource('v1.ts', `export function a(): void {}`);
    const after = extractFromSource(
      'v2.ts',
      `export function a(): void {}
       export function b(): void {}`,
    );
    const d = diffSurface(before, after);
    assert.deepEqual(d.added, ['b']);
    assert.equal(d.hasChanges, true);
  });

  it('integrates with verifyApiSurfaceUnchanged for intentional changes', () => {
    const before = extractFromSource('v1.ts', `export function a(): void {}`);
    const after = extractFromSource(
      'v2.ts',
      `export function a(): void {}
       export function b(): void {}`,
    );
    const v = verifyApiSurfaceUnchanged(before, after, { added: ['b'] });
    assert.equal(v.pass, true);
  });

  it('detects signature changes across identical names', () => {
    const before = extractFromSource('v1.ts', `export function a(x: number): void {}`);
    const after = extractFromSource('v2.ts', `export function a(x: string): void {}`);
    const d = diffSurface(before, after);
    assert.equal(d.changed.length, 1);
    assert.equal(d.changed[0]?.name, 'a');
  });

  it('compacts long signatures to keep snapshots bounded', () => {
    const longParamList = Array.from({ length: 60 }, (_, i) => `p${i}: number`).join(', ');
    const snapshot = extractFromSource('file.ts', `export function giant(${longParamList}): void {}`);
    const sig = snapshot.giant;
    assert.ok(sig);
    assert.ok(sig.length <= 240);
  });
});
