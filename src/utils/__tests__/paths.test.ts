import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "path";
import { homedir, tmpdir } from "os";
import { existsSync } from "fs";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "fs/promises";
import {
  codexHome,
  codexConfigPath,
  codexPromptsDir,
  userSkillsDir,
  projectSkillsDir,
  legacyUserSkillsDir,
  listInstalledSkillDirectories,
  detectLegacySkillRootOverlap,
  omxStateDir,
  omxProjectMemoryPath,
  omxNotepadPath,
  omxPlansDir,
  omxLogsDir,
  packageRoot,
} from "../paths.js";

describe("codexHome", () => {
  let originalCodexHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(() => {
    originalCodexHome = process.env.CODEX_HOME;
    originalUserProfile = process.env.USERPROFILE;
  });

  afterEach(() => {
    if (typeof originalCodexHome === "string") {
      process.env.CODEX_HOME = originalCodexHome;
    } else {
      delete process.env.CODEX_HOME;
    }

    if (typeof originalUserProfile === "string") {
      process.env.USERPROFILE = originalUserProfile;
    } else {
      delete process.env.USERPROFILE;
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
  let originalUserProfile: string | undefined;

  beforeEach(() => {
    originalCodexHome = process.env.CODEX_HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.CODEX_HOME = "/tmp/test-codex";
  });

  afterEach(() => {
    if (typeof originalCodexHome === "string") {
      process.env.CODEX_HOME = originalCodexHome;
    } else {
      delete process.env.CODEX_HOME;
    }

    if (typeof originalUserProfile === "string") {
      process.env.USERPROFILE = originalUserProfile;
    } else {
      delete process.env.USERPROFILE;
    }
  });

  it("returns config.toml under codex home", () => {
    assert.equal(codexConfigPath(), join("/tmp/test-codex", "config.toml"));
  });
});

describe("codexPromptsDir", () => {
  let originalCodexHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(() => {
    originalCodexHome = process.env.CODEX_HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.CODEX_HOME = "/tmp/test-codex";
  });

  afterEach(() => {
    if (typeof originalCodexHome === "string") {
      process.env.CODEX_HOME = originalCodexHome;
    } else {
      delete process.env.CODEX_HOME;
    }

    if (typeof originalUserProfile === "string") {
      process.env.USERPROFILE = originalUserProfile;
    } else {
      delete process.env.USERPROFILE;
    }
  });

  it("returns prompts/ under codex home", () => {
    assert.equal(codexPromptsDir(), join("/tmp/test-codex", "prompts"));
  });
});

describe("userSkillsDir", () => {
  let originalCodexHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(() => {
    originalCodexHome = process.env.CODEX_HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.CODEX_HOME = "/tmp/test-codex";
  });

  afterEach(() => {
    if (typeof originalCodexHome === "string") {
      process.env.CODEX_HOME = originalCodexHome;
    } else {
      delete process.env.CODEX_HOME;
    }

    if (typeof originalUserProfile === "string") {
      process.env.USERPROFILE = originalUserProfile;
    } else {
      delete process.env.USERPROFILE;
    }
  });

  it("returns CODEX_HOME/skills", () => {
    assert.equal(userSkillsDir(), join("/tmp/test-codex", "skills"));
  });
});

describe("projectSkillsDir", () => {
  it("uses provided projectRoot", () => {
    assert.equal(projectSkillsDir("/my/project"), join("/my/project", ".codex", "skills"));
  });

  it("defaults to cwd when no projectRoot given", () => {
    assert.equal(projectSkillsDir(), join(process.cwd(), ".codex", "skills"));
  });
});

describe("legacyUserSkillsDir", () => {
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = "/tmp/test-home";
    process.env.USERPROFILE = "/tmp/test-home";
  });

  afterEach(() => {
    if (typeof originalHome === "string") {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }

    if (typeof originalUserProfile === "string") {
      process.env.USERPROFILE = originalUserProfile;
    } else {
      delete process.env.USERPROFILE;
    }
  });

  it("returns ~/.agents/skills under HOME", () => {
    assert.equal(legacyUserSkillsDir(), join("/tmp/test-home", ".agents", "skills"));
  });
});

describe("listInstalledSkillDirectories", () => {
  let originalCodexHome: string | undefined;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(() => {
    originalCodexHome = process.env.CODEX_HOME;
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
  });

  afterEach(() => {
    if (typeof originalCodexHome === "string") {
      process.env.CODEX_HOME = originalCodexHome;
    } else {
      delete process.env.CODEX_HOME;
    }

    if (typeof originalHome === "string") {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }

    if (typeof originalUserProfile === "string") {
      process.env.USERPROFILE = originalUserProfile;
    } else {
      delete process.env.USERPROFILE;
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
  it("detects overlapping legacy and canonical user skill roots including content mismatches", async () => {
    const homeRoot = await mkdtemp(join(tmpdir(), "omx-paths-home-"));
    const codexHomeRoot = join(homeRoot, ".codex");
    const legacyRoot = join(homeRoot, ".agents", "skills");
    process.env.HOME = homeRoot;
    process.env.USERPROFILE = homeRoot;
    process.env.CODEX_HOME = codexHomeRoot;

    try {
      const canonicalHelpDir = join(codexHomeRoot, "skills", "help");
      const canonicalPlanDir = join(codexHomeRoot, "skills", "plan");
      const legacyHelpDir = join(legacyRoot, "help");
      const legacyOnlyDir = join(legacyRoot, "legacy-only");

      await mkdir(canonicalHelpDir, { recursive: true });
      await mkdir(canonicalPlanDir, { recursive: true });
      await mkdir(legacyHelpDir, { recursive: true });
      await mkdir(legacyOnlyDir, { recursive: true });

      await writeFile(join(canonicalHelpDir, "SKILL.md"), "# canonical help\n");
      await writeFile(join(canonicalPlanDir, "SKILL.md"), "# canonical plan\n");
      await writeFile(join(legacyHelpDir, "SKILL.md"), "# legacy help\n");
      await writeFile(join(legacyOnlyDir, "SKILL.md"), "# legacy only\n");

      const overlap = await detectLegacySkillRootOverlap();

      assert.equal(overlap.canonicalExists, true);
      assert.equal(overlap.legacyExists, true);
      assert.equal(overlap.canonicalSkillCount, 2);
      assert.equal(overlap.legacySkillCount, 2);
      assert.deepEqual(overlap.overlappingSkillNames, ["help"]);
      assert.deepEqual(overlap.mismatchedSkillNames, ["help"]);
      assert.equal(overlap.sameResolvedTarget, false);
    } finally {
      await rm(homeRoot, { recursive: true, force: true });
    }
  });

  it("treats a legacy link to canonical skills as the same resolved target", async () => {
    const homeRoot = await mkdtemp(join(tmpdir(), "omx-paths-linked-home-"));
    const codexHomeRoot = join(homeRoot, ".codex");
    const canonicalSkillsRoot = join(codexHomeRoot, "skills");
    const legacyParent = join(homeRoot, ".agents");
    const legacyRoot = join(legacyParent, "skills");
    process.env.HOME = homeRoot;
    process.env.USERPROFILE = homeRoot;
    process.env.CODEX_HOME = codexHomeRoot;

    try {
      const canonicalHelpDir = join(canonicalSkillsRoot, "help");
      await mkdir(canonicalHelpDir, { recursive: true });
      await mkdir(legacyParent, { recursive: true });
      await writeFile(join(canonicalHelpDir, "SKILL.md"), "# canonical help\n");
      await symlink(
        canonicalSkillsRoot,
        legacyRoot,
        process.platform === "win32" ? "junction" : "dir",
      );

      const overlap = await detectLegacySkillRootOverlap();

      assert.equal(overlap.canonicalExists, true);
      assert.equal(overlap.legacyExists, true);
      assert.equal(overlap.canonicalSkillCount, 1);
      assert.equal(overlap.legacySkillCount, 1);
      assert.equal(overlap.sameResolvedTarget, true);
      assert.deepEqual(overlap.overlappingSkillNames, ["help"]);
      assert.deepEqual(overlap.mismatchedSkillNames, []);
    } finally {
      await rm(homeRoot, { recursive: true, force: true });
    }
  });
});

describe("omxStateDir", () => {
  it("uses provided projectRoot", () => {
    assert.equal(omxStateDir("/my/project"), join("/my/project", ".omx", "state"));
  });

  it("defaults to cwd when no projectRoot given", () => {
    assert.equal(omxStateDir(), join(process.cwd(), ".omx", "state"));
  });
});

describe("omxProjectMemoryPath", () => {
  it("uses provided projectRoot", () => {
    assert.equal(
      omxProjectMemoryPath("/my/project"),
      join("/my/project", ".omx", "project-memory.json"),
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
    assert.equal(omxNotepadPath("/my/project"), join("/my/project", ".omx", "notepad.md"));
  });

  it("defaults to cwd when no projectRoot given", () => {
    assert.equal(omxNotepadPath(), join(process.cwd(), ".omx", "notepad.md"));
  });
});

describe("omxPlansDir", () => {
  it("uses provided projectRoot", () => {
    assert.equal(omxPlansDir("/my/project"), join("/my/project", ".omx", "plans"));
  });

  it("defaults to cwd when no projectRoot given", () => {
    assert.equal(omxPlansDir(), join(process.cwd(), ".omx", "plans"));
  });
});

describe("omxLogsDir", () => {
  it("uses provided projectRoot", () => {
    assert.equal(omxLogsDir("/my/project"), join("/my/project", ".omx", "logs"));
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
