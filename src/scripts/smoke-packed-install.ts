import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  ensureReusableNodeModules,
} from '../utils/repo-deps.js';

export {
  hasUsableNodeModules,
  resolveGitCommonDir,
  resolveReusableNodeModulesSource,
} from '../utils/repo-deps.js';

export const PACKED_INSTALL_SMOKE_CORE_COMMANDS = [
  ['--help'],
  ['version'],
  ['api', '--help'],
  ['sparkshell', '--help'],
] as const;

export const PACKED_INSTALL_NATIVE_HOOK_SMOKE_EVENTS = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'PreCompact',
  'PostCompact',
  'Stop',
] as const;

function usage(): string {
  return [
    'Usage: node scripts/smoke-packed-install.mjs',
    '',
    'Creates an npm tarball, installs it into an isolated prefix, and smoke tests the installed omx CLI.',
    'Release smoke stays intentionally minimal: install + boot + 1-2 core commands only.',
  ].join('\n');
}

interface EnsureRepoDepsOptions {
  gitRunner?: typeof spawnSync;
  install?: (cwd: string) => void;
  log?: (message: string) => void;
}

interface EnsureRepoDepsResult {
  strategy: string;
  nodeModulesPath: string;
  sourceNodeModulesPath?: string;
}

function formatCommandFailure(cmd: string, args: string[], result: { stdout?: string; stderr?: string }): string {
  return [
    `Command failed: ${cmd} ${args.join(' ')}`,
    result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : '',
    result.stderr?.trim() ? `stderr:\n${result.stderr.trim()}` : '',
  ].filter(Boolean).join('\n\n');
}

