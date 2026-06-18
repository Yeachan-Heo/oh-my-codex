import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildUnifiedLedger, refreshUnifiedLedger, searchUnifiedEntries } from "../index.js";

describe("unified session ledger", () => {
  it("collects CLI/API rollout metadata and App cache metadata read-only", async () => {
    const home = await mkdtemp(join(tmpdir(), "omx-ledger-"));
    const codexHome = join(home, ".codex");
    const appSupport = join(home, "app-support");
    try {
      const rollout = join(codexHome, "sessions", "2026", "06", "13", "rollout-session-a.jsonl");
      await mkdir(dirname(rollout), { recursive: true });
      await writeFile(join(codexHome, "auth.json"), '{"auth_mode":"apikey","OPENAI_API_KEY":"sk-secret"}\n');
      await writeFile(rollout, JSON.stringify({
        type: "session_meta",
        payload: { id: "session-a", timestamp: "2026-06-13T01:00:00.000Z", cwd: "/repo" },
      }) + "\n" + JSON.stringify({
        type: "event_msg",
        payload: { type: "user_message", message: "deep-only transcript phrase with sk-secret999" },
      }) + "\n");
      const appDir = join(appSupport, "codex-taskItems-v2-default-user");
      await mkdir(appDir, { recursive: true });

      const entries = await buildUnifiedLedger({ home, codexHomeDir: codexHome, appSupportDir: appSupport });
      assert.equal(entries.some((entry) => entry.sessionId === "session-a" && entry.source === "api"), true);
      assert.equal(entries.some((entry) => entry.sessionId === "codex-taskItems-v2-default-user" && entry.source === "app"), true);
      assert.equal(searchUnifiedEntries(entries, "repo").some((entry) => entry.sessionId === "session-a"), true);

      await refreshUnifiedLedger({ home, codexHomeDir: codexHome, appSupportDir: appSupport });
      const ledger = await readFile(join(home, ".omx", "state", "session-ledger.jsonl"), "utf-8");
      assert.match(ledger, /session-a/);
      assert.doesNotMatch(ledger, /sk-secret/);
      assert.doesNotMatch(ledger, /deep-only transcript phrase/);

      const deepEntries = await refreshUnifiedLedger({ home, codexHomeDir: codexHome, appSupportDir: appSupport, deep: true });
      assert.equal(searchUnifiedEntries(deepEntries, "deep-only transcript phrase").some((entry) => entry.sessionId === "session-a"), true);
      const shallowLedger = await readFile(join(home, ".omx", "state", "session-ledger.jsonl"), "utf-8");
      assert.doesNotMatch(shallowLedger, /deep-only transcript phrase/);
      assert.doesNotMatch(JSON.stringify(deepEntries), /sk-secret999/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
