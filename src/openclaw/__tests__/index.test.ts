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

  it("includes channel/to/threadId in HTTP payload when OPENCLAW_REPLY_* env vars set", async () => {
    process.env.OMX_OPENCLAW = "1";
    process.env.OPENCLAW_REPLY_CHANNEL = "#general";
    process.env.OPENCLAW_REPLY_TARGET = "user42";
    process.env.OPENCLAW_REPLY_THREAD = "thread-abc";

    // Use a local HTTP server to capture the payload
    const { createServer } = await import("http");
    let capturedBody = "";
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        capturedBody = body;
        res.writeHead(200);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    const configPath = join(tmpDir, "openclaw.json");
    writeFileSync(configPath, JSON.stringify({
      enabled: true,
      gateways: { gw: { type: "http", url: `http://127.0.0.1:${port}/hook` } },
      hooks: {
        "session-start": { gateway: "gw", instruction: "hello", enabled: true },
      },
    }));
    process.env.OMX_OPENCLAW_CONFIG = configPath;
    const { wakeOpenClaw } = await import("../index.js");
    const { resetOpenClawConfigCache } = await import("../config.js");
    resetOpenClawConfigCache();

    const result = await wakeOpenClaw("session-start", { sessionId: "s1" });
    server.close();

    assert.ok(result !== null);
    assert.equal(result!.success, true);

    const parsed = JSON.parse(capturedBody);
    assert.equal(parsed.channel, "#general");
    assert.equal(parsed.to, "user42");
    assert.equal(parsed.threadId, "thread-abc");
    // Also in whitelisted context
    assert.equal(parsed.context.replyChannel, "#general");
    assert.equal(parsed.context.replyTarget, "user42");
    assert.equal(parsed.context.replyThread, "thread-abc");
  });

  it("omits channel/to/threadId from HTTP payload when env vars not set", async () => {
    process.env.OMX_OPENCLAW = "1";
    delete process.env.OPENCLAW_REPLY_CHANNEL;
    delete process.env.OPENCLAW_REPLY_TARGET;
    delete process.env.OPENCLAW_REPLY_THREAD;

    const { createServer } = await import("http");
    let capturedBody = "";
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        capturedBody = body;
        res.writeHead(200);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    const configPath = join(tmpDir, "openclaw.json");
    writeFileSync(configPath, JSON.stringify({
      enabled: true,
      gateways: { gw: { type: "http", url: `http://127.0.0.1:${port}/hook` } },
      hooks: {
        "session-start": { gateway: "gw", instruction: "hello", enabled: true },
      },
    }));
    process.env.OMX_OPENCLAW_CONFIG = configPath;
    const { wakeOpenClaw } = await import("../index.js");
    const { resetOpenClawConfigCache } = await import("../config.js");
    resetOpenClawConfigCache();

    const result = await wakeOpenClaw("session-start", { sessionId: "s1" });
    server.close();

    assert.ok(result !== null);
    assert.equal(result!.success, true);

    const parsed = JSON.parse(capturedBody);
    assert.equal(parsed.channel, undefined, "channel should be absent");
    assert.equal(parsed.to, undefined, "to should be absent");
    assert.equal(parsed.threadId, undefined, "threadId should be absent");
    assert.equal(parsed.context.replyChannel, undefined);
    assert.equal(parsed.context.replyTarget, undefined);
    assert.equal(parsed.context.replyThread, undefined);
  });

  it("context.replyChannel takes precedence over env var", async () => {
    process.env.OMX_OPENCLAW = "1";
    process.env.OPENCLAW_REPLY_CHANNEL = "env-channel";

    const { createServer } = await import("http");
    let capturedBody = "";
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        capturedBody = body;
        res.writeHead(200);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    const configPath = join(tmpDir, "openclaw.json");
    writeFileSync(configPath, JSON.stringify({
      enabled: true,
      gateways: { gw: { type: "http", url: `http://127.0.0.1:${port}/hook` } },
      hooks: {
        "session-start": { gateway: "gw", instruction: "hello", enabled: true },
      },
    }));
    process.env.OMX_OPENCLAW_CONFIG = configPath;
    const { wakeOpenClaw } = await import("../index.js");
    const { resetOpenClawConfigCache } = await import("../config.js");
    resetOpenClawConfigCache();

    const result = await wakeOpenClaw("session-start", {
      sessionId: "s1",
      replyChannel: "ctx-channel",
    });
    server.close();

    assert.ok(result !== null);
    const parsed = JSON.parse(capturedBody);
    assert.equal(parsed.channel, "ctx-channel", "context value should win over env var");
    assert.equal(parsed.context.replyChannel, "ctx-channel");
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
