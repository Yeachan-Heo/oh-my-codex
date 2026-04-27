import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import TOML from '@iarna/toml';

interface WorkspacePackageMetadata {
  version?: string;
  'rust-version'?: string;
}

interface WorkspaceMemberPackageMetadata {
  version?: string | { workspace?: boolean };
  'rust-version'?: string | { workspace?: boolean };
}

describe('version sync contract', () => {
  it('keeps package.json, workspace metadata, and Rust members aligned for releases', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as { version: string };
    const workspace = TOML.parse(readFileSync(join(process.cwd(), 'Cargo.toml'), 'utf-8')) as {
      workspace?: { package?: WorkspacePackageMetadata; members?: string[] };
    };
    const explore = TOML.parse(readFileSync(join(process.cwd(), 'crates', 'omx-explore', 'Cargo.toml'), 'utf-8')) as {
      package?: WorkspaceMemberPackageMetadata;
    };
    const runtimeCore = TOML.parse(
      readFileSync(join(process.cwd(), 'crates', 'omx-runtime-core', 'Cargo.toml'), 'utf-8'),
    ) as { package?: WorkspaceMemberPackageMetadata };
    const mux = TOML.parse(readFileSync(join(process.cwd(), 'crates', 'omx-mux', 'Cargo.toml'), 'utf-8')) as {
      package?: WorkspaceMemberPackageMetadata;
    };
    const runtime = TOML.parse(readFileSync(join(process.cwd(), 'crates', 'omx-runtime', 'Cargo.toml'), 'utf-8')) as {
      package?: WorkspaceMemberPackageMetadata;
    };
    const sparkshell = TOML.parse(readFileSync(join(process.cwd(), 'crates', 'omx-sparkshell', 'Cargo.toml'), 'utf-8')) as {
      package?: WorkspaceMemberPackageMetadata;
    };

    assert.equal(workspace.workspace?.package?.version, pkg.version);
    assert.deepEqual(workspace.workspace?.members, [
      'crates/omx-explore',
      'crates/omx-mux',
      'crates/omx-runtime-core',
      'crates/omx-runtime',
      'crates/omx-sparkshell',
    ]);
    assert.equal(workspace.workspace?.package?.['rust-version'], '1.73');
    assert.deepEqual(explore.package?.version, { workspace: true });
    assert.deepEqual(runtimeCore.package?.version, { workspace: true });
    assert.deepEqual(mux.package?.version, { workspace: true });
    assert.deepEqual(runtime.package?.version, { workspace: true });
    assert.deepEqual(sparkshell.package?.version, { workspace: true });
    assert.deepEqual(explore.package?.['rust-version'], { workspace: true });
    assert.deepEqual(runtimeCore.package?.['rust-version'], { workspace: true });
    assert.deepEqual(mux.package?.['rust-version'], { workspace: true });
    assert.deepEqual(runtime.package?.['rust-version'], { workspace: true });
    assert.deepEqual(sparkshell.package?.['rust-version'], { workspace: true });
  });

  it('keeps Cargo.lock readable by the packaged fallback Rust toolchain floor', () => {
    const lockfile = readFileSync(join(process.cwd(), 'Cargo.lock'), 'utf-8');
    assert.match(lockfile, /^version = 3$/m);
    assert.doesNotMatch(lockfile, /^version = 4$/m, 'Cargo.lock v4 breaks cargo 1.73 fallback builds used by omx explore');
  });
});
