import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { listCommand } from "../list.js";

async function captureStdout(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const log = mock.method(console, "log", (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    await run();
  } finally {
    log.mock.restore();
  }
  return lines;
}

describe("cli/list", () => {
  it("emits the catalog contract as compact JSON for --json", async () => {
    const [line] = await captureStdout(() => listCommand(["--json"]));
    assert.ok(line, "expected JSON output");

    const payload = JSON.parse(line) as {
      version?: string;
      counts?: { skillCount?: number; promptCount?: number };
      skills?: Array<{ name?: string }>;
      agents?: Array<{ name?: string }>;
      aliases?: Array<{ name?: string; canonical?: string }>;
      internalHidden?: string[];
    };

    assert.equal(typeof payload.version, "string");
    assert.ok((payload.counts?.skillCount ?? 0) > 0);
    assert.ok((payload.counts?.promptCount ?? 0) > 0);
    assert.ok(payload.skills?.some((skill) => skill.name === "team"));
    assert.ok(payload.agents?.some((agent) => agent.name === "executor"));
    assert.ok(Array.isArray(payload.aliases));
    assert.ok(Array.isArray(payload.internalHidden));
  });

  it("prints human-readable catalog output without --json", async () => {
    const lines = await captureStdout(() => listCommand([]));
    assert.match(lines[0] ?? "", /^OMX catalog /);
    assert.ok(lines.some((line) => line.startsWith("Skills: ")));
    assert.ok(lines.some((line) => line.includes("team")));
    assert.ok(lines.some((line) => line.startsWith("Agents: ")));
  });
});
