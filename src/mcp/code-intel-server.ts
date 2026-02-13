/**
 * OMX Code Intelligence MCP Server
 * Provides LSP-like diagnostics, symbol search, and AST pattern matching.
 * Uses pragmatic CLI wrappers (tsc, ast-grep/sg) rather than full LSP protocol.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { execFile } from 'child_process';
import { readFile, readdir } from 'fs/promises';
import { join, relative, extname, basename } from 'path';
import { existsSync } from 'fs';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ── Helpers ──────────────────────────────────────────────────────────────────

function cwd(wd?: string): string {
  return wd || process.cwd();
}

function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(msg: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true };
}

async function exec(cmd: string, args: string[], options: { cwd?: string; timeout?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(cmd, args, {
      cwd: options.cwd,
      timeout: options.timeout || 30000,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    // tsc returns exit code 2 for type errors but stdout still has the output
    if (e.stdout !== undefined) {
      return { stdout: e.stdout || '', stderr: e.stderr || '' };
    }
    throw err;
  }
}

// ── Diagnostics (tsc --noEmit wrapper) ────────────────────────────────────

interface Diagnostic {
  file: string;
  line: number;
  character: number;
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

function parseTscOutput(output: string, projectDir: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  // tsc format: src/foo.ts(10,5): error TS2304: Cannot find name 'x'.
  const re = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/gm;
  let match;
  while ((match = re.exec(output)) !== null) {
    diagnostics.push({
      file: join(projectDir, match[1]),
      line: parseInt(match[2], 10),
      character: parseInt(match[3], 10),
      severity: match[4] as 'error' | 'warning',
      code: match[5],
      message: match[6],
    });
  }
  return diagnostics;
}

async function findTsconfig(dir: string): Promise<string | null> {
  const candidates = ['tsconfig.json', 'tsconfig.build.json'];
  for (const c of candidates) {
    if (existsSync(join(dir, c))) return join(dir, c);
  }
  return null;
}

async function runTscDiagnostics(
  target: string,
  projectDir: string,
  severity?: string
): Promise<{ diagnostics: Diagnostic[]; command: string }> {
  const tsconfig = await findTsconfig(projectDir);
  const args = ['--noEmit', '--pretty', 'false'];
  if (tsconfig) {
    args.push('--project', tsconfig);
  }

  const { stdout, stderr } = await exec('npx', ['tsc', ...args], { cwd: projectDir, timeout: 60000 });
  const output = stdout + '\n' + stderr;
  let diagnostics = parseTscOutput(output, projectDir);

  // Filter to specific file if target is a file (not directory)
  if (target && !target.endsWith('/') && existsSync(target)) {
    diagnostics = diagnostics.filter(d => d.file === target || d.file.endsWith('/' + basename(target)));
  }

  // Filter by severity
  if (severity && severity !== 'error') {
    // tsc only emits errors, so warning/info/hint filters return empty
  }

  return { diagnostics, command: `npx tsc ${args.join(' ')}` };
}

// ── Symbol extraction (regex-based) ─────────────────────────────────────────

interface DocumentSymbol {
  name: string;
  kind: string;
  line: number;
  character: number;
  endLine?: number;
}

const SYMBOL_PATTERNS: Array<{ kind: string; re: RegExp }> = [
  // TypeScript/JavaScript
  { kind: 'function', re: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/m },
  { kind: 'class', re: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/m },
  { kind: 'interface', re: /^(?:export\s+)?interface\s+(\w+)/m },
  { kind: 'type', re: /^(?:export\s+)?type\s+(\w+)\s*=/m },
  { kind: 'enum', re: /^(?:export\s+)?(?:const\s+)?enum\s+(\w+)/m },
  { kind: 'variable', re: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[=:]/m },
  { kind: 'method', re: /^\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*\w+)?\s*\{/m },
  { kind: 'property', re: /^\s+(?:readonly\s+)?(\w+)\s*[?:].*[;,]$/m },
  // Python
  { kind: 'function', re: /^(?:async\s+)?def\s+(\w+)/m },
  { kind: 'class', re: /^class\s+(\w+)/m },
  // Go
  { kind: 'function', re: /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/m },
  { kind: 'type', re: /^type\s+(\w+)\s+(?:struct|interface)/m },
  // Rust
  { kind: 'function', re: /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/m },
  { kind: 'struct', re: /^(?:pub\s+)?struct\s+(\w+)/m },
  { kind: 'enum', re: /^(?:pub\s+)?enum\s+(\w+)/m },
  { kind: 'trait', re: /^(?:pub\s+)?trait\s+(\w+)/m },
  { kind: 'impl', re: /^impl(?:<[^>]+>)?\s+(\w+)/m },
];

function extractSymbols(content: string): DocumentSymbol[] {
  const symbols: DocumentSymbol[] = [];
  const lines = content.split('\n');
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { kind, re } of SYMBOL_PATTERNS) {
      const match = line.match(re);
      if (match && match[1]) {
        const key = `${kind}:${match[1]}:${i}`;
        if (!seen.has(key)) {
          seen.add(key);
          symbols.push({
            name: match[1],
            kind,
            line: i + 1,
            character: line.indexOf(match[1]),
          });
        }
      }
    }
  }
  return symbols;
}

// ── AST-grep wrapper ────────────────────────────────────────────────────────

async function findSgBinary(): Promise<string | null> {
  for (const bin of ['sg', 'ast-grep']) {
    try {
      await execFileAsync('which', [bin]);
      return bin;
    } catch { /* not found */ }
  }
  // Try npx
  try {
    await execFileAsync('npx', ['--yes', '@ast-grep/cli', '--version'], { timeout: 15000 });
    return 'npx-ast-grep';
  } catch { /* not available */ }
  return null;
}

