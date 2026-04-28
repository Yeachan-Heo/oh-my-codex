import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { mcpParityCommand } from "../mcp-parity.js";

const originalLog = console.log;

afterEach(() => {
  console.log = originalLog;
  process.exitCode = undefined;
});

function captureLogs(): string[] {
  const logs: string[] = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(" "));
  };
  return logs;
}

describe("mcpParityCommand", () => {
  it("supports state write/read parity via CLI", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-mcp-parity-state-"));
    const logs = captureLogs();

    try {
      await mcpParityCommand("state", [
        "state_write",
        "--input",
        JSON.stringify({ mode: "ralph", active: true, current_phase: "executing", workingDirectory: cwd }),
        "--json",
      ]);
      const writeResult = JSON.parse(logs.pop() || "{}") as { path?: string };
      assert.match(writeResult.path ?? "", /ralph-state\.json$/);

      await mcpParityCommand("state", [
        "state_read",
        "--input",
        JSON.stringify({ mode: "ralph", workingDirectory: cwd }),
        "--json",
      ]);
      const readResult = JSON.parse(logs.pop() || "{}") as { active?: boolean; current_phase?: string };
      assert.equal(readResult.active, true);
      assert.equal(readResult.current_phase, "executing");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("preserves session-scoped state when used as the state fallback path", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-mcp-parity-state-session-"));
    const logs = captureLogs();
    const previousDisable = process.env.OMX_STATE_SERVER_DISABLE_AUTO_START;

    try {
      process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = "1";
      await mcpParityCommand("state", [
        "write",
        "--input",
        JSON.stringify({
          mode: "ralph",
          active: true,
          current_phase: "executing",
          session_id: "session-fallback",
          workingDirectory: cwd,
        }),
        "--json",
      ]);
      const writeResult = JSON.parse(logs.pop() || "{}") as { path?: string };
      assert.equal(
        writeResult.path,
        join(cwd, ".omx", "state", "sessions", "session-fallback", "ralph-state.json"),
      );

      await mcpParityCommand("state", [
        "read",
        "--input",
        JSON.stringify({
          mode: "ralph",
          session_id: "session-fallback",
          workingDirectory: cwd,
        }),
        "--json",
      ]);
      const readResult = JSON.parse(logs.pop() || "{}") as {
        active?: boolean;
        current_phase?: string;
        owner_omx_session_id?: string;
      };
      assert.equal(readResult.active, true);
      assert.equal(readResult.current_phase, "executing");
      assert.equal(readResult.owner_omx_session_id, "session-fallback");
    } finally {
      if (typeof previousDisable === "string") process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = previousDisable;
      else delete process.env.OMX_STATE_SERVER_DISABLE_AUTO_START;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("matches state tool outcome-clearing semantics on fallback writes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-mcp-parity-state-outcome-"));
    const logs = captureLogs();

    try {
      await mcpParityCommand("state", [
        "write",
        "--input",
        JSON.stringify({
          mode: "deep-interview",
          active: false,
          lifecycle_outcome: "finished",
          workingDirectory: cwd,
        }),
        "--json",
      ]);
      logs.pop();

      await mcpParityCommand("state", [
        "write",
        "--input",
        JSON.stringify({
          mode: "deep-interview",
          active: true,
          current_phase: "intent",
          workingDirectory: cwd,
        }),
        "--json",
      ]);
      logs.pop();

      await mcpParityCommand("state", [
        "read",
        "--input",
        JSON.stringify({ mode: "deep-interview", workingDirectory: cwd }),
        "--json",
      ]);
      const readResult = JSON.parse(logs.pop() || "{}") as {
        active?: boolean;
        lifecycle_outcome?: string;
        run_outcome?: string;
      };
      assert.equal(readResult.active, true);
      assert.equal(readResult.lifecycle_outcome, undefined);
      assert.equal(readResult.run_outcome, "continue");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("supports notepad and project-memory parity via CLI", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-mcp-parity-memory-"));
    const logs = captureLogs();

    try {
      await mcpParityCommand("notepad", [
        "notepad_write_working",
        "--input",
        JSON.stringify({ content: "Investigating MCP transport death", workingDirectory: cwd }),
        "--json",
      ]);
      const notepadWrite = JSON.parse(logs.pop() || "{}") as { success?: boolean };
      assert.equal(notepadWrite.success, true);

      await mcpParityCommand("notepad", [
        "notepad_read",
        "--input",
        JSON.stringify({ workingDirectory: cwd }),
        "--json",
      ]);
      const notepadRead = JSON.parse(logs.pop() || "{}") as { content?: string };
      assert.match(notepadRead.content ?? "", /Investigating MCP transport death/);

      await mcpParityCommand("project-memory", [
        "project_memory_add_note",
        "--input",
        JSON.stringify({ category: "architecture", content: "CLI parity exists for transport fallback", workingDirectory: cwd }),
        "--json",
      ]);
      const addNote = JSON.parse(logs.pop() || "{}") as { success?: boolean; noteCount?: number };
      assert.equal(addNote.success, true);
      assert.equal(addNote.noteCount, 1);

      await mcpParityCommand("project-memory", [
        "project_memory_read",
        "--input",
        JSON.stringify({ workingDirectory: cwd }),
        "--json",
      ]);
      const memoryRead = JSON.parse(logs.pop() || "{}") as { notes?: Array<{ content?: string }> };
      assert.equal(memoryRead.notes?.length, 1);
      assert.equal(memoryRead.notes?.[0]?.content, "CLI parity exists for transport fallback");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("supports trace summary parity via CLI", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-mcp-parity-trace-"));
    const logs = captureLogs();

    try {
      const logsDir = join(cwd, ".omx", "logs");
      await mkdir(logsDir, { recursive: true });
      await writeFile(
        join(logsDir, "turns-2026-04-08.jsonl"),
        `${JSON.stringify({ timestamp: "2026-04-08T13:00:00.000Z", type: "assistant" })}\n`,
      );

      await mcpParityCommand("trace", [
        "trace_summary",
        "--input",
        JSON.stringify({ workingDirectory: cwd }),
        "--json",
      ]);
      const summary = JSON.parse(logs.pop() || "{}") as {
        turns?: { total?: number; byType?: Record<string, number> };
      };
      assert.equal(summary.turns?.total, 1);
      assert.equal(summary.turns?.byType?.assistant, 1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("supports wiki parity via CLI", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-mcp-parity-wiki-"));
    const logs = captureLogs();

    try {
      await mcpParityCommand("wiki", [
        "wiki_add",
        "--input",
        JSON.stringify({
          title: "Runtime Notes",
          content: "SessionStart uses native hooks.",
          tags: ["runtime", "hooks"],
          category: "architecture",
          workingDirectory: cwd,
        }),
        "--json",
      ]);
      const addResult = JSON.parse(logs.pop() || "{}") as { totalAffected?: number };
      assert.equal(addResult.totalAffected, 1);

      await mcpParityCommand("wiki", [
        "wiki_query",
        "--input",
        JSON.stringify({ query: "sessionstart", workingDirectory: cwd }),
        "--json",
      ]);
      const queryResult = JSON.parse(logs.pop() || "[]") as Array<{ page?: { filename?: string } }>;
      assert.equal(queryResult[0]?.page?.filename, "runtime-notes.md");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
