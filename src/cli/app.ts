import { spawnSync } from "child_process";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { homedir } from "os";
import { readIdentityStatus } from "../auth/identity.js";
import { resolveDefaultCodexHome } from "../auth/paths.js";
import { refreshUnifiedLedger } from "../session-ledger/index.js";
import { escapeTomlString } from "../utils/toml.js";

const HELP = `omx app - Codex App local-experience helpers

Usage:
  omx app doctor [--json]
  omx app setup-actions [--dry-run]
  omx app sidebar doctor [--project <name-or-path>] [--json]
  omx app sidebar repair [--project <name-or-path>] [--dry-run] [--limit <n>] [--force]
  omx app sidebar rollback <backup-dir>
  omx app --help

These helpers optimize the Codex App project experience without writing to the
Codex App private task cache. Project actions are written to .codex/environments/environment.toml.
Sidebar repair only writes backed-up UI metadata in CODEX_HOME/.codex-global-state.json.
`;

const OMX_ACTIONS_START = "# OMX:APP-ACTIONS:START";
const OMX_ACTIONS_END = "# OMX:APP-ACTIONS:END";
const SIDEBAR_PROJECT_THREAD_ORDERS = "sidebar-project-thread-orders";
const THREAD_WORKSPACE_ROOT_HINTS = "thread-workspace-root-hints";
const THREAD_PROJECT_ASSIGNMENTS = "thread-project-assignments";
const WORKSPACE_ROOT_OPTIONS = "electron-saved-workspace-roots";
const PROJECT_ORDER = "project-order";
const WORKSPACE_ROOT_LABELS = "electron-workspace-root-labels";

interface CodexThreadRow {
  id: string;
  title: string;
  cwd: string;
  source: string;
  threadSource: string;
  updatedAtMs: number;
  updatedAt: string;
}

interface SidebarProjectReport {
  projectRoot: string;
  displayName: string;
  matchedThreads: CodexThreadRow[];
  existingOrderedThreadIds: string[];
  missingOrderThreadIds: string[];
  missingHintThreadIds: string[];
  missingAssignmentThreadIds: string[];
}

interface SidebarDoctorReport {
  codexHome: string;
  globalStatePath: string;
  sqlitePath: string;
  projects: SidebarProjectReport[];
  warnings: string[];
}

function wantsJson(args: string[]): boolean {
  return args.includes("--json");
}

function wantsDryRun(args: string[]): boolean {
  return args.includes("--dry-run");
}

function wantsForce(args: string[]): boolean {
  return args.includes("--force");
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function parseLimit(args: string[], fallback = 25): number {
  const raw = optionValue(args, "--limit");
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 1000) : fallback;
}

function runtimeHome(): string {
  return process.env.HOME?.trim() || homedir();
}

function resolveCodexHome(home = runtimeHome()): string {
  const envCodexHome = process.env.CODEX_HOME?.trim();
  return envCodexHome || resolveDefaultCodexHome(home);
}

function resolveGlobalStatePath(codexHome = resolveCodexHome()): string {
  return join(codexHome, ".codex-global-state.json");
}

function resolveSqlitePath(codexHome = resolveCodexHome()): string {
  return join(codexHome, "sqlite", "state_5.sqlite");
}

function accountHome(): string {
  const result = spawnSync("sh", ["-lc", "eval printf %s ~$(id -un)"], { encoding: "utf-8" });
  const resolved = result.status === 0 ? result.stdout.trim() : "";
  return resolved || homedir();
}

function isLiveCodexAppHome(codexHome: string): boolean {
  return normalizePath(resolve(codexHome)) === normalizePath(resolve(resolveDefaultCodexHome(accountHome())));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+$/, "") || value;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function readGlobalState(globalStatePath = resolveGlobalStatePath()): Promise<Record<string, unknown>> {
  if (!existsSync(globalStatePath)) return {};
  return asRecord(JSON.parse(await readFile(globalStatePath, "utf-8")) as unknown);
}

function projectDisplayName(projectRoot: string, labels: Record<string, unknown>): string {
  const label = labels[projectRoot];
  return typeof label === "string" && label.trim() ? label.trim() : basename(projectRoot) || projectRoot;
}

function discoverSidebarProjectRoots(state: Record<string, unknown>, selector?: string): string[] {
  const saved = asStringArray(state[WORKSPACE_ROOT_OPTIONS]);
  const ordered = asStringArray(state[PROJECT_ORDER]).filter((entry) => isAbsolute(entry));
  const roots = [...new Set([...ordered, ...saved])].map(normalizePath);
  if (!selector) return roots;
  const selected = normalizePath(isAbsolute(selector) ? resolve(selector) : selector);
  return roots.filter((root) => root === selected || basename(root) === selector || root.includes(selector));
}