async function runAstGrep(
  pattern: string,
  language: string,
  options: { path?: string; maxResults?: number; context?: number; replacement?: string; dryRun?: boolean }
): Promise<{ matches: unknown[]; command: string }> {
  const sg = await findSgBinary();
  if (!sg) {
    return { matches: [], command: 'ast-grep not installed. Install: npm i -g @ast-grep/cli' };
  }

  const args: string[] = [];
  const cmd = sg === 'npx-ast-grep' ? 'npx' : sg;
  if (sg === 'npx-ast-grep') {
    args.push('--yes', '@ast-grep/cli');
  }

  if (options.replacement && !options.dryRun) {
    // Rewrite mode
    args.push('run', '--pattern', pattern, '--rewrite', options.replacement, '--lang', language);
  } else if (options.replacement && options.dryRun) {
    // Dry run rewrite
    args.push('run', '--pattern', pattern, '--rewrite', options.replacement, '--lang', language);
  } else {
    // Search mode
    args.push('run', '--pattern', pattern, '--lang', language, '--json');
  }

  if (options.path) {
    args.push(options.path);
  }

  try {
    const { stdout } = await exec(cmd, args, { timeout: 30000 });
    try {
      const results = JSON.parse(stdout);
      const matches = Array.isArray(results) ? results : [results];
      return {
        matches: options.maxResults ? matches.slice(0, options.maxResults) : matches,
        command: `${cmd} ${args.join(' ')}`,
      };
    } catch {
      // Non-JSON output (rewrite mode)
      return { matches: [{ output: stdout }], command: `${cmd} ${args.join(' ')}` };
    }
  } catch (err) {
    return { matches: [], command: `${cmd} ${args.join(' ')} (failed: ${(err as Error).message})` };
  }
}

// ── Workspace symbol search ─────────────────────────────────────────────────

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h',
  '.cs', '.rb', '.swift', '.kt', '.scala', '.vue', '.svelte',
]);

async function searchWorkspaceSymbols(
  query: string,
  dir: string,
  maxResults: number = 50
): Promise<DocumentSymbol[]> {
  const results: (DocumentSymbol & { file: string })[] = [];

  async function walk(d: string, depth: number): Promise<void> {
    if (depth > 6 || results.length >= maxResults) return;
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (results.length >= maxResults) break;
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__pycache__') continue;
        await walk(full, depth + 1);
      } else if (entry.isFile() && CODE_EXTENSIONS.has(extname(entry.name))) {
        try {
          const content = await readFile(full, 'utf-8');
          const symbols = extractSymbols(content);
          for (const sym of symbols) {
            if (sym.name.toLowerCase().includes(query.toLowerCase())) {
              results.push({ ...sym, file: relative(dir, full) });
            }
          }
        } catch { /* skip unreadable */ }
      }
    }
  }

  await walk(dir, 0);
  return results.slice(0, maxResults);
}

