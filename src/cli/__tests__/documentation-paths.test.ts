import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

describe("documentation path contracts", () => {
  it("current setup docs reference .codex agents paths", () => {
    const readmes = ["README.md", "README.ko.md"];
    for (const rel of readmes) {
      const text = read(rel);
      assert.match(text, /~\/\.codex\/agents\//, `${rel} should reference user native agents under ~/.codex/agents/`);
      assert.match(text, /\.\/\.codex\/agents\//, `${rel} should reference project native agents under ./.codex/agents/`);
      assert.doesNotMatch(text, /~\/\.omx\/agents\//, `${rel} should not reference stale ~/.omx/agents/ path`);
      assert.doesNotMatch(text, /\.\/\.omx\/agents\//, `${rel} should not reference stale ./.omx/agents/ path`);
    }
  });

  it("active setup and doctor skills do not label live .codex installs as legacy", () => {
    const doctor = read("skills/doctor/SKILL.md");
    const setup = read("skills/omx-setup/SKILL.md");

    assert.match(doctor, /~\/\.codex\/skills\//);
    assert.match(doctor, /~\/\.codex\/agents\//);
    assert.doesNotMatch(doctor, /legacy skills \(~\/\.codex\/skills\)/i);
    assert.doesNotMatch(doctor, /legacy agents \(~\/\.codex\/agents\)/i);
    assert.doesNotMatch(doctor, /now provided by plugin/i);

    assert.match(setup, /~\/\.codex\/agents/);
    assert.match(setup, /\.\/\.codex\/agents/);
    assert.doesNotMatch(setup, /~\/\.omx\/agents/);
    assert.doesNotMatch(setup, /\.\/\.omx\/agents/);
  });
});
