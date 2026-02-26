/**
 * Tests for OpenClaw public API (wakeOpenClaw)
 * Uses node:test and node:assert/strict
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("wakeOpenClaw", () => {
  let tmpDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    tmpDir = join(tmpdir(), `omx-openclaw-index-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, val] of Object.entries(originalEnv)) {
      process.env[key] = val;
    }
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  });

  it("returns null when OMX_OPENCLAW is not set", async () => {
    delete process.env.OMX_OPENCLAW;
    const { wakeOpenClaw } = await import("../index.js");
    const { resetOpenClawConfigCache } = await import("../config.js");
    resetOpenClawConfigCache();
    const result = await wakeOpenClaw("session-start", {});
    assert.equal(result, null);
  });

  it("returns null when config is not found", async () => {
    process.env.OMX_OPENCLAW = "1";
    process.env.OMX_OPENCLAW_CONFIG = join(tmpDir, "nonexistent.json");
    const { wakeOpenClaw } = await import("../index.js");
    const { resetOpenClawConfigCache } = await import("../config.js");
    resetOpenClawConfigCache();
    const result = await wakeOpenClaw("session-start", {});
    assert.equal(result, null);
  });

  it("returns null when event is not mapped", async () => {
    process.env.OMX_OPENCLAW = "1";
    const configPath = join(tmpDir, "openclaw.json");
    writeFileSync(configPath, JSON.stringify({
      enabled: true,
      gateways: { gw: { type: "http", url: "https://example.com/hook" } },
      hooks: {
        // session-start not mapped
      },
    }));
    process.env.OMX_OPENCLAW_CONFIG = configPath;
    const { wakeOpenClaw } = await import("../index.js");
    const { resetOpenClawConfigCache } = await import("../config.js");
    resetOpenClawConfigCache();
    const result = await wakeOpenClaw("session-start", {});
    assert.equal(result, null);
  });

  it("returns null and does not throw on invalid HTTP URL", async () => {
    process.env.OMX_OPENCLAW = "1";
    const configPath = join(tmpDir, "openclaw.json");
    writeFileSync(configPath, JSON.stringify({
      enabled: true,
      gateways: { gw: { type: "http", url: "http://bad-remote.example.com/hook" } },
      hooks: {
        "session-start": { gateway: "gw", instruction: "hello", enabled: true },
      },
    }));
    process.env.OMX_OPENCLAW_CONFIG = configPath;
    const { wakeOpenClaw } = await import("../index.js");
    const { resetOpenClawConfigCache } = await import("../config.js");
    resetOpenClawConfigCache();
    // Should return a result (with success: false) rather than null, or null
    // Either way, it must not throw
    let threw = false;
    try {
      await wakeOpenClaw("session-start", { sessionId: "test-123" });
    } catch {
      threw = true;
    }
    assert.equal(threw, false);
  });

  it("returns result with success:false for disabled command gateway", async () => {
    process.env.OMX_OPENCLAW = "1";
    delete process.env.OMX_OPENCLAW_COMMAND;
    const configPath = join(tmpDir, "openclaw.json");
    writeFileSync(configPath, JSON.stringify({
      enabled: true,
      gateways: { cmd: { type: "command", command: "echo hello" } },
      hooks: {
        "stop": { gateway: "cmd", instruction: "Stopped", enabled: true },
      },
    }));
    process.env.OMX_OPENCLAW_CONFIG = configPath;
    const { wakeOpenClaw } = await import("../index.js");
    const { resetOpenClawConfigCache } = await import("../config.js");
    resetOpenClawConfigCache();
    const result = await wakeOpenClaw("stop", { projectPath: "/some/project" });
    // Should return a result, not null (gateway was found but command gate blocked)
    assert.ok(result !== null);
    assert.equal(result!.success, false);
    assert.ok(result!.error?.includes("OMX_OPENCLAW_COMMAND"));
  });

  it("succeeds with command gateway when both env vars set", async () => {
    process.env.OMX_OPENCLAW = "1";
    process.env.OMX_OPENCLAW_COMMAND = "1";
    const configPath = join(tmpDir, "openclaw.json");
    writeFileSync(configPath, JSON.stringify({
      enabled: true,
      gateways: { cmd: { type: "command", command: "true" } },
      hooks: {
        "session-end": { gateway: "cmd", instruction: "Ended", enabled: true },
      },
    }));
    process.env.OMX_OPENCLAW_CONFIG = configPath;
    const { wakeOpenClaw } = await import("../index.js");
    const { resetOpenClawConfigCache } = await import("../config.js");
    resetOpenClawConfigCache();
    const result = await wakeOpenClaw("session-end", { projectPath: "/some/project" });
    assert.ok(result !== null);
    assert.equal(result!.success, true);
  });
});
