import { existsSync } from "fs";
import { resolve } from "path";
import { spawn } from "child_process";
import { setCurrentMode } from "./mode.js";

function run(command: string, args: string[], cwd = process.cwd()): Promise<number> {
  return new Promise((resolveCode, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: false,
      env: process.env,
    });
    child.on("error", reject);
    child.on("close", (code) => resolveCode(code ?? 0));
  });
}

async function hasCommand(command: string, cwd = process.cwd()): Promise<boolean> {
  const code = await run("bash", ["-lc", `command -v ${command} >/dev/null 2>&1`], cwd);
  return code === 0;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function getFlagValue(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx < 0) return null;
  const value = args[idx + 1];
  if (!value || value.startsWith("--")) return null;
  return value;
}

function printCursorHelp(): void {
  console.log(`
omx cursor <subcommand>

Subcommands:
  setup                 Ensure cursor adapter files exist
  doctor                Validate adapter shape
  new <change-slug>     Bootstrap OpenSpec change scaffold
  plan <change-slug>    Print planning guidance for Cursor workflow
  review <change-slug>  Run drift/spec consistency check
  apply <change-slug>   Cursor-driven apply guidance (use --run to invoke cursor-agent)
  archive <change-slug> Print archive guidance
`);
}

export async function cursorCommand(args: string[]): Promise<void> {
  const sub = args[0];
  const root = process.cwd();
  const bootstrapScript = resolve(root, "scripts/bootstrap-change.sh");
  const driftScript = resolve(root, "scripts/check-drift.sh");
  const adapterReadme = resolve(root, "adapters/cursor/README.md");

  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    printCursorHelp();
    return;
  }

  switch (sub) {
    case "setup": {
      setCurrentMode("cursor");
      if (existsSync(adapterReadme)) {
        console.log("[cursor] adapter detected: adapters/cursor");
      } else {
        console.log(
          "[cursor] adapter not found. Expected adapters/cursor/*. Please add adapter files.",
        );
      }
      if (!existsSync(bootstrapScript) || !existsSync(driftScript)) {
        console.log(
          "[cursor] missing scripts. Expected scripts/bootstrap-change.sh and scripts/check-drift.sh",
        );
      } else {
        console.log("[cursor] required scripts present.");
      }
      const hasCursorAgent = await hasCommand("cursor-agent", root);
      const hasCursorCli = await hasCommand("cursor", root);
      if (!hasCursorAgent && !hasCursorCli) {
        console.log("[cursor] cursor-agent/cursor CLI not found in PATH.");
      } else {
        console.log("[cursor] cursor CLI detected.");
      }
      console.log("[cursor] mode switched to cursor.");
      return;
    }
    case "doctor": {
      const required = [
        "adapters/cursor/control-plane.md",
        "adapters/cursor/model-routing.yaml",
        ".cursor/rules/global.mdc",
        ".cursor/rules/backend-api-design.mdc",
        "openspec/config.yaml",
        ".github/workflows/pr-check.yml",
      ];
      const missing = required.filter((p) => !existsSync(resolve(root, p)));
      if (missing.length > 0) {
        console.error("[cursor] doctor failed. Missing files:");
        for (const m of missing) console.error(`  - ${m}`);
        process.exitCode = 1;
        return;
      }
      const hasCursorAgent = await hasCommand("cursor-agent", root);
      const hasCursorCli = await hasCommand("cursor", root);
      if (!hasCursorAgent && !hasCursorCli) {
        console.error("[cursor] doctor failed. cursor-agent/cursor CLI not found.");
        process.exitCode = 1;
        return;
      }
      console.log("[cursor] doctor passed. Adapter is ready.");
      return;
    }
    case "new": {
      const slug = args[1];
      if (!slug) {
        console.error("usage: omx cursor new <change-slug>");
        process.exitCode = 2;
        return;
      }
      if (!existsSync(bootstrapScript)) {
        console.error("[cursor] missing script: scripts/bootstrap-change.sh");
        process.exitCode = 1;
        return;
      }
      const code = await run("bash", [bootstrapScript, slug], root);
      process.exitCode = code;
      return;
    }
    case "review": {
      const slug = args[1];
      if (!slug) {
        console.error("usage: omx cursor review <change-slug>");
        process.exitCode = 2;
        return;
      }
      if (!existsSync(driftScript)) {
        console.error("[cursor] missing script: scripts/check-drift.sh");
        process.exitCode = 1;
        return;
      }
      const code = await run("bash", [driftScript, slug], root);
      process.exitCode = code;
      return;
    }
    case "plan": {
      const slug = args[1];
      if (!slug) {
        console.error("usage: omx cursor plan <change-slug>");
        process.exitCode = 2;
        return;
      }
      console.log(`[cursor] plan guidance for ${slug}`);
      console.log("1) Refine proposal/specs/design/tasks in openspec/changes/<slug>/");
      console.log("2) Ensure Out_Of_Scope and NFR are explicit.");
      console.log("3) Resolve red/blue debate before apply.");
      return;
    }
    case "apply": {
      const slug = args[1];
      if (!slug) {
        console.error("usage: omx cursor apply <change-slug>");
        process.exitCode = 2;
        return;
      }
      console.log(`[cursor] apply guidance for ${slug}`);
      console.log("1) Open Cursor and implement tasks from openspec/changes/<slug>/tasks.md");
      console.log("2) Keep changes inside In_Scope.");
      console.log("3) Run: omx cursor review <slug> before PR.");

      if (hasFlag(args, "--run")) {
        const model = getFlagValue(args, "--model");
        const workspace = getFlagValue(args, "--workspace") ?? root;
        const trust = hasFlag(args, "--trust");
        const prompt = `Implement tasks from openspec/changes/${slug}/tasks.md.
Respect In_Scope/Out_Of_Scope in proposal.md and NFR in specs/spec.md.
After implementation, summarize changed files and verification commands run.`;

        const hasCursorAgent = await hasCommand("cursor-agent", root);
        const cmd = hasCursorAgent ? "cursor-agent" : "cursor";
        const cmdArgs = ["agent"];
        if (trust) {
          cmdArgs.push("--trust");
        }
        cmdArgs.push("--workspace", workspace, prompt);
        if (model) {
          cmdArgs.push("--model", model);
        }
        console.log(`[cursor] running: ${cmd} ${cmdArgs.join(" ")}`);
        const code = await run(cmd, cmdArgs, root);
        process.exitCode = code;
      }
      return;
    }
    case "archive": {
      const slug = args[1];
      if (!slug) {
        console.error("usage: omx cursor archive <change-slug>");
        process.exitCode = 2;
        return;
      }
      console.log(`[cursor] archive guidance for ${slug}`);
      console.log("Run OpenSpec sync/archive in your Cursor workflow and update docs/rules.");
      return;
    }
    default:
      console.error(`[cursor] unknown subcommand: ${sub}`);
      printCursorHelp();
      process.exitCode = 2;
  }
}

