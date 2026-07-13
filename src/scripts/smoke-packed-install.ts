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
      inheritedEnv: Record<string, string> = {},
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
      }, { ...childEnv, ...inheritedEnv }).stdout),
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

    writeFileSync(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
    requireActorDeny('native-child', 'anchorless state write', runActorProbe('native-child', 'anchorless state write', 'mcp__omx_state__state_write', { mode: 'ultragoal', active: true }));
    writeFileSync(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId, native_session_id: leaderAgentId }));

    for (const [probe, toolName, toolInput] of [
      ['filesystem write', 'mcp__filesystem__write_file', { path: 'src/packed-mcp-write.ts', content: 'escaped' }],
      ['state write', 'mcp__omx_state__state_write', { mode: 'ultragoal', active: true }],
    ] as const) {
      requireActorDeny('native-child', probe, runActorProbe('native-child', probe, toolName, toolInput));
    }

    const wgetReviewMutationCommands = [
      ['bare wget download', 'wget https://example.test/file'],
      ['wget short output log', 'wget -o .omx/state/wget.log https://example.invalid/native-child-write'],
      ['wget long output log', 'wget --output-file=.omx/state/wget.log https://example.invalid/native-child-write'],
      ['wget short append log', 'wget -a .omx/state/wget.log https://example.invalid/native-child-write'],
      ['wget long append log', 'wget --append-output=.omx/state/wget.log https://example.invalid/native-child-write'],
      ['xargs short arg file', 'xargs -a .omx/state/urls wget'],
      ['xargs long arg file', 'xargs --arg-file .omx/state/urls wget'],
      ['xargs short delimiter', `printf '%s\n' 'https://example.invalid/native-child-write' | xargs -d , wget`],
      ['xargs long delimiter', `printf '%s\n' 'https://example.invalid/native-child-write' | xargs --delimiter , wget`],
      ['xargs short eof', `printf '%s\n' 'https://example.invalid/native-child-write' | xargs -E STOP wget`],
      ['xargs long eof', `printf '%s\n' 'https://example.invalid/native-child-write' | xargs --eof=STOP wget`],
      ['xargs short replace', `printf '%s\n' 'https://example.invalid/native-child-write' | xargs -I X wget X`],
      ['xargs long replace', `printf '%s\n' 'https://example.invalid/native-child-write' | xargs --replace=X wget X`],
      ['xargs bsd replace', `printf '%s\n' 'https://example.invalid/native-child-write' | xargs -J X wget X`],
      ['xargs short max lines', `printf '%s\n' 'https://example.invalid/native-child-write' | xargs -L 1 wget`],
      ['xargs long max lines', `printf '%s\n' 'https://example.invalid/native-child-write' | xargs --max-lines=1 wget`],
      ['xargs short max args', `printf '%s\n' 'https://example.invalid/native-child-write' | xargs -n 1 wget`],
      ['xargs long max args', `printf '%s\n' 'https://example.invalid/native-child-write' | xargs --max-args 1 wget`],
      ['xargs short max procs', `printf '%s\n' 'https://example.invalid/native-child-write' | xargs -P 1 wget`],
      ['xargs long max procs', `printf '%s\n' 'https://example.invalid/native-child-write' | xargs --max-procs 1 wget`],
      ['xargs short max chars', `printf '%s\n' 'https://example.invalid/native-child-write' | xargs -s 4096 wget`],
      ['xargs long max chars', `printf '%s\n' 'https://example.invalid/native-child-write' | xargs --max-chars 4096 wget`],
      ['xargs process slot var', `printf '%s\n' 'https://example.invalid/native-child-write' | xargs --process-slot-var SLOT wget`],
      ['xargs abbreviated process slot var', `printf '%s\n' 'https://example.invalid/native-child-write' | xargs --process-slot-v SLOT wget`],
      ['xargs ambiguous long option', `printf '%s\n' 'https://example.invalid/native-child-write' | xargs --max SLOT wget`],
      ['xargs unknown long option', `printf '%s\n' 'https://example.invalid/native-child-write' | xargs --future-option SLOT wget`],
      ['wget end-of-options spider operand', 'wget -- --spider https://example.test/file'],
      ['wget short option argument smuggling', 'wget -U --spider https://example.test/file'],
      ['wget long option argument smuggling', 'wget --user-agent --spider https://example.test/file'],
      ['xargs eof no-value mutator', `printf '%s\n' src/victim.ts | xargs --eof rm`],
      ['xargs replace no-value mutator', `printf '%s\n' src/victim.ts | xargs --replace rm {}`],
      ['xargs max-lines no-value wget', `printf '%s\n' 'https://example.test/file' | xargs --max-lines wget true`],
    ] as const;

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
      ['node internal module loader', `node -e "module.constructor._load('fs').rmSync('src/internal-loader-bypass.ts')"`],
      ['node prototype module loader', `node -e "module.__proto__.constructor._load('fs').rmSync('src/prototype-loader-bypass.ts')"`],
      ['node computed prototype loader', `node -e "Object['getPrototypeOf'](module)['constructor']['_load']('fs')['rmSync']('src/prototype-computed-bypass.ts')"`],
      ['node optional computed prototype loader', `node -e "Object?.['getPrototypeOf'](module)?.['constructor']?.['_load']('fs')?.['rmSync']('src/optional-prototype-bypass.ts',{force:true})"`],
      ['node function constructor', `node -e '(()=>{}).constructor("return process.getBuiltinModule(\\"fs\\").rmSync(\\"src/function-dot.ts\\")")()'`],
      ['node method function constructor', `node -e '({}).toString.constructor("return process.getBuiltinModule(\\"fs\\").rmSync(\\"src/function-method.ts\\")")()'`],
      ['node descriptor builtin', `node -e "Object.getOwnPropertyDescriptor(process,'getBuiltinModule').value('fs').rmSync('src/descriptor.ts')"`],
      ['node descriptor builtin call', `node -e "Object.getOwnPropertyDescriptor(process,'getBuiltinModule').value.call(process,'fs').rmSync('src/descriptor-call.ts')"`],
      ['node destructured comma call', `node -e "const {rmSync}=require('fs');(0,rmSync)('src/destructured-comma.ts')"`],
      ['node destructured method call', `node -e "const {rmSync}=require('fs');rmSync.call(null,'src/destructured-call.ts')"`],
      ['node destructured Reflect.apply', `node -e "const {rmSync}=require('fs');Reflect.apply(rmSync,null,['src/destructured-reflect.ts'])"`],
      ['node ANSI-C eval flag', `node $'-e' "require('fs').rmSync('src/ansi-c.ts')"`],
      ['node nine env wrappers', `${Array.from({ length: 9 }, () => 'env').join(' ')} node -e "require('fs').rmSync('src/env-nine.ts')"`],
      ['node stdin pipe', `printf "require('fs').rmSync('src/stdin-pipe.ts')" | node`],
      ['node global Function computed', `node -e "globalThis['Fun'+'ction'](\\"return require('fs').rmSync('src/global-function.ts')\\")()"`],
      ['node Reflect global Function', `node -e "Reflect.get(globalThis,'Fun'+'ction')(\\"return require('fs').rmSync('src/reflect-function.ts')\\")()"`],
      ['node parenthesized constructor', `node -e "(console.log.constructor)(\\"return require('fs').rmSync('src/parenthesized-constructor.ts')\\")()"`],
      ['node side-effect import', `node --input-type=module -e "import './mutator.mjs'"`],
      ['node require preload', `node --require ./.omx/state/mutator.cjs -e "console.log('ok')"`],
      ['node options require preload', `NODE_OPTIONS='--require ./.omx/state/mutator.cjs' node -e "console.log('ok')"`],
      ['node exported options preload', `export NODE_OPTIONS='--require ./.omx/state/mutator.cjs'; node -e "console.log('ok')"`],
      ['node indirect exported options preload', `P='--require ./.omx/state/mutator.cjs'; export NODE_OPTIONS="$P"; node -e "console.log('ok')"`],
      ['node command exported options preload', `command export NODE_OPTIONS='--require ./.omx/state/mutator.cjs'; node -e "console.log('ok')"`],
      ['node declare exported options preload', `declare -x NODE_OPTIONS='--require ./.omx/state/mutator.cjs'; node -e "console.log('ok')"`],
      ['node function exported options preload', `f(){ export NODE_OPTIONS='--require ./.omx/state/mutator.cjs'; }; f; node -e "console.log('ok')"`],
      ['node dynamic export preload', `N=NODE_OPTIONS; export "$N=--require ./.omx/state/mutator.cjs"; node -e "console.log('ok')"`],
      ['node deep command exported options preload', `command command command command command command export NODE_OPTIONS='--require ./.omx/state/mutator.cjs'; node -e "console.log('ok')"`],
      ['node vm runInThisContext', `node -e "require('node:vm').runInThisContext(\\"require('fs').rmSync('src/vm.ts')\\")"`],
      ['node process alias builtin loader', `node -e "const p=process;p.getBuiltinModule('fs').rmSync('src/process-alias.ts')"`],
      ['node Reflect module require', `node -e "Reflect.apply(Reflect.get(module,'require'),module,['fs']).rmSync('src/reflect-require.ts')"`],
      ['node global process loader', `node -e "global['process'].getBuiltinModule('fs').rmSync('src/global-process.ts')"`],
      ['node ANSI-C command name', `$'\\u006e\\u006f\\u0064\\u0065' -e "require('fs').rmSync('src/ansi-command.ts')"`],
      ['node ANSI-C hex command name', `$'\\x6e\\x6f\\x64\\x65' -e "require('fs').rmSync('src/ansi-hex-command.ts')"`],
      ['node ANSI-C octal command name', `$'\\156\\157\\144\\145' -e "require('fs').rmSync('src/ansi-octal-command.ts')"`],
      ['node ANSI-C wide command name', `$'\\U0000006e\\U0000006f\\U00000064\\U00000065' -e "require('fs').rmSync('src/ansi-wide-command.ts')"`],
      ['python os.remove', `python3 -c "import os;os.remove('src/python-remove.ts')"`],
      ['python modeled write piggyback', `python3 -c "from pathlib import Path;import subprocess;Path('.omx/state/probe').write_text('x');subprocess.run(['rm','-f','src/python-piggyback.ts'])"`],
      ['python path sitecustomize preload', `PYTHONPATH=./.omx/state python3 -c "print('ok')"`],
      ['python dynamic open mode', `python3 -c "m='w';open('src/python-dynamic-open.ts',m)"`],
      ['python warnings module preload', `PYTHONWARNINGS='ignore::Mutator.Warning' python3 -c "print('ok')"`],
      ['ruby uninspected runtime', `ruby -e "File.delete('src/ruby-delete.ts')"`],
      ['python f-string side effect', `python3 -c "import subprocess;f'{subprocess.run([\\"touch\\",\\"src/python-fstring.ts\\"])}'"`],
      ['python isolated script', `python3 -I .omx/tmp/session/run.py`],
      ['perl eval substitution', `perl -pi -e 's/^/system("rm -f src\/perl-eval.ts")/e' .omx/state/conductor.log`],
      ['perl startup module preload', `PERL5LIB=./.omx/state PERL5OPT=-MMutator perl -e 'print;'`],
      ['git add unmodeled mutation', `git add src/runtime.ts`],
      ['sort output mutation', `sort -o src/sort-output.ts package.json`],
      ['sed write command', `sed -n 'w src/sed-output.ts' package.json`],
      ['sed addressed write command', `sed -n '1w src/sed-addressed-output.ts' package.json`],
      ['git diff output mutation', `git diff --output=src/git-output.ts --no-index /dev/null package.json`],
      ['sort compress program execution', `sort --compress-program=./.omx/state/mutator package.json`],
      ['rg pre helper', `rg --pre ./.omx/state/mutator pattern .`],
      ['gh release download write', `gh release download --dir src`],
      ['gh global repo release download', `gh -R owner/repo release download --dir src`],
      ['git external diff env', `GIT_EXTERNAL_DIFF=./.omx/state/mutator git diff`],
      ['git config external diff', `git -c diff.external=./.omx/state/mutator diff`],
      ['awk uninspected runtime', `awk 'BEGIN { print "x" > "src/awk-write.ts" }'`],
      ['npm restart script', 'npm restart'],
      ['npm run build', 'npm run build'],
      ['bash env stdin preload', `printf 'touch src/bash-env-preload.ts\\n' | BASH_ENV=/dev/stdin bash -c 'printf safe\\n'`],
      ['zsh startup preload', `ZDOTDIR=./.omx/state zsh -c "printf safe"`],
      ['python heredoc owner mismatch', `cat <<'SAFE' >/dev/null\nprint('safe')\nSAFE\npython3 <<'PY'\nfrom pathlib import Path\nimport subprocess\nPath('.omx/state/probe').write_text('x')\nsubprocess.run(['touch','src/python-heredoc-bypass.ts'])\nPY`],
      ['python pipeline heredoc mismatch', `cat <<'SAFE' >/dev/null | python3 <<'PY'\nprint('safe')\nSAFE\nfrom pathlib import Path\nimport subprocess\nPath('.omx/state/probe').write_text('x')\nsubprocess.run(['touch','src/python-pipeline-bypass.ts'])\nPY`],
      ['python indented heredoc terminator bypass', `python3 <<'true'
true=None
if True:
 true
echo=__import__('os').system
echo ('touch src/heredoc-bypass.ts')
true`],
      ['ANSI-C heredoc delimiter bypass', `cat <<$'EOF'
safe
EOF
touch src/ansi-heredoc-bypass.ts`],
      ['comment heredoc opener bypass', `true # <<'EOF'
touch src/comment-heredoc-bypass.ts
EOF`],
      ['arithmetic heredoc opener bypass', `: $((1 << 2))
touch src/arithmetic-heredoc-bypass.ts`],
      ['legacy arithmetic heredoc opener bypass', `: $[1 << 2]
touch src/legacy-arith-bypass.ts`],
      ['parameter expansion heredoc opener bypass', `: ${"${x#<<EOF}"}
touch src/parameter-expansion-bypass.ts`],
      ['ANSI CR heredoc terminator bypass', `cat <<$'EOF\\r'
safe
EOF\r
touch src/ansi-cr-heredoc-bypass.ts`],
      ['piped shell function bypass', `mutate(){ touch src/piped-function-bypass.ts; }; true | mutate`],
      ['transformed heredoc runtime bypass', `cat <<'PY' | tr a-z A-Z | python3
from pathlib import Path
Path('.omx/state/probe').write_text('x')
PY`],
      ['path qualified runtime shadow', `./.omx/state/python3 -c "print('ok')"`],
      ['PATH environment runtime shadow', `env PATH=.omx/state:/usr/bin:/bin python3 -c "print('ok')"`],
      ['python escaped path bypass', `python3 -c "from pathlib import Path;Path('.omx/state/\\x2e\\x2e/\\x2e\\x2e/src/python-escape.ts').write_text('x')"`],
      ['clobber redirect bypass', `true >| src/clobber-bypass.ts`],
      ['cross boundary hardlink bypass', `ln src/source.ts .omx/state/source-link.ts`],
      ['node env file preload bypass', `node --env-file=.omx/state/node.env -e "console.log('ok')"`],
      ['python cwd startup bypass', `cd .omx/state && python3 -c "print('ok')"`],
      ['sed in-place execute bypass', `sed -i '1e touch src/sed-exec.ts' .omx/state/conductor.log`],
      ...wgetReviewMutationCommands,
      ['unknown extensionless executable', './.omx/state/mutator'],
      ['heredoc delimiter executable collision', `cat <<'MUTATOR' > .omx/state/conductor.log\nsafe\nMUTATOR\n./.omx/state/mutator`],
      ['path executable function-name collision', `mutator() { printf safe; }; ./.omx/state/mutator`],
      ['wrapped executable function-name collision', `mutator() { printf safe; }; env PATH=.omx/state:/usr/bin:/bin mutator`],
      ['omx state clear', `omx state clear --input '{"mode":"ultragoal"}' --json`],
      ['bash uninspected script', `bash .omx/state/run.sh`],
      ['source uninspected script', `source .omx/state/run.sh`],
    ] as const) {
      for (const actor of ['main-root', 'native-child'] as const) {
        requireActorDeny(actor, probe, runActorProbe(actor, probe, 'Bash', { command }));
      }
    }
    const cliStateWrite = `omx state write --input '{"mode":"ultragoal","active":true,"current_phase":"executing","child_marker":"unauthorized"}' --json`;
    if (Object.keys(runActorProbe('main-root', 'cli state write main', 'Bash', { command: cliStateWrite })).length !== 0) throw new Error('packed main-root CLI state write should retain metadata allowance');
    requireActorDeny('native-child', 'cli state write native child', runActorProbe('native-child', 'cli state write native child', 'Bash', { command: cliStateWrite }));
    for (const [probe, command, inheritedEnv] of [
      ['python inherited sitecustomize preload', `python3 -c "print('ok')"`, { PYTHONPATH: './.omx/state' }],
      ['perl inherited module preload', `perl -e 'print;'`, { PERL5LIB: './.omx/state', PERL5OPT: '-MMutator' }],
      ['bash inherited env preload', `bash -c 'printf safe\\n'`, { BASH_ENV: './.omx/state/mutator.sh' }],
      ['zsh inherited startup preload', `zsh -c 'printf safe'`, { ZDOTDIR: './.omx/state' }],
    ] as const) {
      for (const actor of ['main-root', 'native-child'] as const) {
        requireActorDeny(actor, probe, runActorProbe(actor, probe, 'Bash', { command }, inheritedEnv));
      }
    }
    for (const [probe, command] of [
      ['gh issue create', `gh issue create --title x --body y`],
      ['gh api post', `gh api --method POST /repos/OWNER/REPO/issues -f title=x`],
      ['gh api attached post', `gh api -XPOST --input .omx/state/create-repo.json /user/repos`],
      ['omx ultragoal checkpoint', `omx ultragoal checkpoint --goal-id G001 --status failed --evidence unauthorized`],
      ['wrapped gh issue create', `bash -lc 'gh issue create --title x --body y'`],
      ['wrapped omx ultragoal checkpoint', `bash -lc 'omx ultragoal checkpoint --goal-id G001 --status failed --evidence unauthorized'`],
      ['wrapped gjc ultragoal checkpoint', `bash -lc 'gjc ultragoal checkpoint --goal-id G001 --status failed --evidence unauthorized'`],
      ['performance goal complete', `omx performance-goal complete --slug latency --codex-goal-json goal.json --evidence done`],
      ['wrapped performance goal complete', `bash -lc 'omx performance-goal complete --slug latency --codex-goal-json goal.json --evidence done'`],
      ['autoresearch goal complete', `gjc autoresearch-goal complete --slug safety --evidence done`],
      ['wrapped autoresearch goal complete', `bash -lc 'gjc autoresearch-goal complete --slug safety --evidence done'`],
      ['pipeline read then mutate', `omx status | omx performance-goal complete --slug latency --codex-goal-json goal.json --evidence done`],
      ['xargs gh api mutation', `printf '%s' '-XPOST /repos/OWNER/REPO/issues' | xargs gh api`],
    ] as const) {
      if (Object.keys(runActorProbe('main-root', `${probe} main`, 'Bash', { command })).length !== 0) throw new Error(`packed main-root ${probe} should retain remote orchestration allowance`);
      requireActorDeny('native-child', `${probe} native child`, runActorProbe('native-child', `${probe} native child`, 'Bash', { command }));
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
      ['node array index', `node -e "const a=[1];console.log(a[0])"`],
      ['node dynamic object read', `node -e "const o={x:1};const k='x';console.log(o[k])"`],
      ['node Object.getPrototypeOf', `node -e "console.log(Object.getPrototypeOf({}))"`],
      ['node Object computed getPrototypeOf', `node -e "Object['getPrototypeOf']({x:1})"`],
      ['node object computed constructor', `node -e "const o={constructor:7};console.log(o['constructor'])"`],
      ['node Reflect.get', `node -e "console.log(Reflect.get({x:1},'x'))"`],
      ['wget spider no-body', 'wget --spider https://example.test/file'],
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
