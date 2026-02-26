/**
 * Tests for OpenClaw config reader
 * Uses node:test and node:assert/strict
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// We'll test by controlling env vars and a temp config dir

describe("getOpenClawConfig", () => {
  let tmpDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    tmpDir = join(tmpdir(), `omx-openclaw-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    // Restore env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, val] of Object.entries(originalEnv)) {
      process.env[key] = val;
    }
    // Clean up temp dir
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
    // Reset cache between tests (dynamic import to allow resetting)
  });

  it("returns null when OMX_OPENCLAW is not set", async () => {
    delete process.env.OMX_OPENCLAW;
    const { getOpenClawConfig, resetOpenClawConfigCache } = await import("../config.js");
    resetOpenClawConfigCache();
    const result = getOpenClawConfig();
    assert.equal(result, null);
  });

  it("returns null when OMX_OPENCLAW !== '1'", async () => {
    process.env.OMX_OPENCLAW = "0";
    const { getOpenClawConfig, resetOpenClawConfigCache } = await import("../config.js");
    resetOpenClawConfigCache();
    const result = getOpenClawConfig();
    assert.equal(result, null);
  });

  it("returns null when OMX_OPENCLAW_CONFIG file does not exist", async () => {
    process.env.OMX_OPENCLAW = "1";
    process.env.OMX_OPENCLAW_CONFIG = join(tmpDir, "nonexistent.json");
    const { getOpenClawConfig, resetOpenClawConfigCache } = await import("../config.js");
    resetOpenClawConfigCache();
    const result = getOpenClawConfig();
    assert.equal(result, null);
  });

  it("reads config from OMX_OPENCLAW_CONFIG override file", async () => {
    process.env.OMX_OPENCLAW = "1";
    const configPath = join(tmpDir, "openclaw.json");
    const config = {
      enabled: true,
      gateways: {
        myGateway: { type: "http" as const, url: "https://example.com/hook" },
      },
      hooks: {
        "session-start": { gateway: "myGateway", instruction: "Session started", enabled: true },
      },
    };
    writeFileSync(configPath, JSON.stringify(config));
    process.env.OMX_OPENCLAW_CONFIG = configPath;
    const { getOpenClawConfig, resetOpenClawConfigCache } = await import("../config.js");
    resetOpenClawConfigCache();
    const result = getOpenClawConfig();
    assert.ok(result !== null);
    assert.equal(result!.enabled, true);
    assert.ok("myGateway" in result!.gateways);
  });

  it("returns null when config has enabled: false", async () => {
    process.env.OMX_OPENCLAW = "1";
    const configPath = join(tmpDir, "openclaw.json");
    writeFileSync(configPath, JSON.stringify({ enabled: false, gateways: {}, hooks: {} }));
    process.env.OMX_OPENCLAW_CONFIG = configPath;
    const { getOpenClawConfig, resetOpenClawConfigCache } = await import("../config.js");
    resetOpenClawConfigCache();
    const result = getOpenClawConfig();
    assert.equal(result, null);
  });

  it("returns null for invalid JSON", async () => {
    process.env.OMX_OPENCLAW = "1";
    const configPath = join(tmpDir, "openclaw.json");
    writeFileSync(configPath, "not-valid-json{{{");
    process.env.OMX_OPENCLAW_CONFIG = configPath;
    const { getOpenClawConfig, resetOpenClawConfigCache } = await import("../config.js");
    resetOpenClawConfigCache();
    const result = getOpenClawConfig();
    assert.equal(result, null);
  });
});

describe("resolveGateway", () => {
  it("returns null when event not in hooks", async () => {
    const { resolveGateway } = await import("../config.js");
    const config = {
      enabled: true,
      gateways: { gw: { url: "https://example.com", type: "http" as const } },
      hooks: {},
    };
    const result = resolveGateway(config, "session-start");
    assert.equal(result, null);
  });

  it("returns null when mapping is disabled", async () => {
    const { resolveGateway } = await import("../config.js");
    const config = {
      enabled: true,
      gateways: { gw: { url: "https://example.com", type: "http" as const } },
      hooks: {
        "session-start": { gateway: "gw", instruction: "hi", enabled: false },
      },
    };
    const result = resolveGateway(config, "session-start");
    assert.equal(result, null);
  });

  it("returns null when gateway name not found", async () => {
    const { resolveGateway } = await import("../config.js");
    const config = {
      enabled: true,
      gateways: {},
      hooks: {
        "session-start": { gateway: "missing", instruction: "hi", enabled: true },
      },
    };
    const result = resolveGateway(config, "session-start");
    assert.equal(result, null);
  });

  it("resolves an HTTP gateway", async () => {
    const { resolveGateway } = await import("../config.js");
    const config = {
      enabled: true,
      gateways: { gw: { url: "https://example.com/hook", type: "http" as const } },
      hooks: {
        "session-start": { gateway: "gw", instruction: "Session started", enabled: true },
      },
    };
    const result = resolveGateway(config, "session-start");
    assert.ok(result !== null);
    assert.equal(result!.gatewayName, "gw");
    assert.equal(result!.instruction, "Session started");
  });

  it("resolves a command gateway", async () => {
    const { resolveGateway } = await import("../config.js");
    const config = {
      enabled: true,
      gateways: { cmd: { type: "command" as const, command: "echo hello" } },
      hooks: {
        "stop": { gateway: "cmd", instruction: "Stopped", enabled: true },
      },
    };
    const result = resolveGateway(config, "stop");
    assert.ok(result !== null);
    assert.equal(result!.gatewayName, "cmd");
  });

  it("returns null when HTTP gateway has no url", async () => {
    const { resolveGateway } = await import("../config.js");
    const config = {
      enabled: true,
      gateways: { gw: { url: "", type: "http" as const } },
      hooks: {
        "session-start": { gateway: "gw", instruction: "hi", enabled: true },
      },
    };
    const result = resolveGateway(config, "session-start");
    assert.equal(result, null);
  });
});
