import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getSkillDisplayLabel } from "../skill-display.js";

describe("getSkillDisplayLabel", () => {
  it("prefixes OMX-installed skills without mutating their canonical name", () => {
    assert.equal(
      getSkillDisplayLabel({
        name: "plan",
        origin: "omx",
      }),
      "OMX: plan",
    );
  });

  it("leaves non-OMX skill names unchanged", () => {
    assert.equal(
      getSkillDisplayLabel({
        name: "custom-project",
        origin: "project",
      }),
      "custom-project",
    );
    assert.equal(
      getSkillDisplayLabel({
        name: "github:gh-fix-ci",
        origin: "user",
      }),
      "github:gh-fix-ci",
    );
  });
});
