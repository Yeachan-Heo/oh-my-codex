import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isQuotaError } from "../quota-detector.js";
import { buildRotationPlan, nextSlotAfter } from "../rotation.js";
import { redactAuthSecrets } from "../redact.js";

describe("quota detector", () => {
  it("matches structured and stderr quota signals", () => {
    assert.equal(isQuotaError({ structuredError: { status: 429, message: "too many requests" } }), true);
    assert.equal(isQuotaError({ stderr: "Error: quota exceeded for this account" }), true);
    assert.equal(isQuotaError({ stderr: "HTTP 429 rate limit" }), true);
    assert.equal(isQuotaError({ stderr: "syntax error" }), false);
  });
});

describe("auth rotation", () => {
  const slots = ["a", "b", "c"].map((slot) => ({ slot, createdAt: "now", updatedAt: "now" }));

  it("defaults to round-robin from the current slot", () => {
    assert.deepEqual(buildRotationPlan(slots, { rotation: "round-robin", priority: [] }, "b").order, ["b", "c", "a"]);
  });

  it("supports priority order and exhausted skipping", () => {
    const order = buildRotationPlan(slots, { rotation: "priority", priority: ["c", "a"] }, "b").order;
    assert.deepEqual(order, ["c", "a", "b"]);
    assert.equal(nextSlotAfter(order, "c", new Set(["c"])), "a");
    assert.equal(nextSlotAfter(order, "a", new Set(["a", "b", "c"])), undefined);
  });

  it("manual mode does not plan automatic rotation", () => {
    assert.deepEqual(buildRotationPlan(slots, { rotation: "manual", priority: [] }, "b").order, ["b"]);
  });

  it("redacts token-shaped values", () => {
    const redacted = redactAuthSecrets('access_token:"secret-value" Bearer abc.def sk-test-secret123');
    assert.doesNotMatch(redacted, /secret-value|abc\.def|sk-test-secret123/);
  });
});