// ── MCP Server ──────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'omx-code-intel', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'lsp_diagnostics',
      description: 'Get diagnostics (errors, warnings) for a file. Uses tsc --noEmit for TypeScript projects.',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Path to the source file' },
          severity: { type: 'string', enum: ['error', 'warning', 'info', 'hint'] },
        },
        required: ['file'],
      },
    },
    {
      name: 'lsp_diagnostics_directory',
      description: 'Run project-level diagnostics on a directory using tsc --noEmit. Returns all errors across the project.',
      inputSchema: {
        type: 'object',
        properties: {
          directory: { type: 'string', description: 'Project directory to check' },
          strategy: { type: 'string', enum: ['tsc', 'auto'], description: 'Diagnostic strategy (default: auto)' },
        },
        required: ['directory'],
      },
    },
    {
      name: 'lsp_document_symbols',
      description: 'Get a hierarchical outline of all symbols in a file (functions, classes, variables, etc.).',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Path to the source file' },
        },
        required: ['file'],
      },
    },
    {
      name: 'lsp_workspace_symbols',
      description: 'Search for symbols (functions, classes, etc.) across the workspace by name.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Symbol name or pattern to search' },
          file: { type: 'string', description: 'Any file in the workspace (used to determine project root)' },
        },
        required: ['query', 'file'],
      },
    },
    {
      name: 'lsp_hover',
      description: 'Get type information and documentation at a specific position in a file (regex-based approximation).',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Path to the source file' },
          line: { type: 'integer', description: 'Line number (1-indexed)' },
          character: { type: 'integer', description: 'Character position (0-indexed)' },
        },
        required: ['file', 'line', 'character'],
      },
    },
    {
      name: 'lsp_find_references',
      description: 'Find all references to a symbol across the codebase using grep-based search.',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Path to the source file' },
          line: { type: 'integer', description: 'Line number (1-indexed)' },
          character: { type: 'integer', description: 'Character position (0-indexed)' },
          includeDeclaration: { type: 'boolean' },
        },
        required: ['file', 'line', 'character'],
      },
    },
    {
      name: 'lsp_servers',
      description: 'List available diagnostic backends and their installation status.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'ast_grep_search',
      description: 'Search for code patterns using AST matching. Uses meta-variables: $NAME (single node), $$$ARGS (multiple nodes). Example: "function $NAME($$$ARGS)" finds all function declarations.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'AST pattern with meta-variables ($VAR, $$$VARS)' },
          language: {
            type: 'string',
            enum: ['javascript', 'typescript', 'tsx', 'python', 'ruby', 'go', 'rust', 'java', 'kotlin', 'swift', 'c', 'cpp', 'csharp', 'html', 'css', 'json', 'yaml'],
          },
          path: { type: 'string', description: 'Directory or file to search in' },
          maxResults: { type: 'integer' },
          context: { type: 'integer' },
        },
        required: ['pattern', 'language'],
      },
    },
    {
      name: 'ast_grep_replace',
      description: 'Replace code patterns using AST matching. Use meta-variables in both pattern and replacement. IMPORTANT: dryRun=true (default) only previews changes. Set dryRun=false to apply.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Pattern to match' },
          replacement: { type: 'string', description: 'Replacement pattern (use same meta-variables)' },
          language: {
            type: 'string',
            enum: ['javascript', 'typescript', 'tsx', 'python', 'ruby', 'go', 'rust', 'java', 'kotlin', 'swift', 'c', 'cpp', 'csharp', 'html', 'css', 'json', 'yaml'],
          },
          path: { type: 'string' },
          dryRun: { type: 'boolean', description: 'Preview only (default: true)' },
        },
        required: ['pattern', 'replacement', 'language'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args || {}) as Record<string, unknown>;

  switch (name) {
    case 'lsp_diagnostics': {
      const file = a.file as string;
      if (!file) return errorResult('file is required');
      const dir = join(file, '..');
      // Walk up to find project root (where tsconfig.json is)
      let projectDir = dir;
      for (let i = 0; i < 10; i++) {
        if (existsSync(join(projectDir, 'tsconfig.json')) || existsSync(join(projectDir, 'package.json'))) break;
        const parent = join(projectDir, '..');
        if (parent === projectDir) break;
        projectDir = parent;
      }
      const result = await runTscDiagnostics(file, projectDir, a.severity as string);
      return text({
        file,
        diagnosticCount: result.diagnostics.length,
        diagnostics: result.diagnostics,
        command: result.command,
      });
    }

    case 'lsp_diagnostics_directory': {
      const dir = a.directory as string;
      if (!dir) return errorResult('directory is required');
      const result = await runTscDiagnostics('', dir, a.severity as string);
      // Group by file
      const byFile: Record<string, Diagnostic[]> = {};
      for (const d of result.diagnostics) {
        const rel = relative(dir, d.file);
        if (!byFile[rel]) byFile[rel] = [];
        byFile[rel].push(d);
      }
      return text({
        directory: dir,
        totalErrors: result.diagnostics.filter(d => d.severity === 'error').length,
        totalWarnings: result.diagnostics.filter(d => d.severity === 'warning').length,
        fileCount: Object.keys(byFile).length,
        diagnosticsByFile: byFile,
        command: result.command,
      });
    }

    case 'lsp_document_symbols': {
      const file = a.file as string;
      if (!file) return errorResult('file is required');
      if (!existsSync(file)) return errorResult(`File not found: ${file}`);
      const content = await readFile(file, 'utf-8');
      const symbols = extractSymbols(content);
      return text({ file, symbolCount: symbols.length, symbols });
    }

    case 'lsp_workspace_symbols': {
      const query = a.query as string;
      const file = a.file as string;
      if (!query) return errorResult('query is required');
      // Determine project root from file
      let dir = file ? join(file, '..') : process.cwd();
      for (let i = 0; i < 10; i++) {
        if (existsSync(join(dir, 'package.json')) || existsSync(join(dir, '.git'))) break;
        const parent = join(dir, '..');
        if (parent === dir) break;
        dir = parent;
      }
      const symbols = await searchWorkspaceSymbols(query, dir);
      return text({ query, resultCount: symbols.length, symbols });
    }

    case 'lsp_hover': {
      const file = a.file as string;
      const line = a.line as number;
      const char = a.character as number;
      if (!file || !line) return errorResult('file and line are required');
      if (!existsSync(file)) return errorResult(`File not found: ${file}`);
      const content = await readFile(file, 'utf-8');
      const lines = content.split('\n');
      const targetLine = lines[line - 1] || '';
      // Extract word at position
      let start = char, end = char;
      while (start > 0 && /\w/.test(targetLine[start - 1])) start--;
      while (end < targetLine.length && /\w/.test(targetLine[end])) end++;
      const word = targetLine.slice(start, end);
      // Find definition in file
      const symbols = extractSymbols(content);
      const match = symbols.find(s => s.name === word);
      return text({
        file,
        position: { line, character: char },
        word,
        lineContent: targetLine.trim(),
        localDefinition: match || null,
        note: 'Regex-based approximation. For full LSP hover, install a language server.',
      });
    }

    case 'lsp_find_references': {
      const file = a.file as string;
      const line = a.line as number;
      const char = a.character as number;
      if (!file || !line) return errorResult('file and line are required');
      const content = await readFile(file, 'utf-8');
      const lines = content.split('\n');
      const targetLine = lines[line - 1] || '';
      let start = char, end = char;
      while (start > 0 && /\w/.test(targetLine[start - 1])) start--;
      while (end < targetLine.length && /\w/.test(targetLine[end])) end++;
      const symbol = targetLine.slice(start, end);
      if (!symbol) return errorResult('Could not identify symbol at position');

      // Use grep to find references
      let dir = join(file, '..');
      for (let i = 0; i < 10; i++) {
        if (existsSync(join(dir, 'package.json')) || existsSync(join(dir, '.git'))) break;
        const parent = join(dir, '..');
        if (parent === dir) break;
        dir = parent;
      }
      try {
        const { stdout } = await exec('grep', [
          '-rn', '--include=*.ts', '--include=*.tsx', '--include=*.js', '--include=*.jsx',
          '--include=*.py', '--include=*.go', '--include=*.rs',
          '-w', symbol, dir,
        ], { timeout: 15000 });
        const refs = stdout.split('\n').filter(Boolean).map(line => {
          const match = line.match(/^(.+?):(\d+):(.+)$/);
          if (!match) return null;
          return { file: match[1], line: parseInt(match[2], 10), content: match[3].trim() };
        }).filter(Boolean);
        return text({ symbol, referenceCount: refs.length, references: refs.slice(0, 100) });
      } catch {
        return text({ symbol, referenceCount: 0, references: [], note: 'grep search returned no results' });
      }
    }

    case 'lsp_servers': {
      const checks: Record<string, { available: boolean; version?: string; note?: string }> = {};
      // Check tsc
      try {
        const { stdout } = await exec('npx', ['tsc', '--version'], { timeout: 10000 });
        checks['typescript'] = { available: true, version: stdout.trim() };
      } catch {
        checks['typescript'] = { available: false, note: 'Install: npm i -D typescript' };
      }
      // Check ast-grep
      const sg = await findSgBinary();
      if (sg) {
        checks['ast-grep'] = { available: true, version: sg };
      } else {
        checks['ast-grep'] = { available: false, note: 'Install: npm i -g @ast-grep/cli' };
      }
      // Check grep
      try {
        await exec('grep', ['--version']);
        checks['grep'] = { available: true };
      } catch {
        checks['grep'] = { available: false };
      }
      return text({ servers: checks });
    }

    case 'ast_grep_search': {
      const pattern = a.pattern as string;
      const language = a.language as string;
      if (!pattern || !language) return errorResult('pattern and language are required');
      const result = await runAstGrep(pattern, language, {
        path: a.path as string,
        maxResults: a.maxResults as number,
        context: a.context as number,
      });
      return text(result);
    }

    case 'ast_grep_replace': {
      const pattern = a.pattern as string;
      const replacement = a.replacement as string;
      const language = a.language as string;
      if (!pattern || !replacement || !language) return errorResult('pattern, replacement, and language are required');
      const dryRun = a.dryRun !== false; // default true
      const result = await runAstGrep(pattern, language, {
        path: a.path as string,
        replacement,
        dryRun,
      });
      return text({ ...result, dryRun });
    }

    default:
      return { content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
server.connect(transport).catch(console.error);
