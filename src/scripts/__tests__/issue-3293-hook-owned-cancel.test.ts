import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { dispatchCodexNativeHook } from "../codex-native-hook.js";

async function json(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
}

async function fixture(sessionId = "session-hook-cancel") {
  const cwd = await mkdtemp(join(tmpdir(), "omx-3293-hook-cancel-"));
  const stateDir = join(cwd, ".omx", "state");
  const threadId = `thread-${sessionId}`;
  const sessionDir = join(stateDir, "sessions", sessionId);
  await json(join(stateDir, "session.json"), { session_id: sessionId, cwd, leader_thread_id: threadId });
  await json(join(stateDir, "subagent-tracking.json"), { schemaVersion: 1, sessions: { [sessionId]: { session_id: sessionId, leader_thread_id: threadId, threads: { [threadId]: { thread_id: threadId, kind: "leader" } } } } });
  await json(join(sessionDir, "autopilot-state.json"), { active: true, mode: "autopilot", current_phase: "deep-interview", session_id: sessionId, thread_id: threadId, workingDirectory: cwd });
  await json(join(sessionDir, "skill-active-state.json"), { active: true, skill: "autopilot", phase: "deep-interview", session_id: sessionId, thread_id: threadId, active_skills: [{ active: true, skill: "autopilot", phase: "deep-interview", session_id: sessionId, thread_id: threadId }] });
  return { cwd, stateDir, sessionDir, sessionId, threadId };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function preTool(f: Fixture, command: string, overrides: Record<string, unknown> = {}) {
  return dispatchCodexNativeHook({ hook_event_name: "PreToolUse", cwd: f.cwd, session_id: f.sessionId, thread_id: f.threadId, agent_id: f.threadId, tool_name: "Bash", tool_input: { command }, ...overrides }, { cwd: f.cwd });
}

function stop(f: Fixture) {
  return dispatchCodexNativeHook({ hook_event_name: "Stop", cwd: f.cwd, session_id: f.sessionId, thread_id: f.threadId }, { cwd: f.cwd });
}

function assertValueFreeDenial(result: Awaited<ReturnType<typeof preTool>>, f: Fixture, stateContent: string, label: string): void {
  assert.equal(result.outputJson?.decision, "block", label);
  const rendered = JSON.stringify(result.outputJson);
  for (const secret of [f.cwd, f.sessionId, stateContent]) assert.equal(rendered.includes(secret), false, `${label}: diagnostic leaked a value`);
}

async function withEnv<T>(values: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const before = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  try {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    return await run();
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

async function denialFixture(command: string, mutate?: (f: Fixture) => Promise<void>, payload?: Record<string, unknown>) {
  const f = await fixture();
  try {
    if (mutate) await mutate(f);
    const stateContent = await readFile(join(f.sessionDir, "autopilot-state.json"), "utf8");
    const result = await preTool(f, command, payload);
    assertValueFreeDenial(result, f, stateContent, command);
  } finally { await rm(f.cwd, { recursive: true, force: true }); }
}

async function withTrustedOmx<T>(run: () => Promise<T>): Promise<T> {
  const bin = await mkdtemp(join(tmpdir(), "omx-3293-trusted-bin-"));
  try {
    await symlink(realpathSync(resolve(process.cwd(), "dist", "cli", "omx.js")), join(bin, "omx"));
    return await withEnv({ PATH: [bin, dirname(process.execPath)].join(delimiter) }, run);
  } finally {
    await rm(bin, { recursive: true, force: true });
  }
}

async function standaloneDeepInterviewFixture(sessionId = "session-standalone-deep-interview") {
  const cwd = await mkdtemp(join(tmpdir(), "omx-3293-standalone-cancel-"));
  const stateDir = join(cwd, ".omx", "state");
  const threadId = `thread-${sessionId}`;
  const sessionDir = join(stateDir, "sessions", sessionId);
  await json(join(stateDir, "session.json"), { session_id: sessionId, cwd, leader_thread_id: threadId });
  await json(join(stateDir, "subagent-tracking.json"), { schemaVersion: 1, sessions: { [sessionId]: { session_id: sessionId, leader_thread_id: threadId, threads: { [threadId]: { thread_id: threadId, kind: "leader" } } } } });
  await json(join(sessionDir, "deep-interview-state.json"), { active: true, mode: "deep-interview", current_phase: "intent-first", session_id: sessionId, thread_id: threadId, workingDirectory: cwd });
  await json(join(sessionDir, "skill-active-state.json"), { active: true, skill: "deep-interview", phase: "intent-first", session_id: sessionId, thread_id: threadId, active_skills: [{ active: true, skill: "deep-interview", phase: "intent-first", session_id: sessionId, thread_id: threadId }] });
  return { cwd, stateDir, sessionDir, sessionId, threadId };
}

const npmShimTarget = "node_modules/oh-my-codex/dist/cli/omx.js";
const npmPosixShim = `#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")

case \`uname\` in
    *CYGWIN*|*MINGW*|*MSYS*)
        if command -v cygpath > /dev/null 2>&1; then
            basedir=\`cygpath -w "$basedir"\`
        fi
    ;;
esac

if [ -x "$basedir/node" ]; then
  exec "$basedir/node"  "$basedir/${npmShimTarget}" "$@"
else${" "}
  exec node  "$basedir/${npmShimTarget}" "$@"
fi
`;
const npmCmdShim = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\oh-my-codex\\dist\\cli\\omx.js" %*
`;
const npmPowerShellShim = `#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent

$exe=""
if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {
  # Fix case when both the Windows and Linux builds of Node
  # are installed in the same directory
  $exe=".exe"
}
$ret=0
if (Test-Path "$basedir/node$exe") {
  # Support pipeline input
  if ($MyInvocation.ExpectingInput) {
    $input | & "$basedir/node$exe"  "$basedir/${npmShimTarget}" $args
  } else {
    & "$basedir/node$exe"  "$basedir/${npmShimTarget}" $args
  }
  $ret=$LASTEXITCODE
} else {
  # Support pipeline input
  if ($MyInvocation.ExpectingInput) {
    $input | & "node$exe"  "$basedir/${npmShimTarget}" $args
  } else {
    & "node$exe"  "$basedir/${npmShimTarget}" $args
  }
  $ret=$LASTEXITCODE
}
exit $ret
`;

describe("issue #3293 hook-owned cancellation", () => {
  it("handles bare deep-interview cancellation, terminalizes both files, and does not execute Bash", async () => {
    const f = await fixture();
    try {
      const sentinel = join(f.cwd, "plugin-sentinel");
      await mkdir(join(f.cwd, ".omx", "hooks"), { recursive: true });
      await writeFile(join(f.cwd, ".omx", "hooks", "sentinel.mjs"), `import { writeFile } from 'node:fs/promises'; await writeFile(${JSON.stringify(sentinel)}, 'ran');`);
      const result = await withTrustedOmx(() => preTool(f, "omx cancel"));
      assert.equal(result.outputJson?.decision, "block");
      assert.match(JSON.stringify(result.outputJson), /cancelled_exact_session/);
      assert.equal(JSON.parse(await readFile(join(f.sessionDir, "autopilot-state.json"), "utf8")).active, false);
      assert.equal(JSON.parse(await readFile(join(f.sessionDir, "skill-active-state.json"), "utf8")).active, false);
      await assert.rejects(readFile(sentinel));
    } finally { await rm(f.cwd, { recursive: true, force: true }); }
  });

  it("handles the native Windows npm shim set and rejects a modified PowerShell shim", { skip: process.platform !== "win32" }, async () => {
    const f = await fixture("session-hook-cancel-windows-npm");
    const bin = await mkdtemp(join(tmpdir(), "omx-3293-windows-npm-bin-"));
    try {
      const installedCli = join(bin, ...npmShimTarget.split("/"));
      await mkdir(dirname(installedCli), { recursive: true });
      await symlink(realpathSync(resolve(process.cwd(), "dist", "cli", "omx.js")), installedCli);
      await writeFile(join(bin, "omx"), npmPosixShim);
      await writeFile(join(bin, "omx.cmd"), npmCmdShim.replace(/\n/g, "\r\n"));
      await writeFile(join(bin, "omx.ps1"), `${npmPowerShellShim}Write-Output attacker\n`);

      await withEnv({ PATH: [bin, dirname(process.execPath)].join(delimiter) }, async () => {
        const activeContent = await readFile(join(f.sessionDir, "autopilot-state.json"), "utf8");
        assertValueFreeDenial(await preTool(f, "omx cancel"), f, activeContent, "modified native Windows npm shim");
        assert.equal(JSON.parse(await readFile(join(f.sessionDir, "autopilot-state.json"), "utf8")).active, true);

        await writeFile(join(bin, "omx.ps1"), npmPowerShellShim);
        const result = await preTool(f, "omx cancel");
        assert.equal(result.outputJson?.decision, "block");
        assert.match(JSON.stringify(result.outputJson), /cancelled_exact_session/);
        assert.equal(JSON.parse(await readFile(join(f.sessionDir, "autopilot-state.json"), "utf8")).active, false);
        assert.equal(JSON.parse(await readFile(join(f.sessionDir, "skill-active-state.json"), "utf8")).active, false);
      });
    } finally {
      await rm(f.cwd, { recursive: true, force: true });
      await rm(bin, { recursive: true, force: true });
    }
  });

  it("permits standalone Desktop cancellation only through the exact trusted Windows npm shim set", { skip: process.platform !== "win32" }, async () => {
    const f = await standaloneDeepInterviewFixture();
    const bin = await mkdtemp(join(tmpdir(), "omx-3313-windows-npm-bin-"));
    try {
      const installedCli = join(bin, ...npmShimTarget.split("/"));
      await mkdir(dirname(installedCli), { recursive: true });
      await symlink(realpathSync(resolve(process.cwd(), "dist", "cli", "omx.js")), installedCli);
      await writeFile(join(bin, "omx"), npmPosixShim);
      await writeFile(join(bin, "omx.cmd"), npmCmdShim.replace(/\n/g, "\r\n"));
      await writeFile(join(bin, "omx.ps1"), `${npmPowerShellShim}Write-Output attacker\n`);

      await withEnv({ PATH: [bin, dirname(process.execPath)].join(delimiter), PATHEXT: ".COM;.EXE;.BAT;.CMD" }, async () => {
        const statePath = join(f.sessionDir, "deep-interview-state.json");
        const activeContent = await readFile(statePath, "utf8");
        assertValueFreeDenial(await preTool(f, "omx cancel"), f, activeContent, "modified standalone PowerShell npm shim");
        assert.equal(await readFile(statePath, "utf8"), activeContent);

        await writeFile(join(bin, "omx.ps1"), npmPowerShellShim);
        await writeFile(join(bin, "node.exe"), "attacker");
        assertValueFreeDenial(await preTool(f, "omx cancel"), f, activeContent, "adjacent untrusted node.exe");
        assert.equal(await readFile(statePath, "utf8"), activeContent);
        await rm(join(bin, "node.exe"), { force: true });

        await writeFile(join(bin, "omx.js"), "attacker");
        await withEnv({ PATHEXT: ".JS;.CMD" }, async () => {
          assertValueFreeDenial(await preTool(f, "omx cancel"), f, activeContent, "custom PATHEXT shadow");
          assert.equal(await readFile(statePath, "utf8"), activeContent);
        });
        await rm(join(bin, "omx.js"), { force: true });

        const allowed = await preTool(f, "omx cancel");
        assert.equal(allowed.outputJson, null);
        assert.equal(await readFile(statePath, "utf8"), activeContent);
      });
    } finally {
      await rm(f.cwd, { recursive: true, force: true });
      await rm(bin, { recursive: true, force: true });
    }
  });

  it("stops repeatedly without continuation, reactivation, or terminal-byte changes", async () => {
    const f = await fixture();
    try {
      await withTrustedOmx(() => preTool(f, "omx cancel"));
      const paths = [join(f.sessionDir, "autopilot-state.json"), join(f.sessionDir, "skill-active-state.json")];
      const terminal = await Promise.all(paths.map((path) => readFile(path)));
      assert.equal((await stop(f)).outputJson, null);
      assert.equal((await stop(f)).outputJson, null);
      assert.deepEqual(await Promise.all(paths.map((path) => readFile(path))), terminal);
      assert.equal(JSON.parse(terminal[0].toString()).active, false);
    } finally { await rm(f.cwd, { recursive: true, force: true }); }
  });

  it("terminalizes only the exact session", async () => {
    const f = await fixture();
    try {
      const otherId = "session-other";
      const otherDir = join(f.stateDir, "sessions", otherId);
      const otherAutopilot = { active: true, mode: "autopilot", current_phase: "deep-interview", session_id: otherId, thread_id: "thread-other", workingDirectory: f.cwd };
      const otherSkill = { active: true, skill: "autopilot", phase: "deep-interview", session_id: otherId, thread_id: "thread-other" };
      await json(join(otherDir, "autopilot-state.json"), otherAutopilot);
      await json(join(otherDir, "skill-active-state.json"), otherSkill);
      const before = await Promise.all([readFile(join(otherDir, "autopilot-state.json")), readFile(join(otherDir, "skill-active-state.json"))]);
      await withTrustedOmx(() => preTool(f, "omx cancel"));
      assert.equal(JSON.parse(await readFile(join(f.sessionDir, "autopilot-state.json"), "utf8")).active, false);
      assert.deepEqual(await Promise.all([readFile(join(otherDir, "autopilot-state.json")), readFile(join(otherDir, "skill-active-state.json"))]), before);
    } finally { await rm(f.cwd, { recursive: true, force: true }); }
  });

  it("fails closed for cancellation and Stop when a prepared journal exists", async () => {
    const f = await fixture();
    try {
      await json(join(f.sessionDir, ".hook-cancel-transaction.json"), { phase: "prepared", session_id: f.sessionId });
      const content = await readFile(join(f.sessionDir, "autopilot-state.json"), "utf8");
      assertValueFreeDenial(await preTool(f, "omx cancel"), f, content, "prepared cancellation");
      const stopped = await stop(f);
      assert.equal(stopped.outputJson?.decision, "block");
      const rendered = JSON.stringify(stopped.outputJson);
      for (const secret of [f.cwd, f.sessionId, content]) assert.equal(rendered.includes(secret), false);
    } finally { await rm(f.cwd, { recursive: true, force: true }); }
  });

  it("denies a fully forged public-hook caller because no executable trust can be forged", async () => {
    const f = await fixture();
    try {
      const attacker = join(f.cwd, "attacker-bin");
      await mkdir(attacker); await writeFile(join(attacker, "omx"), "#!/bin/sh\nexit 0\n"); await chmod(join(attacker, "omx"), 0o755);
      await withEnv({ PATH: attacker }, async () => {
        const content = await readFile(join(f.sessionDir, "autopilot-state.json"), "utf8");
        const result = await preTool(f, "omx cancel", { thread_id: "unbound-attacker", agent_id: "unbound-attacker" });
        assertValueFreeDenial(result, f, content, "fully forged public hook");
      });
    } finally { await rm(f.cwd, { recursive: true, force: true }); }
  });

  it("denies hostile modified shim contents", async () => {
    const f = await fixture();
    try {
      const bin = join(f.cwd, "modified-bin");
      await mkdir(bin); await writeFile(join(bin, "omx"), "#!/bin/sh\necho attacker\n"); await chmod(join(bin, "omx"), 0o755);
      const content = await readFile(join(f.sessionDir, "autopilot-state.json"), "utf8");
      await withEnv({ PATH: bin }, async () => assertValueFreeDenial(await preTool(f, "omx cancel"), f, content, "modified shim"));
    } finally { await rm(f.cwd, { recursive: true, force: true }); }
  });

  it("denies hostile shim symlink replacement", async () => {
    const f = await fixture();
    try {
      const bin = join(f.cwd, "symlink-bin"); const target = join(f.cwd, "attacker-omx");
      await mkdir(bin); await writeFile(target, "#!/bin/sh\necho attacker\n"); await chmod(target, 0o755); await symlink(target, join(bin, "omx"));
      const content = await readFile(join(f.sessionDir, "autopilot-state.json"), "utf8");
      await withEnv({ PATH: bin }, async () => assertValueFreeDenial(await preTool(f, "omx cancel"), f, content, "symlink shim"));
    } finally { await rm(f.cwd, { recursive: true, force: true }); }
  });

  const commandCases = [
    ["wrapper with extra commands", "env omx cancel"], ["wrapper with extra args", "omx cancel --force"],
    ["unsafe leading assignment", "FOO=bar omx cancel"], ["semicolon operator", "omx cancel; true"], ["and operator", "omx cancel && true"], ["or operator", "omx cancel || true"], ["pipeline operator", "omx cancel | cat"], ["background operator", "omx cancel &"],
    ["command substitution", "$(printf omx) cancel"], ["backtick substitution", "`printf omx` cancel"], ["input redirection", "omx cancel < /dev/null"], ["output redirection", "omx cancel > /dev/null"], ["path-qualified untrusted executable", "/tmp/omx cancel"],
  ] as const;
  for (const [name, command] of commandCases) it(`denies hostile ${name}`, async () => denialFixture(command));

  const envCases = ["BASH_ENV", "BASH_FUNC_omx%%", "NODE_OPTIONS", "NODE_V8_COVERAGE", "NODE_COMPILE_CACHE", "NODE_REDIRECT_WARNINGS", "NODE_REPORT_DIRECTORY", "NODE_REPORT_FILENAME", "OPENSSL_CONF"] as const;
  for (const name of envCases) it(`denies hostile inherited ${name}`, async () => {
    const f = await fixture();
    try {
      const content = await readFile(join(f.sessionDir, "autopilot-state.json"), "utf8");
      await withEnv({ [name]: name === "BASH_FUNC_omx%%" ? "() { :; }" : join(f.cwd, "injected") }, async () => assertValueFreeDenial(await preTool(f, "omx cancel"), f, content, name));
    } finally { await rm(f.cwd, { recursive: true, force: true }); }
  });

  it("denies hostile loader injection", async () => denialFixture("node --loader attacker.mjs omx cancel"));
  it("denies hostile PATH-shadowed omx", async () => {
    const f = await fixture(); try { const bin = join(f.cwd, "shadow"); await mkdir(bin); await writeFile(join(bin, "omx"), "#!/bin/sh\nexit 0\n"); await chmod(join(bin, "omx"), 0o755); const content = await readFile(join(f.sessionDir, "autopilot-state.json"), "utf8"); await withEnv({ PATH: bin }, async () => assertValueFreeDenial(await preTool(f, "omx cancel"), f, content, "PATH shadow")); } finally { await rm(f.cwd, { recursive: true, force: true }); }
  });
  it("denies hostile repo-local lookalike executable", async () => denialFixture("./omx cancel", async (f) => { await writeFile(join(f.cwd, "omx"), "#!/bin/sh\nexit 0\n"); await chmod(join(f.cwd, "omx"), 0o755); }));
  it("denies hostile cross-session selector", async () => denialFixture("omx cancel", undefined, { session_id: "other-session", sessionId: "other-session" }));
  it("denies hostile cross-root selector", async () => denialFixture("OMX_ROOT=/tmp/other omx cancel"));
  it("denies hostile unset PATH", async () => { const f = await fixture(); try { const content = await readFile(join(f.sessionDir, "autopilot-state.json"), "utf8"); await withEnv({ PATH: undefined }, async () => assertValueFreeDenial(await preTool(f, "omx cancel"), f, content, "unset PATH")); } finally { await rm(f.cwd, { recursive: true, force: true }); } });
  it("denies hostile unreadable PATH entry", async () => { const f = await fixture(); try { const path = join(f.cwd, "unreadable"); await mkdir(path); await chmod(path, 0o000); const content = await readFile(join(f.sessionDir, "autopilot-state.json"), "utf8"); await withEnv({ PATH: path }, async () => assertValueFreeDenial(await preTool(f, "omx cancel"), f, content, "unreadable PATH")); await chmod(path, 0o755); } finally { await rm(f.cwd, { recursive: true, force: true }); } });
  it("denies hostile non-directory PATH entry", async () => { const f = await fixture(); try { const path = join(f.cwd, "not-directory"); await writeFile(path, "x"); const content = await readFile(join(f.sessionDir, "autopilot-state.json"), "utf8"); await withEnv({ PATH: path }, async () => assertValueFreeDenial(await preTool(f, "omx cancel"), f, content, "file PATH")); } finally { await rm(f.cwd, { recursive: true, force: true }); } });
  it("denies hostile non-executable shim", async () => { const f = await fixture(); try { const bin = join(f.cwd, "bin"); await mkdir(bin); await writeFile(join(bin, "omx"), "#!/bin/sh\nexit 0\n"); const content = await readFile(join(f.sessionDir, "autopilot-state.json"), "utf8"); await withEnv({ PATH: bin }, async () => assertValueFreeDenial(await preTool(f, "omx cancel"), f, content, "non-executable shim")); } finally { await rm(f.cwd, { recursive: true, force: true }); } });

  it("R-4 documents payload-bound identity and ambient same-euid target-root selection", async () => {
    const source = await readFile(resolve(process.cwd(), "src/scripts/codex-native-hook.ts"), "utf8");
    assert.match(source, /identity matching is payload-bound while target-root\s+\/\/ selection remains ambient and same-euid trusted/);
  });
});