function parseSqliteRows(stdout: string): CodexThreadRow[] {
  return stdout.split("\n").filter(Boolean).map((line) => {
    const [id = "", title = "", cwd = "", source = "", threadSource = "", updatedAtMs = "0", updatedAt = ""] = line.split("\t");
    return {
      id,
      title,
      cwd,
      source,
      threadSource,
      updatedAtMs: Number(updatedAtMs) || 0,
      updatedAt,
    };
  }).filter((row) => row.id.length > 0);
}

function queryProjectThreads(sqlitePath: string, projectRoot: string, limit: number): CodexThreadRow[] {
  if (!existsSync(sqlitePath)) return [];
  const root = normalizePath(projectRoot);
  const prefix = `${root}/%`;
  const sql = [
    `select id,title,cwd,source,coalesce(thread_source,''),coalesce(updated_at_ms, updated_at * 1000),datetime(coalesce(updated_at_ms, updated_at * 1000)/1000,'unixepoch')`,
    "from threads",
    "where archived=0",
    "and coalesce(thread_source,'user')='user'",
    "and source in ('cli','vscode','appServer')",
    `and (replace(cwd,'\\\\','/')=${sqlString(root)} or replace(cwd,'\\\\','/') like ${sqlString(prefix)})`,
    "order by coalesce(updated_at_ms, updated_at * 1000) desc, id desc",
    `limit ${limit};`,
  ].join("\n");
  const result = spawnSync("sqlite3", ["-separator", "\t", sqlitePath, sql], { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`sqlite3 failed: ${result.stderr || result.stdout || "unknown error"}`);
  }
  return parseSqliteRows(result.stdout);
}

function findRunningCodexAppProcesses(): string[] {
  const result = spawnSync("ps", ["-axo", "pid,args"], { encoding: "utf-8" });
  if (result.status !== 0) return [];
  return result.stdout.split("\n").filter((line) => {
    const text = line.trim();
    if (!text) return false;
    if (text.includes("/Applications/Codex.app/Contents/MacOS/Codex")) return true;
    return text.includes("/Applications/Codex.app/Contents/Resources/codex app-server");
  });
}

async function buildSidebarDoctorReport(args: string[] = []): Promise<SidebarDoctorReport> {
  const codexHome = resolveCodexHome();
  const globalStatePath = resolveGlobalStatePath(codexHome);
  const sqlitePath = resolveSqlitePath(codexHome);
  const state = await readGlobalState(globalStatePath);
  const selector = optionValue(args, "--project");
  const limit = parseLimit(args);
  const roots = discoverSidebarProjectRoots(state, selector);
  const labels = asRecord(state[WORKSPACE_ROOT_LABELS]);
  const orders = asRecord(state[SIDEBAR_PROJECT_THREAD_ORDERS]);
  const hints = asRecord(state[THREAD_WORKSPACE_ROOT_HINTS]);
  const assignments = asRecord(state[THREAD_PROJECT_ASSIGNMENTS]);
  const warnings: string[] = [];

  if (!existsSync(globalStatePath)) warnings.push(`missing global state: ${globalStatePath}`);
  if (!existsSync(sqlitePath)) warnings.push(`missing sqlite state: ${sqlitePath}`);
  if (selector && roots.length === 0) warnings.push(`no saved Codex App project matched: ${selector}`);

  const projects = roots.map((projectRoot) => {
    const matchedThreads = queryProjectThreads(sqlitePath, projectRoot, limit);
    const existingOrderedThreadIds = asStringArray(orders[projectRoot]);
    const existingOrderSet = new Set(existingOrderedThreadIds);
    const missingOrderThreadIds = matchedThreads.map((thread) => thread.id).filter((id) => !existingOrderSet.has(id));
    const missingHintThreadIds = matchedThreads.map((thread) => thread.id).filter((id) => hints[id] !== projectRoot);
    const missingAssignmentThreadIds = matchedThreads.map((thread) => thread.id).filter((id) => assignments[id] !== projectRoot);
    return {
      projectRoot,
      displayName: projectDisplayName(projectRoot, labels),
      matchedThreads,
      existingOrderedThreadIds,
      missingOrderThreadIds,
      missingHintThreadIds,
      missingAssignmentThreadIds,
    };
  });

  return { codexHome, globalStatePath, sqlitePath, projects, warnings };
}

