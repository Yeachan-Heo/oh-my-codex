import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('native release workflow', () => {
  it('defines a unified tag workflow that publishes both Rust binaries before npm publish', () => {
    const workflowPath = join(process.cwd(), '.github', 'workflows', 'release.yml');
    assert.equal(existsSync(workflowPath), true, `missing workflow: ${workflowPath}`);

    const workflow = readFileSync(workflowPath, 'utf-8');
    assert.match(workflow, /name:\s*Release/);
    assert.match(workflow, /push:\s*\n\s*tags:/);
    assert.match(workflow, /permissions:\s*\n\s*contents:\s*write/);
    assert.match(workflow, /id-token:\s*write/);
    assert.match(workflow, /ubuntu-24\.04/);
    assert.match(workflow, /ubuntu-24\.04-arm/);
    assert.match(workflow, /x86_64-unknown-linux-gnu/);
    assert.match(workflow, /x86_64-unknown-linux-musl/);
    assert.match(workflow, /aarch64-unknown-linux-gnu/);
    assert.match(workflow, /aarch64-unknown-linux-musl/);
    assert.match(workflow, /macos-15-intel/);
    assert.match(workflow, /macos-14/);
    assert.match(workflow, /windows-latest/);
    assert.match(workflow, /musl-tools/);
    assert.match(workflow, /CC_x86_64_unknown_linux_musl=musl-gcc/);
    assert.match(workflow, /CC_aarch64_unknown_linux_musl=musl-gcc/);
    assert.match(workflow, /cargo install cargo-dist/);
    assert.match(workflow, /dist build -a local/);
    assert.match(workflow, /dist plan --output-format=json/);
    assert.match(workflow, /actions\/upload-artifact@v4/);
    assert.match(workflow, /actions\/download-artifact@v8/);
    assert.match(workflow, /softprops\/action-gh-release@v2/);
    assert.match(workflow, /omx-explore-harness/);
    assert.match(workflow, /omx-sparkshell/);
    assert.match(workflow, /native-release-manifest\.json/);
    assert.match(workflow, /Publish Native Assets/);
    assert.match(workflow, /Smoke Verify Native Assets/);
    assert.match(workflow, /Smoke Test Packed Global Install/);
    assert.match(workflow, /Older Linux Runtime Proof/);
    assert.match(workflow, /node:20-bullseye/);
    assert.match(workflow, /docker run --rm/);
    assert.match(workflow, /smoke-packed-install\.mjs --release-assets-dir \.\/release-assets --require-no-fallback/);
    assert.match(workflow, /Publish npm Package/);
    assert.match(workflow, /needs:\s*\[older-linux-runtime-proof\]/);
    assert.match(workflow, /smoke-packed-install\.mjs --release-assets-dir release-assets/);
    assert.match(workflow, /npm publish --access public --provenance/);
  });

  it('keeps cargo-dist Linux targets aligned with musl-first plus glibc fallback assets', () => {
    const distWorkspacePath = join(process.cwd(), 'dist-workspace.toml');
    assert.equal(existsSync(distWorkspacePath), true, `missing cargo-dist config: ${distWorkspacePath}`);

    const config = readFileSync(distWorkspacePath, 'utf-8');
    assert.match(config, /aarch64-unknown-linux-gnu/);
    assert.match(config, /aarch64-unknown-linux-musl/);
    assert.match(config, /x86_64-unknown-linux-gnu/);
    assert.match(config, /x86_64-unknown-linux-musl/);
  });

  it('retires the old explore-only release workflow', () => {
    const legacyWorkflowPath = join(process.cwd(), '.github', 'workflows', 'explore-harness-artifacts.yml');
    assert.equal(existsSync(legacyWorkflowPath), false, `legacy workflow should be removed: ${legacyWorkflowPath}`);
  });
});
