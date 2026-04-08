import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveRuntimeProvider,
  resolveRuntimeCommand,
  resolveRuntimeLeadingArgs,
  resolveRuntimeHomeEnvVar,
  resolveProjectRuntimeHome,
} from "../provider.js";

describe("runtime provider", () => {
  it("defaults to codex", () => {
    assert.equal(resolveRuntimeProvider({}), "codex");
  });

  it("supports explicit cursor provider", () => {
    assert.equal(resolveRuntimeProvider({ OMX_RUNTIME_PROVIDER: "cursor" }), "cursor");
    assert.equal(resolveRuntimeCommand("cursor"), "agent");
    assert.deepEqual(resolveRuntimeLeadingArgs("cursor"), []);
    assert.equal(resolveRuntimeHomeEnvVar("cursor"), "CURSOR_HOME");
  });

  it("resolves project runtime home by provider", () => {
    assert.equal(resolveProjectRuntimeHome("codex", "/repo"), "/repo/.codex");
    assert.equal(resolveProjectRuntimeHome("cursor", "/repo"), "/repo/.cursor");
  });
});
