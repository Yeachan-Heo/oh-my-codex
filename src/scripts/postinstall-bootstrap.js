import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distScriptPath = join(__dirname, "..", "..", "dist", "scripts", "postinstall.js");

if (!existsSync(distScriptPath)) {
  process.exit(0);
}

const moduleUrl = pathToFileURL(distScriptPath).href;
try {
  const postinstallModule = await import(moduleUrl);
  if (typeof postinstallModule.main === "function") {
    await postinstallModule.main();
  }
} catch (error) {
  console.warn(
    `[omx] Postinstall bootstrap skipped after a non-fatal error: ${error instanceof Error ? error.message : String(error)}`,
  );
}
