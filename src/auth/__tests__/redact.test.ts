import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { redactAuthSecrets } from "../redact.js";

describe("auth secret redaction", () => {
  it("redacts JSON quoted OAuth token fields while preserving key names", () => {
    const redacted = redactAuthSecrets(
      '{"access_token":"sentinel-secret","refresh_token":"refresh-secret","id_token":"id-secret","safe":"visible"}',
    );

    assert.doesNotMatch(redacted, /sentinel-secret|refresh-secret|id-secret/);
    assert.match(redacted, /"access_token"\s*:\s*"\[REDACTED\]"/);
    assert.match(redacted, /"refresh_token"\s*:\s*"\[REDACTED\]"/);
    assert.match(redacted, /"id_token"\s*:\s*"\[REDACTED\]"/);
    assert.match(redacted, /"safe":"visible"/);
  });

  it("redacts JSON OAuth token fields with whitespace and escaped content", () => {
    const redacted = redactAuthSecrets(
      '{ "access_token" : "sentinel-\\"secret", "refresh_token" : "refresh-secret" }',
    );

    assert.doesNotMatch(redacted, /sentinel|refresh-secret/);
    assert.match(redacted, /"access_token"\s*:\s*"\[REDACTED\]"/);
    assert.match(redacted, /"refresh_token"\s*:\s*"\[REDACTED\]"/);
  });
});
