import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type PackageJson = {
  dependencies?: Record<string, string>;
};

describe('team MCP runtime dependency contract', () => {
  it('declares zod as a top-level runtime dependency because team-server imports it directly', () => {
    const teamServerSource = readFileSync(join(process.cwd(), 'src', 'mcp', 'team-server.ts'), 'utf8');
    assert.match(teamServerSource, /from ['\"]zod['\"]/);

    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as PackageJson;
    assert.equal(
      typeof pkg.dependencies?.zod,
      'string',
      'package.json must declare zod in top-level runtime dependencies when shipped JS imports it directly',
    );
  });
});
