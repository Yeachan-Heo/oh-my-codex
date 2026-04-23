import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DEFAULT_DOCUMENT_REFRESH_RULES, type DocumentRefreshRule } from "./config.js";

export type DocumentRefreshScope = "commit" | "final-handoff";
export type DocumentRefreshHookEventName = "PreToolUse" | "Stop";

export interface ChangedPathRecord {
  status: string;
  path: string;
  previousPath?: string;
}

export interface DocumentRefreshEvaluationInput {
  scope: DocumentRefreshScope;
  changes: ChangedPathRecord[];
  rules?: DocumentRefreshRule[];
  exemptionText?: string | null;
  localFreshTargets?: string[];
}

export interface DocumentRefreshRuleWarning {
  ruleId: string;
  description: string;
  changedPaths: string[];
  refreshTargets: string[];
}

export interface DocumentRefreshWarning {
  scope: DocumentRefreshScope;
  rules: DocumentRefreshRuleWarning[];
  triggeringPaths: string[];
  expectedTargets: string[];
  message: string;
}

export const DOCUMENT_REFRESH_EXEMPTION_PREFIX = "Document-refresh: not-needed |";

const RELEASE_COLLATERAL_GLOBS = [
  "CHANGELOG.md",
  "RELEASE_BODY.md",
  "docs/release-notes-*.md",
  "docs/release-body-*.md",
  "docs/qa/release-readiness-*.md",
];

const TOOLING_ONLY_GLOBS = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
  "tsconfig.*.json",
  "biome.json",
  ".github/workflows/**",
  ".gitignore",
];

function normalizeRepoPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function escapeRegex(char: string): string {
  return /[|\\{}()[\]^$+?.]/u.test(char) ? `\\${char}` : char;
}

export function globToRegExp(glob: string): RegExp {
  const normalized = normalizeRepoPath(glob);
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index] ?? "";
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      index += 1;
      if (normalized[index + 1] === "/") {
        index += 1;
        source += "(?:.*?/)?";
      } else {
        source += ".*";
      }
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegex(char);
  }
  source += "$";
  return new RegExp(source, "u");
}

export function pathMatchesGlob(path: string, glob: string): boolean {
  return globToRegExp(glob).test(normalizeRepoPath(path));
}

function pathMatchesAny(path: string, globs: readonly string[] | undefined): boolean {
  return (globs ?? []).some((glob) => pathMatchesGlob(path, glob));
}

function isRenameOnly(record: ChangedPathRecord): boolean {
  return /^R100$/u.test(record.status.trim());
}

function isTriggerOnlyExcluded(record: ChangedPathRecord): boolean {
  const path = normalizeRepoPath(record.path);
  return pathMatchesAny(path, TOOLING_ONLY_GLOBS) || pathMatchesAny(path, RELEASE_COLLATERAL_GLOBS);
}

function unique(values: Iterable<string>): string[] {
  return [...new Set([...values].map(normalizeRepoPath))].sort();
}

export function hasDocumentRefreshExemption(text: string | null | undefined): boolean {
  if (!text) return false;
  return text.split(/\r?\n/u).some((line) => line.trim().startsWith(DOCUMENT_REFRESH_EXEMPTION_PREFIX));
}

export function parseGitNameStatus(text: string): ChangedPathRecord[] {
  const records: ChangedPathRecord[] = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    const parts = line.split("\t").filter((part) => part.length > 0);
    if (parts.length < 2) continue;
    const status = parts[0] ?? "";
    if (/^R\d+$/u.test(status) || /^C\d+$/u.test(status)) {
      if (parts.length >= 3) {
        records.push({
          status,
          previousPath: normalizeRepoPath(parts[1] ?? ""),
          path: normalizeRepoPath(parts[2] ?? ""),
        });
      }
      continue;
    }
    records.push({ status, path: normalizeRepoPath(parts[1] ?? "") });
  }
  return records;
}

function changedPathCandidates(record: ChangedPathRecord): string[] {
  return unique([record.path, record.previousPath ?? ""].filter(Boolean));
}

