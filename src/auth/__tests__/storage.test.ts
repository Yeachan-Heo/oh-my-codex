import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { atomicWriteFile, addSlotFromAuthFile, listSlots, readAuthMetadata, useSlot, markSlotQuota, clearSlotExhaustion } from "../storage.js";
import {
  resolveAuthMetadataPath,
  resolveLiveAuthPath,
  resolveOmxAuthDir,
  resolveSlotPath,
  validateSlotName,
} from "../paths.js";

async function tempHome(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "omx-auth-storage-"));
}

describe("auth slot storage", () => {
  for (const operation of [addSlotFromAuthFile, useSlot]) {
    it(`rechecks legacy file identity after acquiring the lock in ${operation.name}`, async (t) => {
      const home = await tempHome();
      try {
        const live = join(home, "auth.json");
        await writeFile(live, '{"access_token":"test-only"}\n');
        await addSlotFromAuthFile("work", live, home);
        const metadataPath = resolveAuthMetadataPath(home);
        const legacyPath = join(resolveOmxAuthDir(home), "Slots.json");
        if (existsSync(legacyPath)) {
          t.skip("requires case-distinct filenames");
          return;
        }
        await writeFile(legacyPath, '{"access_token":"legacy"}\n');
        const before = await readFile(metadataPath, "utf-8");
        const lockPath = join(resolveOmxAuthDir(home), ".metadata-lock");
        await mkdir(lockPath);
        const result = operation("Slots", live, home).then(
          () => null,
          (error: unknown) => error,
        );
        await delay(100);
        await rm(legacyPath);
        await link(metadataPath, legacyPath);
        await rm(lockPath, { recursive: true });
        assert.match(String(await result), /reserved/i);
        assert.equal(await readFile(metadataPath, "utf-8"), before);
        assert.equal(await readFile(live, "utf-8"), '{"access_token":"test-only"}\n');
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });
  }

  it("rejects the reserved metadata basename before changing any auth files", async () => {
    const home = await tempHome();
    try {
      const live = join(home, "auth.json");
      await writeFile(live, '{"access_token":"test-only"}\n');
      await addSlotFromAuthFile("work", live, home);
      const before = await readFile(resolveAuthMetadataPath(home), "utf-8");
      for (const reserved of ["slots", "Slots", "SLOTS"]) {
        await assert.rejects(addSlotFromAuthFile(reserved, live, home), /reserved/i);
        await assert.rejects(useSlot(reserved, live, home), /reserved/i);
      }
      assert.equal(await readFile(resolveAuthMetadataPath(home), "utf-8"), before);
      assert.equal(await readFile(live, "utf-8"), '{"access_token":"test-only"}\n');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("preserves concurrent account additions and quota updates", async () => {
    const home = await tempHome();
    try {
      const live = join(home, "auth.json");
      await writeFile(live, '{"access_token":"test-only"}\n');
      const names = Array.from({ length: 8 }, (_, i) => `account-${i}`);
      await Promise.all(names.map(name => addSlotFromAuthFile(name, live, home)));
      assert.deepEqual((await listSlots(home)).map(record => record.slot), names);
      await Promise.all(names.map(name => markSlotQuota(name, home)));
      assert.ok((await readAuthMetadata(home)).slots.every(record => record.exhaustedAt));
      await Promise.all(names.map(name => clearSlotExhaustion(name, home)));
      assert.ok((await readAuthMetadata(home)).slots.every(record => !record.exhaustedAt));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("preserves access to an existing distinct Slots account and unrelated accounts", async (t) => {
    const home = await tempHome();
    try {
      const authDir = resolveOmxAuthDir(home);
      await mkdir(authDir, { recursive: true });
      const legacyPath = join(authDir, "Slots.json");
      const metadataPath = resolveAuthMetadataPath(home);
      await writeFile(legacyPath, '{"access_token":"legacy-test-only"}\n');
      await writeFile(join(authDir, "work.json"), '{"access_token":"work-test-only"}\n');
      await writeFile(metadataPath, JSON.stringify({
        version: 1,
        slots: ["Slots", "work"].map(slot => ({ slot, createdAt: "2026-09-01", updatedAt: "2026-09-01" })),
      }));
      const [legacy, metadata] = await Promise.all([stat(legacyPath), stat(metadataPath)]);
      if (legacy.dev === metadata.dev && legacy.ino === metadata.ino) {
        t.skip("filesystem does not support distinct Slots.json and slots.json");
        return;
      }
      assert.deepEqual((await listSlots(home)).map(slot => slot.slot), ["Slots", "work"]);
      const live = join(home, "auth.json");
      await useSlot("work", live, home);
      assert.equal(await readFile(live, "utf-8"), '{"access_token":"work-test-only"}\n');
      await useSlot("Slots", live, home);
      assert.equal(await readFile(live, "utf-8"), '{"access_token":"legacy-test-only"}\n');
      await addSlotFromAuthFile("Slots", live, home);
      assert.deepEqual((await readAuthMetadata(home)).slots.map(slot => slot.slot), ["Slots", "work"]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects a case-variant credential path that aliases the metadata file", async () => {
    const home = await tempHome();
    try {
      const live = join(home, "auth.json");
      await writeFile(live, '{"access_token":"test-only"}\n');
      await addSlotFromAuthFile("work", live, home);
      const metadataPath = resolveAuthMetadataPath(home);
      const aliasPath = join(resolveOmxAuthDir(home), "Slots.json");
      if (!existsSync(aliasPath)) await link(metadataPath, aliasPath);
      const before = await readFile(metadataPath, "utf-8");
      await assert.rejects(addSlotFromAuthFile("Slots", live, home), /reserved/i);
      await assert.rejects(useSlot("Slots", live, home), /reserved/i);
      assert.equal(await readFile(metadataPath, "utf-8"), before);
      assert.equal(await readFile(live, "utf-8"), '{"access_token":"test-only"}\n');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("serializes account additions from separate CLI processes", async () => {
    const home = await tempHome();
    try {
      const live = join(home, "auth.json");
      await writeFile(live, '{"access_token":"test-only"}\n');
      const moduleUrl = new URL("../storage.js", import.meta.url).href;
      const run = promisify(execFile);
      await Promise.all(Array.from({ length: 4 }, (_, worker) => run(process.execPath, [
        "--input-type=module", "-e",
        `import { addSlotFromAuthFile } from ${JSON.stringify(moduleUrl)};
         const [home, live, worker] = process.argv.slice(1);
         await Promise.all(Array.from({ length: 3 }, (_, i) =>
           addSlotFromAuthFile('worker-' + worker + '-' + i, live, home)));`,
        home, live, String(worker),
      ], { timeout: 15_000 })));
      const slots = await listSlots(home);
      assert.equal(slots.length, 12);
      assert.equal(new Set(slots.map(slot => slot.slot)).size, 12);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("keeps the live credentials and current slot consistent after concurrent switches", async () => {
    const home = await tempHome();
    try {
      const live = join(home, "auth.json");
      const names = Array.from({ length: 4 }, (_, i) => `account-${i}`);
      for (const name of names) {
        await writeFile(live, JSON.stringify({ access_token: `test-only-${name}` }));
        await addSlotFromAuthFile(name, live, home);
      }
      await Promise.all(names.map(name => useSlot(name, live, home)));
      const metadata = await readAuthMetadata(home);
      assert.ok(metadata.currentSlot);
      assert.equal(await readFile(live, "utf-8"), await readFile(resolveSlotPath(metadata.currentSlot, home), "utf-8"));
      assert.ok(metadata.slots.every(slot => slot.lastUsedAt));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

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

  it("keeps live auth unchanged when slot metadata is malformed", async () => {
    const home = await tempHome();
    try {
      const live = join(home, ".codex", "auth.json");
      await mkdir(join(home, ".codex"), { recursive: true });
      await mkdir(resolveOmxAuthDir(home), { recursive: true });
      await writeFile(live, '{"access_token":"original"}\n');
      await writeFile(resolveSlotPath("work", home), '{"access_token":"replacement"}\n');
      await writeFile(resolveAuthMetadataPath(home), "{not-json\n");

      await assert.rejects(useSlot("work", live, home));

      assert.equal(await readFile(live, "utf-8"), '{"access_token":"original"}\n');
      assert.equal(existsSync(join(resolveOmxAuthDir(home), ".metadata-lock")), false);
      await writeFile(resolveAuthMetadataPath(home), '{"version":1,"slots":[]}\n');
      await useSlot("work", live, home);
      assert.equal(await readFile(live, "utf-8"), '{"access_token":"replacement"}\n');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("keeps live auth unchanged when slot metadata contains an invalid slot", async () => {
    const home = await tempHome();
    try {
      const live = join(home, ".codex", "auth.json");
      await mkdir(join(home, ".codex"), { recursive: true });
      await mkdir(resolveOmxAuthDir(home), { recursive: true });
      await writeFile(live, '{"access_token":"original"}\n');
      await writeFile(resolveSlotPath("work", home), '{"access_token":"replacement"}\n');
      await writeFile(
        resolveAuthMetadataPath(home),
        `${JSON.stringify({ version: 1, slots: [{ slot: "../invalid" }] })}\n`,
      );

      await assert.rejects(useSlot("work", live, home), /invalid auth slot name/);

      assert.equal(await readFile(live, "utf-8"), '{"access_token":"original"}\n');
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
