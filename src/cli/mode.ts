import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

export type OmxMode = "codex" | "cursor";

const MODE_FILE = join(process.cwd(), ".omx", "mode.json");

function ensureModeDir(): void {
  const dir = dirname(MODE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function getCurrentMode(): OmxMode {
  try {
    if (!existsSync(MODE_FILE)) return "codex";
    const raw = readFileSync(MODE_FILE, "utf8");
    const parsed = JSON.parse(raw) as { mode?: string };
    return parsed.mode === "cursor" ? "cursor" : "codex";
  } catch {
    return "codex";
  }
}

export function setCurrentMode(mode: OmxMode): void {
  ensureModeDir();
  writeFileSync(
    MODE_FILE,
    `${JSON.stringify({ mode, updated_at: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
}

function printHelp(): void {
  console.log(`
omx mode <show|cursor|codex>

Examples:
  omx mode show
  omx mode cursor
  omx mode codex
`);
}

export async function modeCommand(args: string[]): Promise<void> {
  const action = args[0] ?? "show";
  if (action === "show") {
    console.log(`[mode] ${getCurrentMode()}`);
    return;
  }
  if (action === "cursor" || action === "codex") {
    setCurrentMode(action);
    console.log(`[mode] set to ${action}`);
    return;
  }
  printHelp();
  process.exitCode = 2;
}

