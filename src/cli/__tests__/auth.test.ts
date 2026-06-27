import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function omxBin(): string {
  const testDir = dirname(fileURLToPath(import.meta.url));
  return join(testDir, "..", "..", "..", "dist", "cli", "omx.js");
}

function runOmx(cwd: string, argv: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [omxBin(), ...argv], {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: env.HOME,
      CODEX_HOME: env.CODEX_HOME ?? "",
      NODE_OPTIONS: "",
      OMX_AUTO_UPDATE: "0",
      OMX_NOTIFY_FALLBACK: "0",
      OMX_HOOK_DERIVED_SIGNALS: "0",
      ...env,
    },
  });
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "", error: result.error?.message || "" };
}

async function writeFakeCodex(binDir: string, script: string): Promise<string> {
  await mkdir(binDir, { recursive: true });
  const path = join(binDir, "codex");
  await writeFile(path, script);
  await chmod(path, 0o755);
  return path;
}

describe("omx auth CLI", () => {
  it("shows nested help and top-level hotswap help", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-auth-help-"));
    try {
      const help = runOmx(wd, ["auth", "--help"], { HOME: wd });
      assert.equal(help.status, 0, help.stderr);
      assert.match(help.stdout, /omx auth add <slot>/);
      const top = runOmx(wd, ["--help"], { HOME: wd });
      assert.match(top.stdout, /--hotswap/);
      assert.match(top.stdout, /omx auth/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("adds, lists, and uses slots through the compiled CLI without leaking tokens", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-auth-cli-"));
    try {
      const home = join(wd, "home");
      const codexHome = join(home, ".codex");
      const bin = join(wd, "bin");
      await mkdir(codexHome, { recursive: true });
      await writeFakeCodex(bin, `#!/bin/sh\nif [ "$1" = "login" ]; then mkdir -p "$CODEX_HOME"; printf '{"access_token":"sentinel-secret"}\\n' > "$CODEX_HOME/auth.json"; exit 0; fi\necho unexpected "$@" >&2\nexit 2\n`);
      const env = { HOME: home, CODEX_HOME: codexHome, PATH: `${bin}:/usr/bin:/bin` };
      const add = runOmx(wd, ["auth", "add", "work"], env);
      assert.equal(add.status, 0, add.stderr);
      assert.doesNotMatch(add.stdout + add.stderr, /sentinel-secret/);
      const list = runOmx(wd, ["auth", "list", "--json"], env);
      assert.equal(list.status, 0, list.stderr);
      assert.match(list.stdout, /"slot": "work"/);
      await writeFile(join(codexHome, "auth.json"), '{"access_token":"other"}\n');
      const use = runOmx(wd, ["auth", "use", "work"], env);
      assert.equal(use.status, 0, use.stderr);
      assert.doesNotMatch(use.stdout + use.stderr, /sentinel-secret/);
      assert.equal(await readFile(join(codexHome, "auth.json"), "utf-8"), '{"access_token":"sentinel-secret"}\n');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("adds slots through isolated login CODEX_HOME and forwards device auth", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-auth-isolated-add-"));
    try {
      const home = join(wd, "home");
      const codexHome = join(home, ".codex");
      const bin = join(wd, "bin");
      const loginEnvFile = join(wd, "login-codex-home.txt");
      const loginArgsFile = join(wd, "login-args.txt");
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, "auth.json"), '{"access_token":"live-primary"}\n');
      await writeFakeCodex(bin, `#!/bin/sh
if [ "$1" = "login" ]; then
  printf '%s\n' "$CODEX_HOME" > ${JSON.stringify(loginEnvFile)}
  printf '%s\n' "$*" > ${JSON.stringify(loginArgsFile)}
  mkdir -p "$CODEX_HOME"
  printf '{"access_token":"new-secondary"}\n' > "$CODEX_HOME/auth.json"
  exit 0
fi
echo unexpected "$@" >&2
exit 2
`);
      const env = { HOME: home, CODEX_HOME: codexHome, PATH: `${bin}:/usr/bin:/bin` };
      const add = runOmx(wd, ["auth", "add", "secondary", "--device-auth"], env);
      assert.equal(add.status, 0, add.stderr);
      assert.equal(await readFile(join(codexHome, "auth.json"), "utf-8"), '{"access_token":"live-primary"}\n');
      assert.equal(await readFile(join(home, ".omx", "auth", "secondary.json"), "utf-8"), '{"access_token":"new-secondary"}\n');
      assert.equal(await readFile(loginArgsFile, "utf-8"), "login --device-auth\n");
      assert.notEqual((await readFile(loginEnvFile, "utf-8")).trim(), codexHome);
      assert.doesNotMatch(add.stdout + add.stderr, /live-primary|new-secondary/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("sets subscription Codex defaults when auth add sees empty config", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-auth-defaults-"));
    try {
      const home = join(wd, "home");
      const codexHome = join(home, ".codex");
      const bin = join(wd, "bin");
      await mkdir(codexHome, { recursive: true });
      await writeFakeCodex(bin, `#!/bin/sh\nif [ "$1" = "login" ]; then mkdir -p "$CODEX_HOME"; printf '{"access_token":"sentinel-secret"}\\n' > "$CODEX_HOME/auth.json"; exit 0; fi\necho unexpected "$@" >&2\nexit 2\n`);
      const add = runOmx(wd, ["auth", "add", "work"], { HOME: home, CODEX_HOME: codexHome, PATH: `${bin}:/usr/bin:/bin` });
      assert.equal(add.status, 0, add.stderr);
      assert.match(await readFile(join(codexHome, "config.toml"), "utf-8"), /^model = "gpt-5-codex"\n+model_provider = "openai-chatgpt"\n$/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("preserves explicit model and provider when auth add succeeds", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-auth-preserve-defaults-"));
    try {
      const home = join(wd, "home");
      const codexHome = join(home, ".codex");
      const bin = join(wd, "bin");
      await mkdir(codexHome, { recursive: true });
      const originalConfig = 'model = "gpt-custom"\nmodel_provider = "custom_provider"\n[tui]\nstatus_line = []\n';
      await writeFile(join(codexHome, "config.toml"), originalConfig);
      await writeFakeCodex(bin, `#!/bin/sh\nif [ "$1" = "login" ]; then mkdir -p "$CODEX_HOME"; printf '{"access_token":"sentinel-secret"}\\n' > "$CODEX_HOME/auth.json"; exit 0; fi\necho unexpected "$@" >&2\nexit 2\n`);
      const add = runOmx(wd, ["auth", "add", "work"], { HOME: home, CODEX_HOME: codexHome, PATH: `${bin}:/usr/bin:/bin` });
      assert.equal(add.status, 0, add.stderr);
      assert.equal(await readFile(join(codexHome, "config.toml"), "utf-8"), originalConfig);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });


  it("adds project-scope slots from the same CODEX_HOME used by launch", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-auth-project-add-"));
    try {
      const home = join(wd, "home");
      const bin = join(wd, "bin");
      await mkdir(join(wd, ".omx"), { recursive: true });
      await writeFile(join(wd, ".omx", "setup-scope.json"), '{"scope":"project"}\n');
      const expectedLiveCodexHome = join(await realpath(wd), ".codex");
      const loginEnvFile = join(wd, "login-codex-home.txt");
      await writeFakeCodex(bin, `#!/bin/sh
if [ "$1" = "login" ]; then printf '%s\n' "$CODEX_HOME" > ${JSON.stringify(loginEnvFile)}; mkdir -p "$CODEX_HOME"; printf '{"access_token":"project-secret"}\n' > "$CODEX_HOME/auth.json"; exit 0; fi
echo unexpected "$@" >&2
exit 2
`);
      const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin` };
      const add = runOmx(wd, ["auth", "add", "project"], env);
      assert.equal(add.status, 0, add.stderr);
      assert.doesNotMatch(add.stdout + add.stderr, /project-secret/);
      assert.equal(await readFile(join(home, ".omx", "auth", "project.json"), "utf-8"), '{"access_token":"project-secret"}\n');
      assert.equal(await readFile(join(expectedLiveCodexHome, "auth.json"), "utf-8"), '{"access_token":"project-secret"}\n');
      assert.notEqual((await readFile(loginEnvFile, "utf-8")).trim(), expectedLiveCodexHome);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("fails soft when no slots are configured", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-auth-noslots-"));
    try {
      const result = runOmx(wd, ["--hotswap", "--direct"], { HOME: join(wd, "home"), PATH: `/usr/bin:/bin` });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /no slots configured/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("hotswaps on 429 and resumes the latest rollout with the next slot", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-auth-hotswap-"));
    try {
      const home = join(wd, "home");
      const codexHome = join(home, ".codex");
      const authDir = join(home, ".omx", "auth");
      const bin = join(wd, "bin");
      const countFile = join(wd, "count");
      const argvFile = join(wd, "argv.log");
      await mkdir(authDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(authDir, "first.json"), '{"access_token":"first-secret"}\n');
      await writeFile(join(authDir, "second.json"), '{"access_token":"second-secret"}\n');
      await writeFile(join(authDir, "slots.json"), JSON.stringify({ version: 1, currentSlot: "first", slots: [
        { slot: "first", createdAt: "now", updatedAt: "now" },
        { slot: "second", createdAt: "now", updatedAt: "now" }
      ] }, null, 2));
      await writeFakeCodex(bin, `#!/bin/sh\ncount=0\n[ -f ${JSON.stringify(countFile)} ] && count=$(cat ${JSON.stringify(countFile)})\ncount=$((count+1))\nprintf '%s' "$count" > ${JSON.stringify(countFile)}\nprintf '%s\\n' "$*" >> ${JSON.stringify(argvFile)}\nif [ "$count" -eq 1 ]; then mkdir -p "$CODEX_HOME/sessions/2026/05/24"; printf '{}\\n' > "$CODEX_HOME/sessions/2026/05/24/rollout-session-123.jsonl"; echo 'HTTP 429 quota exceeded access_token=stderr-secret Bearer abc.def' >&2; exit 1; fi\ncase "$*" in *"resume session-123"*--model*"gpt-review"*) exit 0;; *) echo 'missing resume args or model flag' >&2; exit 3;; esac\n`);
      const env = { HOME: home, CODEX_HOME: codexHome, PATH: `${bin}:/usr/bin:/bin` };
      const result = runOmx(wd, ["--hotswap", "--direct", "--model", "gpt-review"], env);
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.match(result.stderr, /HTTP 429 quota exceeded/);
      const argvLog = await readFile(argvFile, "utf-8");
      assert.match(argvLog, /resume session-123/);
      assert.match(argvLog, /--model gpt-review/);
      assert.equal(await readFile(join(codexHome, "auth.json"), "utf-8"), '{"access_token":"second-secret"}\n');
      assert.doesNotMatch(result.stderr + result.stdout, /first-secret|second-secret|stderr-secret|abc\.def/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("skips invalidated hotswap slots without requiring a rollout session", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-auth-invalidated-hotswap-"));
    try {
      const home = join(wd, "home");
      const codexHome = join(home, ".codex");
      const authDir = join(home, ".omx", "auth");
      const bin = join(wd, "bin");
      const argvFile = join(wd, "argv.log");
      await mkdir(authDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(authDir, "first.json"), '{"access_token":"first-secret"}\n');
      await writeFile(join(authDir, "second.json"), '{"access_token":"second-secret"}\n');
      await writeFile(join(authDir, "slots.json"), JSON.stringify({ version: 1, currentSlot: "first", slots: [
        { slot: "first", createdAt: "now", updatedAt: "now" },
        { slot: "second", createdAt: "now", updatedAt: "now" }
      ] }, null, 2));
      await writeFakeCodex(bin, `#!/bin/sh
printf '%s\n' "$*" >> ${JSON.stringify(argvFile)}
if grep -q first-secret "$CODEX_HOME/auth.json"; then
  echo 'HTTP 401 token_invalidated refresh_token_invalidated' >&2
  exit 1
fi
grep -q second-secret "$CODEX_HOME/auth.json" || exit 4
exit 0
`);
      const result = runOmx(wd, ["--hotswap", "--direct", "--model", "gpt-review"], { HOME: home, CODEX_HOME: codexHome, PATH: `${bin}:/usr/bin:/bin` });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.match(result.stderr, /token invalidated for slot first; rotating to slot second/);
      const argvLog = await readFile(argvFile, "utf-8");
      assert.doesNotMatch(argvLog, /resume/);
      assert.match(argvLog, /--model gpt-review/);
      assert.equal(await readFile(join(codexHome, "auth.json"), "utf-8"), '{"access_token":"second-secret"}\n');
      assert.doesNotMatch(result.stderr + result.stdout, /first-secret|second-secret/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("emits one clean error when all hotswap slots are exhausted", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-auth-exhausted-"));
    try {
      const home = join(wd, "home");
      const codexHome = join(home, ".codex");
      const authDir = join(home, ".omx", "auth");
      const bin = join(wd, "bin");
      await mkdir(authDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(authDir, "first.json"), '{"access_token":"first-secret"}\n');
      await writeFile(join(authDir, "second.json"), '{"access_token":"second-secret"}\n');
      await writeFile(join(authDir, "slots.json"), JSON.stringify({ version: 1, currentSlot: "first", slots: [
        { slot: "first", createdAt: "now", updatedAt: "now" },
        { slot: "second", createdAt: "now", updatedAt: "now" }
      ] }, null, 2));
      await writeFakeCodex(bin, `#!/bin/sh\nmkdir -p "$CODEX_HOME/sessions/2026/05/24"\nprintf '{}\\n' > "$CODEX_HOME/sessions/2026/05/24/rollout-session-429.jsonl"\necho 'HTTP 429 quota exceeded' >&2\nexit 1\n`);
      const result = runOmx(wd, ["--hotswap", "--direct"], { HOME: home, CODEX_HOME: codexHome, PATH: `${bin}:/usr/bin:/bin` });
      assert.equal(result.status, 1);
      const matches = result.stderr.match(/all slots exhausted or invalid: first, second/g) ?? [];
      assert.equal(matches.length, 1, result.stderr);
      assert.doesNotMatch(result.stderr + result.stdout, /first-secret|second-secret/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
