import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { getInstallableNativeAgentNames } from '../../agents/policy.js';
import { getSetupInstallableSkillNames } from '../../catalog/installable.js';
import { readCatalogManifest } from '../../catalog/reader.js';

type PackageJson = {
  files?: string[];
  bin?: string | Record<string, string>;
  scripts?: Record<string, string>;
};

type NpmPackDryRunFile = {
  path: string;
  mode?: number;
};

type NpmPackDryRunResult = {
  files?: NpmPackDryRunFile[];
};

describe('package bin contract', () => {
  it('declares omx with an explicit relative bin path and avoids packaging platform-specific native binaries', () => {
    const packageJsonPath = join(process.cwd(), 'package.json');
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as PackageJson;
    const binaryName = platform() === 'win32' ? 'omx-sparkshell.exe' : 'omx-sparkshell';
    const packagedSparkShellPath = join(
      process.cwd(),
      'bin',
      'native',
      `${platform()}-${arch()}`,
      binaryName,
    );

    assert.deepEqual(pkg.bin, { omx: 'dist/cli/omx.js' });
    assert.equal(pkg.scripts?.['build:explore'], 'cargo build -p omx-explore-harness');
    assert.equal(pkg.scripts?.['build:explore:release'], 'node dist/scripts/build-explore-harness.js');
    assert.equal(pkg.scripts?.['build:full'], 'npm run build && npm run build:explore:release && npm run build:sparkshell');
    assert.equal(pkg.scripts?.['clean:native-package-assets'], 'node dist/scripts/cleanup-explore-harness.js');
    assert.equal(pkg.scripts?.['sync:plugin'], 'node dist/scripts/sync-plugin-mirror.js');
    assert.equal(pkg.scripts?.['sync:plugin:check'], 'node dist/scripts/sync-plugin-mirror.js --check');
    assert.equal(pkg.scripts?.['verify:plugin-bundle'], 'node dist/scripts/sync-plugin-mirror.js --check');
    assert.equal(pkg.scripts?.['verify:native-agents'], 'node dist/scripts/verify-native-agents.js');
    assert.equal(pkg.scripts?.prepack, 'npm run build && npm run verify:native-agents && npm run sync:plugin && npm run verify:plugin-bundle && npm run clean:native-package-assets');
    assert.equal(pkg.scripts?.postinstall, 'node src/scripts/postinstall-bootstrap.js');
    assert.equal(pkg.scripts?.postpack, 'npm run clean:native-package-assets');
    assert.equal(pkg.scripts?.['test:explore'], 'cargo test -p omx-explore-harness && node --test dist/cli/__tests__/explore.test.js dist/hooks/__tests__/explore-routing.test.js dist/hooks/__tests__/explore-sparkshell-guidance-contract.test.js');
    assert.equal(pkg.scripts?.['test:team:cross-rebase-smoke:compiled'], 'node --test dist/team/__tests__/cross-rebase-smoke.test.js');
    assert.equal(pkg.scripts?.['test:node'], 'node dist/scripts/run-test-files.js dist');
    assert.equal(pkg.scripts?.test, 'npm run build && npm run verify:native-agents && npm run verify:plugin-bundle && npm run test:node && node dist/scripts/generate-catalog-docs.js --check');
    assert.equal(pkg.scripts?.['test:ci:compiled'], 'npm run verify:native-agents && npm run verify:plugin-bundle && npm run test:node && node dist/scripts/generate-catalog-docs.js --check');
    assert.equal(
      pkg.scripts?.['coverage:team-critical'],
      "npm run build && c8 --all --src dist/team --src dist/state --include 'dist/team/**/*.js' --include 'dist/state/**/*.js' --exclude '**/__tests__/**' --reporter=text-summary --reporter=lcov --reporter=json-summary --report-dir coverage/team --check-coverage --lines=78 --functions=90 --branches=70 --statements=78 node dist/scripts/run-test-files.js dist/team/__tests__ dist/state/__tests__",
    );
    assert.equal(
      pkg.scripts?.['coverage:team-critical:compiled'],
      "c8 --all --src dist/team --src dist/state --include 'dist/team/**/*.js' --include 'dist/state/**/*.js' --exclude '**/__tests__/**' --reporter=text-summary --reporter=lcov --reporter=json-summary --report-dir coverage/team --check-coverage --lines=78 --functions=90 --branches=70 --statements=78 node dist/scripts/run-test-files.js dist/team/__tests__ dist/state/__tests__",
    );
    assert.equal(
      pkg.scripts?.['coverage:ts:full'],
      "npm run build && c8 --all --src dist --exclude '**/__tests__/**' --exclude 'dist/bin/**' --exclude 'dist/**/*.d.ts' --reporter=text-summary --reporter=lcov --reporter=json-summary --report-dir coverage/ts-full node dist/scripts/run-test-files.js dist",
    );
    assert.equal(
      pkg.scripts?.['coverage:ts:full:compiled'],
      "c8 --all --src dist --exclude '**/__tests__/**' --exclude 'dist/bin/**' --exclude 'dist/**/*.d.ts' --reporter=text-summary --reporter=lcov --reporter=json-summary --report-dir coverage/ts-full node dist/scripts/run-test-files.js dist",
    );
    assert.equal(
      pkg.scripts?.['test:ralph-persistence:compiled'],
      'node --test dist/cli/__tests__/session-scoped-runtime.test.js dist/mcp/__tests__/trace-server.test.js dist/hud/__tests__/state.test.js dist/mcp/__tests__/state-server-ralph-phase.test.js dist/ralph/__tests__/persistence.test.js dist/verification/__tests__/ralph-persistence-gate.test.js',
    );
    assert.equal(
      pkg.scripts?.['test:plugin-boundaries:compiled'],
      'node --test dist/cli/__tests__/codex-plugin-layout.test.js dist/cli/__tests__/package-bin-contract.test.js dist/cli/__tests__/setup-hooks-shared-ownership.test.js dist/catalog/__tests__/plugin-bundle-ssot.test.js',
    );
    assert.equal(pkg.scripts?.['test:compat:node'], 'npm run build && node dist/scripts/run-test-files.js dist/compat/__tests__');

    for (const scriptName of ['test:node', 'test:ci:compiled', 'coverage:team-critical', 'coverage:team-critical:compiled', 'coverage:ts:full', 'coverage:ts:full:compiled', 'test:ralph-persistence:compiled', 'test:plugin-boundaries:compiled', 'test:compat:node'] as const) {
      const script: string | undefined = pkg.scripts?.[scriptName];
      assert.ok(script, `expected ${scriptName} to exist`);
      assert.equal(script.includes('$(find '), false, `${scriptName} should not rely on POSIX command substitution`);
      assert.equal(script.includes('*.test.js'), false, `${scriptName} should not rely on shell glob expansion`);
    }

    assert.equal(pkg.files?.includes('dist/'), true, 'expected package files allowlist to include dist/');
    assert.equal(pkg.files?.includes('bin/'), false, 'did not expect broad bin/ allowlist in package files');
    assert.equal(pkg.files?.includes('agents/'), false, 'native agent TOMLs are setup output, not package input');
    assert.ok(pkg.files?.includes('Cargo.toml'));
    assert.ok(pkg.files?.includes('Cargo.lock'));
    assert.ok(pkg.files?.includes('crates/'));
    assert.ok(pkg.files?.includes('plugins/'));
    assert.ok(pkg.files?.includes('.agents/plugins/marketplace.json'));

    const binPath = join(process.cwd(), 'dist', 'cli', 'omx.js');
    const compiledCliPath = join(process.cwd(), 'dist', 'cli', 'index.js');

    const binSource = readFileSync(binPath, 'utf-8');
    const compiledCliSource = readFileSync(compiledCliPath, 'utf-8');
    assert.match(binSource, /^#!\/usr\/bin\/env node/);
    assert.match(compiledCliSource, /omx update\s+Check npm now, update the global install immediately, then refresh setup/);
    assert.match(compiledCliSource, /case "update"/);

    rmSync(packagedSparkShellPath, { force: true });

    const packed = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    assert.equal(packed.status, 0, packed.stderr || packed.stdout);

    const jsonStart = packed.stdout.indexOf('[');
    assert.notEqual(jsonStart, -1, `expected npm pack --json output in stdout\n${packed.stdout}`);
    const results = JSON.parse(packed.stdout.slice(jsonStart)) as NpmPackDryRunResult[];
    assert.equal(Array.isArray(results), true, 'expected npm pack --json array output');

    const binEntry = results[0]?.files?.find((file) => file.path === 'dist/cli/omx.js');
    assert.ok(binEntry, 'expected npm pack output to include dist/cli/omx.js');

    const packagedHarnessPath = process.platform === 'win32' ? 'bin/omx-explore-harness.exe' : 'bin/omx-explore-harness';
    const packagedHarnessEntry = results[0]?.files?.find((file) => file.path === packagedHarnessPath);
    const packagedHarnessMetaEntry = results[0]?.files?.find((file) => file.path === 'bin/omx-explore-harness.meta.json');
    const sparkshellEntry = results[0]?.files?.find((file) => file.path.includes('bin/native/'));
    const cargoTomlEntry = results[0]?.files?.find((file) => file.path === 'Cargo.toml');
    const cargoLockEntry = results[0]?.files?.find((file) => file.path === 'Cargo.lock');
    const crateManifestEntry = results[0]?.files?.find((file) => file.path === 'crates/omx-explore/Cargo.toml');
    const crateMainEntry = results[0]?.files?.find((file) => file.path === 'crates/omx-explore/src/main.rs');
    const marketplaceEntry = results[0]?.files?.find((file) => file.path === '.agents/plugins/marketplace.json');
    const pluginManifestEntry = results[0]?.files?.find((file) => file.path === 'plugins/oh-my-codex/.codex-plugin/plugin.json');
    const pluginMcpEntry = results[0]?.files?.find((file) => file.path === 'plugins/oh-my-codex/.mcp.json');
    const pluginAppsEntry = results[0]?.files?.find((file) => file.path === 'plugins/oh-my-codex/.app.json');
    const stateServerEntry = results[0]?.files?.find((file) => file.path === 'dist/mcp/state-server.js');
    const memoryServerEntry = results[0]?.files?.find((file) => file.path === 'dist/mcp/memory-server.js');
    const codeIntelServerEntry = results[0]?.files?.find((file) => file.path === 'dist/mcp/code-intel-server.js');
    const traceServerEntry = results[0]?.files?.find((file) => file.path === 'dist/mcp/trace-server.js');
    const wikiServerEntry = results[0]?.files?.find((file) => file.path === 'dist/mcp/wiki-server.js');
    const rootRalphSkillEntry = results[0]?.files?.find((file) => file.path === 'skills/ralph/SKILL.md');
    const promptEntry = results[0]?.files?.find((file) => file.path === 'prompts/executor.md');
    const templateEntry = results[0]?.files?.find((file) => file.path === 'templates/AGENTS.md');
    const postinstallEntry = results[0]?.files?.find((file) => file.path === 'src/scripts/postinstall-bootstrap.js');
    const rootNativeAgentEntry = results[0]?.files?.find((file) => file.path === 'agents' || file.path.startsWith('agents/'));
    const pluginScopedHooksEntry = results[0]?.files?.find((file) =>
      file.path === 'plugins/oh-my-codex/hooks.json'
      || file.path === 'plugins/oh-my-codex/.codex/hooks.json'
      || file.path === 'plugins/oh-my-codex/.codex-plugin/hooks.json'
      || file.path.startsWith('plugins/oh-my-codex/.omx/hooks/'));

    assert.equal(packagedHarnessEntry, undefined, `did not expect ${packagedHarnessPath} in npm pack output`);
    assert.equal(packagedHarnessMetaEntry, undefined, 'did not expect packaged explore harness metadata in npm pack output');
    assert.equal(sparkshellEntry, undefined, 'did not expect staged sparkshell binaries in npm pack output');
    assert.ok(cargoTomlEntry, 'expected npm pack output to include Cargo.toml');
    assert.ok(cargoLockEntry, 'expected npm pack output to include Cargo.lock');
    assert.ok(crateManifestEntry, 'expected npm pack output to include crates/omx-explore/Cargo.toml');
    assert.ok(crateMainEntry, 'expected npm pack output to include crates/omx-explore/src/main.rs');
    assert.ok(marketplaceEntry, 'expected npm pack output to include .agents/plugins/marketplace.json');
    assert.ok(pluginManifestEntry, 'expected npm pack output to include plugins/oh-my-codex/.codex-plugin/plugin.json');
    assert.ok(pluginMcpEntry, 'expected npm pack output to include plugins/oh-my-codex/.mcp.json');
    assert.ok(pluginAppsEntry, 'expected npm pack output to include plugins/oh-my-codex/.app.json');
    assert.ok(stateServerEntry, 'expected npm pack output to include dist/mcp/state-server.js for omx mcp-serve');
    assert.ok(memoryServerEntry, 'expected npm pack output to include dist/mcp/memory-server.js for omx mcp-serve');
    assert.ok(codeIntelServerEntry, 'expected npm pack output to include dist/mcp/code-intel-server.js for omx mcp-serve');
    assert.ok(traceServerEntry, 'expected npm pack output to include dist/mcp/trace-server.js for omx mcp-serve');
    assert.ok(wikiServerEntry, 'expected npm pack output to include dist/mcp/wiki-server.js for omx mcp-serve');
    const packedFilePaths = new Set((results[0]?.files ?? []).map((file) => file.path));
    const manifest = readCatalogManifest(process.cwd());
    const installableSkillNames = [...getSetupInstallableSkillNames(manifest)].sort();
    for (const skillName of installableSkillNames) {
      assert.equal(
        packedFilePaths.has(`plugins/oh-my-codex/skills/${skillName}/SKILL.md`),
        true,
        `expected npm pack output to include mirrored plugin ${skillName} skill`,
      );
    }
    const installableNativeAgentNames = [...getInstallableNativeAgentNames(manifest)].sort();
    for (const agentName of installableNativeAgentNames) {
      assert.equal(
        packedFilePaths.has(`prompts/${agentName}.md`),
        true,
        `expected npm pack output to include prompt for native agent ${agentName}`,
      );
    }
    assert.ok(rootRalphSkillEntry, 'expected npm pack output to keep canonical root skills');
    assert.ok(promptEntry, 'expected npm pack output to keep prompts');
    assert.ok(templateEntry, 'expected npm pack output to keep templates');
    assert.ok(postinstallEntry, 'expected npm pack output to keep postinstall bootstrap script');
    assert.equal(rootNativeAgentEntry, undefined, 'did not expect generated root native agent TOMLs in package output');
    assert.equal(pluginScopedHooksEntry, undefined, 'did not expect setup-owned hook assets inside the installable plugin bundle');
  });
});
