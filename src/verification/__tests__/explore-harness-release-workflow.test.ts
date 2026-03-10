import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('explore harness release workflow', () => {
  it('defines a multi-platform workflow that publishes tagged harness bundles to GitHub Releases', () => {
    const workflowPath = join(process.cwd(), '.github', 'workflows', 'explore-harness-artifacts.yml');
    assert.equal(existsSync(workflowPath), true, `missing workflow: ${workflowPath}`);

    const workflow = readFileSync(workflowPath, 'utf-8');
    assert.match(workflow, /name:\s*Explore Harness Artifacts/);
    assert.match(workflow, /workflow_dispatch:/);
    assert.match(workflow, /push:\s*\n\s*tags:/);
    assert.match(workflow, /permissions:\s*\n\s*contents:\s*write/);
    assert.match(workflow, /ubuntu-latest/);
    assert.match(workflow, /macos-latest/);
    assert.match(workflow, /windows-latest/);
    assert.match(workflow, /dtolnay\/rust-toolchain@stable/);
    assert.match(workflow, /npm run build:explore:release/);
    assert.match(workflow, /actions\/upload-artifact@v4/);
    assert.match(workflow, /actions\/download-artifact@v4/);
    assert.match(workflow, /softprops\/action-gh-release@v2/);
    assert.match(workflow, /omx-explore-harness-linux-x64/);
    assert.match(workflow, /omx-explore-harness-macos-x64/);
    assert.match(workflow, /omx-explore-harness-windows-x64/);
    assert.match(workflow, /release-manifest\.json/);
    assert.match(workflow, /explore-harness-release-manifest\.json/);
    assert.match(workflow, /omx-explore-harness-linux-x64\.zip/);
    assert.match(workflow, /omx-explore-harness-macos-x64\.zip/);
    assert.match(workflow, /omx-explore-harness-windows-x64\.zip/);
    assert.match(workflow, /Publish Release Assets/);
    assert.match(workflow, /Attach harness bundles to GitHub Release/);
    assert.match(workflow, /startsWith\(github\.ref, 'refs\/tags\/'\)/);
  });
});
