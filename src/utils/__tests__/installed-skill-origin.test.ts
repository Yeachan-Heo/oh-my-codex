import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import {
  listInstalledSkillDirectories,
  omxInstalledSkillsManifestPath,
} from "../paths.js";

describe("installed skill provenance", () => {
  let originalCodexHome: string | undefined;

  beforeEach(() => {
    originalCodexHome = process.env.CODEX_HOME;
  });

  afterEach(() => {
    if (typeof originalCodexHome === "string") {
      process.env.CODEX_HOME = originalCodexHome;
    } else {
      delete process.env.CODEX_HOME;
    }
  });

  it("marks OMX-shipped skills from the per-root manifest while preserving project/user origins for custom skills", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "omx-skill-origin-project-"));
    const codexHomeRoot = await mkdtemp(join(tmpdir(), "omx-skill-origin-codex-"));
    process.env.CODEX_HOME = codexHomeRoot;

    try {
      const projectHelpDir = join(projectRoot, ".codex", "skills", "help");
      const projectCustomDir = join(projectRoot, ".codex", "skills", "custom-project");
      const userPlanDir = join(codexHomeRoot, "skills", "plan");
      const userCustomDir = join(codexHomeRoot, "skills", "custom-user");

      await mkdir(projectHelpDir, { recursive: true });
      await mkdir(projectCustomDir, { recursive: true });
      await mkdir(userPlanDir, { recursive: true });
      await mkdir(userCustomDir, { recursive: true });
      await mkdir(join(projectRoot, ".codex", "skills", ".system"), {
        recursive: true,
      });
      await mkdir(join(codexHomeRoot, "skills", ".system"), {
        recursive: true,
      });

      await writeFile(join(projectHelpDir, "SKILL.md"), "# project help\n");
      await writeFile(join(projectCustomDir, "SKILL.md"), "# project custom\n");
      await writeFile(join(userPlanDir, "SKILL.md"), "# user plan\n");
      await writeFile(join(userCustomDir, "SKILL.md"), "# user custom\n");

      await writeFile(
        omxInstalledSkillsManifestPath(join(projectRoot, ".codex", "skills")),
        JSON.stringify(
          {
            schema_version: 1,
            generated_at: "2026-04-17T00:00:00.000Z",
            skills: {
              help: { origin: "omx", source: "repo-shipped" },
            },
          },
          null,
          2,
        ),
      );
      await writeFile(
        omxInstalledSkillsManifestPath(join(codexHomeRoot, "skills")),
        JSON.stringify(
          {
            schema_version: 1,
            generated_at: "2026-04-17T00:00:00.000Z",
            skills: {
              plan: { origin: "omx", source: "repo-shipped" },
            },
          },
          null,
          2,
        ),
      );

      const skills = await listInstalledSkillDirectories(projectRoot);
      assert.deepEqual(
        skills.map((skill) => ({
          name: skill.name,
          origin: skill.origin,
          scope: skill.scope,
        })),
        [
          { name: "custom-project", origin: "project", scope: "project" },
          { name: "help", origin: "omx", scope: "project" },
          { name: "custom-user", origin: "user", scope: "user" },
          { name: "plan", origin: "omx", scope: "user" },
        ],
      );
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      await rm(codexHomeRoot, { recursive: true, force: true });
    }
  });
});
