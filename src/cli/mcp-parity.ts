import process from "node:process";

type ToolSchema = {
  name: string;
  description?: string;
};

type ToolHandlerResult = {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
};

type ToolHandler = (request: {
  params: { name: string; arguments?: Record<string, unknown> };
}) => Promise<ToolHandlerResult>;

interface McpCliDescriptor {
  commandName: string;
  title: string;
  tools: ToolSchema[];
  aliases?: Record<string, string>;
  handle: ToolHandler;
}

interface ParsedMcpCliArgs {
  toolName: string | null;
  input: Record<string, unknown>;
  json: boolean;
  help: boolean;
}

type DescriptorLoader = () => Promise<McpCliDescriptor>;
type McpParityCommandName = "state" | "notepad" | "project-memory" | "trace" | "code-intel" | "wiki";

export type McpParityExecutionResult =
  | { ok: true; help: string }
  | { ok: true; data: unknown }
  | { ok: false; error: unknown };

async function importWithAutoStartDisabled<T>(
  envName: string,
  importer: () => Promise<T>,
): Promise<T> {
  const previous = process.env[envName];
  process.env[envName] = "1";
  try {
    return await importer();
  } finally {
    if (typeof previous === "string") process.env[envName] = previous;
    else delete process.env[envName];
  }
}

function buildDescriptorHelp(descriptor: McpCliDescriptor): string {
  const toolLines = descriptor.tools
    .map((tool) => `  - ${tool.name}${tool.description ? ` — ${tool.description}` : ""}`)
    .join("\n");

  return [
    `Usage: omx ${descriptor.commandName} <tool-name> [--input <json>] [--json]`,
    "",
    descriptor.title,
    "",
    "Available tools:",
    toolLines,
    "",
    "Examples:",
    `  omx ${descriptor.commandName} ${descriptor.tools[0]?.name ?? "<tool>"} --input '{}' --json`,
  ].join("\n");
}

function parseInputJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("input JSON must decode to an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Invalid --input JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseMcpCliArgs(args: string[]): ParsedMcpCliArgs {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    return { toolName: null, input: {}, json: false, help: true };
  }

  const [toolName, ...rest] = args;
  let input: Record<string, unknown> = {};
  let json = false;

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--input") {
      const next = rest[i + 1];
      if (!next) throw new Error("Missing value for --input");
      input = parseInputJson(next);
      i += 1;
      continue;
    }
    if (token === "--help" || token === "-h" || token === "help") {
      return { toolName: null, input: {}, json: false, help: true };
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return { toolName, input, json, help: false };
}

