import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getUnifiedMcpRegistryCandidates,
  loadUnifiedMcpRegistry,
} from "../mcp-registry.js";

describe("unified MCP registry loader", () => {
  it("prefers ~/.omx/mcp-registry.json over ~/.omc/mcp-registry.json", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-mcp-registry-"));
    try {
      const omxPath = join(wd, ".omx", "mcp-registry.json");
      const omcPath = join(wd, ".omc", "mcp-registry.json");
      await mkdir(join(wd, ".omx"), { recursive: true });
      await mkdir(join(wd, ".omc"), { recursive: true });

      await writeFile(
        omxPath,
        JSON.stringify({
          eslint: { command: "npx", args: ["@eslint/mcp@latest"], timeout: 11 },
        }),
      );
      await writeFile(
        omcPath,
        JSON.stringify({
          gitnexus: { command: "gitnexus", args: ["mcp"] },
        }),
      );

      const result = await loadUnifiedMcpRegistry({ homeDir: wd });
      assert.equal(result.sourcePath, omxPath);
      assert.deepEqual(result.servers.map((server) => server.name), ["eslint"]);
      assert.equal(result.servers[0].startupTimeoutSec, 11);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("falls back to ~/.omc/mcp-registry.json when ~/.omx registry is absent", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-mcp-registry-"));
    try {
      const omcPath = join(wd, ".omc", "mcp-registry.json");
      await mkdir(join(wd, ".omc"), { recursive: true });
      await writeFile(
        omcPath,
        JSON.stringify({
          gitnexus: { command: "gitnexus", args: ["mcp"], enabled: false },
        }),
      );

      const result = await loadUnifiedMcpRegistry({ homeDir: wd });
      assert.equal(result.sourcePath, omcPath);
      assert.equal(result.servers.length, 1);
      assert.equal(result.servers[0].name, "gitnexus");
      assert.equal(result.servers[0].enabled, false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("skips invalid entries but keeps valid entries from the same file", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-mcp-registry-"));
    try {
      const registryPath = join(wd, "registry.json");
      await writeFile(
        registryPath,
        JSON.stringify({
          bad_type: "not-an-object",
          bad_args: { command: "npx", args: [1, 2, 3] },
          good: { command: "npx", args: ["@eslint/mcp@latest"], timeout: 7 },
        }),
      );

      const result = await loadUnifiedMcpRegistry({
        candidates: [registryPath],
      });
      assert.equal(result.servers.length, 1);
      assert.equal(result.servers[0].name, "good");
      assert.equal(result.servers[0].startupTimeoutSec, 7);
      assert.equal(result.warnings.length >= 2, true);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("returns canonical home-based registry candidates", () => {
    const candidates = getUnifiedMcpRegistryCandidates("/tmp/home");
    assert.deepEqual(candidates, [
      "/tmp/home/.omx/mcp-registry.json",
      "/tmp/home/.omc/mcp-registry.json",
    ]);
  });
});
