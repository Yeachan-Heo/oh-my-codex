import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainPendingTeamDispatch } from "../notify-hook/team-dispatch.js";

/**
 * Issue #3679: the runtime stores the plain file
 * `.omx/state/team/notice-ledger.json` beside real Team directories. The
 * dispatch watcher enumerated every entry as a Team root and looped on
 * `ENOTDIR: mkdir '.../notice-ledger.json/dispatch'`. Only directories (and
 * symlinks to directories) are Team roots.
 */
describe("issue #3679 team dispatch skips non-directory state entries", () => {
  it("drains cleanly and never creates a dispatch dir under a plain file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-issue-3679-"));
    const previousWorker = process.env.OMX_TEAM_WORKER;
    delete process.env.OMX_TEAM_WORKER;
    try {
      const teamRoot = join(cwd, ".omx", "state", "team");
      await mkdir(teamRoot, { recursive: true });
      const ledgerPath = join(teamRoot, "notice-ledger.json");
      const ledgerContent = JSON.stringify({ version: 1, notices: [] }, null, 2);
      await writeFile(ledgerPath, ledgerContent);

      const result = await drainPendingTeamDispatch({
        cwd,
        maxPerTick: 5,
        injector: async () => {
          throw new Error("injector must not run without a pending request");
        },
      });

      assert.deepEqual(result, { processed: 0, skipped: 0, failed: 0 });
      assert.equal(
        existsSync(join(ledgerPath, "dispatch")),
        false,
        "must not create a dispatch directory under the ledger file",
      );
      assert.deepEqual(await readdir(teamRoot), ["notice-ledger.json"]);
      assert.equal(
        await (await import("node:fs/promises")).readFile(ledgerPath, "utf-8"),
        ledgerContent,
        "the ledger file must stay untouched",
      );
    } finally {
      if (typeof previousWorker === "string") process.env.OMX_TEAM_WORKER = previousWorker;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("still enumerates real team directories alongside plain files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-issue-3679-mixed-"));
    const previousWorker = process.env.OMX_TEAM_WORKER;
    delete process.env.OMX_TEAM_WORKER;
    try {
      const teamRoot = join(cwd, ".omx", "state", "team");
      const teamDir = join(teamRoot, "alpha");
      await mkdir(join(teamDir, "dispatch"), { recursive: true });
      await writeFile(join(teamRoot, "notice-ledger.json"), "{}\n");
      await writeFile(join(teamDir, "config.json"), JSON.stringify({ tmux_session: "alpha" }));
      await writeFile(
        join(teamDir, "dispatch", "requests.json"),
        JSON.stringify([
          {
            request_id: "req-1",
            to_worker: "worker-1",
            status: "pending",
            message_id: "msg-1",
          },
        ]),
      );

      let injectedRequestIds: string[] = [];
      const result = await drainPendingTeamDispatch({
        cwd,
        maxPerTick: 5,
        injector: async (request: { request_id?: string }) => {
          injectedRequestIds.push(String(request.request_id));
          return { ok: true, transport: "hook", reason: "injected_for_test" };
        },
      });

      assert.deepEqual(injectedRequestIds, ["req-1"]);
      assert.equal(result.processed, 1);
      assert.equal(result.failed, 0);
      assert.equal(existsSync(join(teamRoot, "notice-ledger.json", "dispatch")), false);
    } finally {
      if (typeof previousWorker === "string") process.env.OMX_TEAM_WORKER = previousWorker;
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