export function ensureRepoDependencies(repoRoot: string, options: EnsureRepoDepsOptions = {}): EnsureRepoDepsResult {
  const {
    gitRunner = spawnSync,
    install = (cwd: string) => {
      const result = spawnSync('npm', ['ci'], {
        cwd,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      if (result.status !== 0) {
        throw new Error(formatCommandFailure('npm', ['ci'], result));
      }
    },
    log = () => {},
  } = options;

  const reusable = ensureReusableNodeModules(repoRoot, { gitRunner });
  if (reusable.strategy === 'existing') {
    return reusable;
  }
  if (reusable.strategy === 'symlink') {
    log(`[smoke:packed-install] Reusing node_modules from ${reusable.sourceNodeModulesPath}`);
    return reusable;
  }

  log('[smoke:packed-install] Installing repo dependencies with npm ci');
  install(repoRoot);
  return {
    strategy: 'installed',
    nodeModulesPath: join(repoRoot, 'node_modules'),
  };
}

function parseArgs(argv: string[]): void {
  for (const token of argv) {
    if (token === '--help' || token === '-h') {
      console.log(usage());
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${token}\n${usage()}`);
  }
}

function run(cmd: string, args: readonly string[], options: Record<string, unknown> = {}): ReturnType<typeof spawnSync> {
  const result = spawnSync(cmd, [...args], {
    encoding: 'utf-8',
    stdio: 'pipe',
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(cmd, [...args], result));
  }
  return result;
}

function npmBinName(name: string): string {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function resolveGlobalNodeModules(prefixDir: string): string {
  const result = run('npm', ['root', '-g', '--prefix', prefixDir], { cwd: prefixDir });
  const root = String(result.stdout || '').trim();
  if (!root) throw new Error('npm root -g did not return a node_modules directory');
  return root;
}

export function validateHookStdout(eventName: string, stdout: string): void {
  const trimmed = stdout.trim();
  if (!trimmed) return;
  try {
    JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `native hook ${eventName} emitted invalid JSON stdout: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function buildNativeHookSmokePayload(
  eventName: typeof PACKED_INSTALL_NATIVE_HOOK_SMOKE_EVENTS[number],
  smokeCwd: string,
): Record<string, unknown> {
  const base = {
    hook_event_name: eventName,
    session_id: `packed-install-smoke-${eventName}`,
    cwd: smokeCwd,
  };
  switch (eventName) {
    case 'SessionStart':
      return {
        ...base,
        transcript_path: join(smokeCwd, 'nonexistent-transcript.jsonl'),
      };
    case 'PreToolUse':
      return {
        ...base,
        tool_name: 'Bash',
        tool_use_id: 'packed-install-smoke-tool',
        tool_input: { command: 'echo packed install smoke' },
      };
    case 'PostToolUse':
      return {
        ...base,
        tool_name: 'Bash',
        tool_use_id: 'packed-install-smoke-tool',
        tool_input: { command: 'echo packed install smoke' },
        tool_response: {
          exit_code: 0,
          stdout: 'packed install smoke\n',
          stderr: '',
        },
      };
    case 'UserPromptSubmit':
      return {
        ...base,
        transcript_path: join(smokeCwd, 'nonexistent-transcript.jsonl'),
        prompt: 'packed install native hook smoke test',
      };
    case 'PreCompact':
    case 'PostCompact':
    case 'Stop':
      return base;
  }
}

function parseNativeHookSmokeOutput(probe: string, stdout: string): Record<string, unknown> {
  validateHookStdout(probe, stdout);
  if (!stdout.trim()) throw new Error(`native hook ${probe} emitted no JSON stdout`);
  const parsed = JSON.parse(stdout) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`native hook ${probe} emitted a non-object JSON result`);
  }
  return parsed as Record<string, unknown>;
}

function requireNativeHookPermissionDeny(probe: string, output: Record<string, unknown>, reason: RegExp): void {
  const hookSpecificOutput = output.hookSpecificOutput;
  if (!hookSpecificOutput || typeof hookSpecificOutput !== 'object' || Array.isArray(hookSpecificOutput)) {
    throw new Error(`native hook ${probe} did not emit hookSpecificOutput`);
  }
  const hookOutput = hookSpecificOutput as Record<string, unknown>;
  if (hookOutput.permissionDecision !== 'deny') {
    throw new Error(`native hook ${probe} did not deny permission`);
  }
  if (!reason.test(String(hookOutput.permissionDecisionReason ?? ''))) {
    throw new Error(`native hook ${probe} denial did not match ${reason.source}`);
  }
}

function smokeInstalledNativeHookDist(prefixDir: string): void {
  const globalNodeModules = resolveGlobalNodeModules(prefixDir);
  const packageRoot = join(globalNodeModules, 'oh-my-codex');
  const hookScript = join(packageRoot, 'dist', 'scripts', 'codex-native-hook.js');
  const smokeCwd = mkdtempSync(join(tmpdir(), 'omx-packed-hook-smoke-'));
  try {
    for (const eventName of PACKED_INSTALL_NATIVE_HOOK_SMOKE_EVENTS) {
      const payload = buildNativeHookSmokePayload(eventName, smokeCwd);
      const result = run(process.execPath, [realpathSync(hookScript)], {
        cwd: smokeCwd,
        env: {
          ...process.env,
          OMX_NATIVE_HOOK_DOCTOR_SMOKE: '1',
          OMX_ROOT: join(smokeCwd, '.omx-packed-hook-root'),
          OMX_SESSION_ID: `packed-install-smoke-${eventName}`,
          OMX_SOURCE_CWD: smokeCwd,
          OMX_STARTUP_CWD: smokeCwd,
        },
        input: JSON.stringify(payload),
      });
      validateHookStdout(eventName, result.stdout as string);
    }

    const hookRoot = join(smokeCwd, '.omx-packed-hook-root');
    const stateDir = join(hookRoot, '.omx', 'state');
    const sessionId = 'packed-install-option-c';
    const leaderAgentId = 'agent-packed-install-leader';
    const teamName = 'packed-option-c';
    mkdirSync(join(stateDir, 'sessions', sessionId), { recursive: true });
    mkdirSync(join(stateDir, 'team', teamName, 'workers', 'worker-1'), { recursive: true });
    writeFileSync(
      join(stateDir, 'session.json'),
      JSON.stringify({ session_id: sessionId, native_session_id: leaderAgentId }),
    );
    writeFileSync(
      join(stateDir, 'sessions', sessionId, 'skill-active-state.json'),
      JSON.stringify({
        active: true,
        skill: 'ultragoal',
        phase: 'executing',
        session_id: sessionId,
        active_skills: [{ skill: 'ultragoal', phase: 'executing', active: true, session_id: sessionId }],
      }),
    );
    writeFileSync(
      join(stateDir, 'sessions', sessionId, 'ultragoal-state.json'),
      JSON.stringify({ active: true, mode: 'ultragoal', current_phase: 'executing', session_id: sessionId }),
    );
    writeFileSync(
      join(stateDir, 'team', teamName, 'config.json'),
      JSON.stringify({
        name: teamName,
        leader_pane_id: '%packed-leader',
        workers: [{ name: 'worker-1', pane_id: '%packed-worker' }],
      }),
    );
    writeFileSync(
      join(stateDir, 'team', teamName, 'workers', 'worker-1', 'identity.json'),
      JSON.stringify({ name: 'worker-1', pane_id: '%packed-worker' }),
    );

    const invokeAuthorizationProbe = (payload: Record<string, unknown>, env: NodeJS.ProcessEnv) => run(
      process.execPath,
      [realpathSync(hookScript)],
      { cwd: smokeCwd, env, input: JSON.stringify(payload) },
    );
    const hookEnv = {
      ...process.env,
      OMX_NATIVE_HOOK_DOCTOR_SMOKE: '1',
      OMX_ROOT: hookRoot,
      OMX_SOURCE_CWD: smokeCwd,
      OMX_STARTUP_CWD: smokeCwd,
    };
    const officialTeamRootPayload = {
      hook_event_name: 'PreToolUse',
      cwd: smokeCwd,
      session_id: sessionId,
      tool_name: 'Edit',
      tool_use_id: 'packed-install-team-root',
      tool_input: { file_path: 'src/packed-team-worker.ts', old_string: 'a', new_string: 'b' },
    };
    const teamEnv: NodeJS.ProcessEnv = {
      ...hookEnv,
      OMX_TEAM_WORKER: `${teamName}/worker-1`,
      OMX_TEAM_STATE_ROOT: stateDir,
      TMUX_PANE: '%packed-worker',
    };
    delete teamEnv.OMX_TEAM_INTERNAL_WORKER;
    const teamOutput = parseNativeHookSmokeOutput(
      'PreToolUse official Team root',
      String(invokeAuthorizationProbe(officialTeamRootPayload, teamEnv).stdout),
    );
    if (Object.keys(teamOutput).length !== 0) {
      throw new Error('native hook official Team root did not preserve the validated Team-worker exemption');
    }

    const leaderOutput = parseNativeHookSmokeOutput(
      'PreToolUse leader with Team environment',
      String(invokeAuthorizationProbe({
        ...officialTeamRootPayload,
        session_id: leaderAgentId,
        tool_use_id: 'packed-install-team-leader',
      }, teamEnv).stdout),
    );
    requireNativeHookPermissionDeny('PreToolUse leader with Team environment', leaderOutput, /Main-root Conductor mode is active/);

    const childEnv = {
      ...hookEnv,
      OMX_TEAM_WORKER: '',
      OMX_TEAM_INTERNAL_WORKER: '',
      OMX_TEAM_STATE_ROOT: '',
    };
    for (const [probe, toolName, toolInput] of [
      [
        'filesystem write',
        'mcp__filesystem__write_file',
        { path: 'src/packed-mcp-write.ts', content: 'export const escaped = true;\n' },
      ],
      [
        'state write',
        'mcp__omx_state__state_write',
        { mode: 'ultragoal', active: true, current_phase: 'executing' },
      ],
    ] as const) {
      const output = parseNativeHookSmokeOutput(
        `PreToolUse native child ${probe}`,
        String(invokeAuthorizationProbe({
          hook_event_name: 'PreToolUse',
          cwd: smokeCwd,
          session_id: sessionId,
          agent_id: 'agent-packed-install-child',
          tool_name: toolName,
          tool_use_id: `packed-install-child-${probe.replace(/\s+/g, '-')}`,
          tool_input: toolInput,
        }, childEnv).stdout),
      );
      requireNativeHookPermissionDeny(`PreToolUse native child ${probe}`, output, /OWNER_CONFIRMATION_REQUIRED/);
    }

    const childReadOutput = parseNativeHookSmokeOutput(
      'PreToolUse native child read-only',
      String(invokeAuthorizationProbe({
        hook_event_name: 'PreToolUse',
        cwd: smokeCwd,
        session_id: sessionId,
        agent_id: 'agent-packed-install-child',
        tool_name: 'Read',
        tool_use_id: 'packed-install-child-read-only',
        tool_input: { file_path: 'src/packed-read-only.ts' },
      }, childEnv).stdout),
    );
    if (Object.keys(childReadOutput).length !== 0) {
      throw new Error('native hook blocked a positively classified native-child read-only operation');
    }

    const unknownChildOutput = parseNativeHookSmokeOutput(
      'PreToolUse native child unknown transport',
      String(invokeAuthorizationProbe({
        hook_event_name: 'PreToolUse',
        cwd: smokeCwd,
        session_id: sessionId,
        agent_id: 'agent-packed-install-child',
        tool_name: 'mcp__example__future_mutation',
        tool_use_id: 'packed-install-child-unknown',
        tool_input: { target: 'src/packed-unknown.ts' },
      }, childEnv).stdout),
    );
    requireNativeHookPermissionDeny(
      'PreToolUse native child unknown transport',
      unknownChildOutput,
      /OWNER_CONFIRMATION_REQUIRED/,
    );
  } finally {
    rmSync(smokeCwd, { recursive: true, force: true });
  }
}

export function parseNpmPackJsonOutput(stdout: string): Array<{ filename: string }> {
  const start = stdout.lastIndexOf('\n[');
  const jsonText = (start >= 0 ? stdout.slice(start + 1) : stdout).trim();
  if (!jsonText.startsWith('[')) {
    throw new Error(`npm pack did not return JSON output: ${stdout.trim()}`);
  }
  return JSON.parse(jsonText) as Array<{ filename: string }>;
}

async function main(): Promise<void> {
  parseArgs(process.argv.slice(2));

  const repoRoot = process.cwd();
  const tempRoot = mkdtempSync(join(tmpdir(), 'omx-packed-install-'));
  const prefixDir = join(tempRoot, 'prefix');
  mkdirSync(prefixDir, { recursive: true });

  let tarballPath: string | undefined;
  try {
    ensureRepoDependencies(repoRoot, {
      log: (message: string) => console.log(message),
    });

    const pack = run('npm', ['pack', '--json'], { cwd: repoRoot });
    const packOutput = parseNpmPackJsonOutput(pack.stdout as string);
    const tarballName = packOutput[0]?.filename;
    if (!tarballName) throw new Error('npm pack did not return a tarball filename');
    tarballPath = join(repoRoot, tarballName);

    run('npm', ['install', '-g', tarballPath, '--prefix', prefixDir], { cwd: repoRoot });

    const omxPath = join(prefixDir, process.platform === 'win32' ? '' : 'bin', npmBinName('omx'));
    for (const argv of PACKED_INSTALL_SMOKE_CORE_COMMANDS) {
      run(omxPath, argv, { cwd: repoRoot });
    }
    smokeInstalledNativeHookDist(prefixDir);

    console.log('packed install smoke: PASS');
  } finally {
    if (tarballPath) rmSync(tarballPath, { force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`packed install smoke: FAIL\n${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
