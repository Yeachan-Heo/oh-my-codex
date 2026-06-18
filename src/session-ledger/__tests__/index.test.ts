import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildUnifiedLedger,
  copyUnifiedSessionIdentity,
  refreshUnifiedLedger,
  resolveSessionLedgerPath,
  resolveUnifiedSessionIdentityPath,
  searchUnifiedEntries,
  writeUnifiedSessionIdentity,
} from "../index.js";

async function writeRollout(codexHome: string, isoDate: string, fileName: string, payload: Record<string, unknown>): Promise<void> {
  const [year, month, day] = isoDate.slice(0, 10).split("-");
  const rollout = join(codexHome, "sessions", year, month, day, fileName);
  await mkdir(dirname(rollout), { recursive: true });
  await writeFile(rollout, `${JSON.stringify({
    type: "session_meta",
    payload,
  })}\n`);
}

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
        payload: { id: "session-a", timestamp: "2026-06-13T01:00:00.000Z", cwd: "/repo", auth_mode: "apikey" },
      }) + "\n" + JSON.stringify({
        type: "event_msg",
        payload: { type: "user_message", message: "deep-only transcript phrase with sk-secret999" },
      }) + "\n" + JSON.stringify({
        type: "response_item",
        payload: { item: { type: "function_call", name: "shell", arguments: '{"cmd":"rg function-argument-only-marker src"}' } },
      }) + "\n");
      const appDir = join(appSupport, "codex-taskItems-v2-default-user");
      await mkdir(appDir, { recursive: true });
      await writeFile(join(appDir, "cache.json"), JSON.stringify({
        title: "App task with sk-appsecret999",
        summary: "Cached summary with access_token:app-token-secret",
      }));

      const entries = await buildUnifiedLedger({ home, codexHomeDir: codexHome, appSupportDir: appSupport });
      assert.equal(entries.some((entry) => entry.sessionId === "session-a" && entry.source === "api"), true);
      assert.equal(entries.some((entry) => entry.sessionId === "codex-taskItems-v2-default-user" && entry.source === "app"), true);
      assert.doesNotMatch(JSON.stringify(entries), /sk-appsecret999|app-token-secret/);
      assert.equal(searchUnifiedEntries(entries, "repo").some((entry) => entry.sessionId === "session-a"), true);

      await refreshUnifiedLedger({ home, codexHomeDir: codexHome, appSupportDir: appSupport });
      const ledger = await readFile(join(home, ".omx", "state", "session-ledger.jsonl"), "utf-8");
      assert.match(ledger, /session-a/);
      assert.doesNotMatch(ledger, /sk-secret/);
      assert.doesNotMatch(ledger, /deep-only transcript phrase/);

      const deepEntries = await refreshUnifiedLedger({ home, codexHomeDir: codexHome, appSupportDir: appSupport, deep: true });
      assert.equal(searchUnifiedEntries(deepEntries, "deep-only transcript phrase").some((entry) => entry.sessionId === "session-a"), true);
      assert.equal(searchUnifiedEntries(deepEntries, "function-argument-only-marker").some((entry) => entry.sessionId === "session-a"), true);
      const shallowLedger = await readFile(join(home, ".omx", "state", "session-ledger.jsonl"), "utf-8");
      assert.doesNotMatch(shallowLedger, /deep-only transcript phrase/);
      assert.doesNotMatch(shallowLedger, /function-argument-only-marker/);
      assert.doesNotMatch(JSON.stringify(deepEntries), /sk-secret999/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("does not stamp historical CLI sessions with the current auth slot", async () => {
    const home = await mkdtemp(join(tmpdir(), "omx-ledger-slot-"));
    const codexHome = join(home, ".codex");
    const appSupport = join(home, "app-support");
    try {
      const implicitRollout = join(codexHome, "sessions", "2026", "06", "13", "rollout-implicit.jsonl");
      const explicitRollout = join(codexHome, "sessions", "2026", "06", "14", "rollout-explicit.jsonl");
      await mkdir(dirname(implicitRollout), { recursive: true });
      await mkdir(dirname(explicitRollout), { recursive: true });
      await mkdir(join(home, ".omx", "auth"), { recursive: true });
      await writeFile(join(home, ".omx", "auth", "slots.json"), JSON.stringify({
        version: 1,
        currentSlot: "current-api",
        slots: [{ slot: "current-api", createdAt: "", updatedAt: "", kind: "api" }],
      }));
      await writeFile(join(codexHome, "auth.json"), '{"auth_mode":"apikey","OPENAI_API_KEY":"sk-secret"}\n');
      await writeFile(implicitRollout, `${JSON.stringify({
        type: "session_meta",
        payload: { id: "implicit-session", timestamp: "2026-06-13T01:00:00.000Z", cwd: "/repo" },
      })}\n`);
      await writeFile(explicitRollout, `${JSON.stringify({
        type: "session_meta",
        payload: {
          id: "explicit-session",
          timestamp: "2026-06-14T01:00:00.000Z",
          cwd: "/repo",
          omx_auth_slot: "created-chatgpt",
        },
      })}\n`);

      const entries = await buildUnifiedLedger({ home, codexHomeDir: codexHome, appSupportDir: appSupport });
      assert.equal(entries.find((entry) => entry.sessionId === "implicit-session")?.identitySlot, undefined);
      assert.equal(entries.find((entry) => entry.sessionId === "implicit-session")?.source, "cli");
      assert.equal(entries.find((entry) => entry.sessionId === "implicit-session")?.authMode, undefined);
      assert.equal(entries.find((entry) => entry.sessionId === "explicit-session")?.identitySlot, "created-chatgpt");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("uses launch identity sidecars only when rollout metadata omits the slot", async () => {
    const home = await mkdtemp(join(tmpdir(), "omx-ledger-sidecar-"));
    const codexHome = join(home, ".codex");
    const appSupport = join(home, "app-support");
    try {
      await writeRollout(codexHome, "2026-06-13T01:00:00.000Z", "rollout-sidecar.jsonl", {
        id: "sidecar-session",
        timestamp: "2026-06-13T01:00:00.000Z",
        cwd: "/repo",
      });
      await writeRollout(codexHome, "2026-06-14T01:00:00.000Z", "rollout-explicit-sidecar.jsonl", {
        id: "explicit-sidecar-session",
        timestamp: "2026-06-14T01:00:00.000Z",
        cwd: "/repo",
        omx_auth_slot: "rollout-slot",
        omx_auth_mode: "chatgpt",
      });
      await writeUnifiedSessionIdentity(codexHome, {
        version: 1,
        sessionId: "sidecar-session",
        identitySlot: "sidecar-slot",
        authMode: "api",
        createdAt: "2026-06-13T00:59:00.000Z",
      });
      await writeUnifiedSessionIdentity(codexHome, {
        version: 1,
        sessionId: "explicit-sidecar-session",
        identitySlot: "sidecar-should-not-win",
        authMode: "api",
        createdAt: "2026-06-14T00:59:00.000Z",
      });

      const entries = await buildUnifiedLedger({ home, codexHomeDir: codexHome, appSupportDir: appSupport });
      const sidecarEntry = entries.find((entry) => entry.sessionId === "sidecar-session");
      assert.equal(sidecarEntry?.identitySlot, "sidecar-slot");
      assert.equal(sidecarEntry?.authMode, "api");
      assert.equal(sidecarEntry?.source, "api");
      const explicitEntry = entries.find((entry) => entry.sessionId === "explicit-sidecar-session");
      assert.equal(explicitEntry?.identitySlot, "rollout-slot");
      assert.equal(explicitEntry?.authMode, "chatgpt");
      assert.equal(explicitEntry?.source, "cli");

      if (process.platform !== "win32") {
        const sidecarPath = resolveUnifiedSessionIdentityPath(codexHome, "sidecar-session");
        assert.equal((await stat(dirname(sidecarPath))).mode & 0o777, 0o700);
        assert.equal((await stat(sidecarPath)).mode & 0o777, 0o600);
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("can copy a launch wrapper identity sidecar to the native Codex session id", async () => {
    const home = await mkdtemp(join(tmpdir(), "omx-ledger-sidecar-native-"));
    const codexHome = join(home, ".codex");
    const appSupport = join(home, "app-support");
    try {
      await writeRollout(codexHome, "2026-06-13T01:00:00.000Z", "rollout-native-sidecar.jsonl", {
        id: "native-codex-session",
        timestamp: "2026-06-13T01:00:00.000Z",
        cwd: "/repo",
      });
      await writeUnifiedSessionIdentity(codexHome, {
        version: 1,
        sessionId: "omx-wrapper-session",
        identitySlot: "wrapper-slot",
        authMode: "chatgpt",
        createdAt: "2026-06-13T00:59:00.000Z",
      });

      assert.equal(
        await copyUnifiedSessionIdentity(codexHome, "omx-wrapper-session", "native-codex-session"),
        true,
      );
      assert.equal(
        await copyUnifiedSessionIdentity(codexHome, "missing-wrapper-session", "unused-native-session"),
        false,
      );

      const entries = await buildUnifiedLedger({ home, codexHomeDir: codexHome, appSupportDir: appSupport });
      const nativeEntry = entries.find((entry) => entry.sessionId === "native-codex-session");
      assert.equal(nativeEntry?.identitySlot, "wrapper-slot");
      assert.equal(nativeEntry?.authMode, "chatgpt");
      assert.equal(nativeEntry?.source, "cli");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("does not overwrite an existing native Codex session identity sidecar", async () => {
    const home = await mkdtemp(join(tmpdir(), "omx-ledger-sidecar-existing-native-"));
    const codexHome = join(home, ".codex");
    const appSupport = join(home, "app-support");
    try {
      await writeRollout(codexHome, "2026-06-13T01:00:00.000Z", "rollout-native-existing-sidecar.jsonl", {
        id: "native-codex-session",
        timestamp: "2026-06-13T01:00:00.000Z",
        cwd: "/repo",
      });
      await writeUnifiedSessionIdentity(codexHome, {
        version: 1,
        sessionId: "omx-wrapper-session",
        identitySlot: "current-wrapper-slot",
        authMode: "api",
        createdAt: "2026-06-13T01:01:00.000Z",
      });
      await writeUnifiedSessionIdentity(codexHome, {
        version: 1,
        sessionId: "native-codex-session",
        identitySlot: "original-native-slot",
        authMode: "chatgpt",
        createdAt: "2026-06-13T00:59:00.000Z",
      });

      assert.equal(
        await copyUnifiedSessionIdentity(codexHome, "omx-wrapper-session", "native-codex-session"),
        false,
      );

      const entries = await buildUnifiedLedger({ home, codexHomeDir: codexHome, appSupportDir: appSupport });
      const nativeEntry = entries.find((entry) => entry.sessionId === "native-codex-session");
      assert.equal(nativeEntry?.identitySlot, "original-native-slot");
      assert.equal(nativeEntry?.authMode, "chatgpt");
      assert.equal(nativeEntry?.source, "cli");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("includes generated project runtime Codex homes when no explicit Codex home is supplied", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-ledger-runtime-"));
    const home = join(cwd, "home");
    const defaultCodexHome = join(home, ".codex");
    const runtimeCodexHome = join(cwd, ".omx", "runtime", "codex-home", "omx-runtime-a");
    const previousCodexHome = process.env.CODEX_HOME;
    try {
      await writeRollout(defaultCodexHome, "2026-06-13T01:00:00.000Z", "rollout-default.jsonl", {
        id: "default-session",
        timestamp: "2026-06-13T01:00:00.000Z",
        cwd,
      });
      await writeRollout(runtimeCodexHome, "2026-06-14T01:00:00.000Z", "rollout-runtime.jsonl", {
        id: "runtime-session",
        timestamp: "2026-06-14T01:00:00.000Z",
        cwd,
      });
      process.env.CODEX_HOME = "";

      const entries = await buildUnifiedLedger({ home, cwd, appSupportDir: join(home, "app-support") });

      assert.equal(entries.some((entry) => entry.sessionId === "default-session" && entry.codexHome === defaultCodexHome), true);
      assert.equal(entries.some((entry) => entry.sessionId === "runtime-session" && entry.codexHome === runtimeCodexHome), true);
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("includes the persisted project Codex home for project-scope unified scans", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-ledger-project-home-"));
    const home = join(cwd, "home");
    const projectCodexHome = join(cwd, ".codex");
    const previousCodexHome = process.env.CODEX_HOME;
    try {
      await mkdir(join(cwd, ".omx"), { recursive: true });
      await writeFile(join(cwd, ".omx", "setup-scope.json"), JSON.stringify({ scope: "project" }));
      await writeRollout(projectCodexHome, "2026-06-15T01:00:00.000Z", "rollout-project.jsonl", {
        id: "project-session",
        timestamp: "2026-06-15T01:00:00.000Z",
        cwd,
      });
      process.env.CODEX_HOME = "";

      const entries = await buildUnifiedLedger({ home, cwd, appSupportDir: join(home, "app-support") });

      assert.equal(entries.some((entry) => entry.sessionId === "project-session" && entry.codexHome === projectCodexHome), true);
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("uses madmax public labels for unified ledger entries without persisting run-root paths", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-ledger-madmax-"));
    const home = join(cwd, "home");
    const runsRoot = join(cwd, "runs");
    const runDir = join(runsRoot, "run-associated");
    const associatedCodexHome = join(runDir, ".omx", "runtime", "codex-home", "omx-madmax-a");
    const previousCodexHome = process.env.CODEX_HOME;
    const previousRunsDir = process.env.OMX_RUNS_DIR;
    try {
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, ".omxbox-run.json"), JSON.stringify({
        source_cwd: cwd,
        run_dir: runDir,
      }));
      await writeRollout(associatedCodexHome, "2026-06-14T01:00:00.000Z", "rollout-madmax.jsonl", {
        id: "madmax-session",
        timestamp: "2026-06-14T01:00:00.000Z",
        cwd,
      });
      process.env.CODEX_HOME = "";
      process.env.OMX_RUNS_DIR = runsRoot;

      const entries = await refreshUnifiedLedger({ home, cwd, appSupportDir: join(home, "app-support") });
      const entry = entries.find((candidate) => candidate.sessionId === "madmax-session");
      assert.equal(entry?.codexHome, "madmax:omx-madmax-a");
      assert.equal(entry?.openTarget, join("madmax:omx-madmax-a", "sessions", "2026", "06", "14", "rollout-madmax.jsonl"));

      const serializedEntries = JSON.stringify(entries);
      const ledger = await readFile(resolveSessionLedgerPath(home), "utf-8");
      assert.equal(serializedEntries.includes(associatedCodexHome), false);
      assert.equal(serializedEntries.includes(runDir), false);
      assert.equal(ledger.includes(associatedCodexHome), false);
      assert.equal(ledger.includes(runDir), false);
      assert.match(ledger, /madmax:omx-madmax-a/);
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      if (previousRunsDir === undefined) delete process.env.OMX_RUNS_DIR;
      else process.env.OMX_RUNS_DIR = previousRunsDir;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("writes refreshed ledger state with owner-only permissions", async () => {
    if (process.platform === "win32") return;
    const cwd = await mkdtemp(join(tmpdir(), "omx-ledger-mode-"));
    const home = join(cwd, "home");
    const codexHome = join(home, ".codex");
    const previousCodexHome = process.env.CODEX_HOME;
    try {
      await writeRollout(codexHome, "2026-06-13T01:00:00.000Z", "rollout-default.jsonl", {
        id: "private-ledger-session",
        timestamp: "2026-06-13T01:00:00.000Z",
        cwd,
      });
      process.env.CODEX_HOME = "";

      await refreshUnifiedLedger({ home, cwd, appSupportDir: join(home, "app-support") });

      const ledgerPath = resolveSessionLedgerPath(home);
      assert.equal((await stat(dirname(ledgerPath))).mode & 0o777, 0o700);
      assert.equal((await stat(ledgerPath)).mode & 0o777, 0o600);
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
