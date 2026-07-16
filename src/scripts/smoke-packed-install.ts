import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
    for (const input of [
      '{"hook_event_name":"PreToolUse",',
      `{"hook_event_name":"PreToolUse","transcript":"${'x'.repeat(1_048_577)}"}`,
    ]) {
      const result = run(process.execPath, [realpathSync(hookScript)], {
        cwd: smokeCwd,
        env: { ...process.env, OMX_ROOT: join(smokeCwd, '.omx-packed-hook-root') },
        input,
      });
      const output = JSON.parse(String(result.stdout)) as { hookSpecificOutput?: Record<string, unknown> };
      if (output.hookSpecificOutput?.permissionDecision !== 'deny' || output.hookSpecificOutput?.hookEventName !== 'PreToolUse') {
        throw new Error('packed malformed or oversized PreToolUse stdin must emit a canonical deny envelope');
      }
    }

    const hookRoot = smokeCwd;
    const stateDir = join(hookRoot, '.omx', 'state');
    const sessionId = 'packed-install-option-c';
    const leaderAgentId = 'agent-packed-install-leader';
    const teamName = 'packed-option-c';
    mkdirSync(join(stateDir, 'sessions', sessionId), { recursive: true });
    mkdirSync(join(stateDir, 'team', teamName, 'workers', 'worker-1'), { recursive: true });
    mkdirSync(join(smokeCwd, 'src', 'shared'), { recursive: true });
    mkdirSync(join(smokeCwd, 'src', 'state'), { recursive: true });
    mkdirSync(join(smokeCwd, '.omx', 'state'), { recursive: true });
    mkdirSync(join(smokeCwd, '.omx', 'state', 'tmp'), { recursive: true });
    writeFileSync(join(smokeCwd, '.omx', 'state', 'conductor-ledger.json'), '{}\n');
    writeFileSync(join(smokeCwd, '.omx', 'state', 'reference-copy'), 'metadata reference target\n');
    writeFileSync(join(smokeCwd, 'README.md'), 'read-only source\n');
    mkdirSync(join(smokeCwd, '.omx', 'state', 'inbox'), { recursive: true });
    writeFileSync(join(smokeCwd, '.omx', 'state', 'payload'), 'metadata payload\n');
    writeFileSync(join(smokeCwd, 'src', 'runtime.ts'), 'export {};\n');
    writeFileSync(join(smokeCwd, 'a'), 'finite metadata source\n');
    writeFileSync(join(smokeCwd, 'src', 'large.bin'), Buffer.alloc(16 * 1024 * 1024 + 1));
    mkdirSync(join(smokeCwd, '.omx', 'state', 'zsh-home'), { recursive: true });
    writeFileSync(join(smokeCwd, '.omx', 'state', 'zsh-home', '.zshenv'), 'touch src/zsh-owned.ts\n');
    writeFileSync(join(smokeCwd, '.omx', 'state', 'inbox', 'time'), '#!/bin/sh\ntouch src/time-wrapper-owned.ts\n');
    chmodSync(join(smokeCwd, '.omx', 'state', 'inbox', 'time'), 0o755);
    writeFileSync(join(smokeCwd, '.omx', 'state', 'inbox', 'node'), '#!/bin/sh\ntouch src/shebang-owned.ts\n');
    chmodSync(join(smokeCwd, '.omx', 'state', 'inbox', 'node'), 0o755);
    symlinkSync(join(smokeCwd, 'src', 'runtime.ts'), join(smokeCwd, '.omx', 'state', 'inbox', 'payload'));
    symlinkSync(join(smokeCwd, 'src', 'runtime.ts'), join(smokeCwd, '.omx', 'state', 'curl-glob-1.log'));
    mkdirSync(join(smokeCwd, 'src', 'subdir'), { recursive: true });
    mkdirSync(join(smokeCwd, '.omx', 'state', 'bash-home'), { recursive: true });
    writeFileSync(join(smokeCwd, '.omx', 'state', 'bash-home', '.bashrc'), 'touch src/interactive-owned.ts\n');
    symlinkSync(join(smokeCwd, 'src', 'subdir'), join(smokeCwd, '.omx', 'state', 'link'));
    symlinkSync(join(smokeCwd, 'src'), join(smokeCwd, '.omx', 'state', 'inbox', 'product-dir'));
    symlinkSync(join(smokeCwd, 'src', 'dangling-target.ts'), join(smokeCwd, '.omx', 'state', 'inbox', 'dangling'));
    writeFileSync(
      join(smokeCwd, '.omx', 'state', 'session.json'),
      JSON.stringify({ session_id: sessionId, native_session_id: leaderAgentId }),
    );
    writeFileSync(
      join(stateDir, 'session.json'),
      JSON.stringify({ session_id: sessionId, native_session_id: leaderAgentId }),
    );
    writeFileSync(
      join(stateDir, 'subagent-tracking.json'),
      JSON.stringify({
        schemaVersion: 1,
        sessions: {
          [sessionId]: {
            session_id: sessionId,
            leader_thread_id: leaderAgentId,
            threads: { [leaderAgentId]: { thread_id: leaderAgentId, kind: 'leader' } },
          },
        },
      }),
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
        agent_id: leaderAgentId,
        thread_id: leaderAgentId,
      }, teamEnv).stdout),
    );
    requireNativeHookPermissionDeny('PreToolUse leader with Team environment', leaderOutput, /Main-root Conductor mode is active/);

    const childEnv = {
      ...hookEnv,
      OMX_TEAM_WORKER: '',
      OMX_TEAM_INTERNAL_WORKER: '',
      OMX_TEAM_STATE_ROOT: '',
    };
    const runActorProbeResult = (
      actor: 'main-root' | 'native-child',
      probe: string,
      toolName: string,
      toolInput: Record<string, unknown>,
      inheritedEnv: Record<string, string> = {},
    ): { output: Record<string, unknown>; stdout: string } => {
      const result = invokeAuthorizationProbe({
        hook_event_name: 'PreToolUse',
        cwd: smokeCwd,
        session_id: actor === 'main-root' ? leaderAgentId : sessionId,
        ...(actor === 'main-root'
          ? { agent_id: leaderAgentId, thread_id: leaderAgentId }
          : { agent_id: 'agent-packed-install-child' }),
        tool_name: toolName,
        tool_use_id: `packed-install-${actor}-${probe.replace(/\W+/g, '-')}`,
        tool_input: toolInput,
      }, { ...childEnv, ...inheritedEnv });
      const stdout = String(result.stdout);
      return { output: parseNativeHookSmokeOutput(`PreToolUse ${actor} ${probe}`, stdout), stdout };
    };
    const runActorProbe = (
      actor: 'main-root' | 'native-child',
      probe: string,
      toolName: string,
      toolInput: Record<string, unknown>,
      inheritedEnv: Record<string, string> = {},
    ): Record<string, unknown> => runActorProbeResult(actor, probe, toolName, toolInput, inheritedEnv).output;
    const requireActorDeny = (
      actor: 'main-root' | 'native-child',
      probe: string,
      output: Record<string, unknown>,
    ): void => requireNativeHookPermissionDeny(
      `PreToolUse ${actor} ${probe}`,
      output,
      actor === 'native-child' ? /OWNER_CONFIRMATION_REQUIRED/ : /Main-root Conductor mode is active/,
    );
    for (const actor of ['main-root', 'native-child'] as const) {
      for (const [probe, command] of [
        ['finite cp directory leaf symlink', 'cp .omx/state/payload .omx/state/inbox'],
        ['finite curl remote-name leaf symlink', 'curl -q --output-dir .omx/state/inbox -O https://example.test/payload'],
        ['finite wget prefix leaf symlink', 'wget --no-config -P .omx/state/inbox https://example.test/payload'],
        ['finite curl remote-name scheme-less extra operand leaf symlink', 'curl -q --output-dir .omx/state/inbox -O https://example.test/payload ftp.example.test/payload'],
        ['finite wget prefix scheme-less extra operand leaf symlink', 'wget --no-config --no-hsts -P .omx/state/inbox https://example.test/payload ftp.example.test/payload'],
        ['finite curl template leaf symlink', "curl -q -o .omx/state/curl-glob-#1.log 'https://example.test/file[1-2]'"],
        ['dangling symlink touch', 'touch .omx/state/inbox/dangling'],
        ['dangling symlink Wget output', 'wget --no-config --no-hsts -P .omx/state/inbox https://example.test/dangling'],
        ['wait -p POSIX writer', 'export POSIXLY_CORRECT; sleep 0 & wait -n -p POSIXLY_CORRECT; wget --no-config --no-hsts -O src/wait-owned.ts https://example.test/file -O -'],
        ['clustered wait -p POSIX writer', 'export POSIXLY_CORRECT; sleep 0 & wait -np POSIXLY_CORRECT; wget --no-config --no-hsts -O src/wait-cluster-owned.ts https://example.test/file -O -'],
        ['fd redirect source sink', 'printf pwn >& src/native-child-owned.ts'],
        ['fd redirect protected state sink', `printf pwn >& .omx/state/sessions/${sessionId}/ultragoal-state.json`],
        ['function return cwd flow', 'f(){ cd src; return; cd ..; }; f; touch .omx/state/inbox/return-owned'],
        ['protected state ancestor removal', `rm -rf .omx/state/sessions/${sessionId}`],
        ['ordered metadata append overflow', 'truncate --size=16777216 .omx/state/inbox/oversized; printf x >> .omx/state/inbox/oversized'],
        ['rsync aliased source and log', 'rsync --log-file=.omx/state/conductor-ledger.json .omx/state/conductor-ledger.json .omx/state/inbox/rsync-alias-copy'],
        ['exec login shell startup', 'HOME=.omx/state/bash-home exec -l /bin/bash -c ":"'],
        ['env argv0 login shell startup', 'HOME=.omx/state/bash-home env --argv0=-bash /bin/bash -c ":"'],
        ['function keyword command-not-found handler', 'function command_not_found_handle { /usr/bin/touch src/path-keyword-owned.ts; }; PATH=/definitely/not-present; cat README.md'],
        ['shadowed printf redirect producer', 'printf(){ /usr/bin/head -c 16777217 /dev/zero; }; printf safe > .omx/state/inbox/oversized'],
        ['shadowed cat heredoc producer', "cat(){ /usr/bin/head -c 16777217 /dev/zero; }; cat <<'EOF' > .omx/state/inbox/oversized-heredoc\nsafe\nEOF"],
        ['glob redirect producer', 'echo .omx/state/* > .omx/state/inbox/glob-producer'],
        ['brace redirect producer', 'echo {a,b} > .omx/state/inbox/brace-producer'],
        ['tilde redirect producer', 'echo ~/metadata > .omx/state/inbox/tilde-producer'],
        ['oversized truncate', 'truncate --size=16777217 .omx/state/inbox/oversized'],
        ['attached oversized truncate', 'truncate -s16777217 .omx/state/inbox/oversized-attached'],
        ['relative truncate size', 'truncate --size=+1 .omx/state/inbox/relative'],
        ['Wget uncapped file sink', 'wget --no-config --no-hsts -O .omx/state/inbox/stream https://example.test/file'],
        ['Wget non-HTTP file sink', 'wget --no-config --no-hsts -O .omx/state/inbox/ftp ftp://example.test/file'],
        ['Wget multiple file sink URLs', 'wget --no-config --no-hsts -O .omx/state/inbox/multiple https://example.test/one https://example.test/two'],
        ['curl uncapped file sink', 'curl -q --max-time 1 -o .omx/state/inbox/stream https://example.test/file'],
        ['trusted script environment interpreter shadow', 'PATH=.omx/state/inbox:/usr/bin:/bin /usr/bin/npm --version'],
      ] as const) {
        requireActorDeny(actor, probe, runActorProbe(actor, probe, 'Bash', { command }));
      }
    }
    for (const fileName of [
      'autopilot-state.json',
      'autoresearch-state.json',
      'deep-interview-state.json',
      'ralplan-state.json',
      'ralph-state.json',
      'ultrawork-state.json',
      'team-state.json',
      'ultraqa-state.json',
      'ultragoal-state.json',
      'skill-active-state.json',
      'release-readiness-state.json',
      'run-state.json',
      'session.json',
      'subagent-tracking.json',
      'native-stop-state.json',
    ] as const) {
      for (const actor of ['main-root', 'native-child'] as const) {
        requireActorDeny(
          actor,
          `raw gate state write ${fileName}`,
          runActorProbe(actor, `raw gate state write ${fileName}`, 'Write', {
            file_path: `.omx/state/sessions/${sessionId}/${fileName}`,
            content: JSON.stringify({ active: false, mode: fileName.slice(0, -'-state.json'.length), current_phase: 'complete', session_id: sessionId }),
          }),
        );
      }
    }
    for (const filePath of [
      `.omx/state/team/${teamName}/phase.json`,
      `.omx/state/team/${teamName}/manifest.v2.json`,
      `.omx/state/team/${teamName}/config.json`,
      `.omx/state/team/${teamName}/workers/worker-1/identity.json`,
    ]) {
      for (const actor of ['main-root', 'native-child'] as const) {
        requireActorDeny(
          actor,
          `raw Team authority write ${filePath}`,
          runActorProbe(actor, `raw Team authority write ${filePath}`, 'Write', { file_path: filePath, content: '{}' }),
        );
      }
    }
    for (const filePath of [
      `.omx/state/sessions/${sessionId}/ULTRAGOAL-STATE.JSON`,
      `.omx/state/sessions/${sessionId}/ultragoal-state.json. `,
    ]) {
      for (const actor of ['main-root', 'native-child'] as const) {
        requireActorDeny(
          actor,
          `protected gate-state filesystem alias ${filePath}`,
          runActorProbe(actor, `protected gate-state filesystem alias ${filePath}`, 'Write', { file_path: filePath, content: '{}' }),
        );
      }
    }
    for (const [probe, command] of [
      ['gate state redirect', `printf x > .omx/state/sessions/${sessionId}/ultragoal-state.json`],
      ['gate state editor', `sed -i 's/executing/complete/' .omx/state/sessions/${sessionId}/ultragoal-state.json`],
      ['gate state interpreter', `node -e "require('fs').writeFileSync('.omx/state/sessions/${sessionId}/ultragoal-state.json','{}')"`],
    ] as const) {
      for (const actor of ['main-root', 'native-child'] as const) {
        requireActorDeny(actor, probe, runActorProbe(actor, probe, 'Bash', { command }));
      }
    }
    requireNativeHookPermissionDeny(
      'identityless remote mutation',
      parseNativeHookSmokeOutput(
        'PreToolUse identityless remote mutation',
        String(invokeAuthorizationProbe({
          hook_event_name: 'PreToolUse',
          cwd: smokeCwd,
          session_id: sessionId,
          tool_name: 'Bash',
          tool_use_id: 'packed-install-identityless-remote-mutation',
          tool_input: { command: 'PATH=/usr/bin:/bin gh issue create --title x --body y' },
        }, childEnv).stdout),
      ),
      /OWNER_CONFIRMATION_REQUIRED/,
    );
    for (const [probe, identity] of [
      ['conflicting owner and current thread aliases', { owner_codex_thread_id: leaderAgentId, thread_id: 'agent-packed-install-child' }],
      ['conflicting session aliases', { session_id: sessionId, sessionId: 'foreign-session', agent_id: leaderAgentId, thread_id: leaderAgentId }],
      ['reversed conflicting session aliases', { session_id: 'foreign-session', sessionId, agent_id: leaderAgentId, thread_id: leaderAgentId }],
      ['conflicting owner and agent aliases', { owner_codex_thread_id: 'foreign-owner', agent_id: leaderAgentId }],
    ] as const) {
      requireNativeHookPermissionDeny(
        probe,
        parseNativeHookSmokeOutput(
          probe,
          String(invokeAuthorizationProbe({
            hook_event_name: 'PreToolUse',
            cwd: smokeCwd,
            session_id: leaderAgentId,
            ...identity,
            tool_name: 'Bash',
            tool_use_id: `packed-install-${probe.replace(/\W+/g, '-')}`,
            tool_input: { command: 'PATH=/usr/bin:/bin gh issue create --title x --body y' },
          }, childEnv).stdout),
        ),
        /PROVENANCE_DENIED/,
      );
    }
    for (const [probe, identity] of [
      ['foreign active session', { session_id: 'foreign-session', agent_id: leaderAgentId, thread_id: leaderAgentId }],
      ['absent active session', { agent_id: leaderAgentId, thread_id: leaderAgentId }],
    ] as const) {
      requireNativeHookPermissionDeny(
        probe,
        parseNativeHookSmokeOutput(
          probe,
          String(invokeAuthorizationProbe({
            hook_event_name: 'PreToolUse',
            cwd: smokeCwd,
            ...identity,
            tool_name: 'Write',
            tool_use_id: `packed-install-${probe.replace(/\W+/g, '-')}`,
            tool_input: { file_path: 'src/session-bypass.ts', content: 'owned\n' },
          }, childEnv).stdout),
        ),
        /PROVENANCE_DENIED/,
      );
    }
    for (const [order, sessionAliases] of [
      ['canonical-first', { session_id: sessionId, sessionId: 'foreign-session' }],
      ['foreign-first', { session_id: 'foreign-session', sessionId }],
    ] as const) {
      for (const [transport, toolName, toolInput] of [
        ['path', 'Write', { file_path: 'src/alias-bypass.ts', content: 'owned\n' }],
        ['bash', 'Bash', { command: 'printf pwn >& src/alias-bypass.ts' }],
        ['state', 'mcp__omx_state__state_write', { mode: 'ultragoal', active: true }],
      ] as const) {
        requireNativeHookPermissionDeny(
          `session alias ${order}/${transport}`,
          parseNativeHookSmokeOutput(
            `PreToolUse session alias ${order}/${transport}`,
            String(invokeAuthorizationProbe({
              hook_event_name: 'PreToolUse',
              cwd: smokeCwd,
              ...sessionAliases,
              agent_id: leaderAgentId,
              thread_id: leaderAgentId,
              tool_name: toolName,
              tool_use_id: `packed-install-session-alias-${order}-${transport}`,
              tool_input: toolInput,
            }, childEnv).stdout),
          ),
          /PROVENANCE_DENIED/,
        );
      }
    }
    requireNativeHookPermissionDeny(
      'noncanonical cwd metadata target',
      parseNativeHookSmokeOutput(
        'PreToolUse noncanonical cwd metadata target',
        String(invokeAuthorizationProbe({
          hook_event_name: 'PreToolUse',
          cwd: join(smokeCwd, 'src'),
          session_id: sessionId,
          agent_id: leaderAgentId,
          thread_id: leaderAgentId,
          tool_name: 'Write',
          tool_use_id: 'packed-install-noncanonical-cwd-metadata-target',
          tool_input: { file_path: '.omx/state/inbox/cwd-bypass', content: 'owned\n' },
        }, childEnv).stdout),
      ),
      /Main-root Conductor mode is active/,
    );
    requireNativeHookPermissionDeny(
      'identityless native-session remote mutation',
      parseNativeHookSmokeOutput(
        'PreToolUse identityless native-session remote mutation',
        String(invokeAuthorizationProbe({
          hook_event_name: 'PreToolUse',
          cwd: smokeCwd,
          session_id: leaderAgentId,
          tool_name: 'Bash',
          tool_use_id: 'packed-install-identityless-native-session-remote-mutation',
          tool_input: { command: 'PATH=/usr/bin:/bin gh issue create --title x --body y' },
        }, childEnv).stdout),
      ),
      /OWNER_CONFIRMATION_REQUIRED/,
    );
    if (Object.keys(runActorProbe('main-root', 'finite cp metadata leaf control', 'Bash', {
      command: 'cp .omx/state/payload .omx/handoffs/run-1/payload',
    })).length !== 0) {
      throw new Error('packed main-root finite cp metadata leaf control should be allowed');
    }
    if (Object.keys(runActorProbe('main-root', 'bounded dd metadata copy control', 'Bash', {
      command: 'dd if=a of=.omx/state/inbox/dd-copy bs=1 count=1',
    })).length !== 0) {
      throw new Error('packed main-root bounded dd metadata copy control should be allowed');
    }
    if (Object.keys(runActorProbe('main-root', 'bounded truncate metadata control', 'Bash', {
      command: 'truncate --size=16777216 .omx/state/inbox/truncate',
    })).length !== 0) {
      throw new Error('packed main-root bounded truncate metadata control should be allowed');
    }
    if (Object.keys(runActorProbe('main-root', 'bounded quoted heredoc metadata control', 'Bash', {
      command: "cat <<'EOF' > .omx/state/conductor-heredoc.json\n{}\nEOF",
    })).length !== 0) {
      throw new Error('packed main-root bounded quoted heredoc metadata control should be allowed');
    }
    if (Object.keys(runActorProbe('main-root', 'zsh fast startup control', 'Bash', {
      command: `zsh -f -c ':'`,
    })).length !== 0) {
      throw new Error('packed main-root zsh fast startup control should be allowed');
    }
    const boxedPlanningRoot = join(smokeCwd, 'boxed-planning-root');
    const boxedPlanningStateDir = join(boxedPlanningRoot, '.omx', 'state');
    const boxedPlanningStatePath = join(boxedPlanningStateDir, 'sessions', leaderAgentId, 'ralplan-state.json');
    writeFileSync(join(smokeCwd, 'src', 'boxed-planning-runtime.ts'), JSON.stringify({
      active: true,
      mode: 'ralplan',
      current_phase: 'planning',
      session_id: leaderAgentId,
    }));
    mkdirSync(join(boxedPlanningStateDir, 'sessions', leaderAgentId), { recursive: true });
    writeFileSync(join(boxedPlanningStateDir, 'session.json'), JSON.stringify({ session_id: leaderAgentId }));
    writeFileSync(join(boxedPlanningStateDir, 'sessions', leaderAgentId, 'skill-active-state.json'), JSON.stringify({
      active: true,
      skill: 'ralplan',
      phase: 'planning',
      session_id: leaderAgentId,
      active_skills: [{ skill: 'ralplan', phase: 'planning', active: true, session_id: leaderAgentId }],
    }));
    symlinkSync(join(smokeCwd, 'src', 'boxed-planning-runtime.ts'), boxedPlanningStatePath);
    const boxedPlanningHardLinkPath = join(boxedPlanningStateDir, 'sessions', leaderAgentId, 'deep-interview-state.json');
    linkSync(join(smokeCwd, 'src', 'boxed-planning-runtime.ts'), boxedPlanningHardLinkPath);
    const boxedPlanningSiblingSessionId = `${leaderAgentId}-sibling`;
    const boxedPlanningSiblingPath = join(boxedPlanningStateDir, 'sessions', boxedPlanningSiblingSessionId, 'ralplan-state.json');
    mkdirSync(dirname(boxedPlanningSiblingPath), { recursive: true });
    writeFileSync(boxedPlanningSiblingPath, JSON.stringify({
      active: true,
      mode: 'ralplan',
      current_phase: 'planning',
      session_id: boxedPlanningSiblingSessionId,
    }));
    requireNativeHookPermissionDeny(
      'main-root boxed planning state symlink',
      runActorProbe('main-root', 'boxed planning state symlink', 'Write', { file_path: boxedPlanningStatePath, content: 'owned\n' }, {
        OMX_ROOT: boxedPlanningRoot,
        OMX_TEAM_STATE_ROOT: '',
      }),
      /(?:Ralplan is active|Main-root Conductor mode is active)/,
    );
    requireNativeHookPermissionDeny(
      'main-root boxed planning state hardlink',
      runActorProbe('main-root', 'boxed planning state hardlink', 'Write', { file_path: boxedPlanningHardLinkPath, content: 'owned\n' }, {
        OMX_ROOT: boxedPlanningRoot,
        OMX_TEAM_STATE_ROOT: '',
      }),
      /(?:Ralplan is active|Main-root Conductor mode is active)/,
    );
    requireNativeHookPermissionDeny(
      'main-root boxed planning sibling session',
      runActorProbe('main-root', 'boxed planning sibling session', 'Write', { file_path: boxedPlanningSiblingPath, content: 'owned\n' }, {
        OMX_ROOT: boxedPlanningRoot,
        OMX_TEAM_STATE_ROOT: '',
      }),
      /(?:Ralplan is active|Main-root Conductor mode is active)/,
    );
    if (Object.keys(runActorProbe('main-root', 'hardlink metadata source control', 'Bash', {
      command: 'ln .omx/state/conductor-ledger.json .omx/handoffs/run-1/ledger-link',
    })).length !== 0) {
      throw new Error('packed main-root hardlink metadata source control should be allowed');
    }

    writeFileSync(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
    requireActorDeny('native-child', 'anchorless state write', runActorProbe('native-child', 'anchorless state write', 'mcp__omx_state__state_write', { mode: 'ultragoal', active: true }));
    writeFileSync(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId, native_session_id: leaderAgentId }));

    for (const [probe, toolName, toolInput] of [
      ['filesystem write', 'mcp__filesystem__write_file', { path: 'src/packed-mcp-write.ts', content: 'escaped' }],
      ['state write', 'mcp__omx_state__state_write', { mode: 'ultragoal', active: true }],
    ] as const) {
      requireActorDeny('native-child', probe, runActorProbe('native-child', probe, toolName, toolInput));
    }
    for (const [probe, toolInput] of [
      ['state write foreign routing', { mode: 'ultragoal', workingDirectory: 'src', session_id: 'foreign', active: false }],
      ['state write unknown payload key', { mode: 'ultragoal', active: true, child_marker: 'forbidden' }],
    ] as const) {
      for (const actor of ['main-root', 'native-child'] as const) {
        requireActorDeny(actor, probe, runActorProbe(actor, probe, 'mcp__omx_state__state_write', toolInput));
      }
    }
    for (const actor of ['main-root', 'native-child'] as const) {
      requireActorDeny(
        actor,
        'state clear active workflow',
        runActorProbe(actor, 'state clear active workflow', 'mcp__omx_state__state_clear', { mode: 'ultragoal' }),
      );
    }
    for (const identity of [
      { agent_id: leaderAgentId, thread_id: 'thread-packed-install-foreign' },
      { agent_id: 'agent-packed-install-foreign', thread_id: leaderAgentId },
    ]) {
      const output = parseNativeHookSmokeOutput(
        'PreToolUse conflicting leader identity',
        String(invokeAuthorizationProbe({
          hook_event_name: 'PreToolUse',
          cwd: smokeCwd,
          session_id: sessionId,
          ...identity,
          tool_name: 'Write',
          tool_input: { file_path: 'src/packed-conflict.ts', content: 'escaped' },
        }, childEnv).stdout),
      );
      requireNativeHookPermissionDeny('PreToolUse conflicting leader identity', output, /PROVENANCE_DENIED/);
    }
    const consistentLeaderOutput = parseNativeHookSmokeOutput(
      'PreToolUse consistent leader identity',
      String(invokeAuthorizationProbe({
        hook_event_name: 'PreToolUse',
        cwd: smokeCwd,
        session_id: sessionId,
        agent_id: leaderAgentId,
        thread_id: leaderAgentId,
        tool_name: 'Write',
        tool_input: { file_path: 'src/packed-consistent-leader.ts', content: 'escaped' },
      }, childEnv).stdout),
    );
    requireNativeHookPermissionDeny('PreToolUse consistent leader identity', consistentLeaderOutput, /Main-root Conductor mode is active/);
    const ownerSessionClaimOutput = parseNativeHookSmokeOutput(
      'PreToolUse owner-session identity claim',
      String(invokeAuthorizationProbe({
        hook_event_name: 'PreToolUse',
        cwd: smokeCwd,
        session_id: sessionId,
        owner_codex_session_id: leaderAgentId,
        owner_omx_session_id: sessionId,
        tool_name: 'Write',
        tool_input: { file_path: 'src/packed-session-claim.ts', content: 'escaped' },
      }, childEnv).stdout),
    );
    requireNativeHookPermissionDeny('PreToolUse owner-session identity claim', ownerSessionClaimOutput, /OWNER_CONFIRMATION_REQUIRED/);

    const wgetReviewMutationCommands = [
      ['bare wget download', 'wget https://example.test/file'],
      ['wget short output log', 'wget -o .omx/state/wget.log https://example.invalid/native-child-write'],
      ['wget long output log', 'wget --output-file=.omx/state/wget.log https://example.invalid/native-child-write'],
      ['wget short append log', 'wget -a .omx/state/wget.log https://example.invalid/native-child-write'],
      ['wget long append log', 'wget --append-output=.omx/state/wget.log https://example.invalid/native-child-write'],
      ['wget dot-slash dash file target', 'wget --no-config --no-hsts -O ./- https://example.test/file'],
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
      ['xargs single quoted empty eof mutator', `printf '%s\n' src/xargs-owned.ts | xargs -E '' touch true`],
      ['xargs double quoted empty eof mutator', `printf '%s\n' src/xargs-owned.ts | xargs -E "" touch true`],
      ['xargs wget short stdout body override', `printf '%s\n' '--output-document=src/xargs-wget-owned.ts' 'https://example.test/file' | xargs wget -O -`],
      ['xargs wget long stdout body override', `printf '%s\n' '--output-document=src/xargs-wget-owned.ts' 'https://example.test/file' | xargs wget --output-document=-`],
      ['xargs wget stdout log injection', `printf '%s\n' '--output-file=src/xargs-wget.log' 'https://example.test/file' | xargs wget -O -`],
      ['dynamic wget stdout body override', `WGET_OPT=--output-document=src/dynamic-wget-owned.ts; wget -O - $WGET_OPT https://example.test/file`],
      ['dynamic wget stdout log injection', `WGET_OPT=--output-file=src/dynamic-wget.log; wget -O - $WGET_OPT https://example.test/file`],
      ['posix wget option ordering', `POSIXLY_CORRECT=1 wget -O src/posix-wget-owned.ts https://example.test/file -O -`],
      ['posix wget append assignment', `POSIXLY_CORRECT+=1 wget --no-config -O src/plus-prefix-owned.ts https://example.test/file -O -`],
      ['export posix wget append assignment', `export POSIXLY_CORRECT+=1; wget --no-config -O src/plus-export-owned.ts https://example.test/file -O -`],
      ['declare posix wget append assignment', `declare -x POSIXLY_CORRECT+=1; wget --no-config -O src/plus-declare-owned.ts https://example.test/file -O -`],
      ['function posix wget append assignment', `f(){ export POSIXLY_CORRECT+=1; }; f; wget --no-config -O src/plus-function-owned.ts https://example.test/file -O -`],
      ['wrapper posix wget append assignment', `command env POSIXLY_CORRECT+=1 wget --no-config -O src/plus-wrapper-owned.ts https://example.test/file -O -`],
      ['quoted posix wget append assignment', `export "POSIXLY_CORRECT+=1"; wget --no-config -O src/plus-quoted-owned.ts https://example.test/file -O -`],
      ['function local posix wget append assignment', `f(){ local -x POSIXLY_CORRECT+=1; wget --no-config -O src/plus-local-owned.ts https://example.test/file -O -; }; f`],
      ['unset posix then append wget', `export POSIXLY_CORRECT=1; unset POSIXLY_CORRECT; export POSIXLY_CORRECT+=1; wget --no-config -O src/unset-append-owned.ts https://example.test/file -O -`],
      ['braced wget stdout body override', `WGET_OPT=--output-document=src/braced-wget-owned.ts; wget -O - \${WGET_OPT} https://example.test/file`],
      ['command substitution wget log injection', `wget -O - $(printf '%s' '--output-file=src/substitution-wget.log') https://example.test/file`],
      ['exported posix wget ordering', `export POSIXLY_CORRECT=1; wget -O src/exported-posix-owned.ts https://example.test/file -O -`],
      ['nested posix wget ordering', `POSIXLY_CORRECT=1 sh -c 'wget -O src/nested-posix-owned.ts https://example.test/file -O -'`],
      ['quote concatenated posix wget ordering', `export POSIXLY_''CORRECT=1; wget -O src/quoted-posix-owned.ts https://example.test/file -O -`],
      ['escaped posix wget ordering', `export POSIXLY_\\CORRECT=1; wget -O src/escaped-posix-owned.ts https://example.test/file -O -`],
      ['ansi c posix wget ordering', `export $'POSIXLY_CORRECT'=1; wget -O src/ansi-posix-owned.ts https://example.test/file -O -`],
      ['dynamic name posix wget ordering', `POSIX_NAME=POSIXLY_CORRECT; export "$POSIX_NAME=1"; wget -O src/dynamic-posix-owned.ts https://example.test/file -O -`],
      ['split dynamic name posix wget ordering', `A=POSIXLY; B=_CORRECT; export "$A$B=1"; wget -O src/split-dynamic-posix-owned.ts https://example.test/file -O -`],
      ['command export posix wget ordering', `command export POSIXLY_CORRECT=1; wget -O src/command-export-posix-owned.ts https://example.test/file -O -`],
      ['command env posix wget ordering', `command env POSIXLY_CORRECT=1 wget -O src/command-env-posix-owned.ts https://example.test/file -O -`],
      ['command double dash export posix wget ordering', `command -- export POSIXLY_CORRECT=1; wget -O src/command-dash-posix-owned.ts https://example.test/file -O -`],
      ['compound dynamic export posix wget ordering', `N=POSIXLY_CORRECT; if export "$N=1"; then wget -O src/compound-posix-owned.ts https://example.test/file -O -; fi`],
      ['time env posix wget ordering', `time env POSIXLY_CORRECT=1 wget -O src/time-posix-owned.ts https://example.test/file -O -`],
      ['function export posix wget ordering', `f(){ export POSIXLY_CORRECT=1; }; f; wget -O src/function-posix-owned.ts https://example.test/file -O -`],
      ['function dynamic export posix wget ordering', `f(){ N=POSIXLY_CORRECT; export "$N=1"; }; f; wget -O src/function-dynamic-posix-owned.ts https://example.test/file -O -`],
      ['function local export posix wget ordering', `f(){ local -x POSIXLY_CORRECT=1; wget -O src/local-posix-owned.ts https://example.test/file -O -; }; f`],
      ['function local dynamic export posix wget ordering', `f(){ N=POSIXLY_CORRECT; local -x "$N=1"; wget -O src/local-dynamic-posix-owned.ts https://example.test/file -O -; }; f`],
      ['case arm function wget', `f(){ wget https://example.test/file; }; case true in true) f;; esac`],
      ['multi case arm function wget', `f(){ wget https://example.test/file; }; case x in a) true;; x) f;; esac`],
      ['direct case arm wget log', `case true in true) wget --no-config -o src/case-wget.log -O - http://127.0.0.1:1/;; esac`],
      ['direct case arm mutator', `case true in true) touch src/case-mutator.ts;; esac`],
      ['pre redefinition posix wget', `f(){ export POSIXLY_CORRECT=1; }; f; f(){ :; }; wget --no-config -O src/redefined-posix-owned.ts https://example.test/file -O -`],
      ['nested shadowed builtin posix wget', `echo(){ export POSIXLY_CORRECT=1; }; f(){ echo; }; f; wget --no-config -O src/nested-posix-owned.ts https://example.test/file -O -`],
      ['deep nested shadowed builtin posix wget', `echo(){ export POSIXLY_CORRECT=1; }; f(){ g(){ echo; }; g; }; f; wget --no-config -O src/deep-nested-posix-owned.ts https://example.test/file -O -`],
      ['case pattern alternation posix wget', `f(){ export POSIXLY_CORRECT=1; }; case true in true|false) f;; esac; wget --no-config -O src/case-posix-owned.ts https://example.test/file -O -`],
      ['env chdir wget log', `env -C src wget --no-config -o .omx/state/env-c.log -O - http://127.0.0.1:1/`],
      ['wgetrc logfile write', `printf '%s\n' 'logfile = src/wgetrc.log' | WGETRC=/dev/stdin wget -O - http://127.0.0.1:1/`],
      ['wgetrc output document write', `printf '%s\n' 'output_document = src/wgetrc-output.ts' | WGETRC=/dev/stdin wget -O - http://127.0.0.1:1/`],
      ['wgetrc directory prefix write', `printf '%s\n' 'dir_prefix = src/wgetrc-directory' | WGETRC=/dev/stdin wget -O - http://127.0.0.1:1/`],
      ['command wrapper function shadow', `touch(){ :; }; command touch src/wrapped-shadow-owned.ts`],
      ['short circuit posix unset', `export POSIXLY_CORRECT=1; false && unset POSIXLY_CORRECT; wget --no-config -O src/short-circuit-owned.ts http://127.0.0.1:1/ -O -`],
      ['conditional function rebind', `f(){ export POSIXLY_CORRECT=1; }; if false; then f(){ :; }; fi; f; wget --no-config -O src/conditional-rebind-owned.ts http://127.0.0.1:1/ -O -`],
      ['readonly posix unset', `export POSIXLY_CORRECT=1; readonly POSIXLY_CORRECT; unset POSIXLY_CORRECT; wget --no-config -O src/readonly-unset-owned.ts http://127.0.0.1:1/ -O -`],
      ['prefix posix function', `f(){ wget --no-config -O src/prefix-function-owned.ts http://127.0.0.1:1/ -O -; }; POSIXLY_CORRECT=1 f`],
      ['prefix posix append function', `f(){ wget --no-config -O src/prefix-append-function-owned.ts http://127.0.0.1:1/ -O -; }; POSIXLY_CORRECT+=1 f`],
      ['declare global posix', `f(){ declare -gx POSIXLY_CORRECT=1; }; f; wget --no-config -O src/declare-global-owned.ts http://127.0.0.1:1/ -O -`],
      ['export before local posix', `f(){ export POSIXLY_CORRECT=1; local POSIXLY_CORRECT=1; }; f; wget --no-config -O src/export-before-local-owned.ts http://127.0.0.1:1/ -O -`],
      ['process substitution current shell', `f(){ export POSIXLY_CORRECT=1; }; f <(true); wget --no-config -O src/process-substitution-owned.ts http://127.0.0.1:1/ -O -`],
      ['coproc ordinary argument', `f(){ export POSIXLY_CORRECT=1; }; f coproc; wget --no-config -O src/coproc-argument-owned.ts http://127.0.0.1:1/ -O -`],
      ['subshell function rebind', `g(){ export POSIXLY_CORRECT=1; }; f(){ g(){ :; }; }; ( f ); g; wget --no-config -O src/subshell-rebind-owned.ts http://127.0.0.1:1/ -O -`],
      ['background function rebind', `g(){ export POSIXLY_CORRECT=1; }; f(){ g(){ :; }; }; f & wait; g; wget --no-config -O src/background-rebind-owned.ts http://127.0.0.1:1/ -O -`],
      ['pipeline function rebind', `g(){ export POSIXLY_CORRECT=1; }; f(){ g(){ :; }; }; f | cat; g; wget --no-config -O src/pipeline-rebind-owned.ts http://127.0.0.1:1/ -O -`],
      ['coproc function rebind', `g(){ export POSIXLY_CORRECT=1; }; f(){ g(){ :; }; }; coproc f; wait; g; wget --no-config -O src/coproc-rebind-owned.ts http://127.0.0.1:1/ -O -`],
      ['later case pattern posix', `f(){ export POSIXLY_CORRECT=1; }; case true in false) :;; true|false) f;; esac; wget --no-config -o src/later-case.log http://127.0.0.1:1/ -o .omx/state/final.log -O -`],
      ['optional case pattern posix', `f(){ export POSIXLY_CORRECT=1; }; case true in (true) f;; esac; wget --no-config -O src/optional-case-owned.ts http://127.0.0.1:1/ -O -`],
      ['nested case pattern posix', `f(){ export POSIXLY_CORRECT=1; }; case true in false) case true in true) :;; esac;; true|false) f;; esac; wget --no-config -O src/nested-case-owned.ts http://127.0.0.1:1/ -O -`],
      ['env chdir curl', `env -C src curl -q -o .omx/state/curl-owned.log http://127.0.0.1:1/`],
      ['env chdir mutator', `env -C src mkdir -p .omx/state/cwd-owned`],
      ['env long chdir mutator', `env --chdir=src touch .omx/state/env-touch-owned`],
      ['persistent wgetrc config', `export WGETRC=/dev/stdin; printf '%s\n' 'logfile = src/persistent-wgetrc.log' | HOME=/dev/null wget -O - http://127.0.0.1:1/`],
      ['nested posix shell environment', `POSIXLY_CORRECT=1 sh -c 'wget --no-config -o src/nested-posix.log http://127.0.0.1:1/ -o .omx/state/final.log -O -'`],
      ['lastpipe posix', `bash -O lastpipe -c 'f(){ export POSIXLY_CORRECT=1; }; true | f; wget --no-config -o src/lastpipe.log http://127.0.0.1:1/ -o .omx/state/final.log -O -'`],
      ['subshell definition scope', `f(){ export POSIXLY_CORRECT=1; }; ( :; f(){ :; }; ); f; wget --no-config -o src/redefinition-scope.log http://127.0.0.1:1/ -o .omx/state/final.log -O -`],
      ['shadowed env function', `env(){ export POSIXLY_CORRECT=1; }; env; wget --no-config -o src/shadow-env.log http://127.0.0.1:1/ -o .omx/state/final.log -O -`],
      ['command suppressed shadow', `export POSIXLY_CORRECT=1; echo(){ unset POSIXLY_CORRECT; }; command echo safe; wget --no-config -o src/command-shadow.log http://127.0.0.1:1/ -o .omx/state/final.log -O -`],
      ['assignment shaped wget operand', `POSIXLY_CORRECT=1 wget --no-config -o src/assignment-operand.log NAME=value -o .omx/state/final.log -O -`],
      ['wrapped xargs wget', `printf '%s\n' '--output-file=src/wrapped-xargs.log' 'http://127.0.0.1:1/' | env xargs wget --no-config -O -`],
      ['wrapped xargs empty eof mutator', `printf '%s\n' src/wrapped-xargs-owned.ts | env xargs -E '' touch .omx/state/anchor`],
      ['nested chdir shell', `env --chdir=src sh -c 'touch .omx/state/env-nested-owned'`],
      ['case branch posix unset', `case true in true) export POSIXLY_CORRECT=1;; false) unset POSIXLY_CORRECT;; esac; wget --no-config -O src/case-branch-owned.ts http://127.0.0.1:1/ -O -`],
      ['subshell direct posix unset', `export POSIXLY_CORRECT=1; ( unset POSIXLY_CORRECT ); wget --no-config -o src/subshell-unset.log http://127.0.0.1:1/ -o .omx/state/final.log -O -`],
      ['env long chdir wget', `env --chdir=src wget --no-config -o .omx/state/env-long-wget.log -O - http://127.0.0.1:1/`],
      ['env long chdir curl', `env --chdir=src curl -q -o .omx/state/env-long-curl.log http://127.0.0.1:1/`],
      ['posix no config after operand', `POSIXLY_CORRECT=1 wget --spider https://example.test/file --no-config`],
      ['posix no hsts after operand', `HOME=src POSIXLY_CORRECT=1 wget --no-config --spider https://example.test/file --no-hsts`],
      ['bare bash login shell', `bash -lc "printf safe"`],
      ['subshell sequence posix wget', `( export POSIXLY_CORRECT=1; wget --no-config -O src/subshell-sequence-owned.ts http://127.0.0.1:1/ -O - )`],
      ['conditional unbound touch', `if false; then :; touch(){ :; }; fi; touch src/conditional-binding-owned.ts`],
      ['reassigned exported wgetrc', `export WGETRC=/dev/null; WGETRC=/dev/stdin; printf '%s\n' 'logfile = src/reassigned-wgetrc.log' | HOME=/dev/null wget -O - http://127.0.0.1:1/`],
      ['function local wgetrc restoration', `export WGETRC=/dev/stdin; f(){ local -x WGETRC=/dev/null; export POSIXLY_CORRECT=1; }; f; printf '%s\n' 'logfile = src/function-scope-wgetrc.log' | HOME=/dev/null wget -O - http://127.0.0.1:1/`],
      ['short circuit wgetrc', `export WGETRC=/dev/stdin; false && export WGETRC=/dev/null; printf '%s\n' 'logfile = src/short-circuit-wgetrc.log' | HOME=/dev/null wget -O - http://127.0.0.1:1/`],
      ['short circuit function rebind', `f(){ export POSIXLY_CORRECT=1; }; false && f(){ :; }; f; wget --no-config -O src/short-rebind-owned.ts http://127.0.0.1:1/ -O -`],
      ['case arm pipeline touch', `case x in x) : | touch src/case-pipeline-owned.ts;; esac`],
      ['case pipeline function rebind', `g(){ export POSIXLY_CORRECT=1; }; f(){ g(){ :; }; }; case true in true) f | cat;; esac; g; wget --no-config -O src/case-pipeline-rebind-owned.ts http://127.0.0.1:1/ -O -`],
      ['process substitution wgetrc state', `export WGETRC=/dev/stdin; : <(export WGETRC=/dev/null); printf '%s\n' 'logfile = src/process-sub-state.log' | HOME=/dev/null wget -O - http://127.0.0.1:1/`],
      ['background group wgetrc state', `export WGETRC=/dev/stdin; { export WGETRC=/dev/null; } & wait; printf '%s\n' 'logfile = src/background-group.log' | HOME=/dev/null wget -O - http://127.0.0.1:1/`],
      ['readonly wgetrc unset', `export WGETRC=/dev/stdin; readonly WGETRC; unset WGETRC; printf '%s\n' 'logfile = src/readonly-wgetrc.log' | HOME=/dev/null wget -O - http://127.0.0.1:1/`],
      ['unset function mode wgetrc', `export WGETRC=/dev/stdin; unset -f WGETRC; printf '%s\n' 'logfile = src/unset-mode-wgetrc.log' | HOME=/dev/null wget -O - http://127.0.0.1:1/`],
      ['quoted empty wget operand', `env -u POSIXLY_CORRECT wget --no-config -O - '' -o src/quoted-empty.log http://127.0.0.1:1/`],
      ['assignment shaped mutator argv', `env -C src touch ../.omx/state/final.log OWNED=value`],
      ['comment function binding', `true # ; touch(){ :; }\ntouch src/comment-binding-owned.ts`],
      ['skipped if wgetrc', `export WGETRC=/dev/stdin; if false; then export WGETRC=/dev/null; fi; printf '%s\n' 'logfile = src/skipped-if-wgetrc.log' | HOME=/dev/null wget -O - http://127.0.0.1:1/`],
      ['mutually exclusive case home', `export HOME=/dev/stdin; case true in true) export HOME=/dev/null;; false) :;; esac; wget -O - http://127.0.0.1:1/`],
      ['synchronous brace posix', `f(){ export POSIXLY_CORRECT=1; }; { f; }; WGETRC=/dev/null wget -O src/synchronous-brace-owned.ts https://example.test/file -O -`],
      ['nested isolation parent state', `( export POSIXLY_CORRECT=1; ( wget --no-config -O src/nested-region-owned.ts http://127.0.0.1:1/ -O - ) )`],
      ['function alternative state join', `f(){ export WGETRC=/dev/stdin; }; if false; then f(){ export WGETRC=/dev/null; }; fi; f; printf '%s\n' 'logfile = src/function-alt-join.log' | HOME=/dev/null wget -O - http://127.0.0.1:1/`],
      ['function binding alternative join', `g(){ :; }; f(){ g(){ export POSIXLY_CORRECT=1; }; }; if false; then f(){ :; }; fi; f; g; wget --no-config -O src/function-binding-join-owned.ts http://127.0.0.1:1/ -O -`],
      ['conditional wrapper unbound', `if false; then :; env(){ :; }; fi; env touch src/conditional-env-owned.ts`],
      ['shadowed false status', `false(){ :; }; false && export POSIXLY_CORRECT=1; wget --no-config -O src/shadow-false-owned.ts http://127.0.0.1:1/ -O -`],
      ['path conditional readonly', `export WGETRC=/dev/null; if false; then readonly WGETRC; fi; WGETRC=/dev/stdin; printf '%s\n' 'logfile = src/maybe-readonly-wgetrc.log' | HOME=/dev/null wget -O - http://127.0.0.1:1/`],
      ['readonly function mode', `export WGETRC=/dev/null; readonly -f WGETRC; WGETRC=/dev/stdin; printf '%s\n' 'logfile = src/readonly-function-mode.log' | HOME=/dev/null wget -O - http://127.0.0.1:1/`],
      ['local inherit wgetrc', `export WGETRC=/dev/stdin; f(){ local -I WGETRC; printf '%s\n' 'logfile = src/local-inherit-wgetrc.log' | HOME=/dev/null wget -O - http://127.0.0.1/; }; f`],
      ['case fallthrough touch', `case x in x) : ;& true) touch src/case-fallthrough-owned.ts;; esac`],
      ['case reserved word touch', `case case in case) touch src/case-reserved-word-owned.ts;; esac`],
      ['parameter length comment touch', `: \${#x}; touch src/parameter-length-comment-owned.ts`],
      ['touch mode arity', `touch .omx/state/final.log -m src/touch-option-owned.ts`],
      ['nested export posix', `export POSIXLY_CORRECT=1; sh -c 'wget --no-config -O src/nested-export-owned.ts http://127.0.0.1:1/ -O -'`],
      ['process substitution inherited posix', `export POSIXLY_CORRECT=1; cat <(wget --no-config -O src/process-inherited-owned.ts http://127.0.0.1:1/ -O -)`],
      ['bashopts lastpipe', `env BASHOPTS=lastpipe bash -c 'f(){ export POSIXLY_CORRECT=1; }; true | f; wget --no-config -O src/bashopts-lastpipe-owned.ts http://127.0.0.1:1/ -O -'`],
      ['skipped function call state', `export WGETRC=/dev/stdin; f(){ export WGETRC=/dev/null; }; if false; then f; fi; printf '%s\n' 'logfile = src/skipped-function.log' | HOME=/dev/null wget -O - http://127.0.0.1:1/`],
      ['nested isolation wgetrc', `export WGETRC=/dev/null; ( export WGETRC=/dev/stdin; ( printf '%s\n' 'logfile = src/nested-isolation.log' | HOME=/dev/null wget -O - http://127.0.0.1:1/ ) )`],
      ['declare function local', `export WGETRC=/dev/stdin; f(){ declare -x WGETRC=/dev/null; }; f; printf '%s\n' 'logfile = src/declare-local.log' | HOME=/dev/null wget -O - http://127.0.0.1:1/`],
      ['readonly branch join', `export WGETRC=/dev/null; if true; then :; else readonly WGETRC; fi; WGETRC=/dev/stdin; printf '%s\n' 'logfile = src/readonly-join.log' | HOME=/dev/null wget -O - http://127.0.0.1:1/`],
      ['nested background isolation parent state', `( export POSIXLY_CORRECT=1; ( wget --no-config -O src/nested-background-owned.ts http://127.0.0.1:1/ -O - ) ) & wait`],
      ['case retest fallthrough touch', `case x in x) : ;;& x) touch src/case-retest-owned.ts;; esac`],
      ['recursive nested cwd root', `env --chdir=src sh -c "sh -c 'mkdir -p .omx/state/nested-cwd-owned'"`],
      ['process substitution lexical cwd', `cd src; cat <(mkdir -p .omx/state/process-cwd-owned)`],
      ['nameref posix wget', `f(){ declare -n ref=POSIXLY_CORRECT; export ref=1; }; f; wget --no-config -O src/nameref-posix-owned.ts https://example.test/file -O -`],
      ['global nameref posix wget', `f(){ declare -gn ref=POSIXLY_CORRECT; }; f; export ref=1; wget --no-config -O src/global-nameref-posix-owned.ts https://example.test/file -O -`],
      ['arithmetic expansion posix wget', `export POSIXLY_CORRECT; : $((POSIXLY_CORRECT=1)); wget --no-config https://example.test/file -O src/arithmetic-posix-owned.ts`],
      ['curl header sink', `curl -q --dump-header src/curl-header-owned.txt https://example.test/file`],
      ['rsync remote sink', `rsync .omx/state/conductor-ledger.json example.test:state/`],
      ['rsync remote log sink', `rsync --log-file=.omx/state/rsync.log .omx/state/conductor-ledger.json example.test:state/`],
      ['function cwd state', `f(){ cd src; }; f; mkdir -p .omx/state/function-cwd-owned`],
      ['function caller local state', `export WGETRC=/dev/null; g(){ WGETRC=/dev/stdin; }; f(){ local -x WGETRC=/dev/null; g; printf '%s\n' 'logfile = src/function-caller-local-owned.log' | HOME=/dev/null wget -O - http://127.0.0.1:1/; }; f`],
      ['process substitution before inline unset', `export POSIXLY_CORRECT=1; unset POSIXLY_CORRECT <(wget --no-config -O src/process-inline-unset-owned.ts http://127.0.0.1:1/ -O -)`],
      ['process substitution before function', `export POSIXLY_CORRECT=1; f(){ unset POSIXLY_CORRECT; }; f <(wget --no-config -O src/process-before-function-owned.ts http://127.0.0.1:1/ -O -)`],
      ['nested process substitution touch', `cat <(cat <(touch src/nested-process-owned.ts))`],
      ['conditional job control lastpipe', `export POSIXLY_CORRECT=1; shopt -s lastpipe; if true; then set -m; fi; f(){ unset POSIXLY_CORRECT; }; true | f; wget --no-config -O src/jobcontrol-owned.ts http://127.0.0.1:1/ -O -`],
      ['unsupported shopt option', `shopt -s extglob; touch .omx/state/final.log`],
      ['dynamic shopt lastpipe', `mode=lastpipe; shopt -s "$mode"; touch .omx/state/final.log`],
      ['loop function definition', `while false; do touch(){ :; }; done; touch src/loop-definition-owned.ts`],
      ['background function definition', `{ touch(){ :; }; } & wait; touch src/background-definition-owned.ts`],
      ['pipeline function definition', `{ touch(){ :; }; } | cat; touch src/pipeline-definition-owned.ts`],
      ['coproc function definition', `coproc { touch(){ :; }; }; wait; touch src/coproc-definition-owned.ts`],
      ['coproc external touch mutation', `coproc touch src/coproc-external-owned.ts; wait`],
      ['coproc function runtime does not leak', `coproc { local_read(){ :; }; local_read; }; wait; local_read`],
      ['subshell function definition', `( touch(){ :; }; ); touch src/subshell-definition-owned.ts`],
      ['conditional readonly function', `f(){ :; }; if false; then readonly -f f; fi; f(){ export POSIXLY_CORRECT=1; }; f; wget --no-config -O src/conditional-readonly-function-owned.ts http://127.0.0.1:1/ -O -`],
      ['readonly unbound function', `readonly -f touch; touch src/readonly-unbound-owned.ts`],
      ['unexported child function', `touch(){ :; }; bash -c 'touch src/unexported-child-function-owned.ts'`],
      ['export nf removes child function', `f(){ :; }; export -f f; export -nf f; bash -c 'f; wget --no-config -O - https://example.test/file'`],
      ['exported child function uninspected body', `f(){ source src/exported-child-uninspected.sh; }; export -f f; bash -c 'f'`],
      ['env child unset', `export POSIXLY_CORRECT=1; env unset POSIXLY_CORRECT; wget --no-config -O src/env-child-unset-owned.ts http://127.0.0.1:1/ -O -`],
      ['global attribute under local', `WGETRC=/dev/stdin; f(){ local WGETRC=/dev/null; declare -gx WGETRC; }; f; printf '%s\n' 'logfile = src/global-attribute-owned.log' | HOME=/dev/null wget -O - http://127.0.0.1:1/`],
      ['nameref unset referent', `export HOME=src; export WGETRC=/dev/null; declare -n ref=WGETRC; unset ref; wget -O - http://127.0.0.1:1/`],
      ['arithmetic compound posix', `unset POSIXLY_CORRECT; export POSIXLY_CORRECT; : x$((POSIXLY_CORRECT+=1)); wget --no-config -O src/arithmetic-compound-owned.ts http://127.0.0.1:1/ -O -`],
      ['parameter nameref posix', `unset POSIXLY_CORRECT; export POSIXLY_CORRECT; declare -n ref=POSIXLY_CORRECT; : x\${ref:=1}; wget --no-config -O src/parameter-nameref-owned.ts https://example.test/file -O -`],
      ['case escaped esac', `case x in \\esac|x) touch src/case-escaped-esac-owned.ts;; esac`],
      ['reserved filename touch', `touch .omx/state/final.log case`],
      ['reserved filename copy', `cp .omx/state/conductor-ledger.json case`],
      ['chmod reference product', `chmod --reference=.omx/state/session.json src/chmod-reference-owned.ts .omx/state/session.json`],
      ['chown reference product', `chown --reference=.omx/state/session.json src/chown-reference-owned.ts .omx/state/session.json`],
      ['chgrp reference product', `chgrp --reference=.omx/state/session.json src/chgrp-reference-owned.ts .omx/state/session.json`],
      ['chmod reference separated product', `chmod --reference .omx/state/session.json src/chmod-reference-separated-owned.ts`],
      ['chown reference separated product', `chown --reference .omx/state/session.json src/chown-reference-separated-owned.ts`],
      ['chgrp reference separated product', `chgrp --reference .omx/state/session.json src/chgrp-reference-separated-owned.ts`],
      ['curl cluster header sink', `curl -q -sD src/curl-cluster-owned.txt -o - http://127.0.0.1:1/`],
      ['curl config sink', `curl -q -K src/curl-config-owned.txt http://127.0.0.1:1/`],
      ['rsync log sink', `rsync --log-file=src/rsync-owned.log .omx/state/conductor-ledger.json .omx/state/rsync-copy`],
      ['rsync partial sink', `rsync --partial-dir=src/rsync-partial .omx/state/conductor-ledger.json .omx/state/rsync-copy`],
      ['rsync write batch sink', `rsync --write-batch=src/rsync-owned.batch .omx/state/conductor-ledger.json .omx/state/rsync-copy`],
      ['failed cd rsync metadata control', `cd .omx/missing; rsync --log-file=.omx/state/failed-cd-rsync.log .omx/state/conductor-ledger.json .omx/state/failed-cd-rsync-copy`],
      ['failed pushd rsync metadata control', `pushd .omx/missing; rsync --log-file=.omx/state/failed-pushd-rsync.log .omx/state/conductor-ledger.json .omx/state/failed-pushd-rsync-copy`],
      ['cleared exported child function', `touch(){ :; }; export -f touch; env -u BASH_FUNC_touch%% bash -c 'touch src/cleared-exported-child-owned.ts'`],
      ['cdpath relative cwd', `CDPATH=src; cd team; mkdir -p ../.omx/state/cdpath-owned`],
      ['cdpath absolute cwd product', `CDPATH=src; cd /tmp; touch src/cdpath-absolute-owned.ts`],
      ['cdpath balanced stack product', `CDPATH=src; pushd ./src; popd; touch src/cdpath-balanced-stack-owned.ts`],
      ['unbalanced popd product', `popd; touch src/unbalanced-popd-owned.ts`],
      ['reference without target', `chmod --reference=.omx/state/session.json`],
      ['chown reference without target', `chown --reference=.omx/state/session.json`],
      ['chgrp reference without target', `chgrp --reference=.omx/state/session.json`],
      ['chmod reference separated without target', `chmod --reference .omx/state/session.json`],
      ['chown reference separated without target', `chown --reference .omx/state/session.json`],
      ['chgrp reference separated without target', `chgrp --reference .omx/state/session.json`],
      ['exported bashopts lastpipe', `shopt -s lastpipe; export BASHOPTS; bash -c 'f(){ export POSIXLY_CORRECT=1; }; true | f; wget --no-config -O src/exported-bashopts-owned.ts http://127.0.0.1:1/ -O -'`],
      ['depth process substitution prefix', `f4(){ export POSIXLY_CORRECT=1; cat <(true); cat <(wget --no-config -O src/depth-prefix-owned.ts http://127.0.0.1:1/ -O -); }; f3(){ f4; }; f2(){ f3; }; f1(){ f2; }; f1`],


      ['wget stdout short directory prefix', `wget -O - -P src https://example.test/file`],
      ['wget stdout long directory prefix', `wget --output-document=- --directory-prefix=src https://example.test/file`],
      ['wget stdout short log target', `wget -O - -o src/wget-stdout.log https://example.test/file`],
      ['wget stdout long log target', `wget --output-document=- --output-file=src/wget-stdout.log https://example.test/file`],
      ['wget repeated output last file', `wget -O - https://example.test/file -O src/wget-last-output.ts`],
      ['wget repeated log last file', `wget -o .omx/state/ignored.log -o src/wget-final.log -O - https://example.test/file`],
      ['wget repeated directory last file', `wget -P .omx/state -P src https://example.test/file`],
      ['wget repeated long directory last file', `wget --directory-prefix=.omx/state --directory-prefix=src https://example.test/file`],




      ['wget short execute output sink', `wget --no-config -e 'output_document=src/wget-execute-owned.ts' https://example.test/file`],
      ['wget long execute log sink', `wget --no-config --execute='logfile=src/wget-execute.log' -O - https://example.test/file`],
      ['wget execute directory prefix sink', `wget --no-config --execute='dir_prefix=src/wget-execute-directory' https://example.test/file`],
      ['wget execute unknown directive', `wget --no-config --execute='future_directive=src/wget-unknown.ts' -O - https://example.test/file`],
      ['stdbuf i retains environment', `export POSIXLY_CORRECT=1; stdbuf -i 0 sh -c 'wget --no-config -O src/stdbuf-posix-owned.ts https://example.test/file -O -'`],
      ['env i reapplies prefix environment', `export POSIXLY_CORRECT=1; env -i POSIXLY_CORRECT=1 sh -c 'wget --no-config -O src/env-i-posix-owned.ts https://example.test/file -O -'`],
      ['curl startup config unresolved', `curl https://example.test/file`],
      ['curl write out output sink', `curl -q --write-out '%output{src/curl-write-out-owned.log}' https://example.test/file`],
      ['curl short write out output sink', `curl -q -w '%output{src/curl-short-write-out-owned.log}' https://example.test/file`],
      ['curl write out append sink', `curl -q --write-out '%output{>>src/curl-write-out-append.log}' https://example.test/file`],
      ['time short output sink', `time -o src/time-output-owned.log printf safe`],
      ['time long output sink', `time --output=src/time-long-output-owned.log printf safe`],
      ['command substitution later cwd', `cd src; printf '%s' "$(mkdir -p .omx/state/command-substitution-cwd-owned)"; cd ..`],
      ['backtick substitution later cwd', "cd src; printf '%s' \`mkdir -p .omx/state/backtick-substitution-cwd-owned\`; cd .."],
      ['command substitution later posix unset', `export POSIXLY_CORRECT=1; printf '%s' "$(wget --no-config -O src/command-substitution-posix-owned.ts http://127.0.0.1:1/ -O -)"; unset POSIXLY_CORRECT`],
      ['command substitution later function unset', `export POSIXLY_CORRECT=1; printf '%s' "$(wget --no-config -O src/command-substitution-function-owned.ts http://127.0.0.1:1/ -O -)"; f(){ unset POSIXLY_CORRECT; }; f`],
      ['grouped command substitution cwd', `( cd src; printf '%s' "$(mkdir -p .omx/state/group-command-substitution-owned)" )`],
      ['grouped process substitution cwd', `( cd src; cat <(mkdir -p .omx/state/group-process-substitution-owned) )`],
      ['printf v cdpath writer', `printf -v CDPATH '%s' src; cd shared; mkdir -p .omx/state/printf-v-cdpath-owned`],
      ['read posix writer', `export POSIXLY_CORRECT; read POSIXLY_CORRECT <<< 1; wget --no-config -O src/read-posix-writer-owned.ts http://127.0.0.1:1/ -O -`],
      ['printf v wgetrc writer', `printf -v WGETRC '%s' src/wgetrc; export WGETRC; wget -O - https://example.test/file`],
      ['getopts wgetrc writer', `export WGETRC; getopts a WGETRC; wget -O - https://example.test/file`],
      ['for cdpath writer', `for CDPATH in src; do :; done; cd shared; mkdir -p .omx/state/for-cdpath-owned`],
      ['select cdpath writer', `select CDPATH in src; do break; done; cd shared; mkdir -p .omx/state/select-cdpath-owned`],
      ['curl dynamic output', `OUT=src/curl-dynamic-output.log; curl -q -o "$OUT" https://example.test/file`],
      ['curl dynamic write out', `FMT='%output{src/curl-dynamic-write-out.log}'; curl -q -w "$FMT" https://example.test/file`],
      ['curl write out at file', `curl -q --write-out @.omx/state/curl-format https://example.test/file`],
      ['curl dynamic argv injection', `CURL_OPTIONS='--upload-file=.omx/state/conductor-ledger.json'; curl -q $CURL_OPTIONS https://example.test/file`],
      ['wget dynamic argv injection', `WGET_OPTIONS='--post-data=mode=write'; wget --no-config $WGET_OPTIONS -O - https://example.test/file`],
      ['curl post data', `curl -q --data 'mode=write' https://example.test/file`],
      ['curl request post', `curl -q --request POST https://example.test/file`],
      ['curl upload file', `curl -q --upload-file .omx/state/conductor-ledger.json https://example.test/file`],
      ['wget post data', `wget --no-config --post-data='mode=write' -O - https://example.test/file`],
      ['wget method post', `wget --no-config --method=POST -O - https://example.test/file`],
      ['wget background', `wget --no-config --background -O - https://example.test/file`],
      ['rsync dynamic option', `OPTS='--log-file=src/rsync-dynamic.log'; rsync $OPTS .omx/state/conductor-ledger.json .omx/state/rsync-copy`],
      ['rsync short cluster temp dir', `rsync -aTsrc/rsync-cluster-temp .omx/state/conductor-ledger.json .omx/state/rsync-copy`],
      ['rsync short cluster temp dir next argv', `rsync -aT src/rsync-cluster-temp .omx/state/conductor-ledger.json .omx/state/rsync-copy`],
      ['rsync short cluster unknown', `rsync -aZ .omx/state/conductor-ledger.json .omx/state/rsync-copy`],
      ['time abbreviated output sink', `time --out=src/time-abbreviated-output.log printf safe`],
      ['time exact separate output sink', `time --output src/time-exact-separate-output.log printf safe`],
      ['time separate abbreviated output sink', `time --out src/time-separate-output.log printf safe`],
      ['time attached output sink', `time -osrc/time-attached-output.log printf safe`],
      ['time wrapper attached output sink', `env time -osrc/time-wrapper-attached-output.log printf safe`],
      ['time append attached output sink', `time -aosrc/time-append-attached-output.log printf safe`],
      ['time dynamic output sink', `OUT=src/time-dynamic-output.log; time -o "$OUT" printf safe`],
      ['time malformed output sink', `time --output= printf safe`],
      ['path repository shadow', `cp -p /usr/bin/touch .omx/state/cat; PATH=.omx/state; cat src/conductor-owned.ts`],
      ['path prefix repository shadow', `cp -p /usr/bin/touch .omx/state/cat; PATH=.omx/state cat src/conductor-owned.ts`],
      ['path env repository shadow', `cp -p /usr/bin/touch .omx/state/cat; env PATH=.omx/state cat src/conductor-owned.ts`],
      ['cdpath global dirty function', `CDPATH=.omx; f(){ local CDPATH=.omx; declare -g CDPATH=src; }; f; cd shared; mkdir -p .omx/state/cdpath-global-dirty-owned`],
      ['cp hardlink then reference', `cp -l .omx/state/conductor-ledger.json .omx/state/linked-ledger; chmod --reference=.omx/state/conductor-ledger.json .omx/state/linked-ledger`],
      ['curl method override header', `curl -q -H 'X-HTTP-Method-Override: POST' -o .omx/state/curl-method-override.log https://example.test/file`],
      ['curl next transfer product output', `curl -q --output-dir src -o first.log https://example.test/first --next --output-dir .omx/state -o second.log https://example.test/second`],
      ['wget warc cdx standalone sink', `wget --no-config --warc-cdx .omx/state/wget-cdx.log https://example.test/file`],
      ['wget no proxy standalone sink', `wget --no-config --no-proxy .omx/state/wget-proxy.log https://example.test/file`],
      ['wget short x standalone sink', `wget --no-config -x .omx/state/wget-x.log https://example.test/file`],
      ['rsync rsync-path helper execution', `rsync --rsync-path=.omx/state/helper .omx/state/conductor-ledger.json .omx/state/rsync-copy`],
      ['rmdir invalidates static cwd proof', `rmdir .omx/state/tmp; cd .omx/state/tmp; touch .omx/state/final.log`],
      ['posix special builtin prefix persistence', `set -o posix; POSIXLY_CORRECT=1 export POSIXLY_CORRECT; wget --no-config -O src/posix-special-owned.ts https://example.test/file -O -`],
      ['wget late no config', `wget -q --no-config -O - https://example.test/file`],
      ['curl output template traversal', `curl -q -o .omx/state/curl-#1.log https://example.test/file[..]`],
      ['native child dead reference marker', `f(){ chmod --reference=.omx/state/session.json .omx/state/dead-reference.log; }; touch src/live-after-dead-marker.log`],
      ['reference looking post end of options', `chmod 600 -- --reference=.omx/state/session.json`],
      ['curl quote request control', `curl -q --quote 'DELE state' https://example.test/file`],
      ['curl short quote request control', `curl -q -Q 'DELE state' https://example.test/file`],
      ['curl postquote request control', `curl -q --postquote 'DELE state' https://example.test/file`],
      ['curl dynamic prequote request control', `OP='NOOP'; curl -q --prequote "$OP" https://example.test/file`],
      ['curl unknown request control', `curl -q --request-target=/state https://example.test/file`],
      ['wget header method override', `wget --no-config --header='X-HTTP-Method-Override: POST' -O - https://example.test/file`],
      ['wget dynamic header method override', `HEADER='X-HTTP-Method-Override: POST'; wget --no-config --header="$HEADER" -O - https://example.test/file`],
      ['curl brace template traversal', `curl -q -o .omx/state/curl-#1.log 'https://example.test/{safe,../escape}'`],
      ['rsync archive then reference', `rsync -a --log-file=.omx/state/rsync-alias.log .omx/state/conductor-ledger.json .omx/state/rsync-alias-copy; chmod --reference=.omx/state/session.json .omx/state/rsync-alias-copy`],
      ['cp archive then reference', `cp -a .omx/state/conductor-ledger.json .omx/state/archive-ledger; chmod --reference=.omx/state/session.json .omx/state/archive-ledger`],
      ['nested rmdir invalidates cwd proof', `rmdir .omx/state/tmp; sh -c 'cd .omx/state/tmp; touch .omx/state/final.log'`],
      ['nested chmod invalidates cwd proof', `chmod --reference=.omx/state/session.json .omx/state/tmp; sh -c 'cd .omx/state/tmp; touch .omx/state/final.log'`],
      ['relative slash command', `./src/conductor-owned.ts`],
      ['unresolved arithmetic expansion', `touch .omx/state/unresolved-arithmetic.log $((UNFINISHED)`],
      ['elif mutation reachability', `if false; then :; elif true; then touch src/elif-reachable-owned.ts; fi`],
      ['dynamic loader preload wrapper', `LD_PRELOAD=.omx/state/mutator.so cat src/conductor-owned.ts`],
      ['dynamic loader audit env wrapper', `env LD_AUDIT=.omx/state/audit.so cat src/conductor-owned.ts`],
      ['curl clustered form mutation', `curl -q -sF field=value https://example.test/file`],
      ['curl clustered quote mutation', `curl -q -sQ 'DELE state' https://example.test/file`],
      ['curl proxy header method override', `curl -q --proxy-header 'X-HTTP-Method-Override: POST' https://example.test/file`],
      ['rsync product destination', `rsync README.md src/readme.md`],
      ['recursive arithmetic substitution', `arith='slot[$(touch src/arithmetic-owned.ts)0]'; : $((arith))`],
      ['arithmetic array subscript', `slot=1; : $((slot[$(touch src/arithmetic-array-owned.ts)0]))`],
      ['numeric binding arithmetic', `N=1; : $((N << 2))`],
      ['conditional numeric binding arithmetic', `arith='slot[$(touch src/arithmetic-conditional-owned.ts)0]'; if false; then arith=1; fi; : $((arith))`],
      ['printf v numeric binding arithmetic', `N=1; printf -v N '%s' 'slot[$(touch src/arithmetic-printf-owned.ts)0]'; : $((N))`],
      ['loader conditional clear', `declare -n loader=LD_PRELOAD; export loader; loader=.omx/state/mutator.so; false && unset loader; /usr/bin/cat /dev/null`],
      ['loader function clear', `declare -n loader=LD_PRELOAD; export loader; loader=.omx/state/mutator.so; clear_loader(){ unset loader; }; false && clear_loader; /usr/bin/cat /dev/null`],
      ['node persistent v8 coverage output', `export NODE_V8_COVERAGE=src; node -e "console.log('ok')"`],
      ['node function compile cache output', `configure_node(){ export NODE_COMPILE_CACHE=src; }; configure_node; node -e "console.log('ok')"`],
      ['cp parents path shaping', `cp --parents src/runtime.ts .omx/state`],
      ['cp hardlink cross boundary', `cp --link src/runtime.ts .omx/state/runtime-link.ts`],
      ['curl template unbounded capture', `curl -q -o .omx/state/curl-glob-#1.log https://example.test/file[1-999]`],
      ['gh dynamic web helper', `OPT=--web; GH_BROWSER=.omx/state/mutator PATH=/usr/bin:/bin gh issue create --title x --body y $OPT`],
      ['gh command prefix pager helper', `GH_PAGER=cat PATH=/usr/bin:/bin gh issue create --title x --body y`],
      ['loader nameref preload', `declare -n loader=LD_PRELOAD; export loader; loader=.omx/state/mutator.so; cat src/conductor-owned.ts`],
      ['loader debug output', `LD_DEBUG=libs LD_DEBUG_OUTPUT=src/ld-debug cat src/conductor-owned.ts`],
      ['loader profile output', `LD_PROFILE=cat LD_PROFILE_OUTPUT=src/ld-profile cat src/conductor-owned.ts`],
      ['node cpu profile output', `node --cpu-prof --cpu-prof-dir=src -e "console.log('ok')"`],
      ['node v8 coverage output', `NODE_V8_COVERAGE=src node -e "console.log('ok')"`],
      ['node compile cache output', `NODE_COMPILE_CACHE=src node -e "console.log('ok')"`],
      ['curl expand data request', `curl -q --expand-data 'mode=write' https://example.test/state`],
      ['curl expand output sink', `curl -q --variable OUT=src/curl-expand-owned.txt --expand-output '{{OUT}}' file:///etc/hosts`],
      ['curl unknown long option', `curl -q --future-option https://example.test/file`],
      ['gh repo create interactive', `PATH=/usr/bin:/bin gh repo create`],
      ['gh repo fork local remote', `PATH=/usr/bin:/bin gh repo fork OWNER/REPO`],
      ['curl header file source', `curl -q --header @.omx/state/headers -o .omx/state/header.log https://example.test/file`],
      ['wget warc tempdir sink', `wget --no-config --warc-tempdir=src -O - https://example.test/file`],
      ['install strip program execution', `install --strip-program=.omx/state/mutator package.json .omx/state/install-copy`],
      ['python unsafe x option', `python3 -I -X importtime -c "print('ok')"`],
      ['perl debugger option', `perl -d -e 'print'`],
      ['rg config file', `rg --config .omx/state/rg-config pattern`],
      ['git trace output', `GIT_TRACE=src/git-trace git diff`],
      ['python pycache prefix', `PYTHONPYCACHEPREFIX=src python3 -I -c "print('ok')"`],
      ['allexport node output', `set -a; NODE_V8_COVERAGE=src; node -e "console.log('ok')"`],
      ['loader command wrapper', `command env LD_PRELOAD=.omx/state/mutator.so cat src/conductor-owned.ts`],
      ['loader before env clear', `LD_PRELOAD=.omx/state/mutator.so /usr/bin/env -i /usr/bin/cat src/conductor-owned.ts`],
      ['loader in background pipeline', `LD_PRELOAD=.omx/state/mutator.so /usr/bin/cat src/conductor-owned.ts | cat &`],
      ['loader in later pipeline member', `printf x | LD_DEBUG=libs LD_DEBUG_OUTPUT=src/pipe-loader /usr/bin/cat /dev/null`],
      ['dynamic set option', `PS4='$(touch src/dynamic-set-owned.ts)'; OPTION=-x; set $OPTION; :`],
      ['prompt parameter transform', `PS4='$(touch src/prompt-transform-owned.ts)'; : \${PS4@P}`],
      ['dynamic declaration attribute', `ATTRIBUTE=i; declare -$ATTRIBUTE 'slot[$(touch src/dynamic-declare-owned.ts)0]=1'`],
      ['perl regex assertion in place', `perl -pi -e 's/(?!safe)/x/' .omx/state/conductor-ledger.json`],
      ['uniq second output operand', `uniq src/conductor-owned.ts src/uniq-owned.ts`],
      ['rg hostname helper', `rg --hostname-bin=.omx/state/inbox/helper needle src`],
      ['escaped time path shadow', `PATH=.omx/state/inbox:/usr/bin:/bin \\time printf safe`],
      ['quoted time path shadow', `PATH=.omx/state/inbox:/usr/bin:/bin 'time' printf safe`],
      ['ansi-c time path shadow', `PATH=.omx/state/inbox:/usr/bin:/bin $'time' printf safe`],
      ['concatenated time path shadow', `PATH=.omx/state/inbox:/usr/bin:/bin "ti"me printf safe`],
      ['coproc path shadow', `PATH=.omx/state/inbox:/usr/bin:/bin 'coproc' printf safe`],
      ['env chdir product mutation', `env --chdir=src touch ../.omx/state/final.log`],
      ['rsync permissions alias', `rsync -p .omx/state/conductor-ledger.json .omx/state/rsync-copy`],
      ['reference directory target', `chmod --reference=.omx/state/session.json .omx/state`],
      ['reference glob target', `chmod --reference=.omx/state/session.json .omx/state/*`],
      ['wget startup options after end', `WGETRC=/dev/stdin wget -O - http://127.0.0.1:1/ -- --no-config --no-hsts`],
      ['wget recursive metadata transfer', `wget --no-config --no-hsts --recursive --page-requisites --directory-prefix=.omx/state https://example.test/index.html`],
      ['wget SSL key log output', `SSLKEYLOGFILE=src/wget-tls.keys wget --no-config --no-hsts -O - https://example.test/file`],
      ['curl SSL key log output', `SSLKEYLOGFILE=src/curl-tls.keys curl -q -o - https://example.test/file`],
      ['curl SSL key log persistent output', `export SSLKEYLOGFILE=src/curl-tls.keys; curl -q -o - https://example.test/file`],
      ['wget SSL key log persistent output', `export SSLKEYLOGFILE=src/wget-tls.keys; wget --no-config --no-hsts -O - https://example.test/file`],
      ['curl SSL key log dynamic output', `SSLKEYLOGFILE="$TLS_KEY_LOG" curl -q -o - https://example.test/file`],
      ['rsync partial environment output', `RSYNC_PARTIAL_DIR=src/rsync-partials rsync .omx/state/conductor-ledger.json .omx/state/inbox/rsync-copy`],
      ['rsync exported runtime output', `export RSYNC_PARTIAL_DIR=src/rsync-partials; rsync .omx/state/conductor-ledger.json .omx/state/inbox/rsync-copy`],
      ['shellopts allexport posix ordering', `env SHELLOPTS=allexport bash -c 'POSIXLY_CORRECT=1; wget --no-config --no-hsts -O src/shellopts-owned.ts https://example.test/file -O -'`],
      ['bash posix PATH persistence', `bash -o posix -c 'PATH=.omx/state export PATH; cat src/conductor-owned.ts'`],
      ['bash long posix PATH persistence', `bash --posix -c 'PATH=.omx/state export PATH; cat src/conductor-owned.ts'`],
      ['bashopts allexport posix ordering', `env BASHOPTS=allexport bash -c 'POSIXLY_CORRECT=1; wget --no-config --no-hsts -O src/bashopts-owned.ts https://example.test/file -O -'`],
      ['unresolved PATH command not found', `command_not_found_handle(){ /usr/bin/touch src/path-owned.ts; }; PATH=/definitely/not-present; cat README.md`],
      ['curl command protocol local listener', `printf 'set state\n' | curl -q -m 1 telnet://127.0.0.1:9`],
      ['curl command protocol gopher', `curl -q -m 1 gopher://127.0.0.1:9/1/state`],
      ['curl command protocol smtp', `curl -q -m 1 smtp://127.0.0.1:9`],
      ['curl command protocol unknown', `curl -q -m 1 mutator://127.0.0.1/state`],
      ['curl remote header name cluster', `curl -q -OJ https://example.test/payload`],
      ['curl remote header name long', `curl -q --remote-header-name -O https://example.test/payload`],
      ['wget execute recursive directive', `wget --no-config --no-hsts -e 'recursive=on' -O - https://example.test/file`],
      ['mixed scheme wget directory prefix', `wget --no-config --no-hsts --directory-prefix=.omx/state https://example.test/file file:///etc/hosts`],
      ['mixed scheme curl remote name', `curl -q --output-dir=.omx/state -O https://example.test/file file:///etc/hosts`],
      ['unsupported bashopts localvar inherit', `CDPATH=src env BASHOPTS=localvar_inherit bash --noprofile --norc -c 'f(){ local CDPATH; cd state; touch ../.omx/state/owned; }; f'`],
      ['curl schemeless extra operand remote name', `curl -q --output-dir=.omx/state/inbox -O https://example.test/payload ftp.example.test/payload`],
      ['wget schemeless extra operand directory prefix', `wget --no-config --no-hsts --directory-prefix=.omx/state/inbox https://example.test/payload ftp.example.test/payload`],
      ['curl multiple static URLs remote name', `curl -q --output-dir=.omx/state/inbox -O https://example.test/first https://example.test/second`],
      ['wget multiple static URLs directory prefix', `wget --no-config --no-hsts --directory-prefix=.omx/state/inbox https://example.test/first https://example.test/second`],
      ['wget short input file decoy URL', `wget --no-config --no-hsts -i urls.txt -O - https://example.test/file`],
      ['wget attached input file decoy URL', `wget --no-config --no-hsts -iurls.txt -O - https://example.test/file`],
      ['wget clustered input file decoy URL', `wget --no-config --no-hsts -qiurls.txt -O - https://example.test/file`],
      ['wget long input file decoy URL', `wget --no-config --no-hsts --input-file=urls.txt -O - https://example.test/file`],
      ['wget execute tries zero', `wget --no-config --no-hsts -e 'tries=0' -O - https://example.test/file`],
      ['wget execute timeout zero', `wget --no-config --no-hsts -e 'timeout=0' -O - https://example.test/file`],
      ['wget direct tries zero', `wget --no-config --no-hsts --tries=0 -O - https://example.test/file`],
      ['wget short tries zero', `wget --no-config --no-hsts -t0 -O - https://example.test/file`],
      ['wget direct timeout zero', `wget --no-config --no-hsts --timeout=0 -O - https://example.test/file`],
      ['wget direct wait excessive', `wget --no-config --no-hsts --wait=61 -O - https://example.test/file`],
      ['wget execute waitretry infinite', `wget --no-config --no-hsts -e 'waitretry=infinite' -O - https://example.test/file`],
      ['wget short timeout zero', `wget --no-config --no-hsts -T0 -O - https://example.test/file`],
      ['wget short wait zero', `wget --no-config --no-hsts -w0 -O - https://example.test/file`],
      ['wget direct waitretry zero', `wget --no-config --no-hsts --waitretry=0 -O - https://example.test/file`],
      ['wget malformed wait', `wget --no-config --no-hsts --wait=one -O - https://example.test/file`],
      ['wget dynamic timeout', `wget --no-config --no-hsts --timeout="$WGET_TIMEOUT" -O - https://example.test/file`],
      ['wget connect timeout zero', `wget --no-config --no-hsts --connect-timeout=0 -O - https://example.test/file`],
      ['wget DNS timeout excessive', `wget --no-config --no-hsts --dns-timeout=61 -O - https://example.test/file`],
      ['wget read timeout dynamic', `wget --no-config --no-hsts --read-timeout="$WGET_TIMEOUT" -O - https://example.test/file`],
      ['wget execute connect timeout zero', `wget --no-config --no-hsts -e 'connecttimeout=0' -O - https://example.test/file`],
      ['wget late no-config WGETRC product log', `WGETRC=/dev/stdin; printf 'output = src/late-no-config-wgetrc.log\n' | wget -O - https://example.test/file --no-config --no-hsts`],
      ['curl glob cumulative cardinality', `curl -q -o .omx/state/curl-explosive.log 'https://example.test/{a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p}{a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p}{a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p}{a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p}'`],
      ['select conditional touch', `select choice in safe; do touch src/select-owned.ts; done </dev/null`],
      ['allexport POSIX Wget', `set -a; POSIXLY_CORRECT=1; wget --no-config --no-hsts -O src/allexport-posix-owned.ts https://example.test/file -O -`],
      ['allexport SSL keylog curl', `set -o allexport; SSLKEYLOGFILE=src/allexport-curl.keys; curl -q -o - https://example.test/file`],
      ['nested allexport SSL keylog curl', `bash -a -c 'SSLKEYLOGFILE=src/nested-allexport-curl.keys; curl -q -o - https://example.test/file'`],
      ['composed SSL keylog export', `NAME=SSLKEYLOGFILE; export "$NAME"; SSLKEYLOGFILE=src/composed-curl.keys; curl -q -o - https://example.test/file`],
      ['dynamic export name', `export "$UNRESOLVED_NAME"; cat src/conductor-owned.ts`],
      ['curl unquoted glob output sink', `curl -q -o .omx/state/*.log https://example.test/file`],
      ['curl unquoted brace URL', `curl -q -o .omx/state/curl-brace-#1.log https://example.test/{one,two}`],
      ['nested bash shopt localvar inherit cdpath', `CDPATH=src bash -O localvar_inherit -c 'f(){ local CDPATH; cd state; touch ../.omx/state/owned; }; f'`],
      ['nested bash shopt localvar inherit posix', `POSIXLY_CORRECT=1 bash -Olocalvar_inherit -c 'f(){ local POSIXLY_CORRECT; wget --no-config --no-hsts -O - https://example.test/file; }; f'`],
      ['nested bash shopt plus localvar inherit cdpath', `CDPATH=src bash +O localvar_inherit -c 'f(){ local CDPATH; cd state; touch ../.omx/state/owned; }; f'`],
      ['nested bash shopt plus attached localvar inherit posix', `POSIXLY_CORRECT=1 bash +Olocalvar_inherit -c 'f(){ local POSIXLY_CORRECT; wget --no-config --no-hsts -O - https://example.test/file; }; f'`],
      ['git cat-file filters', `git cat-file --filters HEAD:filtered.txt`],
      ['xtrace PS4 command substitution', `PS4='$(touch src/ps4-owned.ts)'; set -x; :`],
      ['keyword late environment assignment', `set -o keyword; wget --no-config --no-hsts -U POSIXLY_CORRECT=1 -O src/keyword-owned.ts https://example.test/file -O -`],
      ['interactive Bash startup', `HOME=.omx/state/bash-home bash -ic ':'`],
      ['clustered allexport POSIX ordering', `set -ae; POSIXLY_CORRECT=1; wget --no-config --no-hsts -O src/cluster-owned.ts https://example.test/file -O -`],
      ['nested clustered allexport POSIX ordering', `bash -ae -c 'POSIXLY_CORRECT=1; wget --no-config --no-hsts -O src/nested-cluster-owned.ts https://example.test/file -O -'`],
      ['local shell option snapshot', `set -a; f(){ local -; set +a; }; f; POSIXLY_CORRECT=1; wget --no-config --no-hsts -O src/local-option-owned.ts https://example.test/file -O -`],
      ['monitor disables lastpipe', `export POSIXLY_CORRECT=1; shopt -s lastpipe; set -o monitor; f(){ unset POSIXLY_CORRECT; }; true | f; wget --no-config --no-hsts -O src/monitor-owned.ts https://example.test/file -O -`],
      ['generic glob mutation target', `truncate --size=0 .omx/state/*.log`],
      ['generic brace mutation target', `touch .omx/state/{conductor,ledger}.log`],
      ['generic glob directory destination', `mv .omx/state/conductor-ledger.json .omx/state/inbox/*`],
      ['physical cd symlink escape', `cd -P .omx/state/link; cd ..; touch physical-owned.ts`],
      ['physical shell mode symlink escape', `set -P; cd .omx/state/link; cd ..; touch physical-mode-owned.ts`],
      ['Python metadata copy eval alias', `python3 -I - <<'PY'
import shutil
shutil.copyfile('a', '.omx/state/inbox/py-control')
print=eval
print("'Pa' + 'th'('src/python-alias-owned.ts').write_text('x')")
PY`],
      ['literal quote metadata path', "mkdir -p \\'.omx/handoffs/run-1"],
      ['external dispatcher time wrapper', `PATH=.omx/state/inbox:/usr/bin:/bin env time printf safe`],
      ['Python interactive short cluster stdin', `python3 -Ii -c "print('safe')" <<'PY'
__import__('os').system('touch src/python-interactive-owned.ts')
PY`],
      ['Perl trailing substitution statement', `perl -pi -e 's/a/b/;system("touch src/perl-owned.ts") #/' .omx/state/conductor.log`],
      ['multiple Perl substitution programs', `perl -pi -e 's/a/b/' -e 's/b/c/' .omx/state/conductor.log`],
      ['multiple sed substitution programs', `sed -i -e 's/a/b/' -e 's/b/c/' .omx/state/conductor.log`],
      ['integer declaration secondary expansion', `declare -a slot; declare -i sink='slot[$(touch src/declare-integer-owned.ts)0]'`],
      ['zsh HOME startup', `HOME=.omx/state/zsh-home zsh -c ':'`],
      ['interactive Bash no-rc startup', `PS0='$(touch src/ps0-owned.ts)' bash --noprofile --norc -ic ':'`],
      ['background lastpipe pipeline', `export POSIXLY_CORRECT=1; shopt -s lastpipe; f(){ unset POSIXLY_CORRECT; }; true | f & wait; wget --no-config --no-hsts -o src/async-lastpipe.log http://127.0.0.1:1/ -o - -O -`],
      ['sed in-place backup sink', `printf x > .omx/state/runtime.ts; cd .omx/state; command sed --in-place='../../src/*' -e 's/x/y/' runtime.ts`],
      ['unbounded Python metadata copy', `python3 -I - <<'PY'
import shutil
shutil.copyfile('/dev/zero', '.omx/state/inbox/unbounded')
PY`],
      ['unbounded dd metadata copy', `dd if=/dev/zero of=.omx/state/inbox/unbounded`],
    ] as const;

    for (const [probe, command] of [
      ['node fs.rmSync', `node -e "require('fs').rmSync('src/victim.ts')"`],
      ['node create read stream write', `node -e "require('fs').createReadStream('src/victim.ts',{flags:'w'})"`],
      ['node bound create read stream append', `node -e "const {createReadStream: stream}=require('fs');stream('src/victim.ts',{flags:'a'})"`],
      ['posix uniq output after operand', `cd src; POSIXLY_CORRECT=1 uniq runtime.ts --count`],
      ['posix touch reference after operand', `POSIXLY_CORRECT=1 touch .omx/state/inbox/marker --reference src/runtime.ts`],
      ['nested sh posix special builtin', `sh -c 'POSIXLY_CORRECT=1 export POSIXLY_CORRECT; wget --no-config --no-hsts -O src/sh-posix-owned.ts https://example.test/file -O -'`],
      ['nested exec argv0 sh posix', `exec -a sh bash -c 'POSIXLY_CORRECT=1 export POSIXLY_CORRECT; wget --no-config --no-hsts -O src/exec-argv0-posix-owned.ts https://example.test/file -O -'`],
      ['nested env argv0 sh posix', `env --argv0 sh bash -c 'POSIXLY_CORRECT=1 export POSIXLY_CORRECT; wget --no-config --no-hsts -O src/env-argv0-posix-owned.ts https://example.test/file -O -'`],
      ['bare arithmetic command secondary expansion', `true='slot[$(touch src/arithmetic-command-owned.ts)0]'; ((true))`],
      ['arithmetic for secondary expansion', `for ((i=$(touch src/arithmetic-for-owned.ts); i<1; i++)); do :; done`],
      ['let secondary expansion', `let 'slot[$(touch src/let-owned.ts)0]=1'`],
      ['oversized metadata redirect', `head -c 16777217 /dev/zero > .omx/state/inbox/oversized`],
      ['unbounded metadata redirect', `cat /dev/zero > .omx/state/inbox/unbounded`],
      ['unbounded metadata redirect with unrelated heredoc', `cat /dev/zero > .omx/state/inbox/unbounded-with-heredoc; cat <<'EOF'
bounded
EOF`],
      ['oversized rsync metadata source', `rsync src/large.bin .omx/state/inbox/large-copy`],
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
      ['node xargs wrapper read', `printf x | xargs node -e "require('fs').readFileSync('src/victim.ts','utf8')"`],
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
      ['python non-isolation read-only', `python3 -c "print('ok')"`],
      ['python non-isolation modeled metadata copy', "python3 - <<'PY'\nimport shutil\nshutil.copyfile('a', '.omx/state/foo')\nPY"],
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
      ['git config env helper', `HELPER=/usr/bin/touch git --config-env=diff.external=HELPER diff --no-index README.md src/scripts/codex-native-hook.ts`],
      ['rg search zip helper', `rg -z never .omx/state/input.gz`],
      ['sensitive printf v runtime writer', `printf -v NODE_V8_COVERAGE '%s' src; export NODE_V8_COVERAGE; node -e "console.log('ok')"`],
      ['sensitive read runtime writer', `set -a; read GIT_TRACE <<< src/git-trace.log; git status`],
      ['bash login startup', `HOME=.omx/state/login-home bash -lc 'printf safe'`],
      ['wget prefix home hsts', `WGETRC=/dev/null HOME=src wget --no-config -O - https://example.test/file`],
      ['reference precedes reference option', `chmod src/victim.ts --reference=.omx/state/session.json .omx/state/reference-copy`],
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
      ['target directory cross boundary hardlink bypass', `ln src/source.ts -t .omx/handoffs/run-1`],
      ['symbolic link metadata bypass', `ln -s .omx/state/conductor-ledger.json .omx/state/ledger-symlink`],
      ['target directory value missing', 'cp package.json --target-directory'],
      ['target directory attached empty', 'install --target-directory= .omx/state/conductor-ledger.json'],
      ['target directory ordering missing value', 'mv src/a.ts --target-directory'],
      ['target directory terminator missing value', 'ln .omx/state/conductor-ledger.json -t --'],
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
    const workspacePackageCli = realpathSync(join(packageRoot, 'dist', 'cli', 'omx.js'));
    const packedNpmBinDir = join(smokeCwd, 'node_modules', '.bin');
    const packedNpmOmxShim = join(packedNpmBinDir, 'omx');
    const packedNpmGjcShim = join(packedNpmBinDir, 'gjc');
    mkdirSync(packedNpmBinDir, { recursive: true });
    symlinkSync(resolve(workspacePackageCli), packedNpmOmxShim);
    symlinkSync(resolve(workspacePackageCli), packedNpmGjcShim);
    const selfAssertedWorkspaceCli = join(smokeCwd, 'bin', 'omx.js');
    mkdirSync(dirname(selfAssertedWorkspaceCli), { recursive: true });
    writeFileSync(join(smokeCwd, 'package.json'), JSON.stringify({ name: 'oh-my-codex', bin: { omx: 'bin/omx.js' } }));
    writeFileSync(selfAssertedWorkspaceCli, '#!/usr/bin/env node\n', { mode: 0o755 });
    rmSync(packedNpmOmxShim);
    symlinkSync(selfAssertedWorkspaceCli, packedNpmOmxShim);
    for (const actor of ['main-root', 'native-child'] as const) {
      requireActorDeny(
        actor,
        'workspace self-asserted package CLI',
        runActorProbe(actor, 'workspace self-asserted package CLI', 'Bash', { command: `omx state write --input '{"mode":"ultragoal","active":true}' --json` }, { PATH: `${packedNpmBinDir}:/usr/bin:/bin` }),
      );
    }
    rmSync(packedNpmOmxShim);
    symlinkSync(workspacePackageCli, packedNpmOmxShim);
    const packedNpmPath = `${packedNpmBinDir}:${process.env.PATH || '/usr/bin:/bin'}`;
    const packedNpmCommandPrefix = `PATH="${packedNpmBinDir}:/usr/bin:/bin"`;
    requireNativeHookPermissionDeny(
      'main-root boxed planning CLI poisoned state root',
      runActorProbe(
        'main-root',
        'boxed planning CLI poisoned state root',
        'Bash',
        { command: `OMX_STATE_ROOT=${join(smokeCwd, 'src', 'state')} ${packedNpmCommandPrefix} omx state write --input '{"mode":"ralplan","active":true}' --json` },
        { OMX_ROOT: boxedPlanningRoot, OMX_TEAM_STATE_ROOT: '' },
      ),
      /(?:Ralplan is active|Main-root Conductor mode is active)/,
    );
    const npmBinPathShadow = join(smokeCwd, '.omx', 'state', 'inbox', 'cat');
    symlinkSync('/usr/bin/touch', npmBinPathShadow);
    const npmBinMissingCandidatePath = `${packedNpmBinDir}:${join(smokeCwd, '.omx', 'state', 'inbox')}:/usr/bin:/bin`;
    for (const actor of ['main-root', 'native-child'] as const) {
      requireActorDeny(
        actor,
        'npm bin missing candidate continues PATH scan',
        runActorProbe(actor, 'npm bin missing candidate continues PATH scan', 'Bash', { command: 'cat src/path-owned.ts' }, { PATH: npmBinMissingCandidatePath }),
      );
    }
    const nonexistentAbsoluteNpmBin = join(smokeCwd, 'node_modules', 'oh-my-codex', 'node_modules', '.bin');
    const packedNpmPathWithMissingNpmBin = `${nonexistentAbsoluteNpmBin}:${packedNpmPath}`;
    for (const [probe, command, path] of [
      ['absolute workspace npm bin cat parity', 'cat src/conductor-owned.ts', packedNpmPath],
      ['absolute workspace npm bin wrapped cat parity', 'env cat src/conductor-owned.ts', packedNpmPath],
      ['nonexistent absolute npm bin cat control', 'cat src/conductor-owned.ts', packedNpmPathWithMissingNpmBin],
      ['nonexistent absolute npm bin wrapped cat control', 'env cat src/conductor-owned.ts', packedNpmPathWithMissingNpmBin],
    ] as const) {
      for (const actor of ['main-root', 'native-child'] as const) {
        const result = runActorProbeResult(actor, probe, 'Bash', { command }, { PATH: path });
        if (Object.keys(result.output).length !== 0) {
          throw new Error(`packed ${actor} ${probe} should resolve to the system command: ${JSON.stringify(result.output)}\nactual stdout:\n${result.stdout}`);
        }
      }
    }
    const packedNpmNodeShadow = join(packedNpmBinDir, 'node');
    writeFileSync(packedNpmNodeShadow, '#!/bin/sh\ntouch src/omx-status-owned.ts\n', { mode: 0o755 });
    for (const actor of ['main-root', 'native-child'] as const) {
      for (const command of [`omx state write --input '{"mode":"ultragoal","active":true}' --json`, 'omx status'] as const) {
        requireActorDeny(
          actor,
          `workspace npm bin Node shadow ${command}`,
          runActorProbe(actor, `workspace npm bin Node shadow ${command}`, 'Bash', { command }, { PATH: `${packedNpmBinDir}:/usr/bin:/bin` }),
        );
      }
    }
    rmSync(packedNpmNodeShadow, { force: true });
    const cliStateWrite = `OMX_SESSION_ID=${sessionId} omx state write --input '{"mode":"ultragoal","active":true,"current_phase":"executing"}' --json`;
    const mainRootCliStateWriteProbe = runActorProbeResult('main-root', 'cli state write main', 'Bash', { command: cliStateWrite }, { PATH: packedNpmPath });
    if (Object.keys(mainRootCliStateWriteProbe.output).length !== 0) {
      throw new Error(`packed main-root CLI state write should retain metadata allowance: ${JSON.stringify(mainRootCliStateWriteProbe.output)}\nactual stdout:\n${mainRootCliStateWriteProbe.stdout}`);
    }
    requireActorDeny('native-child', 'cli state write native child', runActorProbe('native-child', 'cli state write native child', 'Bash', { command: cliStateWrite }, { PATH: packedNpmPath }));
    const systemNodeCliStateWriteProbe = runActorProbeResult(
      'main-root',
      'cli state write system Node',
      'Bash',
      { command: cliStateWrite },
      { PATH: `${packedNpmBinDir}:/usr/bin:/bin` },
    );
    if (Object.keys(systemNodeCliStateWriteProbe.output).length !== 0) {
      throw new Error(`packed main-root CLI state write should permit a trusted system Node: ${JSON.stringify(systemNodeCliStateWriteProbe.output)}\nactual stdout:\n${systemNodeCliStateWriteProbe.stdout}`);
    }
    const benignOrchestrationRuntimeEnvironment = {
      PATH: packedNpmPath,
      GJC_SESSION_CWD: smokeCwd,
      GJC_SESSION_FILE: join(stateDir, 'session.json'),
      GJC_SESSION_ID: sessionId,
      OMX_OPENCLAW: '1',
      OMX_OPENCLAW_COMMAND: 'resume',
      OMX_OPENCLAW_DEBUG: '1',
      OMX_TEST_RELAX_TMUX_TIMEOUT: '1',
    };
    const benignRuntimeEnvironmentCliStateWriteProbe = runActorProbeResult(
      'main-root',
      'cli state write benign runtime environment',
      'Bash',
      { command: cliStateWrite },
      benignOrchestrationRuntimeEnvironment,
    );
    if (Object.keys(benignRuntimeEnvironmentCliStateWriteProbe.output).length !== 0) {
      throw new Error(`packed main-root CLI state write should permit benign runtime environment: ${JSON.stringify(benignRuntimeEnvironmentCliStateWriteProbe.output)}\nactual stdout:\n${benignRuntimeEnvironmentCliStateWriteProbe.stdout}`);
    }
    const benignRuntimeEnvironmentStatusProbe = runActorProbeResult(
      'main-root',
      'cli status benign runtime environment',
      'Bash',
      { command: 'omx status' },
      benignOrchestrationRuntimeEnvironment,
    );
    if (Object.keys(benignRuntimeEnvironmentStatusProbe.output).length !== 0) {
      throw new Error(`packed main-root CLI status should permit benign runtime environment: ${JSON.stringify(benignRuntimeEnvironmentStatusProbe.output)}\nactual stdout:\n${benignRuntimeEnvironmentStatusProbe.stdout}`);
    }
    const functionPersistedRsyncEnvironment = `poison(){ export RSYNC_PARTIAL_DIR=${join(smokeCwd, 'src', 'rsync-partials')}; }; poison; rsync .omx/state/conductor-ledger.json .omx/state/inbox/rsync-copy`;
    const functionPersistedOmxEnvironment = `poison(){ export OMX_STATE_ROOT=${join(smokeCwd, 'src', 'state')}; }; poison; omx state write --input '{"mode":"ultragoal","active":true}' --json`;
    for (const [probe, command] of [
      ['function persisted rsync runtime environment', functionPersistedRsyncEnvironment],
      ['function persisted omx runtime environment', functionPersistedOmxEnvironment],
      ['function persisted gjc runtime environment', `poison(){ export GJC_UNREVIEWED_HELPER=src/mutator; }; poison; omx status`],
      ['nameref rsync runtime environment', `declare -n poison=RSYNC_PARTIAL_DIR; poison=src/rsync-partials; rsync .omx/state/conductor-ledger.json .omx/state/inbox/rsync-copy`],
      ['joined rsync runtime environment', `if true; then export RSYNC_PARTIAL_DIR=src/rsync-partials; fi; rsync .omx/state/conductor-ledger.json .omx/state/inbox/rsync-copy`],
      ['nested omx runtime environment', `export OMX_STATE_ROOT=${join(smokeCwd, 'src', 'state')}; bash --noprofile --norc -c 'omx status'`],
      ['function readonly omx root failed unset', `poison(){ readonly OMX_ROOT=${join(smokeCwd, 'src')}; unset OMX_ROOT; }; poison; omx status`],
      ['function readonly rsync runtime failed unset', `poison(){ readonly RSYNC_PARTIAL_DIR=src/rsync-partials; unset RSYNC_PARTIAL_DIR; }; poison; rsync .omx/state/conductor-ledger.json .omx/state/inbox/rsync-copy`],
      ['function readonly gjc runtime failed unset', `poison(){ readonly GJC_UNREVIEWED_HELPER=src/mutator; unset GJC_UNREVIEWED_HELPER; }; poison; omx status`],
    ] as const) {
      for (const actor of ['main-root', 'native-child'] as const) {
        requireActorDeny(actor, probe, runActorProbe(actor, probe, 'Bash', { command }, { PATH: packedNpmPath }));
      }
    }
    const modeCliStateWrite = `OMX_SESSION_ID=${sessionId} omx state write --mode=ultragoal --input '{"active":true,"current_phase":"blocked","reason":"native delegation unavailable -> terminalized"}' --json`;
    const mainRootModeCliStateWriteProbe = runActorProbeResult('main-root', 'mode CLI state write main', 'Bash', { command: modeCliStateWrite }, { PATH: packedNpmPath });
    if (Object.keys(mainRootModeCliStateWriteProbe.output).length !== 0) {
      throw new Error(`packed main-root mode CLI state write should retain metadata allowance: ${JSON.stringify(mainRootModeCliStateWriteProbe.output)}\nactual stdout:\n${mainRootModeCliStateWriteProbe.stdout}`);
    }
    requireActorDeny('native-child', 'mode CLI state write native child', runActorProbe('native-child', 'mode CLI state write native child', 'Bash', { command: modeCliStateWrite }, { PATH: packedNpmPath }));
    for (const [probe, prefix] of [
      ['poisoned OMX root', `OMX_ROOT=${join(smokeCwd, 'src')} PATH=${packedNpmPath}`],
      ['poisoned OMX state root', `OMX_STATE_ROOT=${join(smokeCwd, 'src', 'state')} PATH=${packedNpmPath}`],
      ['unknown OMX runtime output', `OMX_UNREVIEWED_OUTPUT=src/output PATH=${packedNpmPath}`],
      ['unknown OMX runtime environment', `OMX_UNREVIEWED_HELPER=src/mutator PATH=${packedNpmPath}`],
      ['unknown GJC runtime environment', `GJC_UNREVIEWED_HELPER=src/mutator PATH=${packedNpmPath}`],
    ] as const) {
      for (const command of [cliStateWrite, 'omx status'] as const) {
        const surface = command === cliStateWrite ? 'state write' : 'read-only omx';
        requireActorDeny(
          'main-root',
          `${probe} ${surface}`,
          runActorProbe('main-root', `${probe} ${surface}`, 'Bash', { command: `${prefix} ${command}` }),
        );
      }
    }
    const fakeOmxDirectory = join(smokeCwd, '.omx', 'state');
    const fakeOmxPath = join(fakeOmxDirectory, 'omx');
    const fakeGjcPath = join(fakeOmxDirectory, 'gjc');
    writeFileSync(fakeOmxPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(fakeGjcPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const fakeOmxStateWrite = `omx state write --input '{"mode":"ultragoal","active":true}' --json`;
    const fakeGjcCheckpoint = `gjc ultragoal checkpoint --goal-id G001 --status failed --evidence unauthorized`;
    for (const actor of ['main-root', 'native-child'] as const) {
      requireActorDeny(
        actor,
        'repository omx shadow',
        runActorProbe(actor, 'repository omx shadow', 'Bash', { command: fakeOmxStateWrite }, {
          PATH: `${fakeOmxDirectory}:${packedNpmPath}`,
        }),
      );
      requireActorDeny(
        actor,
        'repository gjc shadow',
        runActorProbe(actor, 'repository gjc shadow', 'Bash', { command: fakeGjcCheckpoint }, {
          PATH: `${fakeOmxDirectory}:${packedNpmPath}`,
        }),
      );
    }
    rmSync(fakeOmxPath, { force: true });
    rmSync(fakeGjcPath, { force: true });
    rmSync(packedNpmOmxShim, { force: true });
    writeFileSync(packedNpmOmxShim, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    for (const actor of ['main-root', 'native-child'] as const) {
      requireActorDeny(
        actor,
        'workspace npm bin omx shadow',
        runActorProbe(actor, 'workspace npm bin omx shadow', 'Bash', { command: fakeOmxStateWrite }, { PATH: packedNpmPath }),
      );
    }
    rmSync(packedNpmOmxShim, { force: true });
    symlinkSync(workspacePackageCli, packedNpmOmxShim);
    rmSync(packedNpmGjcShim, { force: true });
    writeFileSync(packedNpmGjcShim, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    for (const actor of ['main-root', 'native-child'] as const) {
      requireActorDeny(
        actor,
        'workspace npm bin gjc shadow',
        runActorProbe(actor, 'workspace npm bin gjc shadow', 'Bash', { command: fakeGjcCheckpoint }, { PATH: packedNpmPath }),
      );
    }
    rmSync(packedNpmGjcShim, { force: true });
    symlinkSync(workspacePackageCli, packedNpmGjcShim);
    const workspaceNpmBinChmodShadowCommand = `chmod --reference=.omx/state/session.json .omx/state/reference-copy; omx state write --input '{"mode":"ultragoal"}' --json`;
    const workspaceNpmBinChmodShadow = join(packedNpmBinDir, 'chmod');
    writeFileSync(workspaceNpmBinChmodShadow, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    for (const actor of ['main-root', 'native-child'] as const) {
      requireActorDeny(
        actor,
        'workspace npm bin chmod shadow',
        runActorProbe(actor, 'workspace npm bin chmod shadow', 'Bash', { command: workspaceNpmBinChmodShadowCommand }, { PATH: packedNpmPath }),
      );
    }
    rmSync(workspaceNpmBinChmodShadow, { force: true });
    const currentRuntimeNodePath = process.execPath;
    const currentRuntimeNodePathEnvironment = { PATH: `${dirname(currentRuntimeNodePath)}:/usr/bin:/bin` };
    const untrustedExternalBin = mkdtempSync(join(tmpdir(), 'omx-native-hook-external-path-'));
    const untrustedExternalCat = join(untrustedExternalBin, 'cat');
    const untrustedExternalGh = join(untrustedExternalBin, 'gh');
    const untrustedExternalNode = join(untrustedExternalBin, 'node');
    const untrustedExternalNodeLookalike = join(untrustedExternalBin, 'node-copy');
    for (const actor of ['main-root', 'native-child'] as const) {
      const output = runActorProbe(actor, 'external path without cat candidate', 'Bash', {
        command: `PATH=${untrustedExternalBin}:${process.env.PATH || '/usr/bin:/bin'} cat src/conductor-owned.ts`,
      });
      if (Object.keys(output).length !== 0) throw new Error(`packed ${actor} external PATH without a cat candidate should fall through to the system command`);
    }
    symlinkSync('/bin/cat', untrustedExternalCat);
    writeFileSync(untrustedExternalGh, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(untrustedExternalNode, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(untrustedExternalNodeLookalike, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    try {
      for (const [probe, command] of [
        ['untrusted external absolute executable', `${untrustedExternalCat} src/conductor-owned.ts`],
        ['untrusted external PATH executable', `PATH=${untrustedExternalBin}:${process.env.PATH || '/usr/bin:/bin'} cat src/conductor-owned.ts`],
        ['untrusted external absolute gh', `${untrustedExternalGh} issue create --title x --body y`],
        ['untrusted external PATH gh', `PATH=${untrustedExternalBin}:${process.env.PATH || '/usr/bin:/bin'} gh issue create --title x --body y`],
        ['untrusted external absolute node', `${untrustedExternalNode} -e "require('fs').readFileSync('src/victim.ts','utf8')"`],
        ['untrusted external PATH node', `PATH=${untrustedExternalBin}:/usr/bin:/bin node -e "require('fs').readFileSync('src/victim.ts','utf8')"`],
        ['untrusted external node lookalike', `${untrustedExternalNodeLookalike} -e "require('fs').readFileSync('src/victim.ts','utf8')"`],
      ] as const) {
        for (const actor of ['main-root', 'native-child'] as const) {
          requireActorDeny(actor, probe, runActorProbe(actor, probe, 'Bash', { command }));
        }
      }
    } finally {
      rmSync(untrustedExternalBin, { recursive: true, force: true });
    }
    const dynamicCliStateWrite = `omx state write --input "$STATE_INPUT" --json`;
    for (const actor of ['main-root', 'native-child'] as const) {
      requireActorDeny(
        actor,
        'dynamic CLI state write',
        runActorProbe(actor, 'dynamic CLI state write', 'Bash', { command: dynamicCliStateWrite }, { PATH: packedNpmPath }),
      );
    }
    const unknownStateWriteFlag = `omx state write --unexpected --input '{"mode":"ultragoal","active":true}' --json`;
    for (const actor of ['main-root', 'native-child'] as const) {
      requireActorDeny(
        actor,
        'unknown state write flag',
        runActorProbe(actor, 'unknown state write flag', 'Bash', { command: unknownStateWriteFlag }, { PATH: packedNpmPath }),
      );
    }
    for (const [probe, command] of [
      ['state write foreign routing', `omx state write --input '{"mode":"ultragoal","workingDirectory":"src","session_id":"foreign","active":false}' --json`],
      ['state write unknown payload key', `omx state write --input '{"mode":"ultragoal","active":true,"child_marker":"forbidden"}' --json`],
      ['state write conflicting mode', `omx state write --mode=ultragoal --input '{"mode":"ralph","active":true}' --json`],
      ['state write foreign session environment', `OMX_SESSION_ID=foreign omx state write --input '{"mode":"ultragoal","active":true}' --json`],
      ['state write unset session environment', `env -uOMX_SESSION_ID omx state write --input '{"mode":"ultragoal","active":true}' --json`],
      ['state write shell unset session', `unset OMX_SESSION_ID; omx state write --input '{"mode":"ultragoal","active":true}' --json`],
      ['state write noncanonical cwd', `cd src; omx state write --input '{"mode":"ultragoal","active":true}' --json`],
    ] as const) {
      for (const actor of ['main-root', 'native-child'] as const) {
        requireActorDeny(actor, probe, runActorProbe(actor, probe, 'Bash', { command }, { PATH: packedNpmPath }));
      }
    }
    for (const [probe, inheritedEnv] of [
      ['inherited foreign OMX session selector', { OMX_SESSION_ID: 'foreign' }],
      ['inherited foreign GJC session selector', { GJC_SESSION_ID: 'foreign' }],
      ['inherited conflicting session selectors', { OMX_SESSION_ID: sessionId, GJC_SESSION_ID: 'foreign' }],
    ] as const) {
      for (const actor of ['main-root', 'native-child'] as const) {
        requireActorDeny(
          actor,
          probe,
          runActorProbe(actor, probe, 'Bash', { command: `omx state write --input '{"mode":"ultragoal","active":true}' --json` }, { PATH: packedNpmPath, ...inheritedEnv }),
        );
      }
    }
    const mixedReferenceStateCommand = `chmod --reference=.omx/state/session.json .omx/state/reference-copy; OMX_SESSION_ID=${sessionId} omx state write --input '{"mode":"ultragoal"}' --json`;
    const mainRootMixedReferenceStateProbe = runActorProbeResult('main-root', 'native child mixed reference state write main', 'Bash', { command: mixedReferenceStateCommand }, { PATH: packedNpmPath });
    if (Object.keys(mainRootMixedReferenceStateProbe.output).length !== 0) {
      throw new Error(`packed main-root mixed reference/state command should retain metadata allowance: ${JSON.stringify(mainRootMixedReferenceStateProbe.output)}\nactual stdout:\n${mainRootMixedReferenceStateProbe.stdout}`);
    }
    requireActorDeny(
      'native-child',
      'native child mixed reference state write native child',
      runActorProbe('native-child', 'native child mixed reference state write native child', 'Bash', { command: mixedReferenceStateCommand }, { PATH: packedNpmPath }),
    );
    requireActorDeny(
      'native-child',
      'native child rsync authority target',
      runActorProbe('native-child', 'native child rsync authority target', 'Bash', { command: `rsync .omx/state/conductor-ledger.json .omx/state/session.json` }),
    );
    const referenceUnknownCommand = `chmod --reference=.omx/state/session.json .omx/state/reference-copy; unknown-mutation-transport`;
    for (const actor of ['main-root', 'native-child'] as const) {
      requireActorDeny(
        actor,
        'native child reference unknown command',
        runActorProbe(actor, 'native child reference unknown command', 'Bash', { command: referenceUnknownCommand }),
      );
    }
    for (const [probe, command, inheritedEnv] of [
      ['python inherited sitecustomize preload', `python3 -c "print('ok')"`, { PYTHONPATH: './.omx/state' }],
      ['perl inherited module preload', `perl -e 'print;'`, { PERL5LIB: './.omx/state', PERL5OPT: '-MMutator' }],
      ['bash inherited env preload', `bash -c 'printf safe\\n'`, { BASH_ENV: './.omx/state/mutator.sh' }],
      ['bash inherited env plain read-only', `cat src/conductor-owned.ts`, { BASH_ENV: './.omx/state/mutator.sh' }],
      ['zsh inherited startup preload', `zsh -c 'printf safe'`, { ZDOTDIR: './.omx/state' }],
      ['curl inherited SSL key log output', `curl -q -o - https://example.test/file`, { SSLKEYLOGFILE: 'src/curl-tls.keys' }],
      ['wget inherited SSL key log output', `wget --no-config --no-hsts -O - https://example.test/file`, { SSLKEYLOGFILE: 'src/wget-tls.keys' }],
      ['wget inherited posix option ordering', `wget -O src/posix-inherited-wget-owned.ts https://example.test/file -O -`, { POSIXLY_CORRECT: '1' }],
      ['inherited empty path', `cat src/conductor-owned.ts`, { PATH: '' }],
      ['inherited relative path', `cat src/conductor-owned.ts`, { PATH: '.' }],
      ['inherited unresolved path', `cat src/conductor-owned.ts`, { PATH: '$UNKNOWN_PATH' }],
      ['inherited dynamic loader library path', `cat src/conductor-owned.ts`, { LD_LIBRARY_PATH: './.omx/state' }],
      ['inherited dynamic loader audit path', `cat src/conductor-owned.ts`, { DYLD_LIBRARY_PATH: './.omx/state' }],
      ['inherited xtrace shell option', `cat src/conductor-owned.ts`, { SHELLOPTS: 'xtrace' }],
      ['inherited keyword shell option', `cat src/conductor-owned.ts`, { SHELLOPTS: 'keyword' }],
    ] as const) {
      for (const actor of ['main-root', 'native-child'] as const) {
        requireActorDeny(actor, probe, runActorProbe(actor, probe, 'Bash', { command }, inheritedEnv));
      }
    }
    for (const actor of ['main-root', 'native-child'] as const) {
      for (const [probe, command] of [
        ['python inherited unbuffered read-only control', `python3 -I -c "print('ok')"`],
        ['python inherited unbuffered isolated metadata cwd control', `cd .omx/state && python3 -I -c "print('ok')"`],
      ] as const) {
        const output = runActorProbe(actor, probe, 'Bash', { command }, { PYTHONUNBUFFERED: '1' });
        if (Object.keys(output).length !== 0) throw new Error(`packed ${actor} ${probe} should be allowed`);
      }
    }
    const unbufferedModeledMetadataOutput = runActorProbe(
      'main-root',
      'python inherited unbuffered modeled metadata control',
      'Bash',
      { command: "python3 -I - <<'PY'\nimport shutil\nshutil.copyfile('a', '.omx/state/foo')\nPY" },
      { PYTHONUNBUFFERED: '1' },
    );
    if (Object.keys(unbufferedModeledMetadataOutput).length !== 0) {
      throw new Error('packed main-root python inherited unbuffered modeled metadata control should be allowed');
    }
    for (const actor of ['main-root', 'native-child'] as const) {
      const output = runActorProbe(actor, 'repository path without cat candidate', 'Bash', { command: 'cat src/conductor-owned.ts' }, {
        PATH: `${smokeCwd}:${process.env.PATH || '/usr/bin:/bin'}`,
      });
      if (Object.keys(output).length !== 0) throw new Error(`packed ${actor} repository PATH without a cat candidate should fall through to the system command`);
    }

    for (const [probe, command, inheritedEnv] of [
      ['inherited bash function shadow', `cat src/conductor-owned.ts`, { 'BASH_FUNC_cat%%': '() { touch src/inherited-function-owned.ts; }' }],
    ] as const) {
      for (const actor of ['main-root', 'native-child'] as const) {
        requireActorDeny(actor, probe, runActorProbe(actor, probe, 'Bash', { command }, inheritedEnv));
      }
    }
    writeFileSync(join(fakeOmxDirectory, 'env'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    for (const actor of ['main-root', 'native-child'] as const) {
      requireActorDeny(
        actor,
        'repository external wrapper shadow',
        runActorProbe(actor, 'repository external wrapper shadow', 'Bash', {
          command: `PATH=${fakeOmxDirectory}:/usr/bin:/bin env cat src/conductor-owned.ts`,
        }),
      );
    }
    rmSync(join(fakeOmxDirectory, 'env'), { force: true });
    for (const actor of ['main-root', 'native-child'] as const) {
      requireActorDeny(
        actor,
        'loader before external env clear',
        runActorProbe(actor, 'loader before external env clear', 'Bash', { command: `env -i cat src/conductor-owned.ts` }, { LD_LIBRARY_PATH: './.omx/state' }),
      );
    }
    for (const actor of ['main-root', 'native-child'] as const) {
      const output = runActorProbe(actor, 'cleared inherited bash function control', 'Bash', { command: `env -i cat src/conductor-owned.ts` }, { 'BASH_FUNC_cat%%': '() { touch src/inherited-function-owned.ts; }' });
      if (Object.keys(output).length !== 0) throw new Error(`packed ${actor} clear-environment inherited-function control should be allowed`);
    }
    for (const [probe, command] of [
      ['cleared environment empty path', `env -i PATH= sh -c 'wget --no-config -O - https://example.test/file'`],
      ['cleared environment relative path', `env -i PATH=. sh -c 'wget --no-config -O - https://example.test/file'`],
      ['cleared environment repository path', `env -i PATH=${smokeCwd} sh -c 'wget --no-config -O - https://example.test/file'`],
      ['cleared exec empty path', `exec -c env PATH= sh -c 'wget --no-config -O - https://example.test/file'`],
      ['cleared exec relative path', `exec -c env PATH=. sh -c 'wget --no-config -O - https://example.test/file'`],
      ['cleared exec repository path', `exec -c env PATH=${smokeCwd} sh -c 'wget --no-config -O - https://example.test/file'`],
      ['recursive reference metadata', `chmod -R --reference=.omx/state/session.json .omx/state`],
      ['rsync directory tree metadata', `rsync -a --log-file=.omx/state/rsync-tree.log .omx/state/ .omx/state/rsync-tree-copy/`],
      ['rsync keep dirlinks metadata', `rsync --keep-dirlinks --log-file=.omx/state/rsync-dirlinks.log .omx/state/conductor-ledger.json .omx/state/rsync-dirlinks-copy`],
      ['rsync explicit links metadata', `rsync --links --log-file=.omx/state/rsync-links.log .omx/state/conductor-ledger.json .omx/state/rsync-links-copy`],
    ] as const) {
      for (const actor of ['main-root', 'native-child'] as const) {
        requireActorDeny(actor, probe, runActorProbe(actor, probe, 'Bash', { command }));
      }
    }
    const trustedSystemGh = '/usr/bin/gh';
    const hasTrustedSystemGh = existsSync(trustedSystemGh);
    for (const [probe, command] of [
      ['gh issue create', `${trustedSystemGh} issue create --title x --body y`],
      ['gh issue quoted regex body', `${trustedSystemGh} issue create --title x --body 'Guard regex /[^>]+>{1,2}/ is data, not a redirect'`],
      ['gh api post', `${trustedSystemGh} api --method POST /repos/OWNER/REPO/issues -f title=x`],
      ['gh api attached post', `${trustedSystemGh} api -XPOST --input .omx/state/create-repo.json /user/repos`],
      ['gh api attached field post', `${trustedSystemGh} api -ftitle=x /repos/OWNER/REPO/issues`],
      ['omx ultragoal final checkpoint', `${packedNpmCommandPrefix} omx ultragoal checkpoint --goal-id G001 --status complete --codex-goal-json goal.json --quality-gate-json quality.json --evidence unauthorized --json`],
      ['wrapped gh issue create', `bash --noprofile --norc -lc '${trustedSystemGh} issue create --title x --body y'`],
      ['wrapped omx ultragoal final checkpoint', `${packedNpmCommandPrefix} bash --noprofile --norc -lc '${packedNpmCommandPrefix} omx ultragoal checkpoint --goal-id G001 --status complete --codex-goal-json goal.json --quality-gate-json quality.json --evidence unauthorized --json'`],
      ['wrapped gjc ultragoal final checkpoint', `${packedNpmCommandPrefix} bash --noprofile --norc -lc '${packedNpmCommandPrefix} gjc ultragoal checkpoint --goal-id G001 --status complete --codex-goal-json goal.json --quality-gate-json quality.json --evidence unauthorized --json'`],
      ['performance goal complete', `${packedNpmCommandPrefix} omx performance-goal complete --slug latency --codex-goal-json goal.json --evidence done --json`],
      ['wrapped performance goal complete', `${packedNpmCommandPrefix} bash --noprofile --norc -lc '${packedNpmCommandPrefix} omx performance-goal complete --slug latency --codex-goal-json goal.json --evidence done --json'`],
      ['autoresearch goal complete', `${packedNpmCommandPrefix} gjc autoresearch-goal complete --slug safety --codex-goal-json goal.json --json`],
      ['wrapped autoresearch goal complete', `${packedNpmCommandPrefix} bash --noprofile --norc -lc '${packedNpmCommandPrefix} gjc autoresearch-goal complete --slug safety --codex-goal-json goal.json --json'`],
      ['pipeline read then mutate', `${packedNpmCommandPrefix} omx status | ${packedNpmCommandPrefix} omx performance-goal complete --slug latency --codex-goal-json goal.json --evidence done --json`],
    ] as const) {
      const mainRootProbe = runActorProbeResult('main-root', `${probe} main`, 'Bash', { command });
      const requiresTrustedGh = probe.startsWith('gh ') || probe.startsWith('wrapped gh ');
      if (requiresTrustedGh && !hasTrustedSystemGh) {
        requireActorDeny('main-root', `${probe} main`, mainRootProbe.output);
      } else if (Object.keys(mainRootProbe.output).length !== 0) {
        throw new Error(`packed main-root ${probe} should retain remote orchestration allowance: ${JSON.stringify(mainRootProbe.output)}\nactual stdout:\n${mainRootProbe.stdout}`);
      }
      requireActorDeny('native-child', `${probe} native child`, runActorProbe('native-child', `${probe} native child`, 'Bash', { command }));
    }
    const inheritedGhHelperEnvironment = { GH_BROWSER: 'true', GH_PAGER: 'cat', GIT_EDITOR: 'true' };
    for (const [probe, command] of [
      ['gh issue create inherited helper control', `${trustedSystemGh} issue create --title x --body y`],
      ['gh api inherited helper control', `${trustedSystemGh} api --method POST /repos/OWNER/REPO/issues -f title=x`],
    ] as const) {
      const mainRootProbe = runActorProbeResult('main-root', probe, 'Bash', { command }, inheritedGhHelperEnvironment);
      if (!hasTrustedSystemGh) {
        requireActorDeny('main-root', probe, mainRootProbe.output);
      } else if (Object.keys(mainRootProbe.output).length !== 0) {
        throw new Error(`packed main-root ${probe} should ignore inherited GH helper environment: ${JSON.stringify(mainRootProbe.output)}\nactual stdout:\n${mainRootProbe.stdout}`);
      }
    }
    for (const [probe, command] of [
      ['gh api dynamic method', `gh api --method "$GH_METHOD" /repos/OWNER/REPO/issues`],
      ['xargs gh api mutation', `printf '%s' '-XPOST /repos/OWNER/REPO/issues' | PATH=/usr/bin:/bin xargs gh api`],
      ['omx unknown mutation', `omx unrecognized mutate --status failed`],
    ] as const) {
      for (const actor of ['main-root', 'native-child'] as const) {
        requireActorDeny(actor, probe, runActorProbe(actor, probe, 'Bash', { command }));
      }
    }
    for (const [probe, command] of [
      ['omx checkpoint unknown option', `${packedNpmCommandPrefix} omx ultragoal checkpoint --goal-id G001 --status failed --evidence x --future-output=src/owned.ts`],
      ['omx node options preload', `NODE_OPTIONS='--require ./.omx/state/mutator.cjs' ${packedNpmCommandPrefix} omx status`],
      ['omx node coverage output', `NODE_V8_COVERAGE=src ${packedNpmCommandPrefix} omx status`],
      ['posix stdout before extra operand', `WGETRC=/dev/null POSIXLY_CORRECT=1 wget --no-config --no-hsts -O - https://example.test/file -O src/posix-after-operand.ts`],
      ['posix spider before extra operand', `WGETRC=/dev/null POSIXLY_CORRECT=1 wget --no-config --no-hsts --spider https://example.test/file -O src/posix-spider-after-operand.ts`],
      ['posix append stdout before extra operand', `POSIXLY_CORRECT+=1 wget --no-config --no-hsts -O - https://example.test/file -O src/posix-append-after-operand.ts`],
      ['coproc function lifecycle child', `touch(){ :; }; coproc { unset -f touch; }; wait; touch src/coproc-lifecycle-shadowed.ts`],
      ['wget repeated log last metadata sink', `wget --no-config --no-hsts -o src/ignored.log -o .omx/state/final.log -O - https://example.test/file`],
      ['wget repeated directory last metadata sink', `wget --no-config --no-hsts -P src -P .omx/state https://example.test/file`],
      ['wget repeated long directory last metadata sink', `wget --no-config --no-hsts --directory-prefix=src --directory-prefix=.omx/state https://example.test/file`],
      ['wget exact output document metadata sink', `wget --no-config --no-hsts --output-document=.omx/state/download.ts https://example.test/file`],
      ['wget execute metadata log sink', `wget --no-config --no-hsts --execute='logfile=.omx/state/wget-execute.log' -O - https://example.test/file`],
      ['curl literal hash output metadata sink', `curl -q -o .omx/state/curl-literal#hash.log https://example.test/file`],
      ['curl write out metadata sink', `curl -q --write-out '%output{.omx/state/curl-write-out.log}' https://example.test/file`],
      ['curl inline write out metadata sink', `curl -q --write-out='%output{.omx/state/curl-inline-write-out.log}' https://example.test/file`],
    ] as const) {
      for (const actor of ['main-root', 'native-child'] as const) {
        requireActorDeny(actor, probe, runActorProbe(actor, probe, 'Bash', { command }));
      }
    }

    for (const [probe, command] of [
      ['current runtime node absolute read', `${currentRuntimeNodePath} -e "require('fs').readFileSync('src/victim.ts','utf8')"`],
      ['node fs readFileSync', `node -e "require('fs').readFileSync('src/victim.ts','utf8')"`],
      ['node write mutation text', `node -e 'console.log("require(\\"fs\\").writeFileSync(\\"src/victim.ts\\", \\"x\\")")'`],
      ['node ESM fs readFileSync', `node --input-type=module -e "import fs from 'node:fs';fs.readFileSync('src/victim.ts','utf8')"`],
      ['node fs openSync read-only', `node -e "require('fs').openSync('src/victim.ts','r')"`],
      ['node regex mutation text', `node -e 'console.log(/require\\("fs"\\)\\.rmSync\\("src\\/victim.ts"\\)/.test("x"))'`],
      ['node static unrelated computed member', `node -e "console.log(module['filename'])"`],
      ['node attached short read', `node -e"require('fs').readFileSync('src/victim.ts','utf8')"`],
      ['node read-only path module', `node -e "console.log(require('path').join('src','victim.ts'))"`],
      ['node array index', `node -e "const a=[1];console.log(a[0])"`],
      ['node dynamic object read', `node -e "const o={x:1};const k='x';console.log(o[k])"`],
      ['node Object.getPrototypeOf', `node -e "console.log(Object.getPrototypeOf({}))"`],
      ['node Object computed getPrototypeOf', `node -e "Object['getPrototypeOf']({x:1})"`],
      ['node object computed constructor', `node -e "const o={constructor:7};console.log(o['constructor'])"`],
      ['node Reflect.get', `node -e "console.log(Reflect.get({x:1},'x'))"`],
      ['python isolated read-only', `python3 -I -c "print('ok')"`],
      ['wget spider no-body', 'wget --no-config --no-hsts --spider https://example.test/file'],
      ['wget stdout short output document', 'wget --no-config --no-hsts -O - https://example.test/file'],
      ['wget stdout long output document', 'wget --no-config --no-hsts --output-document=- https://example.test/file'],
      ['wget stdout attached short output document', 'wget --no-config --no-hsts -O- https://example.test/file'],
      ['wget repeated output last stdout', 'wget --no-config --no-hsts -O src/wget-first-output.ts https://example.test/file -O -'],
      ['posix wget literal data', `printf '%s\n' 'POSIXLY_CORRECT wget -O src/not-executed.ts -O -'`],
      ['posix url data before stdout wget', `printf '%s\n' 'https://example.test/POSIXLY_CORRECT'; wget --no-config --no-hsts -O - https://example.test/file`],
      ['function after wget no posix taint', `f(){ export POSIXLY_CORRECT=1; }; wget --no-config --no-hsts -O src/function-after.ts https://example.test/file -O -; f`],
      ['subshell function no posix taint', `f(){ export POSIXLY_CORRECT=1; }; ( f ); wget --no-config --no-hsts -O src/function-subshell.ts https://example.test/file -O -`],
      ['returned local posix control', `f(){ local -x POSIXLY_CORRECT=1; }; f; wget --no-config --no-hsts -O src/local-scope-control.ts https://example.test/file -O -`],
      ['background posix control', `f(){ export POSIXLY_CORRECT=1; }; f & wait; wget --no-config --no-hsts -O src/background-control.ts https://example.test/file -O -`],
      ['pipeline posix control', `f(){ export POSIXLY_CORRECT=1; }; f | cat; wget --no-config --no-hsts -O src/pipeline-control.ts https://example.test/file -O -`],
      ['coproc posix control', `f(){ export POSIXLY_CORRECT=1; }; coproc f; wait; WGETRC=/dev/null wget --no-config --no-hsts -O - https://example.test/file`],
      ['nested subshell posix control', `f(){ export POSIXLY_CORRECT=1; }; if ( f ); then :; fi; wget --no-config --no-hsts -O src/nested-subshell-control.ts https://example.test/file -O -`],
      ['wrapper only posix control', `env POSIXLY_CORRECT=1 true; wget --no-config --no-hsts -O src/wrapper-control.ts https://example.test/file -O -`],
      ['wgetrc null control', `WGETRC=/dev/null wget --no-config --no-hsts -O - https://example.test/file`],
      ['home null control', `HOME=/dev/null wget --no-config --no-hsts -O - https://example.test/file`],
      ['case arm stdout control', `case true in true) wget --no-config --no-hsts -O - https://example.test/file;; esac`],
      ['xargs empty eof read-only control', `printf '%s\n' safe | xargs -E '' printf`],
      ['env chdir stdout control', `env -C src wget --no-config --no-hsts -O - https://example.test/file`],
      ['nonexported declare posix control', `declare POSIXLY_CORRECT=1; WGETRC=/dev/null wget --no-config --no-hsts -O src/declare-control.ts https://example.test/file -O -`],
      ['persistent wgetrc null control', `export WGETRC=/dev/null; wget --no-config --no-hsts -O - https://example.test/file`],
      ['restored wgetrc control', `export WGETRC=/dev/stdin; unset WGETRC; HOME=/dev/null wget --no-config --no-hsts -O - https://example.test/file`],
      ['dynamic case subject stdout control', `mode=true; case "$mode" in true) wget --no-config --no-hsts -O - https://example.test/file;; esac`],
      ['case arm pipeline read only', `case x in x) : | true;; esac`],
      ['later optional case pattern stdout', `case x in a) :;; (x) wget --no-config --no-hsts -O - https://example.test/file;; esac`],
      ['successful posix unset stdout', `export POSIXLY_CORRECT=1; unset POSIXLY_CORRECT; WGETRC=/dev/null wget --no-config --no-hsts -O src/unset-posix-first.ts https://example.test/file -O -`],
      ['nested posix stdout', `POSIXLY_CORRECT=1 sh -c 'wget --no-config --no-hsts -O - https://example.test/file'`],
      ['nested chdir stdout', `env --chdir=src sh -c 'wget --no-config --no-hsts -O - https://example.test/file'`],
      ['nested lastpipe stdout', `bash -O lastpipe -c 'wget --no-config --no-hsts -O - https://example.test/file'`],
      ['nested lastpipe pipeline stdout', `bash -O lastpipe -c 'printf safe | cat; wget --no-config --no-hsts -O - https://example.test/file'`],
      ['process substitution static read only', `cat <(printf safe)`],
      ['process substitution wget stdout', `cat <(wget --no-config --no-hsts -O - https://example.test/file)`],
      ['background brace posix control', `f(){ export POSIXLY_CORRECT=1; }; { f; } & wait; WGETRC=/dev/null wget --no-config --no-hsts -O - https://example.test/file`],
      ['background function definition child control', `{ touch(){ :; }; touch src/background-child-shadowed.ts; } & wait`],
      ['pipeline function definition child control', `{ touch(){ :; }; touch src/pipeline-child-shadowed.ts; } | cat`],
      ['coproc function definition child control', `coproc { touch(){ :; }; touch src/coproc-child-shadowed.ts; }; wait`],
      ['coproc inherited function runtime child control', `inherited_read(){ :; }; coproc { inherited_read; }; wait`],
      ['subshell function definition child control', `( touch(){ :; }; touch src/subshell-child-shadowed.ts )`],
      ['background function lifecycle child control', `touch(){ :; }; { unset -f touch; } & wait; touch src/background-lifecycle-shadowed.ts`],
      ['pipeline function lifecycle child control', `touch(){ :; }; { unset -f touch; } | cat; touch src/pipeline-lifecycle-shadowed.ts`],
      ['subshell function lifecycle child control', `touch(){ :; }; ( unset -f touch; ); touch src/subshell-lifecycle-shadowed.ts`],
      ['nested isolation stdout control', `( export POSIXLY_CORRECT=1; ( wget --no-config --no-hsts -O - https://example.test/file ) )`],
      ['function alternative null control', `f(){ export WGETRC=/dev/null; }; if false; then f(){ export WGETRC=/dev/null; }; fi; f; wget --no-config --no-hsts -O - https://example.test/file`],
      ['readonly function mode control', `export WGETRC=/dev/null; readonly -f WGETRC; HOME=/dev/null wget --no-config --no-hsts -O - https://example.test/file`],
      ['case fallthrough read only', `case x in x) : ;& true) printf safe;; esac`],
      ['export n wgetrc control', `export WGETRC=/dev/stdin; export -n WGETRC; HOME=/dev/null wget --no-config --no-hsts -O - https://example.test/file`],
      ['nested export posix stdout', `export POSIXLY_CORRECT=1; sh -c 'wget --no-config --no-hsts -O - https://example.test/file'`],
      ['bashopts lastpipe stdout', `env BASHOPTS=lastpipe bash -c 'true | printf safe; wget --no-config --no-hsts -O - https://example.test/file'`],
      ['wget quiet cluster stdout', `wget --no-config --no-hsts -qO- https://example.test/file`],
      ['case retest fallthrough read only', `case x in x) : ;;& x) printf safe;; esac`],
      ['declare plus x wgetrc control', `export WGETRC=/dev/stdin; declare +x WGETRC; HOME=/dev/null wget --no-config --no-hsts -O - https://example.test/file`],
      ['declare function local stdout', `f(){ declare -x WGETRC=/dev/null; wget --no-config --no-hsts -O - https://example.test/file; }; f`],
      ['arithmetic expansion stdout control', `: $((1 << 2)); wget --no-config --no-hsts -O - https://example.test/file`],
      ['legacy arithmetic expansion stdout control', `: $[1 << 2]; wget --no-config --no-hsts -O - https://example.test/file`],
      ['parameter length expansion stdout control', `: \${#x}; wget --no-config --no-hsts -O - https://example.test/file`],
      ['parameter expansion stdout control', `: \${x:-safe}; wget --no-config --no-hsts -O - https://example.test/file`],
      ['nested clear environment stdout', `export POSIXLY_CORRECT=1; env -i sh -c 'wget --no-config --no-hsts -O - https://example.test/file'`],
      ['parameter assignment expansion stdout', `export POSIXLY_CORRECT; : \${POSIXLY_CORRECT:=1}; wget --no-config --no-hsts -O - https://example.test/file`],
      ['nested exec clear environment stdout', `export POSIXLY_CORRECT=1; exec -c sh -c 'wget --no-config --no-hsts -O - https://example.test/file'`],
      ['curl header stdout control', `curl -q --dump-header - https://example.test/file`],
      ['unset wgetrc then append null control', `export WGETRC=/dev/stdin; unset WGETRC; WGETRC+=/dev/null wget --no-config --no-hsts -O - https://example.test/file`],
      ['process substitution nested read only', `cat <(cat <(printf safe))`],
      ['sed read-only control', `sed -n '1,20p' src/runtime.ts`],
      ['exported child function read only', `f(){ :; }; export -f f; bash -c 'f; wget --no-config --no-hsts -O - https://example.test/file'`],
      ['cleared child function read only', `f(){ :; }; export -f f; env -i bash -c 'wget --no-config --no-hsts -O - https://example.test/file'`],
      ['wgetrc unset control', `export WGETRC=/dev/null; unset WGETRC; HOME=/dev/null wget --no-config --no-hsts -O - https://example.test/file`],
      ['cdpath explicit relative control', `CDPATH=src; cd ./src; wget --no-config --no-hsts -O - https://example.test/file`],
      ['cdpath pushd popd control', `CDPATH=src; pushd ./src; popd; wget --no-config --no-hsts -O - https://example.test/file`],
      ['chmod reference separated metadata control', `chmod --reference .omx/state/reference-copy .omx/state/reference-copy`],
      ['chown reference separated metadata control', `chown --reference .omx/state/reference-copy .omx/state/reference-copy`],
      ['chgrp reference separated metadata control', `chgrp --reference .omx/state/reference-copy .omx/state/reference-copy`],
      ['python isolated metadata cwd control', `cd .omx/state && python3 -I -c "print('ok')"`],
      ['reference metadata control', `chmod --reference=.omx/state/reference-copy .omx/state/reference-copy`],
      ['chown reference metadata control', `chown --reference=.omx/state/reference-copy .omx/state/reference-copy`],
      ['chgrp reference metadata control', `chgrp --reference=.omx/state/reference-copy .omx/state/reference-copy`],
      ['curl cluster stdout control', `curl -q -sD - -o - https://example.test/file`],
      ['rsync metadata log control', `rsync --quiet --log-file=.omx/state/rsync.log .omx/state/conductor-ledger.json .omx/state/inbox/rsync-copy`],
      ['rsync metadata separated log control', `rsync --log-file .omx/state/rsync.log .omx/state/conductor-ledger.json .omx/state/inbox/rsync-copy`],
      ['nonrecursive rsync metadata', `rsync --compress --log-file=.omx/state/rsync-recursive.log .omx/state/conductor-ledger.json .omx/state/inbox/rsync-copy`],
      ['rsync metadata no log control', `rsync .omx/state/conductor-ledger.json .omx/state/inbox/rsync-copy`],
      ['function unset rsync runtime control', `export RSYNC_PARTIAL_DIR=src/rsync-partials; clear(){ unset RSYNC_PARTIAL_DIR; }; clear; rsync .omx/state/conductor-ledger.json .omx/state/inbox/rsync-copy`],
      ['rsync product source metadata control', `rsync README.md .omx/state/inbox/readme.md`],
      ['wget version control', `wget --no-config --no-hsts -V`],
      ['wget value option stdout control', `wget --no-config --no-hsts -t 1 -O - https://example.test/file`],
      ['wget help control', `wget --no-config --no-hsts --help`],
      ['cdpath absolute control', `CDPATH=src; cd /tmp; wget --no-config --no-hsts -O - https://example.test/file`],
      ['function lastpipe option control', `export POSIXLY_CORRECT=1; f(){ shopt -s lastpipe; }; f; g(){ unset POSIXLY_CORRECT; }; true | g; wget --no-config --no-hsts -O src/function-lastpipe-first.ts https://example.test/file -O -`],


      ['wget execute static nonsink stdout', `wget --no-config --no-hsts -e 'timeout=1' -O - https://example.test/file`],
      ['wget bounded connect DNS read timeout control', `wget --no-config --no-hsts --connect-timeout=1 --dns-timeout=1 --read-timeout=1 -O - https://example.test/file`],
      ['nested bash shopt lastpipe control', `bash -O lastpipe -c 'true | printf safe'`],
      ['curl disabled startup stdout', `curl -q --write-out '%output{-}' https://example.test/file`],
      ['curl short write out stdout', `curl -q -w '%output{-}' https://example.test/file`],
      ['curl disable startup stdout', `curl --disable --write-out '%output{-}' https://example.test/file`],
      ['curl inline write out stdout', `curl -q --write-out='%output{-}' https://example.test/file`],
      ['static benign export control', `export GJC_SESSION_ID; cat src/conductor-owned.ts`],
      ['curl SSL key log unset control', `SSLKEYLOGFILE=src/curl-tls.keys env -u SSLKEYLOGFILE curl -q -o - https://example.test/file`],
      ['wget SSL key log unset control', `SSLKEYLOGFILE=src/wget-tls.keys env -u SSLKEYLOGFILE wget --no-config --no-hsts -O - https://example.test/file`],
      ['exported readonly child function control', `f(){ :; }; declare -frx f; bash -c 'f; wget --no-config --no-hsts -O - https://example.test/file'`],
      ['exported redefined child function control', `f(){ :; }; export -f f; f(){ :; }; bash -c 'f; wget --no-config --no-hsts -O - https://example.test/file'`],
      ['cdpath rsync metadata control', `CDPATH=.omx; cd state; rsync --log-file=rsync-cdpath.log conductor-ledger.json inbox/rsync-cdpath-copy`],
      ['pushd cdpath rsync metadata control', `CDPATH=.omx; pushd state; rsync --log-file=rsync-pushd.log conductor-ledger.json inbox/rsync-pushd-copy`],
      ['cdpath prefix cd metadata control', `CDPATH=src cd state; rsync --log-file=../../.omx/state/rsync-prefix-cdpath.log ../../.omx/state/conductor-ledger.json ../../.omx/state/inbox/rsync-prefix-cdpath-copy`],
      ['cdpath local function restores', `CDPATH=.omx; f(){ local CDPATH=src; cd shared; cd ../..; }; f; cd state; rsync --log-file=rsync-local-cdpath.log conductor-ledger.json inbox/rsync-local-cdpath-copy`],
      ['cdpath nested local function restores', `CDPATH=.omx; f(){ local CDPATH=src; g(){ local CDPATH=.omx; cd state; cd ../..; }; g; cd shared; cd ../..; }; f; cd state; rsync --log-file=rsync-nested-local-cdpath.log conductor-ledger.json inbox/rsync-nested-local-cdpath-copy`],
      ['curl static head stdout', `curl -q --request HEAD https://example.test/file`],
      ['wget no proxy standalone stdout control', `wget --no-config --no-hsts --no-proxy -O - https://example.test/file`],
      ['wget quiet standalone stdout control', `wget --no-config --no-hsts -q -O - https://example.test/file`],
      ['wget short quiet standalone stdout control', `wget --no-config --no-hsts -qO- https://example.test/file`],
      ['wget static head stdout', `wget --no-config --no-hsts --method=HEAD -O - https://example.test/file`],
      ['node output clear environment control', `NODE_V8_COVERAGE=src env -i node -e "console.log('ok')"`],
      ['node persistent output clear environment control', `export NODE_V8_COVERAGE=src; env -i node -e "console.log('ok')"`],
      ['path inherited system control', `cat src/conductor-owned.ts`],
      ['absolute system path control', `/usr/bin/cat src/conductor-owned.ts`],
      ['loader clear environment control', `env -i /usr/bin/cat src/conductor-owned.ts`],
      ['loader unrelated declaration control', `export WGETRC=/dev/stdin; declare +x WGETRC; HOME=/dev/null wget --no-config --no-hsts -O - https://example.test/file`],
      ['sort numeric read-only', `sort -n README.md`],
      ['isolated bash login read-only', `bash --noprofile --norc -lc "printf safe"`],
    ] as const) {
      for (const actor of ['main-root', 'native-child'] as const) {
        const output = runActorProbe(
          actor,
          probe,
          'Bash',
          { command },
        );
        if (Object.keys(output).length !== 0) {
          throw new Error(`native hook blocked semantic Node read-only operation: ${actor} ${probe}`);
        }
      }
    }
    for (const actor of ['main-root', 'native-child'] as const) {
      const output = runActorProbe(
        actor,
        'current runtime node bare read',
        'Bash',
        { command: `node -e "require('fs').readFileSync('src/victim.ts','utf8')"` },
        currentRuntimeNodePathEnvironment,
      );
      if (Object.keys(output).length !== 0) {
        throw new Error(`packed ${actor} current runtime bare node should retain read-only allowance`);
      }
    }
    for (const actor of ['main-root', 'native-child'] as const) {
      requireActorDeny(
        actor,
        'current runtime node loader',
        runActorProbe(
          actor,
          'current runtime node loader',
          'Bash',
          { command: `LD_PRELOAD=.omx/state/mutator.so ${currentRuntimeNodePath} -e "require('fs').readFileSync('src/victim.ts','utf8')"` },
        ),
      );
    }
    for (const [probe, command] of [
      ['nested chdir metadata', `env --chdir=src sh -c 'touch ../.omx/state/final.log'`],
      ['touch mode metadata', `touch .omx/state/final.log -m`],
      ['time output metadata', `time --output=.omx/state/time-output.log printf safe`],
    ] as const) {
      if (Object.keys(runActorProbe('main-root', `${probe} main`, 'Bash', { command })).length !== 0) {
        throw new Error(`packed main-root ${probe} should retain metadata allowance`);
      }
      requireActorDeny('native-child', `${probe} native child`, runActorProbe('native-child', `${probe} native child`, 'Bash', { command }));
    }
    for (const actor of ['main-root', 'native-child'] as const) {
      requireActorDeny(actor, 'curl static glob output template', runActorProbe(actor, 'curl static glob output template', 'Bash', {
        command: `curl -q -o .omx/state/curl-glob-#1.log 'https://example.test/file[1-2]'`,
      }));
    }
    const curlBraceTemplateCommand = `curl -q -o .omx/state/curl-brace-#2.log 'https://example.test/{one,two}[1-2]'`;
    for (const actor of ['main-root', 'native-child'] as const) {
      requireActorDeny(actor, 'curl brace glob output template', runActorProbe(actor, 'curl brace glob output template', 'Bash', { command: curlBraceTemplateCommand }));
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

    writeFileSync(join(stateDir, 'sessions', sessionId, 'skill-active-state.json'), JSON.stringify({
      active: true,
      skill: 'ralplan',
      phase: 'planning',
      session_id: sessionId,
      active_skills: [{ skill: 'ralplan', phase: 'planning', active: true, session_id: sessionId }],
    }));
    writeFileSync(join(stateDir, 'sessions', sessionId, 'ralplan-state.json'), JSON.stringify({
      active: true,
      mode: 'ralplan',
      current_phase: 'planning',
      session_id: sessionId,
    }));
    mkdirSync(join(stateDir, 'sessions', leaderAgentId), { recursive: true });
    writeFileSync(join(stateDir, 'sessions', leaderAgentId, 'skill-active-state.json'), JSON.stringify({
      active: true,
      skill: 'ralplan',
      phase: 'planning',
      session_id: leaderAgentId,
      active_skills: [{ skill: 'ralplan', phase: 'planning', active: true, session_id: leaderAgentId }],
    }));
    writeFileSync(join(stateDir, 'sessions', leaderAgentId, 'ralplan-state.json'), JSON.stringify({
      active: true,
      mode: 'ralplan',
      current_phase: 'planning',
      session_id: leaderAgentId,
    }));
    symlinkSync(join(smokeCwd, 'src'), join(smokeCwd, '.omx', 'drafts'));
    for (const actor of ['main-root', 'native-child'] as const) {
      const output = runActorProbe(actor, 'linked planning artifact redirect', 'Bash', {
        command: 'printf owned > .omx/drafts/linked-plan.md',
      });
      if ((output.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision !== 'deny') {
        throw new Error(`packed ${actor} linked planning artifact redirect should be denied`);
      }
    }
    writeFileSync(join(stateDir, 'sessions', sessionId, 'skill-active-state.json'), JSON.stringify({
      active: true,
      skill: 'ralph',
      phase: 'starting',
      session_id: sessionId,
      active_skills: [{ skill: 'ralph', phase: 'starting', active: true, session_id: sessionId }],
    }));
    writeFileSync(join(stateDir, 'sessions', sessionId, 'ralph-state.json'), JSON.stringify({
      active: true,
      mode: 'ralph',
      current_phase: 'starting',
      session_id: sessionId,
    }));
    requireActorDeny('native-child', 'Ralph starting write', runActorProbe('native-child', 'Ralph starting write', 'Write', {
      file_path: 'src/ralph-starting-bypass.ts',
      content: 'owned\n',
    }));
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
