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
    const runActorProbe = (
      actor: 'main-root' | 'native-child',
      probe: string,
      toolName: string,
      toolInput: Record<string, unknown>,
    ): Record<string, unknown> => parseNativeHookSmokeOutput(
      `PreToolUse ${actor} ${probe}`,
      String(invokeAuthorizationProbe({
        hook_event_name: 'PreToolUse',
        cwd: smokeCwd,
        session_id: actor === 'main-root' ? leaderAgentId : sessionId,
        ...(actor === 'native-child' ? { agent_id: 'agent-packed-install-child' } : {}),
        tool_name: toolName,
        tool_use_id: `packed-install-${actor}-${probe.replace(/\W+/g, '-')}`,
        tool_input: toolInput,
      }, childEnv).stdout),
    );
    const requireActorDeny = (
      actor: 'main-root' | 'native-child',
      probe: string,
      output: Record<string, unknown>,
    ): void => requireNativeHookPermissionDeny(
      `PreToolUse ${actor} ${probe}`,
      output,
      actor === 'native-child' ? /OWNER_CONFIRMATION_REQUIRED/ : /Main-root Conductor mode is active/,
    );

    for (const [probe, toolName, toolInput] of [
      ['filesystem write', 'mcp__filesystem__write_file', { path: 'src/packed-mcp-write.ts', content: 'escaped' }],
      ['state write', 'mcp__omx_state__state_write', { mode: 'ultragoal', active: true }],
    ] as const) {
      requireActorDeny('native-child', probe, runActorProbe('native-child', probe, toolName, toolInput));
    }

    for (const [probe, command] of [
      ['node fs.rmSync', `node -e "require('fs').rmSync('src/victim.ts')"`],
      ['node fs.renameSync', `node -e "require('fs').renameSync('src/a.ts','src/b.ts')"`],
      ['node template interpolation', "node -e '" + '`${require("fs").rmSync("src/template.ts")}`' + "'"],
      ['node computed mutation', `node -e "const fs=require('fs');const op='rmSync';fs[op]('src/computed.ts')"`],
      ['node ESM rename', `node --input-type=module -e "import fs from 'node:fs';fs.renameSync('src/esm-a.ts','src/esm-b.ts')"`],
      ['nodejs fs.rmSync', `nodejs -e "require('fs').rmSync('src/nodejs.ts')"`],
      ['node.exe fs.rmSync', `node.exe -e "require('fs').rmSync('src/node-exe.ts')"`],
      ['node getBuiltinModule', `node -e "process.getBuiltinModule('fs').rmSync('src/builtin.ts')"`],
      ['node optional mutation', `node -e "const fs=require('fs');fs?.rmSync('src/optional.ts')"`],
      ['node aliased fs object', `node -e "const fs=require('fs');const alias=fs;alias.rmSync('src/alias.ts')"`],
      ['node dynamic eval source', `PAYLOAD="require('fs').rmSync('src/env.ts')"; node -e "$PAYLOAD"`],
      ['node concatenated eval source', `A="require('fs')."; B="rmSync('src/concat.ts')"; node -e "$A$B"`],
      ['node backtick eval source', `node -e "\`cat payload.js\`"`],
      ['node command-substitution eval source', `node -e "$(cat payload.js)"`],
      ['node combined print eval', `node -pe "require('fs').rmSync('src/combined.ts')"`],
      ['node aliased require', `node -e "const req=require;const fs=req('fs');fs.rmSync('src/aliased-require.ts')"`],
      ['node object-escaped fs', `node -e "const h={fs:require('fs')};h.fs.rmSync('src/object-escape.ts')"`],
      ['node computed require alias', `node -e "const req=module['require'];const fs=req('fs');fs.rmSync('src/computed-require.ts')"`],
      ['node computed builtin loader', `node -e "const fs=process['getBuiltinModule']('fs');fs.rmSync('src/computed-builtin.ts')"`],
      ['node postfix division mutation', `node -e "let x=1;x++ / require('fs').rmSync('src/postfix-division.ts') / 1"`],
      ['node string division mutation', `node -e "'value' / require('fs').rmSync('src/string-division.ts') / 1"`],
      ['node unicode-escaped loader', `node -e 'requ\\u0069re("fs").rmSync("src/unicode-escape.ts")'`],
      ['node parenthesized eval', `node -e "(eval)('require(\\"fs\\").rmSync(\\"src/eval-bypass.ts\\")')"`],
      ['node concatenated computed loader', `node -e "const fs=module['requ'+'ire']('fs');fs.rmSync('src/computed-loader.ts')"`],
      ['node attached short eval', `node -e"require('fs').rmSync('src/attached-eval.ts')"`],
      ['node xargs wrapper mutation', `printf x | xargs node -e "require('fs').rmSync('src/xargs-bypass.ts')"`],
      ['node child-process mutation', `node -e "require('child_process').execFileSync('rm',['-f','src/child-process-bypass.ts'])"`],
    ] as const) {
      for (const actor of ['main-root', 'native-child'] as const) {
        requireActorDeny(actor, probe, runActorProbe(actor, probe, 'Bash', { command }));
      }
    }

    for (const [probe, command] of [
      ['node fs readFileSync', `node -e "require('fs').readFileSync('src/victim.ts','utf8')"`],
      ['node write mutation text', `node -e 'console.log("require(\\"fs\\").writeFileSync(\\"src/victim.ts\\", \\"x\\")")'`],
      ['node ESM fs readFileSync', `node --input-type=module -e "import fs from 'node:fs';fs.readFileSync('src/victim.ts','utf8')"`],
      ['node fs openSync read-only', `node -e "require('fs').openSync('src/victim.ts','r')"`],
      ['node regex mutation text', `node -e 'console.log(/require\\("fs"\\)\\.rmSync\\("src\\/victim.ts"\\)/.test("x"))'`],
      ['node static unrelated computed member', `node -e "console.log(module['filename'])"`],
      ['node attached short read', `node -e"require('fs').readFileSync('src/victim.ts','utf8')"`],
      ['node xargs wrapper read', `printf x | xargs node -e "require('fs').readFileSync('src/victim.ts','utf8')"`],
      ['node read-only path module', `node -e "console.log(require('path').join('src','victim.ts'))"`],
    ] as const) {
      for (const actor of ['main-root', 'native-child'] as const) {
        const output = runActorProbe(actor, probe, 'Bash', { command });
        if (Object.keys(output).length !== 0) {
          throw new Error(`native hook blocked semantic Node read-only operation: ${actor} ${probe}`);
        }
      }
    }

    for (const actor of ['main-root', 'native-child'] as const) {
      requireActorDeny(actor, 'unknown transport', runActorProbe(actor, 'unknown transport', 'mcp__example__future_mutation', {
        target: 'src/packed-unknown.ts',
      }));
    }
    for (const [probe, toolName] of [
      ['wiki ingest', 'mcp__omx_wiki__wiki_ingest'],
      ['project memory write', 'mcp__omx_memory__project_memory_write'],
    ] as const) {
      for (const actor of ['main-root', 'native-child'] as const) {
        requireActorDeny(actor, probe, runActorProbe(actor, probe, toolName, { content: 'mutation' }));
      }
    }
    for (const [probe, toolName, toolInput] of [
      ['trace summary', 'mcp__omx_trace__trace_summary', { workingDirectory: smokeCwd }],
      ['LSP diagnostics', 'mcp__omx_code_intel__lsp_diagnostics', { file: 'src/runtime.ts' }],
      ['wiki query', 'mcp__omx_wiki__wiki_query', { query: 'native hook', workingDirectory: smokeCwd }],
      ['project memory read', 'mcp__omx_memory__project_memory_read', { workingDirectory: smokeCwd }],
      ['notepad stats', 'mcp__omx_memory__notepad_stats', { workingDirectory: smokeCwd }],
    ] as const) {
      for (const actor of ['main-root', 'native-child'] as const) {
        const output = runActorProbe(actor, probe, toolName, toolInput);
        if (Object.keys(output).length !== 0) {
          throw new Error(`native hook blocked audited read-only MCP operation: ${actor} ${probe}`);
        }
      }
    }

    const childReadOutput = runActorProbe('native-child', 'read-only', 'Read', { file_path: 'src/packed-read-only.ts' });
    if (Object.keys(childReadOutput).length !== 0) {
      throw new Error('native hook blocked a positively classified native-child read-only operation');
    }
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
