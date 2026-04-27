import assert from "node:assert/strict";
import { utimes, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  DOCUMENT_REFRESH_EXEMPTION_PREFIX,
  evaluateDocumentRefresh,
  findFreshLocalPlanningTargets,
  isFinalHandoffDocumentRefreshCandidate,
  parseGitNameStatus,
  type ChangedPathRecord,
} from "../enforcer.js";

function warningFor(changes: ChangedPathRecord[], options: {
  scope?: "commit" | "final-handoff";
  exemptionText?: string;
  localFreshTargets?: string[];
} = {}) {
  return evaluateDocumentRefresh({
    scope: options.scope ?? "commit",
    changes,
    exemptionText: options.exemptionText,
    localFreshTargets: options.localFreshTargets,
  });
}

describe("document refresh evaluator", () => {
  it("triggers on mapped native-hook source without docs/spec refresh", () => {
    const warning = warningFor([{ status: "M", path: "src/scripts/codex-native-hook.ts" }]);

    assert.ok(warning);
    assert.match(warning.message, /Document-refresh warning/);
    assert.deepEqual(warning.triggeringPaths, ["src/scripts/codex-native-hook.ts"]);
    assert.ok(warning.expectedTargets.includes("docs/codex-native-hooks.md"));
  });

  it("commit path suppresses when tracked or force-staged rule-scoped planning spec appears in the diff", () => {
    const warning = warningFor([
      { status: "M", path: "src/document-refresh/enforcer.ts" },
      { status: "A", path: ".omx/plans/prd-document-refresh-enforcer.md" },
    ]);

    assert.equal(warning, null);
  });

  it("does not suppress native-hook changes with document-refresh-only planning specs", () => {
    const warning = warningFor([
      { status: "M", path: "src/scripts/codex-native-hook.ts" },
      { status: "A", path: ".omx/plans/prd-document-refresh-enforcer.md" },
    ]);

    assert.ok(warning);
    assert.deepEqual(warning.rules.map((rule) => rule.ruleId), ["native-hook-behavior"]);
  });

  it("commit path does not suppress on ignored local-only planning spec evidence", () => {
    const warning = warningFor(
      [{ status: "M", path: "src/scripts/codex-native-hook.ts" }],
      { scope: "commit", localFreshTargets: [".omx/plans/prd-document-refresh-enforcer.md"] },
    );

    assert.ok(warning);
  });

  it("commit path suppresses when relevant product doc changed", () => {
    const warning = warningFor([
      { status: "M", path: "src/scripts/codex-native-hook.ts" },
      { status: "M", path: "docs/codex-native-hooks.md" },
    ]);

    assert.equal(warning, null);
  });

  it("does not suppress on unrelated doc change", () => {
    const warning = warningFor([
      { status: "M", path: "src/scripts/codex-native-hook.ts" },
      { status: "M", path: "docs/release-notes-0.14.3.md" },
    ]);

    assert.ok(warning);
    assert.deepEqual(warning.triggeringPaths, ["src/scripts/codex-native-hook.ts"]);
  });

  it("suppresses explicit exemption", () => {
    const warning = warningFor(
      [{ status: "M", path: "src/scripts/codex-native-hook.ts" }],
      { exemptionText: `${DOCUMENT_REFRESH_EXEMPTION_PREFIX} internal-only behavior verified` },
    );

    assert.equal(warning, null);
  });

  it("ignores tooling-only changes", () => {
    const warning = warningFor([
      { status: "M", path: "package.json" },
      { status: "M", path: "tsconfig.json" },
      { status: "M", path: "biome.json" },
      { status: "M", path: ".github/workflows/ci.yml" },
    ]);

    assert.equal(warning, null);
  });

  it("ignores release/docs collateral trigger-only changes", () => {
    const warning = warningFor([
      { status: "M", path: "CHANGELOG.md" },
      { status: "M", path: "RELEASE_BODY.md" },
      { status: "M", path: "docs/release-notes-0.14.3.md" },
      { status: "M", path: "docs/qa/release-readiness-20260423.md" },
    ]);

    assert.equal(warning, null);
  });

  it("ignores rename-only changes", () => {
    const warning = warningFor([
      { status: "R100", previousPath: "src/cli/old.ts", path: "src/cli/new.ts" },
    ]);

    assert.equal(warning, null);
  });

  it("ignores non-user-facing internal test-only change", () => {
    const warning = warningFor([
      { status: "M", path: "src/cli/__tests__/internal.test.ts" },
    ]);

    assert.equal(warning, null);
  });

  it("parses git name-status rename records", () => {
    assert.deepEqual(parseGitNameStatus("M\tsrc/scripts/codex-native-hook.ts\nR100\tsrc/cli/old.ts\tsrc/cli/new.ts\n"), [
      { status: "M", path: "src/scripts/codex-native-hook.ts" },
      { status: "R100", previousPath: "src/cli/old.ts", path: "src/cli/new.ts" },
    ]);
  });

  it("recognizes only terminal-looking final handoff text for Stop warnings", () => {
    assert.equal(isFinalHandoffDocumentRefreshCandidate("Launch-ready: yes"), true);
    assert.equal(isFinalHandoffDocumentRefreshCandidate("All verification passed; ready to merge."), true);
    assert.equal(isFinalHandoffDocumentRefreshCandidate("Task completed with green verification."), true);
    assert.equal(isFinalHandoffDocumentRefreshCandidate("I am done inspecting and will edit next."), false);
    assert.equal(isFinalHandoffDocumentRefreshCandidate("I will keep working on the implementation."), false);
    assert.equal(isFinalHandoffDocumentRefreshCandidate(""), false);
  });

  it("final handoff local .omx freshness suppresses when planning spec is newer than source", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-document-refresh-fresh-"));
    try {
      const sourcePath = join(cwd, "src", "scripts", "codex-native-hook.ts");
      const planPath = join(cwd, ".omx", "plans", "prd-native-hook-behavior.md");
      await mkdir(join(cwd, "src", "scripts"), { recursive: true });
      await mkdir(join(cwd, ".omx", "plans"), { recursive: true });
      await writeFile(sourcePath, "source", "utf-8");
      await writeFile(planPath, "plan", "utf-8");
      const oldDate = new Date("2026-04-23T00:00:00Z");
      const newDate = new Date("2026-04-23T01:00:00Z");
      await utimes(sourcePath, oldDate, oldDate);
      await utimes(planPath, newDate, newDate);

      const changes = [{ status: "M", path: "src/scripts/codex-native-hook.ts" }];
      const freshTargets = findFreshLocalPlanningTargets(cwd, changes);
      assert.deepEqual(freshTargets, [".omx/plans/prd-native-hook-behavior.md"]);
      assert.equal(warningFor(changes, { scope: "final-handoff", localFreshTargets: freshTargets }), null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
