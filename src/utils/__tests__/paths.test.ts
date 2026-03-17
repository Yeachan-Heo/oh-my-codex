import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "path";
import { homedir, tmpdir } from "os";
import { existsSync } from "fs";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import {
  codexHome,
  codexConfigPath,
  codexPromptsDir,
  userSkillsDir,
  projectSkillsDir,
  listInstalledSkillDirectories,
  omxStateDir,
  omxProjectMemoryPath,
  omxNotepadPath,
  omxPlansDir,
  omxLogsDir,
  packageRoot,
} from "../paths.js";

describe("codexHome", () => {
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

  it("returns CODEX_HOME env var when set", () => {
    process.env.CODEX_HOME = "/tmp/custom-codex";
    assert.equal(codexHome(), "/tmp/custom-codex");
  });

  it("defaults to ~/.codex when CODEX_HOME is not set", () => {
    delete process.env.CODEX_HOME;
    assert.equal(codexHome(), join(homedir(), ".codex"));
  });
});

describe("codexConfigPath", () => {
  let originalCodexHome: string | undefined;

  beforeEach(() => {
    originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = "/tmp/test-codex";
  });

  afterEach(() => {
    if (typeof originalCodexHome === "string") {
      process.env.CODEX_HOME = originalCodexHome;
    } else {
      delete process.env.CODEX_HOME;
    }
  });

  it("returns config.toml under codex home", () => {
    assert.equal(codexConfigPath(), "/tmp/test-codex/config.toml");
  });
});

describe("codexPromptsDir", () => {
  let originalCodexHome: string | undefined;

  beforeEach(() => {
    originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = "/tmp/test-codex";
  });

  afterEach(() => {
    if (typeof originalCodexHome === "string") {
      process.env.CODEX_HOME = originalCodexHome;
    } else {
      delete process.env.CODEX_HOME;
    }
  });

  it("returns prompts/ under codex home", () => {
    assert.equal(codexPromptsDir(), "/tmp/test-codex/prompts");
  });
});

describe("userSkillsDir", () => {
  let originalCodexHome: string | undefined;

  beforeEach(() => {
    originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = "/tmp/test-codex";
  });

  afterEach(() => {
    if (typeof originalCodexHome === "string") {
      process.env.CODEX_HOME = originalCodexHome;
    } else {
      delete process.env.CODEX_HOME;
    }
  });

  it("returns CODEX_HOME/skills", () => {
    assert.equal(userSkillsDir(), "/tmp/test-codex/skills");
  });
});

describe("projectSkillsDir", () => {
  it("uses provided projectRoot", () => {
    assert.equal(projectSkillsDir("/my/project"), "/my/project/.codex/skills");
  });

  it("defaults to cwd when no projectRoot given", () => {
    assert.equal(projectSkillsDir(), join(process.cwd(), ".codex", "skills"));
  });
});

describe("listInstalledSkillDirectories", () => {
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

  it("deduplicates by skill name and prefers project skills over user skills", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "omx-paths-project-"));
    const codexHomeRoot = await mkdtemp(join(tmpdir(), "omx-paths-codex-"));
    process.env.CODEX_HOME = codexHomeRoot;

    try {
      const projectHelpDir = join(projectRoot, ".codex", "skills", "help");
      const projectOnlyDir = join(
        projectRoot,
        ".codex",
        "skills",
        "project-only",
      );
      const userHelpDir = join(codexHomeRoot, "skills", "help");
      const userOnlyDir = join(codexHomeRoot, "skills", "user-only");

      await mkdir(projectHelpDir, { recursive: true });
      await mkdir(projectOnlyDir, { recursive: true });
      await mkdir(userHelpDir, { recursive: true });
      await mkdir(userOnlyDir, { recursive: true });

      await writeFile(join(projectHelpDir, "SKILL.md"), "# project help\n");
      await writeFile(join(projectOnlyDir, "SKILL.md"), "# project only\n");
      await writeFile(join(userHelpDir, "SKILL.md"), "# user help\n");
      await writeFile(join(userOnlyDir, "SKILL.md"), "# user only\n");

      const skills = await listInstalledSkillDirectories(projectRoot);

      assert.deepEqual(
        skills.map((skill) => ({
          name: skill.name,
          scope: skill.scope,
        })),
        [
          { name: "help", scope: "project" },
          { name: "project-only", scope: "project" },
          { name: "user-only", scope: "user" },
        ],
      );
      assert.equal(skills[0]?.path, projectHelpDir);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      await rm(codexHomeRoot, { recursive: true, force: true });
    }
  });
});

describe("omxStateDir", () => {
  it("uses provided projectRoot", () => {
    assert.equal(omxStateDir("/my/project"), "/my/project/.omx/state");
  });

  it("defaults to cwd when no projectRoot given", () => {
    assert.equal(omxStateDir(), join(process.cwd(), ".omx", "state"));
  });
});

describe("omxProjectMemoryPath", () => {
  it("uses provided projectRoot", () => {
    assert.equal(
      omxProjectMemoryPath("/my/project"),
      "/my/project/.omx/project-memory.json",
    );
  });

  it("defaults to cwd when no projectRoot given", () => {
    assert.equal(
      omxProjectMemoryPath(),
      join(process.cwd(), ".omx", "project-memory.json"),
    );
  });
});

describe("omxNotepadPath", () => {
  it("uses provided projectRoot", () => {
    assert.equal(omxNotepadPath("/my/project"), "/my/project/.omx/notepad.md");
  });

  it("defaults to cwd when no projectRoot given", () => {
    assert.equal(omxNotepadPath(), join(process.cwd(), ".omx", "notepad.md"));
  });
});

describe("omxPlansDir", () => {
  it("uses provided projectRoot", () => {
    assert.equal(omxPlansDir("/my/project"), "/my/project/.omx/plans");
  });

  it("defaults to cwd when no projectRoot given", () => {
    assert.equal(omxPlansDir(), join(process.cwd(), ".omx", "plans"));
  });
});

describe("omxLogsDir", () => {
  it("uses provided projectRoot", () => {
    assert.equal(omxLogsDir("/my/project"), "/my/project/.omx/logs");
  });

  it("defaults to cwd when no projectRoot given", () => {
    assert.equal(omxLogsDir(), join(process.cwd(), ".omx", "logs"));
  });
});

describe("packageRoot", () => {
  it("resolves to a directory containing package.json", () => {
    const root = packageRoot();
    assert.equal(existsSync(join(root, "package.json")), true);
  });
});
