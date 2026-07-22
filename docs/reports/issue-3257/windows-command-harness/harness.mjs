#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";

const HERE = new URL(".", import.meta.url);
const CORPUS_URL = new URL("resolution-corpus.json", HERE);
const DISPOSABLE_PREFIX = "issue-3257-disposable-";
const STABLE_PROFILE = "install --global --ignore-scripts --no-audit --no-progress --prefix <FROZEN_PREFIX> oh-my-codex@latest";
const DEV_PROFILE = "install --global --ignore-scripts --no-audit --no-progress --prefix <FROZEN_PREFIX> <VALIDATED_ABSOLUTE_CONTAINED_TARBALL>";

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write("usage: node harness.mjs --mode noop|disposable --source stable|dev [--root <disposable-temp-root>]\n");
  process.exit(64);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!["--mode", "--source", "--root"].includes(option) || options[option]) usage("invalid or duplicate option");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) usage(`missing value for ${option}`);
    options[option] = value;
    index += 1;
  }
  if (!options["--mode"] || !options["--source"]) usage("--mode and --source are required");
  return { mode: options["--mode"], source: options["--source"], root: options["--root"] };
}

function assertDisposableRoot(root) {
  if (!root) usage("--root is required for disposable mode");
  const resolvedRoot = resolve(root);
  const tempRoot = resolve(tmpdir());
  const pathFromTemp = relative(tempRoot, resolvedRoot);
  const contained = pathFromTemp && !pathFromTemp.startsWith("..") && !pathFromTemp.includes("/") && !pathFromTemp.includes("\\");
  if (!contained || !resolvedRoot.split(/[\\/]/).at(-1).startsWith(DISPOSABLE_PREFIX)) {
    usage("refusing non-disposable root; use a direct child of the system temp directory named issue-3257-disposable-*");
  }
  return resolvedRoot;
}

function windowsResolve(scenario, extensions) {
  const existing = new Set(scenario.existingCommands.map((entry) => entry.toLowerCase()));
  for (const directory of scenario.pathDirectories) {
    for (const extension of extensions) {
      const candidate = `${directory}\\${scenario.command}${extension}`;
      if (existing.has(candidate.toLowerCase())) return candidate;
    }
  }
  return null;
}

function verifyCorpus(corpus) {
  const approvedEdges = [
    "npm run build",
    "npm run verify:native-agents",
    "npm run sync:plugin",
    "npm run verify:plugin-bundle",
    "npm run clean:native-package-assets",
  ];
  if (
    corpus.contractRevision !== 8
    || corpus.commandContractSha256 !== "4cacc4a13de4f6d53c54c9237aa4c1df6b9582cf824aa19d4911e12a57d447df"
    || corpus.windowsPathExtensions.join(",") !== ".com,.exe,.bat,.cmd"
    || corpus.approvedNestedNpmRunEdges.join("\n") !== approvedEdges.join("\n")
  ) {
    throw new Error("corpus violates the frozen Revision 8 Windows resolution policy");
  }
  return corpus.scenarios.map((scenario) => {
    const actualResolution = windowsResolve(scenario, corpus.windowsPathExtensions);
    if (actualResolution !== scenario.expectedResolution) throw new Error(`resolution mismatch for ${scenario.id}`);
    const actualDisposition = actualResolution === null
      ? "REJECT_UNRESOLVED"
      : actualResolution.toLowerCase().includes("\\disposable\\shadow\\")
        ? "REJECT_SHADOW"
        : "ALLOW";
    if (actualDisposition !== scenario.expectedDisposition) throw new Error(`disposition mismatch for ${scenario.id}`);
    return { id: scenario.id, resolution: actualResolution, disposition: actualDisposition };
  });
}

const { mode, source, root } = parseArgs(process.argv.slice(2));
if (!["noop", "disposable"].includes(mode)) usage("--mode must be noop or disposable");
if (!["stable", "dev"].includes(source)) usage("--source must be stable or dev");
if (mode === "noop" && root) usage("--root is not allowed for noop mode");
const disposableRoot = mode === "disposable" ? assertDisposableRoot(root) : null;
const corpus = JSON.parse(await readFile(CORPUS_URL, "utf8"));
const modeledWindowsResolution = verifyCorpus(corpus);

process.stdout.write(`${JSON.stringify({
  receiptType: "ISSUE_3257_PHASE_0_FEASIBILITY_RECEIPT",
  contractRevision: 8,
  commandContractSha256: corpus.commandContractSha256,
  mode,
  source,
  disposableRoot,
  installProfile: source === "stable" ? STABLE_PROFILE : DEV_PROFILE,
  installScripts: "SUPPRESSED",
  productExecution: "NOT_EXECUTED",
  packageManagerMutation: "NOT_EXECUTED",
  globalOrUserMutation: "NOT_EXECUTED",
  externalLifecycleExecution: "NOT_EXECUTED",
  empiricalResult: "NOT_EXECUTED",
  ownerReview: "REQUIRED",
  modeledWindowsResolution,
  scope: corpus.scope,
})}\n`);
