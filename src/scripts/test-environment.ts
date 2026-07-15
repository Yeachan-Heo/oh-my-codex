import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const MODEL_ENV_KEYS = [
  'ANTHROPIC_MODEL',
  'CLAUDE_MODEL',
  'CODEX_MODEL',
  'OPENAI_MODEL',
  'OMX_DEFAULT_FRONTIER_MODEL',
  'OMX_DEFAULT_MODEL',
  'OMX_DEFAULT_SPARK_MODEL',
  'OMX_MODEL',
  'OMX_SPARK_MODEL',
  'OMX_TEAM_WORKER_LAUNCH_ARGS',
] as const;

export interface HermeticTestEnvironment {
  sandboxRoot: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

export interface HermeticTestEnvironmentOptions {
  baseEnv?: NodeJS.ProcessEnv;
  packageRoot: string;
  isolateCwd: boolean;
  prefix?: string;
  preserveRuntimeEnv?: boolean;
}

function isRuntimeEnvironmentKey(key: string): boolean {
  return key.startsWith('OMX_')
    || key.startsWith('OMXBOX_')
    || key.startsWith('CODEX_')
    || key === 'USE_OMX_EXPLORE_CMD'
    || key === 'SESSION_ID'
    || key === 'TMUX'
    || key === 'TMUX_PANE';
}

function configureHermeticEnvironment(
  sandboxRoot: string,
  options: HermeticTestEnvironmentOptions,
): Omit<HermeticTestEnvironment, 'cleanup'> {
  const home = join(sandboxRoot, 'home');
  const xdgConfig = join(sandboxRoot, 'xdg-config');
  const codexHome = join(sandboxRoot, 'codex-home');
  const claudeConfig = join(sandboxRoot, 'claude-config');
  const npmCache = join(sandboxRoot, 'npm-cache');
  const npmUserConfig = join(sandboxRoot, 'npmrc');
  const project = join(sandboxRoot, 'project');
  for (const directory of [home, xdgConfig, codexHome, claudeConfig, npmCache, project]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(npmUserConfig, '', { flag: 'wx' });

  const env = { ...(options.baseEnv ?? process.env) };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase().startsWith('npm_config_')
      || key.startsWith('LC_')
      || (!options.preserveRuntimeEnv && isRuntimeEnvironmentKey(key))) delete env[key];
  }
  for (const key of MODEL_ENV_KEYS) delete env[key];
  delete env.LANGUAGE;

  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: xdgConfig,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeConfig,
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
    npm_config_cache: npmCache,
    npm_config_update_notifier: 'false',
    npm_config_userconfig: npmUserConfig,
    OMX_TEST_PACKAGE_ROOT: resolve(options.packageRoot),
    OMX_TEST_SANDBOX: sandboxRoot,
    OMX_TEST_CWD: options.isolateCwd ? project : resolve(options.packageRoot),
  });

  return {
    sandboxRoot,
    cwd: options.isolateCwd ? project : resolve(options.packageRoot),
    env,
  };
}

export function createHermeticTestEnvironment(
  options: HermeticTestEnvironmentOptions,
): HermeticTestEnvironment {
  const sandboxRoot = realpathSync(mkdtempSync(join(tmpdir(), options.prefix ?? 'omx-node-test-')));
  const configured = configureHermeticEnvironment(sandboxRoot, options);
  let cleaned = false;
  return {
    ...configured,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      rmSync(sandboxRoot, { recursive: true, force: true });
    },
  };
}

export function prepareHermeticTestEnvironment(
  sandboxRoot: string,
  options: HermeticTestEnvironmentOptions,
): Omit<HermeticTestEnvironment, 'cleanup'> {
  mkdirSync(sandboxRoot, { recursive: true });
  return configureHermeticEnvironment(realpathSync(sandboxRoot), options);
}
