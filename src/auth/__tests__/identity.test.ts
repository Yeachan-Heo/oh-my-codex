import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectAuthFileKind, detectAuthKindFromJson, readIdentityStatus } from "../identity.js";

describe("identity detection", () => {
  it("detects API key and ChatGPT auth shapes without exposing credentials", () => {
    assert.deepEqual(detectAuthKindFromJson({ auth_mode: "apikey", OPENAI_API_KEY: "sk-secret" }), {
      kind: "api",
      authMode: "apikey",
    });
    assert.deepEqual(detectAuthKindFromJson({ access_token: "secret-token" }), {
      kind: "chatgpt",
      authMode: undefined,
    });
    assert.equal(detectAuthKindFromJson({}).kind, "unknown");
  });

  it("reports active CODEX_HOME identity status", async () => {
    const home = await mkdtemp(join(tmpdir(), "omx-identity-"));
    try {
      const codexHome = join(home, ".codex");
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, "auth.json"), '{"auth_mode":"apikey","OPENAI_API_KEY":"sk-secret"}\n');
      assert.equal((await detectAuthFileKind(join(codexHome, "auth.json"))).kind, "api");
      const status = await readIdentityStatus(process.cwd(), { CODEX_HOME: codexHome }, home);
      assert.equal(status.kind, "api");
      assert.equal(status.codexHome, codexHome);
      assert.match(status.warnings.join("\n"), /API key/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("matches the live auth file to the actual slot contents", async () => {
    const home = await mkdtemp(join(tmpdir(), "omx-identity-match-"));
    try {
      const codexHome = join(home, ".codex");
      const authDir = join(home, ".omx", "auth");
      await mkdir(codexHome, { recursive: true });
      await mkdir(authDir, { recursive: true });
      await writeFile(join(codexHome, "auth.json"), '{"access_token":"api-live"}\n');
      await writeFile(join(authDir, "main.json"), '{"access_token":"main"}\n');
      await writeFile(join(authDir, "api.json"), '{"access_token":"api-live"}\n');
      await writeFile(join(authDir, "slots.json"), JSON.stringify({ version: 1, currentSlot: "main", slots: [
        { slot: "main", createdAt: "now", updatedAt: "now", kind: "chatgpt" },
        { slot: "api", createdAt: "now", updatedAt: "now", kind: "api" },
      ] }));

      const status = await readIdentityStatus(process.cwd(), { CODEX_HOME: codexHome }, home);
      assert.equal(status.currentSlot, "main");
      assert.equal(status.matchedSlot, "api");
      assert.match(status.warnings.join("\n"), /matches slot "api"/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
