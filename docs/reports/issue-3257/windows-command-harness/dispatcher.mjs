#!/usr/bin/env node
import process from "node:process";

const APPROVED_EDGES = new Set([
  "npm run build",
  "npm run verify:native-agents",
  "npm run sync:plugin",
  "npm run verify:plugin-bundle",
  "npm run clean:native-package-assets",
]);

const requestedEdge = process.argv.slice(2).join(" ");
if (!APPROVED_EDGES.has(requestedEdge)) {
  process.stderr.write(`issue-3257 dispatcher rejected nested edge: ${requestedEdge || "<empty>"}\n`);
  process.exitCode = 64;
} else {
  process.stdout.write(`${requestedEdge}\n`);
}