function extractPayload(result: ToolHandlerResult): unknown {
  const text = result.content
    ?.filter((entry) => entry.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text as string)
    .join("\n")
    .trim() ?? "";

  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function executeDescriptorCommand(
  args: string[],
  loadDescriptor: DescriptorLoader,
): Promise<McpParityExecutionResult> {
  const descriptor = await loadDescriptor();
  const parsed = parseMcpCliArgs(args);
  if (parsed.help || !parsed.toolName) {
    return { ok: true, help: buildDescriptorHelp(descriptor) };
  }

  const toolName = descriptor.aliases?.[parsed.toolName] ?? parsed.toolName;
  const allowedTools = new Set(descriptor.tools.map((tool) => tool.name));
  if (!allowedTools.has(toolName)) {
    throw new Error(
      `Unknown ${descriptor.commandName} tool: ${parsed.toolName}\n${buildDescriptorHelp(descriptor)}`,
    );
  }

  const result = await descriptor.handle({
    params: {
      name: toolName,
      arguments: parsed.input,
    },
  });
  const payload = extractPayload(result);
  return result.isError
    ? { ok: false, error: payload }
    : { ok: true, data: payload };
}

async function runDescriptorCommand(
  args: string[],
  loadDescriptor: DescriptorLoader,
): Promise<void> {
  const parsed = parseMcpCliArgs(args);
  const result = await executeDescriptorCommand(args, loadDescriptor);
  if ("help" in result) {
    globalThis.console.log(result.help);
    return;
  }
  if (parsed.json) {
    globalThis.console.log(JSON.stringify("data" in result ? result.data : result.error));
  } else if ("data" in result && typeof result.data === "string") {
    globalThis.console.log(result.data);
  } else if ("error" in result && typeof result.error === "string") {
    globalThis.console.log(result.error);
  } else {
    globalThis.console.log(JSON.stringify("data" in result ? result.data : result.error, null, 2));
  }
  if (!result.ok) process.exitCode = 1;
}

async function loadStateDescriptor(): Promise<McpCliDescriptor> {
  const { buildStateServerTools, handleStateToolCall } = await importWithAutoStartDisabled(
    "OMX_STATE_SERVER_DISABLE_AUTO_START",
    async () => await import("../mcp/state-server.js"),
  );
  return {
    commandName: "state",
    title: "JSON CLI surface for OMX state operations.",
    tools: buildStateServerTools().map(({ name, description }) => ({ name, description })),
    aliases: {
      read: "state_read",
      write: "state_write",
      clear: "state_clear",
      "list-active": "state_list_active",
      "get-status": "state_get_status",
    },
    handle: handleStateToolCall,
  };
}

async function loadMemoryDescriptor(
  commandName: "notepad" | "project-memory",
  prefix: "notepad_" | "project_memory_",
  title: string,
): Promise<McpCliDescriptor> {
  const { buildMemoryServerTools, handleMemoryToolCall } = await importWithAutoStartDisabled(
    "OMX_MEMORY_SERVER_DISABLE_AUTO_START",
    async () => await import("../mcp/memory-server.js"),
  );
  return {
    commandName,
    title,
    tools: buildMemoryServerTools()
      .filter((tool) => tool.name.startsWith(prefix))
      .map(({ name, description }) => ({ name, description })),
    aliases: commandName === "notepad"
      ? {
        read: "notepad_read",
        "write-priority": "notepad_write_priority",
        "write-working": "notepad_write_working",
        "write-manual": "notepad_write_manual",
        prune: "notepad_prune",
        stats: "notepad_stats",
      }
      : {
        read: "project_memory_read",
        write: "project_memory_write",
        "add-note": "project_memory_add_note",
        "add-directive": "project_memory_add_directive",
      },
    handle: handleMemoryToolCall,
  };
}

async function loadTraceDescriptor(): Promise<McpCliDescriptor> {
  const { buildTraceServerTools, handleTraceToolCall } = await importWithAutoStartDisabled(
    "OMX_TRACE_SERVER_DISABLE_AUTO_START",
    async () => await import("../mcp/trace-server.js"),
  );
  return {
    commandName: "trace",
    title: "JSON CLI surface for OMX trace operations.",
    tools: buildTraceServerTools().map(({ name, description }) => ({ name, description })),
    aliases: {
      timeline: "trace_timeline",
      summary: "trace_summary",
    },
    handle: handleTraceToolCall,
  };
}

async function loadCodeIntelDescriptor(): Promise<McpCliDescriptor> {
  const { buildCodeIntelServerTools, handleCodeIntelToolCall } = await importWithAutoStartDisabled(
    "OMX_CODE_INTEL_SERVER_DISABLE_AUTO_START",
    async () => await import("../mcp/code-intel-server.js"),
  );
  return {
    commandName: "code-intel",
    title: "JSON CLI surface for OMX code-intel operations.",
    tools: buildCodeIntelServerTools().map(({ name, description }) => ({ name, description })),
    handle: handleCodeIntelToolCall,
  };
}

async function loadWikiDescriptor(): Promise<McpCliDescriptor> {
  const { buildWikiServerTools, handleWikiToolCall } = await importWithAutoStartDisabled(
    "OMX_WIKI_SERVER_DISABLE_AUTO_START",
    async () => await import("../mcp/wiki-server.js"),
  );
  return {
    commandName: "wiki",
    title: "JSON CLI surface for OMX wiki operations.",
    tools: buildWikiServerTools().map(({ name, description }) => ({ name, description })),
    aliases: {
      ingest: "wiki_ingest",
      query: "wiki_query",
      lint: "wiki_lint",
      add: "wiki_add",
      list: "wiki_list",
      read: "wiki_read",
      delete: "wiki_delete",
      refresh: "wiki_refresh",
    },
    handle: handleWikiToolCall,
  };
}

export async function mcpParityCommand(
  commandName: McpParityCommandName,
  args: string[],
): Promise<void> {
  switch (commandName) {
    case "state":
      await runDescriptorCommand(args, loadStateDescriptor);
      return;
    case "notepad":
      await runDescriptorCommand(
        args,
        async () => await loadMemoryDescriptor("notepad", "notepad_", "JSON CLI surface for OMX notepad operations."),
      );
      return;
    case "project-memory":
      await runDescriptorCommand(
        args,
        async () => await loadMemoryDescriptor(
          "project-memory",
          "project_memory_",
          "JSON CLI surface for OMX project-memory operations.",
        ),
      );
      return;
    case "trace":
      await runDescriptorCommand(args, loadTraceDescriptor);
      return;
    case "code-intel":
      await runDescriptorCommand(args, loadCodeIntelDescriptor);
      return;
    case "wiki":
      await runDescriptorCommand(args, loadWikiDescriptor);
      return;
  }
}

export async function executeMcpParityCommand(
  commandName: McpParityCommandName,
  args: string[],
): Promise<McpParityExecutionResult> {
  switch (commandName) {
    case "state":
      return await executeDescriptorCommand(args, loadStateDescriptor);
    case "notepad":
      return await executeDescriptorCommand(
        args,
        async () => await loadMemoryDescriptor("notepad", "notepad_", "JSON CLI surface for OMX notepad operations."),
      );
    case "project-memory":
      return await executeDescriptorCommand(
        args,
        async () => await loadMemoryDescriptor(
          "project-memory",
          "project_memory_",
          "JSON CLI surface for OMX project-memory operations.",
        ),
      );
    case "trace":
      return await executeDescriptorCommand(args, loadTraceDescriptor);
    case "code-intel":
      return await executeDescriptorCommand(args, loadCodeIntelDescriptor);
    case "wiki":
      return await executeDescriptorCommand(args, loadWikiDescriptor);
  }
}
