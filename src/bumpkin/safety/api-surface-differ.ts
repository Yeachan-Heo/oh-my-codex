export type SurfaceSnapshot = Readonly<Record<string, string>>;

export interface SurfaceDiff {
  added: string[];
  removed: string[];
  changed: Array<{ name: string; before: string; after: string }>;
  hasChanges: boolean;
}

export function diffSurface(before: SurfaceSnapshot, after: SurfaceSnapshot): SurfaceDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: Array<{ name: string; before: string; after: string }> = [];

  for (const name of Object.keys(after)) {
    if (!(name in before)) {
      added.push(name);
    } else if (before[name] !== after[name]) {
      const b = before[name];
      const a = after[name];
      if (b !== undefined && a !== undefined) {
        changed.push({ name, before: b, after: a });
      }
    }
  }

  for (const name of Object.keys(before)) {
    if (!(name in after)) removed.push(name);
  }

  added.sort();
  removed.sort();
  changed.sort((x, y) => x.name.localeCompare(y.name));

  return {
    added,
    removed,
    changed,
    hasChanges: added.length + removed.length + changed.length > 0,
  };
}

export interface SurfaceDiffVerdict {
  pass: boolean;
  reason: string;
  diff: SurfaceDiff;
}

export function verifyApiSurfaceUnchanged(
  before: SurfaceSnapshot,
  after: SurfaceSnapshot,
  allowed: { added?: readonly string[]; removed?: readonly string[]; changed?: readonly string[] } = {},
): SurfaceDiffVerdict {
  const diff = diffSurface(before, after);
  const allowAdded = new Set(allowed.added ?? []);
  const allowRemoved = new Set(allowed.removed ?? []);
  const allowChanged = new Set(allowed.changed ?? []);

  const unexpectedAdded = diff.added.filter((n) => !allowAdded.has(n));
  const unexpectedRemoved = diff.removed.filter((n) => !allowRemoved.has(n));
  const unexpectedChanged = diff.changed.filter((c) => !allowChanged.has(c.name));

  if (
    unexpectedAdded.length === 0 &&
    unexpectedRemoved.length === 0 &&
    unexpectedChanged.length === 0
  ) {
    return { pass: true, reason: 'public API surface unchanged (or only expected changes)', diff };
  }

  const bits: string[] = [];
  if (unexpectedAdded.length > 0) bits.push(`added: ${unexpectedAdded.join(', ')}`);
  if (unexpectedRemoved.length > 0) bits.push(`removed: ${unexpectedRemoved.join(', ')}`);
  if (unexpectedChanged.length > 0)
    bits.push(`changed: ${unexpectedChanged.map((c) => c.name).join(', ')}`);

  return { pass: false, reason: `unexpected API surface changes — ${bits.join('; ')}`, diff };
}
