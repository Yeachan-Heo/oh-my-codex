import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { diffSurface, verifyApiSurfaceUnchanged } from '../safety/api-surface-differ.js';

describe('bumpkin/api-surface-differ', () => {
  it('reports no changes when before and after match', () => {
    const d = diffSurface(
      { foo: '(a: number) => string' },
      { foo: '(a: number) => string' },
    );
    assert.equal(d.hasChanges, false);
    assert.deepEqual(d.added, []);
    assert.deepEqual(d.removed, []);
  });

  it('detects added exports', () => {
    const d = diffSurface({ foo: 'F' }, { foo: 'F', bar: 'B' });
    assert.deepEqual(d.added, ['bar']);
    assert.equal(d.hasChanges, true);
  });

  it('detects removed exports', () => {
    const d = diffSurface({ foo: 'F', bar: 'B' }, { foo: 'F' });
    assert.deepEqual(d.removed, ['bar']);
  });

  it('detects changed signatures', () => {
    const d = diffSurface({ foo: '(a: number) => string' }, { foo: '(a: string) => string' });
    assert.equal(d.changed.length, 1);
    assert.equal(d.changed[0]?.name, 'foo');
    assert.equal(d.changed[0]?.before, '(a: number) => string');
    assert.equal(d.changed[0]?.after, '(a: string) => string');
  });

  it('verifyApiSurfaceUnchanged passes on identical surfaces', () => {
    const v = verifyApiSurfaceUnchanged({ foo: 'F' }, { foo: 'F' });
    assert.equal(v.pass, true);
  });

  it('verifyApiSurfaceUnchanged fails on unexpected additions', () => {
    const v = verifyApiSurfaceUnchanged({ foo: 'F' }, { foo: 'F', bar: 'B' });
    assert.equal(v.pass, false);
    assert.match(v.reason, /added: bar/);
  });

  it('verifyApiSurfaceUnchanged allows explicitly permitted changes', () => {
    const v = verifyApiSurfaceUnchanged(
      { foo: 'F' },
      { foo: 'F', bar: 'B' },
      { added: ['bar'] },
    );
    assert.equal(v.pass, true);
  });

  it('verifyApiSurfaceUnchanged flags all three change kinds at once', () => {
    const v = verifyApiSurfaceUnchanged(
      { foo: 'F', baz: 'Z' },
      { foo: 'F2', bar: 'B' },
    );
    assert.equal(v.pass, false);
    assert.match(v.reason, /added: bar/);
    assert.match(v.reason, /removed: baz/);
    assert.match(v.reason, /changed: foo/);
  });
});