function recordMatchesRuleSource(record: ChangedPathRecord, rule: DocumentRefreshRule): boolean {
  if (isRenameOnly(record)) return false;
  if (isTriggerOnlyExcluded(record)) return false;
  const candidates = changedPathCandidates(record);
  return candidates.some((path) => pathMatchesAny(path, rule.sourceGlobs))
    && !candidates.every((path) => pathMatchesAny(path, rule.ignoredGlobs));
}

function hasRuleRefresh(
  changes: ChangedPathRecord[],
  localFreshTargets: readonly string[],
  rule: DocumentRefreshRule,
): boolean {
  const changedRefresh = changes.some((record) => {
    if (isRenameOnly(record)) return false;
    return changedPathCandidates(record).some((path) => pathMatchesAny(path, rule.refreshTargets));
  });
  if (changedRefresh) return true;
  return localFreshTargets.some((path) => pathMatchesAny(path, rule.refreshTargets));
}

export function evaluateDocumentRefresh(
  input: DocumentRefreshEvaluationInput,
): DocumentRefreshWarning | null {
  if (hasDocumentRefreshExemption(input.exemptionText)) return null;

  const changes = input.changes.filter((record) => record.path.trim() !== "");
  if (changes.length === 0) return null;

  const rules = input.rules ?? DEFAULT_DOCUMENT_REFRESH_RULES;
  const localFreshTargets = input.scope === "final-handoff"
    ? unique(input.localFreshTargets ?? [])
    : [];
  const warnings: DocumentRefreshRuleWarning[] = [];

  for (const rule of rules) {
    const triggering = changes
      .filter((record) => recordMatchesRuleSource(record, rule))
      .flatMap(changedPathCandidates);
    const changedPaths = unique(triggering.filter((path) => pathMatchesAny(path, rule.sourceGlobs)));
    if (changedPaths.length === 0) continue;
    if (hasRuleRefresh(changes, localFreshTargets, rule)) continue;
    warnings.push({
      ruleId: rule.id,
      description: rule.description,
      changedPaths,
      refreshTargets: [...rule.refreshTargets],
    });
  }

  if (warnings.length === 0) return null;

  const triggeringPaths = unique(warnings.flatMap((warning) => warning.changedPaths));
  const expectedTargets = unique(warnings.flatMap((warning) => warning.refreshTargets));
  return {
    scope: input.scope,
    rules: warnings,
    triggeringPaths,
    expectedTargets,
    message: formatDocumentRefreshWarning({
      scope: input.scope,
      rules: warnings,
      triggeringPaths,
      expectedTargets,
      message: "",
    }),
  };
}


const FINAL_HANDOFF_MARKER_PATTERNS = [
  /\b(?:final handoff|handoff|merge-ready|launch-ready|ready to merge|ready for dev|shippable)\b/iu,
  /\b(?:task|work|implementation|feature|change|verification)\b[\s\S]{0,80}\b(?:complete|completed|done|finished)\b/iu,
  /\b(?:verification|tests?|build|lint)\b[\s\S]{0,120}\b(?:pass|passed|green|success|succeeded)\b/iu,
];

export function isFinalHandoffDocumentRefreshCandidate(text: string | null | undefined): boolean {
  const message = text?.trim() ?? "";
  if (!message) return false;
  if (hasDocumentRefreshExemption(message)) return true;
  return FINAL_HANDOFF_MARKER_PATTERNS.some((pattern) => pattern.test(message));
}

export function buildDocumentRefreshAdvisoryOutput(
  warning: DocumentRefreshWarning,
  hookEventName: DocumentRefreshHookEventName,
): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName,
      additionalContext: warning.message,
    },
    systemMessage: warning.message,
  };
}

export function formatDocumentRefreshWarning(warning: DocumentRefreshWarning): string {
  const seam = warning.scope === "commit"
    ? "Bash git commit uses the staged diff only"
    : "final handoff uses staged + unstaged changes and fresh local .omx planning/spec files";
  const ruleLines = warning.rules.map((rule) => `- ${rule.ruleId}: ${rule.description}`).join("\n");
  const pathLines = warning.triggeringPaths.slice(0, 8).map((path) => `- ${path}`).join("\n");
  const targetLines = warning.expectedTargets.slice(0, 10).map((path) => `- ${path}`).join("\n");
  return [
    "Document-refresh warning: mapped code or test-contract changes may need a planning-spec/product-doc refresh.",
    `Scope: ${seam}. This warning is agent-only and does not add CI/pre-commit hard blocking.`,
    "Triggered rule(s):",
    ruleLines,
    "Changed path(s):",
    pathLines,
    "Expected refresh target(s):",
    targetLines,
    `If no refresh is needed, acknowledge explicitly with: ${DOCUMENT_REFRESH_EXEMPTION_PREFIX} <reason>`,
  ].join("\n");
}