function printSidebarDoctor(report: SidebarDoctorReport): void {
  console.log("Codex App sidebar session status");
  console.log(`codexHome: ${report.codexHome}`);
  console.log(`globalState: ${report.globalStatePath}`);
  console.log(`sqlite: ${report.sqlitePath}`);
  for (const warning of report.warnings) console.log(`warning: ${warning}`);
  if (report.warnings.length === 0) console.log("warning: none");
  for (const project of report.projects) {
    console.log("");
    console.log(`${project.displayName}`);
    console.log(`projectRoot: ${project.projectRoot}`);
    console.log(`matched main sessions: ${project.matchedThreads.length}`);
    console.log(`missing sidebar order: ${project.missingOrderThreadIds.length}`);
    console.log(`missing workspace hint: ${project.missingHintThreadIds.length}`);
    console.log(`missing project assignment: ${project.missingAssignmentThreadIds.length}`);
    for (const thread of project.matchedThreads.slice(0, 8)) {
      const marker = project.missingOrderThreadIds.includes(thread.id) || project.missingHintThreadIds.includes(thread.id) ? "needs-link" : "linked";
      console.log(`- ${thread.id} [${marker}] ${thread.updatedAt} ${thread.title}`);
    }
  }
}

function mergeUnique(first: string[], second: string[]): string[] {
  return [...new Set([...first, ...second])];
}

