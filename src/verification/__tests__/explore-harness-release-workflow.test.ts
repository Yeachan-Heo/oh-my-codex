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
    assert.match(workflow, /softprops\/action-gh-release@v3/);
    assert.match(workflow, /generate-release-body\.js/);
    assert.match(workflow, /omx-api/);
    assert.match(workflow, /omx-explore-harness/);
    assert.match(workflow, /omx-sparkshell/);
    assert.match(workflow, /native-release-manifest\.json/);
    assert.match(workflow, /Publish Native Assets/);
    assert.match(workflow, /Smoke Verify Native Assets/);
    assert.match(workflow, /Smoke Test Packed Global Install/);
    assert.match(workflow, /Publish npm Package/);
    assert.match(workflow, /needs:\s*\[smoke-packed-install\]/);
    assert.match(workflow, /npm publish --access public --provenance/);
    assert.doesNotMatch(workflow, /Older Linux Runtime Proof/);
    assert.doesNotMatch(workflow, /node:20-bullseye/);
    assert.doesNotMatch(workflow, /docker run --rm/);
    assert.doesNotMatch(workflow, /scripts\/check-version-sync\.mjs/);
    assert.doesNotMatch(workflow, /scripts\/generate-native-release-manifest\.mjs/);
    assert.doesNotMatch(workflow, /scripts\/verify-native-release-assets\.mjs/);
    assert.doesNotMatch(workflow, /scripts\/smoke-packed-install\.mjs/);
    assert.doesNotMatch(workflow, /--release-assets-dir/);
    assert.doesNotMatch(workflow, /--require-no-fallback/);

    assert.match(workflow, /verify-version-sync:[\s\S]*Verify version sync against workspace crates[\s\S]*node --input-type=module/);
    assert.match(workflow, /publish-native-assets:[\s\S]*npm run build[\s\S]*node dist\/scripts\/generate-native-release-manifest\.js/);
    assert.match(workflow, /publish-native-assets:[\s\S]*Generate release body[\s\S]*node dist\/scripts\/generate-release-body\.js --template RELEASE_BODY\.md --out RELEASE_BODY\.generated\.md/);
    assert.match(workflow, /body_path:\s*RELEASE_BODY\.generated\.md/);
    assert.match(workflow, /smoke-verify-native:[\s\S]*npm run build[\s\S]*node dist\/scripts\/verify-native-release-assets\.js/);
    assert.match(workflow, /smoke-packed-install:[\s\S]*npm run build[\s\S]*Smoke test packed install boot \+ core commands[\s\S]*npm run smoke:packed-install/);
    assert.match(workflow, /publish-npm:[\s\S]*Verify version sync against workspace crates[\s\S]*npm pack --dry-run/);
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
