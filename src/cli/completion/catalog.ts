import { ASK_PROVIDERS } from '../ask.js';
import { AGENTS_SUBCOMMANDS } from '../agents.js';
import { AUTORESEARCH_SUBCOMMANDS } from '../autoresearch.js';
import { HOOKS_SUBCOMMANDS } from '../hooks.js';
import { SESSION_SUBCOMMANDS } from '../session-search.js';
import { STATE_OPERATION_MAP } from '../state.js';
import { TEAM_CLI_SUBCOMMANDS } from '../team.js';
import { TMUX_HOOK_SUBCOMMANDS } from '../tmux-hook.js';
import { TOP_LEVEL_CLI_COMMANDS } from '../top-level-commands.js';
import { TEAM_API_OPERATIONS } from '../../team/api-interop.js';

export interface CompletionOptionSpec {
  flags: string[];
  values?: string[];
}

export interface CompletionNode {
  name: string;
  subcommands?: CompletionNode[];
  options?: CompletionOptionSpec[];
  positionalValues?: string[];
}

const LOCAL_HELP_OPTION: CompletionOptionSpec = {
  flags: ['--help', '-h'],
};

function option(flags: string[], values?: readonly string[]): CompletionOptionSpec {
  return {
    flags: [...flags],
    ...(values && values.length > 0 ? { values: [...values] } : {}),
  };
}

