import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile, addSlotFromAuthFile, listSlots, readAuthMetadata, useSlot } from "../storage.js";
import { resolveLiveAuthPath, resolveOmxAuthDir, resolveSlotPath, validateSlotName } from "../paths.js";

async function tempHome(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "omx-auth-storage-"));
}

describe("auth slot storage", () => {
  it("adds, lists, and uses auth slots without exposing blob contents", async () => {
    const home = await tempHome();
    try {
      const live = join(home, ".codex", "auth.json");
      await mkdir(join(home, ".codex"), { recursive: true });
      await writeFile(live, '{"access_token":"sentinel-secret"}\n');

      await addSlotFromAuthFile("work", live, home, new Date("2026-05-24T00:00:00.000Z"));
      const slots = await listSlots(home);
      assert.deepEqual(slots.map((slot) => slot.slot), ["work"]);
      assert.equal(await readFile(resolveSlotPath("work", home), "utf-8"), '{"access_token":"sentinel-secret"}\n');

      await writeFile(live, '{"access_token":"other"}\n');
      await useSlot("work", live, home, new Date("2026-05-24T01:00:00.000Z"));
      assert.equal(await readFile(live, "utf-8"), '{"access_token":"sentinel-secret"}\n');
      const metadata = await readAuthMetadata(home);
      assert.equal(metadata.currentSlot, "work");
      assert.equal(metadata.slots[0]?.lastUsedAt, "2026-05-24T01:00:00.000Z");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("stores non-sensitive identity metadata for slots", async () => {
    const home = await tempHome();
    try {
      const live = join(home, ".codex", "auth.json");
      await mkdir(join(home, ".codex"), { recursive: true });
      await writeFile(live, '{"auth_mode":"apikey","OPENAI_API_KEY":"secret"}\n');
      await addSlotFromAuthFile("api-work", live, home, new Date("2026-05-24T00:00:00.000Z"), {
        displayName: "API Work",
        kind: "api",
        isPrimary: false,
        workspaceHint: "platform",
        createdFromCodexHome: join(home, ".codex"),
      });
      const metadata = await readAuthMetadata(home);
      assert.equal(metadata.slots[0]?.displayName, "API Work");
      assert.equal(metadata.slots[0]?.kind, "api");
      assert.equal(metadata.slots[0]?.workspaceHint, "platform");
      assert.doesNotMatch(JSON.stringify(metadata), /secret/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("can mark an added auth slot as current", async () => {
    const home = await tempHome();
    try {
      const live = join(home, ".codex", "auth.json");
      await mkdir(join(home, ".codex"), { recursive: true });
      await writeFile(live, '{"auth_mode":"apikey","OPENAI_API_KEY":"secret"}\n');

      await addSlotFromAuthFile(
        "api-work",
        live,
        home,
        new Date("2026-05-24T00:00:00.000Z"),
        { kind: "api" },
        { setCurrent: true },
      );

      const metadata = await readAuthMetadata(home);
      assert.equal(metadata.currentSlot, "api-work");
      assert.equal(metadata.slots[0]?.kind, "api");
      assert.doesNotMatch(JSON.stringify(metadata), /secret/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("drops unknown fields when reading slot metadata", async () => {
    const home = await tempHome();
    try {
      const authDir = resolveOmxAuthDir(home);
      await mkdir(authDir, { recursive: true });
      await writeFile(resolveSlotPath("work", home), "{}\n");
      await writeFile(join(authDir, "slots.json"), JSON.stringify({
        version: 1,
        currentSlot: "work",
        slots: [
          { slot: "work", createdAt: "now", updatedAt: "now", kind: "chatgpt", token: "secret-token" },
        ],
      }));
      const metadata = await readAuthMetadata(home);
      assert.equal(metadata.slots[0]?.slot, "work");
      assert.doesNotMatch(JSON.stringify(metadata), /secret-token/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("uses owner-only modes for auth directory and files", async () => {
    if (process.platform === "win32") return;
    const home = await tempHome();
    try {
      const live = join(home, ".codex", "auth.json");
      await mkdir(join(home, ".codex"), { recursive: true });
      await writeFile(live, "{}\n");
      await addSlotFromAuthFile("personal", live, home);
      const dirMode = (await stat(resolveOmxAuthDir(home))).mode & 0o777;
      const slotMode = (await stat(resolveSlotPath("personal", home))).mode & 0o777;
      assert.equal(dirMode, 0o700);
      assert.equal(slotMode, 0o600);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects unsafe slot names", () => {
    assert.throws(() => validateSlotName("../bad"), /invalid auth slot name/);
    assert.throws(() => validateSlotName("bad/name"), /invalid auth slot name/);
  });

  it("rejects a symlinked auth directory", async () => {
    if (process.platform === "win32") return;
    const home = await tempHome();
    const outside = await tempHome();
    try {
      await mkdir(join(home, ".omx"), { recursive: true });
      await symlink(outside, join(home, ".omx", "auth"));
      const live = join(home, ".codex", "auth.json");
      await mkdir(join(home, ".codex"), { recursive: true });
      await writeFile(live, "{}\n");
      await assert.rejects(addSlotFromAuthFile("work", live, home), /auth directory must not be a symlink/);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("keeps the original file when atomic write fails before rename", async () => {
    const home = await tempHome();
    try {
      const target = join(home, ".codex", "auth.json");
      await mkdir(join(home, ".codex"), { recursive: true });
      await writeFile(target, "original\n");
      await assert.rejects(
        atomicWriteFile(target, "partial\n", {
          beforeRename: () => {
            throw new Error("simulated interrupt");
          },
        }),
        /simulated interrupt/,
      );
      assert.equal(await readFile(target, "utf-8"), "original\n");
      assert.equal(existsSync(`${target}.tmp`), false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("resolves CODEX_HOME, project-scope, and default auth paths", async () => {
    const home = await tempHome();
    const wd = await mkdtemp(join(tmpdir(), "omx-auth-project-"));
    try {
      assert.equal(resolveLiveAuthPath(wd, { CODEX_HOME: join(home, "custom") }, home), join(home, "custom", "auth.json"));
      await mkdir(join(wd, ".omx"), { recursive: true });
      await writeFile(join(wd, ".omx", "setup-scope.json"), '{"scope":"project"}\n');
      assert.equal(resolveLiveAuthPath(wd, {}, home), join(wd, ".codex", "auth.json"));
      assert.equal(resolveLiveAuthPath(wd, { CODEX_HOME: "" }, home), join(wd, ".codex", "auth.json"));
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(wd, { recursive: true, force: true });
    }
  });
});
