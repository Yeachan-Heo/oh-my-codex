import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAuthStderrRedactor, redactAuthSecrets } from "../redact.js";

describe("auth secret redaction", () => {
  it("redacts every byte split of token records, including multiline fields and UTF-8", () => {
    for (const record of [
      '{"access_token":"synthetic-secret"}\n',
      '{"refresh_token":\n "synthetic-secret"}\n',
      '{"id_token"\n :\n "synthetic-secret"}\n',
      "Bearer synthetic-secret\n",
      'árvíz {"access_token":"synthetic-secret"}',
    ]) {
      const bytes = Buffer.from(record);
      for (let split = 0; split <= bytes.length; split++) {
        let output = "";
        const redactor = createAuthStderrRedactor((text) => { output += text; });
        redactor.write(bytes.subarray(0, split));
        redactor.write(bytes.subarray(split));
        redactor.end();
        assert.equal(output, redactAuthSecrets(record), `split ${split}: ${record}`);
        assert.doesNotMatch(output, /synthetic-secret/);
      }
    }
  });

  it("streams completed safe lines and suppresses oversized records until newline", () => {
    let output = "";
    const redactor = createAuthStderrRedactor((text) => { output += text; });
    redactor.write(Buffer.from("safe line\n"));
    assert.equal(output, "safe line\n");
    redactor.write(Buffer.from('{"access_token":"' + "x".repeat(65 * 1024)));
    redactor.write(Buffer.from('synthetic-secret"}\nquota exceeded\n'));
    redactor.end();
    assert.doesNotMatch(output, /synthetic-secret|xxx/);
    assert.match(output, /suppressed\nquota exceeded\n$/);
  });

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