function readGitNameStatus(cwd: string, args: string[]): ChangedPathRecord[] | null {
  try {
    const output = execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseGitNameStatus(output);
  } catch {
    return null;
  }
}

export function readStagedGitChanges(cwd: string): ChangedPathRecord[] | null {
  return readGitNameStatus(cwd, ["diff", "--cached", "--name-status"]);
}

export function readStagedAndUnstagedGitChanges(cwd: string): ChangedPathRecord[] | null {
  const staged = readGitNameStatus(cwd, ["diff", "--cached", "--name-status"]);
  const unstaged = readGitNameStatus(cwd, ["diff", "--name-status"]);
  if (!staged || !unstaged) return null;
  return [...staged, ...unstaged];
}

function collectFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function repoRelative(cwd: string, path: string): string {
  return normalizeRepoPath(relative(cwd, path));
}

function latestExistingMtimeMs(cwd: string, paths: readonly string[]): number {
  let latest = 0;
  for (const path of paths) {
    const fullPath = join(cwd, path);
    try {
      const stat = statSync(fullPath);
      latest = Math.max(latest, stat.mtimeMs);
    } catch {
      // Missing/deleted paths do not contribute freshness evidence.
    }
  }
  return latest;
}

export function findFreshLocalPlanningTargets(
  cwd: string,
  changes: readonly ChangedPathRecord[],
  rules: readonly DocumentRefreshRule[] = DEFAULT_DOCUMENT_REFRESH_RULES,
): string[] {
  const triggeringPathsByRule = new Map<string, string[]>();
  for (const rule of rules) {
    const triggering = changes
      .filter((record) => recordMatchesRuleSource(record, rule))
      .flatMap(changedPathCandidates)
      .filter((path) => pathMatchesAny(path, rule.sourceGlobs));
    if (triggering.length > 0) triggeringPathsByRule.set(rule.id, unique(triggering));
  }
  if (triggeringPathsByRule.size === 0) return [];

  const localPlanningFiles = [
    ...collectFiles(join(cwd, ".omx", "plans")),
    ...collectFiles(join(cwd, ".omx", "specs")),
  ].map((path) => repoRelative(cwd, path));
  if (localPlanningFiles.length === 0) return [];

  const fresh = new Set<string>();
  for (const rule of rules) {
    const triggering = triggeringPathsByRule.get(rule.id);
    if (!triggering) continue;
    const latestTriggerMtime = latestExistingMtimeMs(cwd, triggering);
    if (latestTriggerMtime === 0) continue;
    for (const target of localPlanningFiles) {
      if (!pathMatchesAny(target, rule.refreshTargets)) continue;
      try {
        const targetMtime = statSync(join(cwd, target)).mtimeMs;
        if (targetMtime >= latestTriggerMtime) fresh.add(target);
      } catch {
        // Ignore races with local file cleanup.
      }
    }
  }
  return unique(fresh);
}

export function evaluateStagedDocumentRefresh(
  cwd: string,
  exemptionText?: string | null,
): DocumentRefreshWarning | null {
  const changes = readStagedGitChanges(cwd);
  if (!changes) return null;
  return evaluateDocumentRefresh({
    scope: "commit",
    changes,
    exemptionText,
  });
}

export function evaluateFinalHandoffDocumentRefresh(
  cwd: string,
  exemptionText?: string | null,
): DocumentRefreshWarning | null {
  const changes = readStagedAndUnstagedGitChanges(cwd);
  if (!changes) return null;
  return evaluateDocumentRefresh({
    scope: "final-handoff",
    changes,
    exemptionText,
    localFreshTargets: findFreshLocalPlanningTargets(cwd, changes),
  });
}