function shouldPreferProjectRoot(candidate: string, current: string | undefined): boolean {
  if (!current) return true;
  return normalizePath(candidate).length > normalizePath(current).length;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`);
  await writeFile(tmp, `${JSON.stringify(value)}\n`, "utf-8");
  await rename(tmp, path);
}

function timestampForPath(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

async function backupGlobalState(globalStatePath: string, backupRoot = join(runtimeHome(), ".omx", "backups", "codex-app-sidebar")): Promise<string> {
  const dir = join(backupRoot, timestampForPath());
  await mkdir(dir, { recursive: true });
  if (existsSync(globalStatePath)) await copyFile(globalStatePath, join(dir, basename(globalStatePath)));
  if (existsSync(`${globalStatePath}.bak`)) await copyFile(`${globalStatePath}.bak`, join(dir, `${basename(globalStatePath)}.bak`));
  await writeFile(join(dir, "manifest.json"), `${JSON.stringify({
    createdAt: new Date().toISOString(),
    source: globalStatePath,
    rollbackCommand: `omx app sidebar rollback ${dir}`,
  }, null, 2)}\n`);
  return dir;
}

async function repairSidebar(args: string[]): Promise<void> {
  const dryRun = wantsDryRun(args);
  const force = wantsForce(args);
  const report = await buildSidebarDoctorReport(args);
  const state = await readGlobalState(report.globalStatePath);
  const orders = asRecord(state[SIDEBAR_PROJECT_THREAD_ORDERS]);
  const hints = asRecord(state[THREAD_WORKSPACE_ROOT_HINTS]);
  const assignments = asRecord(state[THREAD_PROJECT_ASSIGNMENTS]);
  const preferredRootByThread = new Map<string, string>();
  let changedOrders = 0;
  let changedHints = 0;
  let changedAssignments = 0;

  for (const project of report.projects) {
    if (project.matchedThreads.length === 0) continue;
    const matchedThreadIds = project.matchedThreads.map((thread) => thread.id);
    for (const id of matchedThreadIds) {
      const current = preferredRootByThread.get(id);
      if (shouldPreferProjectRoot(project.projectRoot, current)) {
        preferredRootByThread.set(id, project.projectRoot);
      }
    }
    const previousOrder = asStringArray(orders[project.projectRoot]);
    const nextOrder = mergeUnique(matchedThreadIds, previousOrder);
    if (nextOrder.join("\0") !== previousOrder.join("\0")) {
      orders[project.projectRoot] = nextOrder;
      changedOrders += nextOrder.length - previousOrder.length;
    }
  }

  for (const [id, projectRoot] of preferredRootByThread.entries()) {
    if (hints[id] !== projectRoot) {
      hints[id] = projectRoot;
      changedHints += 1;
    }
    if (assignments[id] !== projectRoot) {
      assignments[id] = projectRoot;
      changedAssignments += 1;
    }
  }

  const payload = {
    dryRun,
    globalStatePath: report.globalStatePath,
    sqlitePath: report.sqlitePath,
    changedOrders,
    changedHints,
    changedAssignments,
    projects: report.projects.map((project) => ({
      projectRoot: project.projectRoot,
      displayName: project.displayName,
      matchedThreads: project.matchedThreads.length,
      missingOrderThreadIds: project.missingOrderThreadIds,
      missingHintThreadIds: project.missingHintThreadIds,
      missingAssignmentThreadIds: project.missingAssignmentThreadIds,
    })),
  };

  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const runningProcesses = isLiveCodexAppHome(report.codexHome) ? findRunningCodexAppProcesses() : [];
  if (!force && runningProcesses.length > 0) {
    throw new Error([
      "Codex App appears to be running, so offline sidebar metadata repair is blocked by default.",
      "The running app keeps global state in memory and can overwrite direct file edits.",
      "Quit Codex App fully, then rerun this command. Use --dry-run to preview or --force only if you intentionally accept a hot-write risk.",
      `Detected process: ${runningProcesses[0]}`,
    ].join("\n"));
  }

  const backupDir = await backupGlobalState(report.globalStatePath);
  state[SIDEBAR_PROJECT_THREAD_ORDERS] = orders;
  state[THREAD_WORKSPACE_ROOT_HINTS] = hints;
  state[THREAD_PROJECT_ASSIGNMENTS] = assignments;
  await writeJsonAtomic(report.globalStatePath, state);
  await writeJsonAtomic(`${report.globalStatePath}.bak`, state);

  console.log(`Repaired Codex App sidebar UI metadata: orders=${changedOrders} hints=${changedHints} assignments=${changedAssignments}`);
  console.log(`Original session sqlite was not modified: ${report.sqlitePath}`);
  console.log(`Backup: ${backupDir}`);
  console.log(`Rollback: omx app sidebar rollback ${backupDir}`);
  console.log("Restart Codex App after offline repair so the sidebar reloads the updated project-thread metadata.");
}

async function rollbackSidebar(args: string[]): Promise<void> {
  const backupDir = args.find((arg) => !arg.startsWith("--"));
  if (!backupDir) throw new Error("Usage: omx app sidebar rollback <backup-dir>");
  const codexHome = resolveCodexHome();
  const globalStatePath = resolveGlobalStatePath(codexHome);
  const backupState = join(backupDir, basename(globalStatePath));
  const backupBak = join(backupDir, `${basename(globalStatePath)}.bak`);
  if (!existsSync(backupState)) throw new Error(`Backup state not found: ${backupState}`);
  await copyFile(backupState, globalStatePath);
  if (existsSync(backupBak)) await copyFile(backupBak, `${globalStatePath}.bak`);
  console.log(`Restored Codex App sidebar UI metadata from ${backupDir}`);
}

function environmentTomlPath(cwd = process.cwd()): string {
  return join(cwd, ".codex", "environments", "environment.toml");
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function actionBlock(projectName: string): string {
  const projectQuery = shellSingleQuote(projectName);
  const actions = [
    {
      name: "OMX Identity",
      icon: "run",
      command: "omx app doctor",
    },
    {
      name: "OMX Sessions",
      icon: "run",
      command: "omx session list --unified",
    },
    {
      name: "OMX Project History",
      icon: "run",
      command: `omx session search ${projectQuery} --unified || omx session list --unified`,
    },
  ];

  return [
    OMX_ACTIONS_START,
    "# Generated by `omx app setup-actions`. Safe to remove and regenerate.",
    ...actions.flatMap((action) => [
      "",
      "[[actions]]",
      `name = "${escapeTomlString(action.name)}"`,
      `icon = "${escapeTomlString(action.icon)}"`,
      `command = "${escapeTomlString(action.command)}"`,
    ]),
    OMX_ACTIONS_END,
    "",
  ].join("\n");
}

function stripExistingOmxActionBlock(content: string): string {
  const start = content.indexOf(OMX_ACTIONS_START);
  const end = content.indexOf(OMX_ACTIONS_END);
  if (start < 0 || end < start) return content.trimEnd();
  return `${content.slice(0, start)}${content.slice(end + OMX_ACTIONS_END.length)}`.trimEnd();
}

function defaultEnvironmentToml(projectName: string): string {
  return [
    "# THIS IS AUTOGENERATED BY OMX. App settings may edit this file.",
    "version = 1",
    `name = "${escapeTomlString(projectName)}"`,
    "",
    "[setup]",
    'script = ""',
    "",
  ].join("\n");
}

export async function buildCodexAppEnvironmentToml(cwd = process.cwd()): Promise<string> {
  const projectName = basename(cwd) || "project";
  const target = environmentTomlPath(cwd);
  const existing = existsSync(target)
    ? await readFile(target, "utf-8")
    : defaultEnvironmentToml(projectName);
  return `${stripExistingOmxActionBlock(existing)}\n\n${actionBlock(projectName)}`;
}

async function setupActions(args: string[]): Promise<void> {
  const cwd = process.cwd();
  const target = environmentTomlPath(cwd);
  const content = await buildCodexAppEnvironmentToml(cwd);
  if (wantsDryRun(args)) {
    console.log(content.trimEnd());
    return;
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
  console.log(`Wrote Codex App actions to ${target}`);
  console.log("Open this project in Codex App and use the top-bar OMX actions.");
}

async function doctor(args: string[]): Promise<void> {
  const cwd = process.cwd();
  const identity = await readIdentityStatus(cwd);
  const entries = await refreshUnifiedLedger();
  const appEntries = entries.filter((entry) => entry.source === "app");
  const localEntries = entries.filter((entry) => entry.source === "cli" || entry.source === "api" || entry.source === "omx");
  const target = environmentTomlPath(cwd);
  const payload = {
    cwd,
    codexAppActionsFile: target,
    codexAppActionsConfigured: existsSync(target),
    identity: {
      kind: identity.kind,
      authMode: identity.authMode,
      codexHome: identity.codexHome,
      currentSlot: identity.currentSlot,
      matchedSlot: identity.matchedSlot,
      slotCount: identity.slots.length,
      warnings: identity.warnings,
    },
    unifiedSessions: {
      total: entries.length,
      app: appEntries.length,
      local: localEntries.length,
      latest: entries.slice(0, 5).map((entry) => ({
        sessionId: entry.sessionId,
        source: entry.source,
        title: entry.title,
        cwd: entry.cwd,
        updatedAt: entry.updatedAt,
      })),
    },
  };
  if (wantsJson(args)) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log("Codex App experience status");
  console.log(`cwd: ${payload.cwd}`);
  console.log(`actions: ${payload.codexAppActionsConfigured ? "configured" : "missing"} (${target})`);
  console.log(`identity: ${identity.kind}${identity.authMode ? ` (${identity.authMode})` : ""}`);
  console.log(`codexHome: ${identity.codexHome}`);
  console.log(`slot: ${identity.matchedSlot ?? identity.currentSlot ?? "none"}`);
  for (const warning of identity.warnings) console.log(`warning: ${warning}`);
  if (identity.warnings.length === 0) console.log("warning: none");
  console.log(`sessions: total=${entries.length} app=${appEntries.length} local=${localEntries.length}`);
  for (const entry of entries.slice(0, 5)) {
    console.log(`- ${entry.sessionId} [${entry.source}] ${entry.title ?? ""}`.trim());
  }
  if (!payload.codexAppActionsConfigured) {
    console.log("next: run `omx app setup-actions` to add top-bar Codex App actions for this project.");
  }
}

async function sidebarCommand(args: string[]): Promise<void> {
  const command = args[0];
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log([
      "omx app sidebar - Codex App sidebar session repair",
      "",
      "Usage:",
      "  omx app sidebar doctor [--project <name-or-path>] [--json]",
      "  omx app sidebar repair [--project <name-or-path>] [--dry-run] [--limit <n>] [--force]",
      "  omx app sidebar rollback <backup-dir>",
      "",
      "This reads CODEX_HOME/sqlite/state_5.sqlite and only writes backed-up UI metadata",
      "in CODEX_HOME/.codex-global-state.json. It does not modify original session data.",
      "Non-dry-run repair is blocked while the real Codex App is running unless --force is used.",
    ].join("\n"));
    return;
  }
  if (command === "doctor") {
    const report = await buildSidebarDoctorReport(args.slice(1));
    if (wantsJson(args)) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    printSidebarDoctor(report);
    return;
  }
  if (command === "repair") {
    await repairSidebar(args.slice(1));
    return;
  }
  if (command === "rollback") {
    await rollbackSidebar(args.slice(1));
    return;
  }
  throw new Error(`Unknown app sidebar command: ${command}`);
}

export async function appCommand(args: string[]): Promise<void> {
  const command = args[0];
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(HELP.trim());
    return;
  }
  if (command === "doctor") {
    await doctor(args.slice(1));
    return;
  }
  if (command === "setup-actions") {
    await setupActions(args.slice(1));
    return;
  }
  if (command === "sidebar") {
    await sidebarCommand(args.slice(1));
    return;
  }
  throw new Error(`Unknown app command: ${command}\n${HELP.trim()}`);
}