function node(name: string, spec: Omit<CompletionNode, 'name'> = {}): CompletionNode {
  const existing = spec.options ?? [];
  const seen = new Set<string>();
  const merged = [...existing, LOCAL_HELP_OPTION].filter((entry) => {
    const key = entry.flags.join('\u0000');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    name,
    ...(spec.subcommands ? { subcommands: spec.subcommands } : {}),
    ...(merged.length > 0 ? { options: merged } : {}),
    ...(spec.positionalValues && spec.positionalValues.length > 0
      ? { positionalValues: [...spec.positionalValues] }
      : {}),
  };
}

function repeatOptions(
  names: readonly string[],
  options: readonly CompletionOptionSpec[],
): CompletionNode[] {
  return names.map((name) => node(name, { options: [...options] }));
}

function buildTopLevelCommandNames(): string[] {
  return TOP_LEVEL_CLI_COMMANDS.map((entry) => entry.name);
}

async function loadMcpToolNames(): Promise<{
  notepad: string[];
  projectMemory: string[];
  trace: string[];
  codeIntel: string[];
  wiki: string[];
}> {
  const envState = process.env.OMX_STATE_SERVER_DISABLE_AUTO_START;
  const envMemory = process.env.OMX_MEMORY_SERVER_DISABLE_AUTO_START;
  const envTrace = process.env.OMX_TRACE_SERVER_DISABLE_AUTO_START;
  const envCodeIntel = process.env.OMX_CODE_INTEL_SERVER_DISABLE_AUTO_START;
  const envWiki = process.env.OMX_WIKI_SERVER_DISABLE_AUTO_START;

  process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
  process.env.OMX_MEMORY_SERVER_DISABLE_AUTO_START = '1';
  process.env.OMX_TRACE_SERVER_DISABLE_AUTO_START = '1';
  process.env.OMX_CODE_INTEL_SERVER_DISABLE_AUTO_START = '1';
  process.env.OMX_WIKI_SERVER_DISABLE_AUTO_START = '1';

  try {
    const [
      { buildMemoryServerTools },
      { buildTraceServerTools },
      { buildCodeIntelServerTools },
      { buildWikiServerTools },
    ] = await Promise.all([
      import('../../mcp/memory-server.js'),
      import('../../mcp/trace-server.js'),
      import('../../mcp/code-intel-server.js'),
      import('../../mcp/wiki-server.js'),
    ]);

    const notepadAliases: Record<string, string> = {
      read: 'notepad_read',
      'write-priority': 'notepad_write_priority',
      'write-working': 'notepad_write_working',
      'write-manual': 'notepad_write_manual',
      prune: 'notepad_prune',
      stats: 'notepad_stats',
    };
    const projectMemoryAliases: Record<string, string> = {
      read: 'project_memory_read',
      write: 'project_memory_write',
      'add-note': 'project_memory_add_note',
      'add-directive': 'project_memory_add_directive',
    };
    const traceAliases: Record<string, string> = {
      timeline: 'trace_timeline',
      summary: 'trace_summary',
    };
    const wikiAliases: Record<string, string> = {
      ingest: 'wiki_ingest',
      query: 'wiki_query',
      lint: 'wiki_lint',
      add: 'wiki_add',
      list: 'wiki_list',
      read: 'wiki_read',
      delete: 'wiki_delete',
      refresh: 'wiki_refresh',
    };

    const namesFromAliases = (
      tools: Array<{ name: string }>,
      aliases: Record<string, string>,
      prefix?: string,
    ): string[] => {
      const out = new Set<string>();
      const aliasedTargets = new Set<string>();
      for (const [alias, target] of Object.entries(aliases)) {
        if (tools.some((tool) => tool.name === target)) {
          out.add(alias);
          aliasedTargets.add(target);
        }
      }
      if (prefix) {
        for (const tool of tools) {
          if (!tool.name.startsWith(prefix) || aliasedTargets.has(tool.name)) continue;
          out.add(tool.name.slice(prefix.length));
        }
      }
      return [...out].sort();
    };

    return {
      notepad: namesFromAliases(buildMemoryServerTools(), notepadAliases, 'notepad_'),
      projectMemory: namesFromAliases(buildMemoryServerTools(), projectMemoryAliases, 'project_memory_'),
      trace: namesFromAliases(buildTraceServerTools(), traceAliases, 'trace_'),
      codeIntel: buildCodeIntelServerTools().map((tool) => tool.name).sort(),
      wiki: namesFromAliases(buildWikiServerTools(), wikiAliases, 'wiki_'),
    };
  } finally {
    if (typeof envState === 'string') process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = envState;
    else delete process.env.OMX_STATE_SERVER_DISABLE_AUTO_START;
    if (typeof envMemory === 'string') process.env.OMX_MEMORY_SERVER_DISABLE_AUTO_START = envMemory;
    else delete process.env.OMX_MEMORY_SERVER_DISABLE_AUTO_START;
    if (typeof envTrace === 'string') process.env.OMX_TRACE_SERVER_DISABLE_AUTO_START = envTrace;
    else delete process.env.OMX_TRACE_SERVER_DISABLE_AUTO_START;
    if (typeof envCodeIntel === 'string') process.env.OMX_CODE_INTEL_SERVER_DISABLE_AUTO_START = envCodeIntel;
    else delete process.env.OMX_CODE_INTEL_SERVER_DISABLE_AUTO_START;
    if (typeof envWiki === 'string') process.env.OMX_WIKI_SERVER_DISABLE_AUTO_START = envWiki;
    else delete process.env.OMX_WIKI_SERVER_DISABLE_AUTO_START;
  }
}

export async function buildCompletionCatalog(): Promise<CompletionNode> {
  const mcpToolNames = await loadMcpToolNames();

  const ioOptions = [option(['--input']), option(['--json'])] as const;
  const teamStateSubcommands = TEAM_CLI_SUBCOMMANDS.map((name) => {
    switch (name) {
      case 'status':
        return node(name, { options: [option(['--json']), option(['--tail-lines'])] });
      case 'await':
        return node(name, { options: [option(['--timeout-ms']), option(['--after-event-id']), option(['--json'])] });
      case 'shutdown':
        return node(name, { options: [option(['--force']), option(['--confirm-issues'])] });
      case 'api':
        return node(name, { subcommands: repeatOptions(TEAM_API_OPERATIONS, ioOptions), options: [...ioOptions] });
      default:
        return node(name);
    }
  });

  return {
    name: '__root__',
    options: [
      option(['--help', '-h']),
      option(['--version', '-v']),
      option(['--yolo']),
      option(['--high']),
      option(['--xhigh']),
      option(['--madmax']),
      option(['--spark']),
      option(['--madmax-spark']),
      option(['--notify-temp']),
      option(['--tmux']),
      option(['--discord']),
      option(['--slack']),
      option(['--telegram']),
      option(['--custom']),
      option(['--worktree', '-w']),
    ],
    subcommands: [
      node('launch', {
        options: [
          option(['--yolo']),
          option(['--high']),
          option(['--xhigh']),
          option(['--madmax']),
          option(['--spark']),
          option(['--madmax-spark']),
          option(['--notify-temp']),
          option(['--tmux']),
          option(['--discord']),
          option(['--slack']),
          option(['--telegram']),
          option(['--custom']),
          option(['--worktree', '-w']),
        ],
      }),
      node('exec', {
        options: [
          option(['--help', '-h']),
          option(['--yolo']),
          option(['--high']),
          option(['--xhigh']),
          option(['--madmax']),
          option(['--notify-temp']),
          option(['--discord']),
          option(['--slack']),
          option(['--telegram']),
          option(['--custom']),
          option(['--worktree', '-w']),
        ],
      }),
      node('setup', {
        options: [option(['--force']), option(['--dry-run']), option(['--verbose']), option(['--scope'], ['user', 'project']), option(['--skill-target'], ['codex-home'])],
      }),
      node('agents', {
        subcommands: AGENTS_SUBCOMMANDS.map((name) => node(name, { options: [option(['--scope'], ['user', 'project']), ...(name === 'add' || name === 'remove' ? [option(['--force'])] : [])] })),
      }),
      node('agents-init', { options: [option(['--dry-run']), option(['--force']), option(['--verbose'])] }),
      node('deepinit', { options: [option(['--dry-run']), option(['--force']), option(['--verbose'])] }),
      node('uninstall', { options: [option(['--dry-run']), option(['--keep-config']), option(['--verbose']), option(['--purge']), option(['--scope'], ['user', 'project'])] }),
      node('doctor', { options: [option(['--team']), option(['--verbose'])] }),
      node('cleanup', { options: [option(['--dry-run'])] }),
      node('ask', { positionalValues: [...ASK_PROVIDERS], options: [option(['-p', '--prompt', '--print']), option(['--agent-prompt'])] }),
      node('resume'),
      node('explore', { options: [option(['--prompt']), option(['--prompt-file'])] }),
      node('session', {
        subcommands: SESSION_SUBCOMMANDS.map((name) => node(name, {
          options: [
            option(['--limit']),
            option(['--session']),
            option(['--since']),
            option(['--project'], ['current', 'all']),
            option(['--context']),
            option(['--case-sensitive']),
            option(['--json']),
          ],
        })),
      }),
      node('team', {
        subcommands: teamStateSubcommands,
        options: [option(['--help', '-h'])],
      }),
      node('ralph'),
      node('autoresearch', {
        subcommands: AUTORESEARCH_SUBCOMMANDS.map((name) => node(name)),
        options: [option(['--topic']), option(['--evaluator']), option(['--keep-policy']), option(['--slug']), option(['--resume'])],
      }),
      node('completion', { positionalValues: ['bash', 'zsh', 'fish', 'powershell'] }),
      node('version'),
      node('tmux-hook', { subcommands: repeatOptions(TMUX_HOOK_SUBCOMMANDS, []) }),
      node('hooks', { subcommands: repeatOptions(HOOKS_SUBCOMMANDS, []) }),
      node('hud', { options: [option(['--watch']), option(['--json']), option(['--preset'])] }),
      node('state', {
        subcommands: repeatOptions(Object.keys(STATE_OPERATION_MAP), ioOptions),
      }),
      node('notepad', { subcommands: repeatOptions(mcpToolNames.notepad, ioOptions), options: [...ioOptions] }),
      node('project-memory', { subcommands: repeatOptions(mcpToolNames.projectMemory, ioOptions), options: [...ioOptions] }),
      node('trace', { subcommands: repeatOptions(mcpToolNames.trace, ioOptions), options: [...ioOptions] }),
      node('code-intel', { subcommands: repeatOptions(mcpToolNames.codeIntel, ioOptions), options: [...ioOptions] }),
      node('wiki', { subcommands: repeatOptions(mcpToolNames.wiki, ioOptions), options: [...ioOptions] }),
      node('sparkshell', { options: [option(['--tmux-pane']), option(['--tail-lines'])] }),
      node('help'),
      node('status'),
      node('cancel'),
      node('reasoning', { positionalValues: ['low', 'medium', 'high', 'xhigh'] }),
      // Keep top-level names aligned with the shared CLI surface, including hidden aliases.
      ...buildTopLevelCommandNames()
        .filter((name) => ![
          'launch',
          'exec',
          'setup',
          'agents',
          'agents-init',
          'deepinit',
          'uninstall',
          'doctor',
          'cleanup',
          'ask',
          'resume',
          'explore',
          'session',
          'team',
          'ralph',
          'autoresearch',
          'completion',
          'version',
          'tmux-hook',
          'hooks',
          'hud',
          'state',
          'notepad',
          'project-memory',
          'trace',
          'code-intel',
          'wiki',
          'sparkshell',
          'help',
          'status',
          'cancel',
          'reasoning',
        ].includes(name))
        .map((name) => node(name)),
    ],
  };
}
