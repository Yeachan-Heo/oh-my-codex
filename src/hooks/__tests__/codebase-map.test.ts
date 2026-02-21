/**
 * Tests for Codebase Map Generator
 *
 * Covers: symbol extraction, map generation, entry point detection,
 * opt-out via OMX_CODEBASE_MAP=0, size cap, and marker boundaries.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  generateCodebaseMap,
  extractTopSymbols,
  CODEBASE_MAP_START,
  CODEBASE_MAP_END,
} from '../codebase-map.js';
import { writeSessionModelInstructionsFile } from '../agents-overlay.js';
import { generateOverlay } from '../agents-overlay.js';

async function makeTempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'omx-codebase-map-test-'));
  await mkdir(join(dir, '.omx', 'state'), { recursive: true });
  return dir;
}

describe('extractTopSymbols', () => {
  it('extracts TypeScript symbols', () => {
    const content = [
      'export function greet(name: string): string {',
      '  return `Hello, ${name}`;',
      '}',
      '',
      'export class UserService {',
      '  async findById(id: number) {}',
      '}',
      '',
      'export interface Config {',
      '  port: number;',
      '}',
      '',
      'export type ID = string;',
      '',
      'export const VERSION = "1.0.0";',
    ].join('\n');

    const symbols = extractTopSymbols(content, 10);
    assert.ok(symbols.some(s => s.includes('greet')));
    assert.ok(symbols.some(s => s.includes('UserService')));
    assert.ok(symbols.some(s => s.includes('Config')));
    assert.ok(symbols.some(s => s.includes('ID')));
    assert.ok(symbols.some(s => s.includes('VERSION')));
  });

  it('extracts Python symbols', () => {
    const content = [
      'class MyApp:',
      '    pass',
      '',
      'def main():',
      '    pass',
      '',
      'async def fetch_data():',
      '    pass',
    ].join('\n');

    const symbols = extractTopSymbols(content, 10);
    assert.ok(symbols.some(s => s.includes('MyApp')));
    assert.ok(symbols.some(s => s.includes('main')));
    assert.ok(symbols.some(s => s.includes('fetch_data')));
  });

  it('extracts Go symbols', () => {
    const content = [
      'func main() {',
      '}',
      '',
      'type Server struct {',
      '  Port int',
      '}',
      '',
      'func (s *Server) Start() {',
      '}',
    ].join('\n');

    const symbols = extractTopSymbols(content, 10);
    assert.ok(symbols.some(s => s.includes('main')));
    assert.ok(symbols.some(s => s.includes('Server')));
    assert.ok(symbols.some(s => s.includes('Start')));
  });

  it('respects max symbol limit', () => {
    const content = Array.from({ length: 20 }, (_, i) =>
      `export function fn${i}() {}`
    ).join('\n');

    const symbols = extractTopSymbols(content, 3);
    assert.equal(symbols.length, 3);
  });

  it('returns empty for non-source content', () => {
    const symbols = extractTopSymbols('# README\n\nJust text.\n', 10);
    assert.equal(symbols.length, 0);
  });
});

describe('generateCodebaseMap', () => {
  let tempDir: string;

  before(async () => {
    tempDir = await makeTempProject();

    // Create a realistic project structure
    await writeFile(join(tempDir, 'package.json'), JSON.stringify({
      name: 'test-project',
      main: 'dist/index.js',
      bin: { cli: 'bin/cli.js' },
    }));

    await mkdir(join(tempDir, 'src'), { recursive: true });
    await mkdir(join(tempDir, 'src', 'utils'), { recursive: true });

    await writeFile(join(tempDir, 'src', 'index.ts'), [
      'export function main() {}',
      'export class App {}',
    ].join('\n'));

    await writeFile(join(tempDir, 'src', 'server.ts'), [
      'export async function startServer(port: number) {}',
      'export interface ServerConfig { port: number; }',
    ].join('\n'));

    await writeFile(join(tempDir, 'src', 'utils', 'helpers.ts'), [
      'export function formatDate(d: Date): string { return ""; }',
      'export const DEFAULT_TIMEOUT = 5000;',
    ].join('\n'));
  });

  after(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('generates map with markers', async () => {
    const map = await generateCodebaseMap(tempDir);
    assert.ok(map.includes(CODEBASE_MAP_START));
    assert.ok(map.includes(CODEBASE_MAP_END));
    assert.ok(map.includes('<codebase_map>'));
    assert.ok(map.includes('</codebase_map>'));
  });

  it('includes file symbols', async () => {
    const map = await generateCodebaseMap(tempDir);
    assert.ok(map.includes('main'));
    assert.ok(map.includes('App'));
    assert.ok(map.includes('startServer'));
    assert.ok(map.includes('formatDate'));
  });

  it('detects entry points from package.json', async () => {
    const map = await generateCodebaseMap(tempDir);
    assert.ok(map.includes('dist/index.js'));
  });

  it('respects OMX_CODEBASE_MAP=0 opt-out', async () => {
    const orig = process.env.OMX_CODEBASE_MAP;
    process.env.OMX_CODEBASE_MAP = '0';
    try {
      const map = await generateCodebaseMap(tempDir);
      assert.equal(map, '');
    } finally {
      if (orig === undefined) delete process.env.OMX_CODEBASE_MAP;
      else process.env.OMX_CODEBASE_MAP = orig;
    }
  });

  it('returns empty for directory with no source files', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'omx-empty-test-'));
    await mkdir(join(emptyDir, '.omx', 'state'), { recursive: true });
    try {
      const map = await generateCodebaseMap(emptyDir);
      assert.equal(map, '');
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('enforces size cap', async () => {
    const map = await generateCodebaseMap(tempDir, 500);
    assert.ok(map.length <= 500, `Map too large: ${map.length} chars`);
    assert.ok(map.includes(CODEBASE_MAP_START));
  });

  it('skips node_modules and dist', async () => {
    await mkdir(join(tempDir, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(tempDir, 'node_modules', 'pkg', 'index.js'),
      'export function external() {}');
    await mkdir(join(tempDir, 'dist'), { recursive: true });
    await writeFile(join(tempDir, 'dist', 'index.js'),
      'export function compiled() {}');

    const map = await generateCodebaseMap(tempDir);
    assert.ok(!map.includes('external'));
    assert.ok(!map.includes('compiled'));
  });
});

describe('codebase map integration with session AGENTS.md', () => {
  let tempDir: string;

  before(async () => {
    tempDir = await makeTempProject();
    await mkdir(join(tempDir, 'src'), { recursive: true });
    await writeFile(join(tempDir, 'src', 'app.ts'),
      'export class Application {}\nexport function bootstrap() {}');
    await writeFile(join(tempDir, 'AGENTS.md'),
      '# Project AGENTS\n\nProject instructions here.\n');
  });

  after(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('injects codebase map between base and overlay in session file', async () => {
    const overlay = await generateOverlay(tempDir, 'map-session-1');
    const codebaseMap = await generateCodebaseMap(tempDir);

    const path = await writeSessionModelInstructionsFile(
      tempDir, 'map-session-1', overlay, codebaseMap,
    );
    const content = await readFile(path, 'utf-8');

    // All three sections present
    assert.ok(content.includes('# Project AGENTS'));
    assert.ok(content.includes(CODEBASE_MAP_START));
    assert.ok(content.includes('<!-- OMX:RUNTIME:START -->'));

    // Order: base → codebase map → overlay
    const baseIdx = content.indexOf('# Project AGENTS');
    const mapIdx = content.indexOf(CODEBASE_MAP_START);
    const overlayIdx = content.indexOf('<!-- OMX:RUNTIME:START -->');
    assert.ok(baseIdx < mapIdx, 'Base should come before codebase map');
    assert.ok(mapIdx < overlayIdx, 'Codebase map should come before overlay');
  });

  it('works without codebase map (backward compatible)', async () => {
    const overlay = await generateOverlay(tempDir, 'map-session-2');
    const path = await writeSessionModelInstructionsFile(
      tempDir, 'map-session-2', overlay,
    );
    const content = await readFile(path, 'utf-8');

    assert.ok(content.includes('# Project AGENTS'));
    assert.ok(content.includes('<!-- OMX:RUNTIME:START -->'));
    assert.ok(!content.includes(CODEBASE_MAP_START));
  });

  it('strips codebase map from base AGENTS.md if present', async () => {
    // Simulate a corrupted AGENTS.md that has a stale codebase map
    const corrupted = `# Project AGENTS\n\n${CODEBASE_MAP_START}\nstale map\n${CODEBASE_MAP_END}\n`;
    await writeFile(join(tempDir, 'AGENTS.md'), corrupted);

    const overlay = await generateOverlay(tempDir, 'map-session-3');
    const freshMap = await generateCodebaseMap(tempDir);
    const path = await writeSessionModelInstructionsFile(
      tempDir, 'map-session-3', overlay, freshMap,
    );
    const content = await readFile(path, 'utf-8');

    // Should have fresh map, not stale
    assert.ok(!content.includes('stale map'));
    assert.ok(content.includes('Application'));
  });
});
