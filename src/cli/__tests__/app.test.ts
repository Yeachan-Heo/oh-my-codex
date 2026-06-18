import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCodexAppEnvironmentToml } from "../app.js";

function runOmx(cwd: string, argv: string[], env: Record<string, string> = {}) {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, "..", "..", "..");
  const omxBin = join(repoRoot, "dist", "cli", "omx.js");
  const result = spawnSync(process.execPath, [omxBin, ...argv], {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: env.HOME,
      CODEX_HOME: env.CODEX_HOME ?? "",
      OMX_AUTO_UPDATE: "0",
      OMX_NOTIFY_FALLBACK: "0",
      OMX_HOOK_DERIVED_SIGNALS: "0",
      ...env,
    },
  });
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function hasSqlite3(): boolean {
  return spawnSync("sqlite3", ["--version"], { encoding: "utf-8" }).status === 0;
}

describe("omx app", () => {
  it("generates Codex App project actions without removing existing actions", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-app-actions-"));
    try {
      const envDir = join(wd, ".codex", "environments");
      await mkdir(envDir, { recursive: true });
      await writeFile(join(envDir, "environment.toml"), [
        "version = 1",
        'name = "demo"',
        "",
        "[[actions]]",
        'name = "Run"',
        'icon = "run"',
        'command = "npm test"',
        "",
      ].join("\n"));

      const content = await buildCodexAppEnvironmentToml(wd);
      assert.match(content, /name = "Run"/);
      assert.match(content, /name = "OMX Identity"/);
      assert.match(content, /command = "omx app doctor"/);
      assert.match(content, /name = "OMX Sessions"/);
      assert.match(content, /name = "OMX Project History"/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("writes project-local environment.toml and leaves App private cache untouched", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-app-cli-"));
    try {
      const home = join(wd, "home");
      const codexHome = join(home, ".codex");
      const appCache = join(home, "Library", "Application Support", "com.openai.chat");
      await mkdir(codexHome, { recursive: true });
      await mkdir(appCache, { recursive: true });
      await writeFile(join(codexHome, "auth.json"), '{"auth_mode":"apikey","OPENAI_API_KEY":"secret"}\n');

      const setup = runOmx(wd, ["app", "setup-actions"], { HOME: home, CODEX_HOME: codexHome });
      assert.equal(setup.status, 0, setup.stderr || setup.stdout);
      const envToml = await readFile(join(wd, ".codex", "environments", "environment.toml"), "utf-8");
      assert.match(envToml, /OMX Identity/);
      assert.match(envToml, /omx session list --unified/);
      assert.deepEqual(existsSync(join(appCache, "environment.toml")), false);

      const doctor = runOmx(wd, ["app", "doctor", "--json"], { HOME: home, CODEX_HOME: codexHome });
      assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
      const parsed = JSON.parse(doctor.stdout) as { codexAppActionsConfigured: boolean; identity: { kind: string } };
      assert.equal(parsed.codexAppActionsConfigured, true);
      assert.equal(parsed.identity.kind, "api");
      assert.doesNotMatch(doctor.stdout + doctor.stderr, /secret/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("diagnoses and repairs Codex App sidebar metadata without touching session sqlite", { skip: !hasSqlite3() }, async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-app-sidebar-"));
    try {
      const home = join(wd, "home");
      const codexHome = join(home, ".codex");
      const sqliteDir = join(codexHome, "sqlite");
      const projectRoot = join(wd, "翻译插件");
      const childProjectRoot = join(projectRoot, "pkg");
      const wildcardProjectRoot = join(wd, "foo_bar");
      const unrelatedWildcardRoot = join(wd, "fooXbar");
      const dottedProjectRoot = join(wd, "release.v1");
      const threadId = "019ebc5d-f080-71d0-b16a-f4ff0caed5ab";
      const childThreadId = "child-project-thread";
      const wildcardThreadId = "wildcard-project-thread";
      const unrelatedWildcardThreadId = "wildcard-leak-thread";
      const dottedThreadId = "dotted-project-thread";
      const sqlValue = (value: string) => value.replace(/'/g, "''");
      await mkdir(sqliteDir, { recursive: true });
      await mkdir(projectRoot, { recursive: true });
      await mkdir(childProjectRoot, { recursive: true });
      await mkdir(wildcardProjectRoot, { recursive: true });
      await mkdir(unrelatedWildcardRoot, { recursive: true });
      await mkdir(dottedProjectRoot, { recursive: true });
      await writeFile(join(codexHome, "auth.json"), '{"auth_mode":"apikey","OPENAI_API_KEY":"secret"}\n');
      const globalStatePath = join(codexHome, ".codex-global-state.json");
      await writeFile(globalStatePath, `${JSON.stringify({
        "electron-saved-workspace-roots": [projectRoot, childProjectRoot, wildcardProjectRoot, dottedProjectRoot],
        "project-order": [projectRoot, childProjectRoot, wildcardProjectRoot, dottedProjectRoot],
      })}\n`);

      const sqlitePath = join(sqliteDir, "state_5.sqlite");
      const schema = [
        "create table threads (",
        "id text primary key, title text not null, cwd text not null, source text not null,",
        "thread_source text, archived integer not null default 0, updated_at integer not null, updated_at_ms integer",
        ");",
        `insert into threads values ('${threadId}','看下最新的session','${sqlValue(projectRoot)}','vscode','user',0,1780000000,1780000000000);`,
        `insert into threads values ('subagent-thread','hidden child','${sqlValue(projectRoot)}','subagent','subagent',0,1780000001,1780000001000);`,
        `insert into threads values ('${childThreadId}','child project','${sqlValue(join(childProjectRoot, "src"))}','vscode','user',0,1780000005,1780000005000);`,
        `insert into threads values ('${wildcardThreadId}','wildcard project','${sqlValue(join(wildcardProjectRoot, "child"))}','vscode','user',0,1780000002,1780000002000);`,
        `insert into threads values ('${unrelatedWildcardThreadId}','wildcard leak','${sqlValue(join(unrelatedWildcardRoot, "child"))}','vscode','user',0,1780000003,1780000003000);`,
        `insert into threads values ('${dottedThreadId}','dotted project','${sqlValue(dottedProjectRoot)}','vscode','user',0,1780000004,1780000004000);`,
      ].join("\n");
      const init = spawnSync("sqlite3", [sqlitePath, schema], { encoding: "utf-8" });
      assert.equal(init.status, 0, init.stderr || init.stdout);
      const sqliteBefore = await readFile(sqlitePath);

      const doctor = runOmx(wd, ["app", "sidebar", "doctor", "--project", "翻译插件", "--json"], { HOME: home, CODEX_HOME: codexHome });
      assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
      const report = JSON.parse(doctor.stdout) as {
        projects: Array<{
          matchedThreads: Array<{ id: string }>;
          missingOrderThreadIds: string[];
          missingHintThreadIds: string[];
          missingAssignmentThreadIds: string[];
        }>;
      };
      assert.equal(report.projects[0]?.matchedThreads.length, 1);
      assert.equal(report.projects[0]?.matchedThreads.some((thread) => thread.id === childThreadId), false);
      assert.deepEqual(report.projects[0]?.missingOrderThreadIds, [threadId]);
      assert.deepEqual(report.projects[0]?.missingHintThreadIds, [threadId]);
      assert.deepEqual(report.projects[0]?.missingAssignmentThreadIds, [threadId]);

      const relativePathDoctor = runOmx(wd, ["app", "sidebar", "doctor", "--project", "./翻译插件", "--json"], { HOME: home, CODEX_HOME: codexHome });
      assert.equal(relativePathDoctor.status, 0, relativePathDoctor.stderr || relativePathDoctor.stdout);
      const relativePathReport = JSON.parse(relativePathDoctor.stdout) as { projects: Array<{ projectRoot: string; matchedThreads: Array<{ id: string }> }> };
      assert.equal(relativePathReport.projects[0]?.projectRoot, projectRoot);
      assert.equal(relativePathReport.projects[0]?.matchedThreads[0]?.id, threadId);

      const dotDoctor = runOmx(projectRoot, ["app", "sidebar", "doctor", "--project", ".", "--json"], { HOME: home, CODEX_HOME: codexHome });
      assert.equal(dotDoctor.status, 0, dotDoctor.stderr || dotDoctor.stdout);
      const dotReport = JSON.parse(dotDoctor.stdout) as { projects: Array<{ projectRoot: string; matchedThreads: Array<{ id: string }> }> };
      assert.equal(dotReport.projects.length, 1);
      assert.equal(dotReport.projects[0]?.projectRoot, projectRoot);
      assert.equal(dotReport.projects[0]?.matchedThreads[0]?.id, threadId);

      const wildcardDoctor = runOmx(wd, ["app", "sidebar", "doctor", "--project", "foo_bar", "--json"], { HOME: home, CODEX_HOME: codexHome });
      assert.equal(wildcardDoctor.status, 0, wildcardDoctor.stderr || wildcardDoctor.stdout);
      const wildcardReport = JSON.parse(wildcardDoctor.stdout) as { projects: Array<{ projectRoot: string; matchedThreads: Array<{ id: string }> }> };
      assert.deepEqual(wildcardReport.projects[0]?.matchedThreads.map((thread) => thread.id), [wildcardThreadId]);

      const dryRun = runOmx(wd, ["app", "sidebar", "repair", "--project", "翻译插件", "--dry-run"], { HOME: home, CODEX_HOME: codexHome });
      assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
      assert.deepEqual(JSON.parse(await readFile(globalStatePath, "utf-8")), {
        "electron-saved-workspace-roots": [projectRoot, childProjectRoot, wildcardProjectRoot, dottedProjectRoot],
        "project-order": [projectRoot, childProjectRoot, wildcardProjectRoot, dottedProjectRoot],
      });

      const missingProject = runOmx(wd, ["app", "sidebar", "repair", "--project", "--dry-run"], { HOME: home, CODEX_HOME: codexHome });
      assert.notEqual(missingProject.status, 0);
      assert.match(missingProject.stderr, /--project requires a value/);

      const missingLimit = runOmx(wd, ["app", "sidebar", "repair", "--limit", "--dry-run"], { HOME: home, CODEX_HOME: codexHome });
      assert.notEqual(missingLimit.status, 0);
      assert.match(missingLimit.stderr, /--limit requires a value/);

      const repair = runOmx(wd, ["app", "sidebar", "repair", "--project", "翻译插件"], { HOME: home, CODEX_HOME: codexHome });
      assert.equal(repair.status, 0, repair.stderr || repair.stdout);
      const repaired = JSON.parse(await readFile(globalStatePath, "utf-8")) as Record<string, unknown>;
      assert.deepEqual((repaired["sidebar-project-thread-orders"] as Record<string, string[]>)[projectRoot], [threadId]);
      assert.equal((repaired["sidebar-project-thread-orders"] as Record<string, string[]>)[projectRoot]?.includes(childThreadId), false);
      assert.equal((repaired["thread-workspace-root-hints"] as Record<string, string>)[threadId], projectRoot);
      assert.equal((repaired["thread-project-assignments"] as Record<string, string>)[threadId], projectRoot);
      assert.deepEqual(await readFile(sqlitePath), sqliteBefore);

      const backup = repair.stdout.match(/Backup: (.+)/)?.[1]?.trim();
      assert.ok(backup, repair.stdout);
      const rollback = runOmx(wd, ["app", "sidebar", "rollback", backup], { HOME: home, CODEX_HOME: codexHome });
      assert.equal(rollback.status, 0, rollback.stderr || rollback.stdout);
      assert.deepEqual(JSON.parse(await readFile(globalStatePath, "utf-8")), {
        "electron-saved-workspace-roots": [projectRoot, childProjectRoot, wildcardProjectRoot, dottedProjectRoot],
        "project-order": [projectRoot, childProjectRoot, wildcardProjectRoot, dottedProjectRoot],
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
