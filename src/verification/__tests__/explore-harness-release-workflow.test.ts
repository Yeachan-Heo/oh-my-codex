import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function releaseUploadRunsAfterVerifier(
  workflow: string,
  uploadName: string,
  verifierResult: 'success' | 'failure',
): boolean {
  const verification = workflow.indexOf('Verify release archives and manifest');
  const upload = workflow.indexOf(uploadName);
  const nextStep = workflow.indexOf('\n      - name:', upload + uploadName.length);
  const uploadBlock = workflow.slice(upload, nextStep === -1 ? workflow.length : nextStep);
  return verification >= 0 && upload > verification && verifierResult === 'success' && !/^\s+if:/m.test(uploadBlock);
}

function flattenReleaseArtifacts(sourcePaths: string[]): string[] {
  const destinations = new Set<string>();

  for (const source of sourcePaths) {
    const basename = source.slice(source.lastIndexOf('/') + 1);
    if (destinations.has(basename)) {
      throw new Error(`release asset basename collision: ${source} -> release-assets/${basename}`);
    }
    destinations.add(basename);
  }

  return [...destinations];
}




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

    const manifestGeneration = workflow.indexOf('Generate release manifest from cargo-dist plan');
    const verification = workflow.indexOf('Verify release archives and manifest');
    const bundleUpload = workflow.indexOf('Upload release asset bundle for follow-up jobs');
    const releaseUpload = workflow.indexOf('Attach native assets to GitHub Release');
    assert.ok(manifestGeneration >= 0, 'release workflow must generate the manifest');
    assert.ok(verification > manifestGeneration, 'release workflow must verify after manifest generation');
    assert.ok(bundleUpload > verification, 'release bundle upload must occur after verification');
    assert.ok(releaseUpload > bundleUpload, 'GitHub Release upload must occur after the verified bundle upload');
    assert.match(workflow, /Verify release archives and manifest[\s\S]*node dist\/scripts\/verify-native-release-assets\.js/);

    const bundleUploadBlock = workflow.slice(bundleUpload, workflow.indexOf('Generate release body', bundleUpload));
    const releaseUploadBlock = workflow.slice(releaseUpload, workflow.indexOf('Write release summary', releaseUpload));
    assert.doesNotMatch(bundleUploadBlock, /^\s+if:/m, 'bundle upload must retain the default success() condition');
    assert.doesNotMatch(releaseUploadBlock, /^\s+if:/m, 'release attachment must retain the default success() condition');
    for (const uploadName of ['Upload release asset bundle for follow-up jobs', 'Attach native assets to GitHub Release']) {
      assert.equal(releaseUploadRunsAfterVerifier(workflow, uploadName, 'success'), true, `${uploadName} must run after successful verification`);
      assert.equal(releaseUploadRunsAfterVerifier(workflow, uploadName, 'failure'), false, `${uploadName} must not run when verification fails`);
    }
  });

  it('fails closed before manifest generation when downloaded artifacts share a basename', () => {
    const duplicateArchiveBasenameFixture = [
      'release-artifacts/native-x86/omx-api-v0.20.3-x86_64-unknown-linux-gnu.tar.xz',
      'release-artifacts/native-arm/omx-api-v0.20.3-x86_64-unknown-linux-gnu.tar.xz',
    ];
    const duplicateChecksumBasenameFixture = [
      'release-artifacts/native-x86/omx-api-v0.20.3-x86_64-unknown-linux-gnu.tar.xz.sha256',
      'release-artifacts/native-arm/omx-api-v0.20.3-x86_64-unknown-linux-gnu.tar.xz.sha256',
    ];
    for (const fixture of [duplicateArchiveBasenameFixture, duplicateChecksumBasenameFixture]) {
      assert.throws(
        () => flattenReleaseArtifacts(fixture),
        /release asset basename collision: release-artifacts\/native-arm\/.* -> release-assets\//,
      );
    }

    const workflowPath = join(process.cwd(), '.github', 'workflows', 'release.yml');
    const workflow = readFileSync(workflowPath, 'utf-8');
    const manifestGeneration = workflow.indexOf('Generate release manifest from cargo-dist plan');
    const verification = workflow.indexOf('Verify release archives and manifest', manifestGeneration);
    const bundleUpload = workflow.indexOf('Upload release asset bundle for follow-up jobs', manifestGeneration);
    const collisionCheck = workflow.indexOf('release asset basename collision:', manifestGeneration);
    const copy = workflow.indexOf('cp -- "$source" "$destination"', manifestGeneration);

    assert.ok(collisionCheck > manifestGeneration, 'collision detection must be in the artifact collection step');
    assert.ok(copy > collisionCheck, 'collision detection must run before copying an artifact basename');
    assert.ok(verification > copy, 'verification must not run when collision detection blocks manifest generation');
    assert.ok(bundleUpload > verification, 'upload must not run when collision detection blocks manifest generation or verification');
    assert.match(workflow, /destination="release-assets\/\$\(basename "\$source"\)"[\s\S]*if \[\[ -e "\$destination" \|\| -L "\$destination" \]\]; then[\s\S]*exit 1[\s\S]*cp -- "\$source" "\$destination"/);
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
