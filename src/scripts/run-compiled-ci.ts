import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const SOURCE_CHECKOUT_SENTINELS = [
  "src/catalog/manifest.json",
  "docs/troubleshooting.md",
  ".github/workflows/ci.yml",
] as const;

const INSTALLED_PACKAGE_TEST_FILES = [
  "dist/scripts/__tests__/smoke-packed-install.test.js",
  "dist/cli/__tests__/nested-help-routing.test.js",
  "dist/cli/__tests__/mcp-parity.test.js",
] as const;

const INSTALLED_PACKAGE_CLI_SMOKE_COMMANDS = [
  ["--help"],
  ["version"],
  ["api", "--help"],
  ["sparkshell", "--help"],
  ["notepad", "--help"],
  ["project-memory", "--help"],
  ["trace", "--help"],
  ["code-intel", "--help"],
] as const;

function npmBin(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, [...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OMX_AUTO_UPDATE: "0",
      OMX_NOTIFY_FALLBACK: "0",
      OMX_HOOK_DERIVED_SIGNALS: "0",
    },
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

function isSourceCheckout(): boolean {
  return SOURCE_CHECKOUT_SENTINELS.every((sentinel) =>
    existsSync(join(process.cwd(), sentinel)),
  );
}

function runSourceCheckoutGate(): void {
  run(npmBin(), ["run", "verify:native-agents"]);
  run(npmBin(), ["run", "verify:plugin-bundle"]);
  run(npmBin(), ["run", "test:node"]);
  run(process.execPath, ["dist/scripts/generate-catalog-docs.js", "--check"]);
}

function runInstalledPackageGate(): void {
  run(npmBin(), ["run", "verify:native-agents"]);
  run(npmBin(), ["run", "verify:plugin-bundle"]);
  run(process.execPath, [
    "dist/scripts/run-test-files.js",
    ...INSTALLED_PACKAGE_TEST_FILES,
  ]);
  for (const argv of INSTALLED_PACKAGE_CLI_SMOKE_COMMANDS) {
    run(process.execPath, ["dist/cli/omx.js", ...argv]);
  }
}

try {
  if (isSourceCheckout()) {
    runSourceCheckoutGate();
  } else {
    runInstalledPackageGate();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
