import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  ManagedCodexHooksPlanError,
  planManagedCodexHooksRemoval,
} from '../../config/codex-hooks.js';

import {
  CODEX_APP_SERVER_TIMEOUTS,
  CodexAppServer,
  CodexExecutableNotFoundError,
  appendDisplayOrderStableForeignHookGroups,
  approveManagedHooksInCodex,
  assertCodexBatchWriteResult,
  assertForeignHookGroupsPreserved,
  assertGeneratedTrustMatchesCodex,
  createCodexBatchWriteEnvelope,
  foreignHookGroupSnapshot,
  generatedHookTrustState,
  hookMetadataSnapshot,
  initializeCodexAppServer,
  listCodexHooks,
  managedCodexHooksByEvent,
  probeCodexVersion,
  type CodexHookMetadata,
} from '../../scripts/smoke-packed-install.js';

function isolatedEnv(home: string, codexHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CODEX_HOME: codexHome };
  for (const key of [
    'OMX_SESSION_ID',
    'OMX_RUN_ID',
    'OMX_ROOT',
    'OMX_STATE_ROOT',
    'OMX_ACTIVE_SESSION_PID',
    'CODEX_SESSION_ID',
    'TMUX',
    'TMUX_PANE',
  ]) {
    delete env[key];
  }
  return env;
}

function escapedTomlBasicString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function trustedProjectConfig(projectDir: string): string {
  return [
    `[projects."${escapedTomlBasicString(projectDir)}"]`,
    'trust_level = "trusted"',
    '',
  ].join('\n');
}


function runRepoOmxResult(projectDir: string, argv: string[], env: NodeJS.ProcessEnv) {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const omxBin = join(testDir, '..', '..', '..', 'dist', 'cli', 'omx.js');
  return spawnSync(process.execPath, [omxBin, ...argv], {
    cwd: projectDir,
    env,
    encoding: 'utf-8',
  });
}

function runRepoOmx(projectDir: string, argv: string[], env: NodeJS.ProcessEnv): void {
  const result = runRepoOmxResult(projectDir, argv, env);
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `repo omx ${argv.join(' ')} failed\nstdout:\n${result.stdout || ''}\nstderr:\n${result.stderr || ''}`,
  );
}

async function assertNoUninstallTransactionArtifacts(codexDir: string): Promise<void> {
  const artifacts = (await readdir(codexDir)).filter((entry) => entry.includes('.omx-uninstall-'));
  assert.deepEqual(
    artifacts,
    [],
    `unsafe uninstall left replacement, staged, or tombstone paths: ${artifacts.join(', ')}`,
  );
}


async function observeHooks(
  projectDir: string,
  hooksPath: string,
  env: NodeJS.ProcessEnv,
): Promise<CodexHookMetadata[]> {
  const server = await CodexAppServer.start({ cwd: projectDir, env });
  try {
    await initializeCodexAppServer(server, 'omx-hook-trust-regression');
    return (await listCodexHooks(server, projectDir, hooksPath)).hooks;
  } finally {
    await server.close();
  }
}

function assertTrustedOmxHooks(hooks: readonly CodexHookMetadata[]): void {
  for (const [event, hook] of Object.entries(managedCodexHooksByEvent(hooks))) {
    assert.equal(hook.trustStatus, 'trusted', `Codex did not trust OMX ${event}`);
  }
}

function assertUnapprovedOmxHooks(hooks: readonly CodexHookMetadata[]): void {
  for (const [event, hook] of Object.entries(managedCodexHooksByEvent(hooks))) {
    assert.notEqual(hook.trustStatus, 'trusted', `setup-generated trust pre-approved OMX ${event}`);
  }
}

function omxMetadataSnapshot(hooks: readonly CodexHookMetadata[]): unknown[] {
  return hookMetadataSnapshot(Object.values(managedCodexHooksByEvent(hooks)));
}

function foreignMetadataSnapshot(hooks: readonly CodexHookMetadata[], marker: string) {
  return hookMetadataSnapshot(hooks.filter((hook) => hook.command.includes(marker)));
}
function isObservedCodexVersionMismatch(error: Error): boolean {
  if (!error.message.startsWith('Unsupported installed Codex version')) return false;
  const observations = error.message.split('\n').slice(1).filter(Boolean);
  return observations.length > 0 && observations.every((line) =>
    /: stdout="codex-cli \d+\.\d+\.\d+\\n" stderr=/.test(line)
  );
}

function skipUnsupportedInstalledCodex(t: { skip: (message?: string) => void }, error: unknown): boolean {
  if (error instanceof CodexExecutableNotFoundError) {
    t.skip('codex executable is absent; installed-Codex boundary is unavailable');
    return true;
  }
  if (error instanceof Error && isObservedCodexVersionMismatch(error)) {
    t.skip(error.message);
    return true;
  }
  return false;
}


test('Linux installed-Codex hooks/list preserves full foreign metadata through uninstall (no macOS claim)', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('This regression records Linux-only Codex evidence and makes no macOS claim.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'omx-setup-hooks-trust-e2e-'));
  const projectDir = resolve(root, 'project');
  const home = join(root, 'home');
  const codexHome = join(root, 'codex-home');
  const hooksPath = join(projectDir, '.codex', 'hooks.json');
  const configPath = join(projectDir, '.codex', 'config.toml');
  const foreignMarker = 'omx-hook-trust-e2e-foreign';
  const env = isolatedEnv(home, codexHome);

  try {
    await Promise.all([
      mkdir(projectDir, { recursive: true }),
      mkdir(home, { recursive: true }),
      mkdir(codexHome, { recursive: true }),
      mkdir(join(projectDir, '.codex'), { recursive: true }),
    ]);
    await writeFile(join(codexHome, 'config.toml'), trustedProjectConfig(projectDir), 'utf-8');
    await writeFile(
      hooksPath,
      appendDisplayOrderStableForeignHookGroups('{"hooks":{}}', foreignMarker, { appendGroups: true }),
      'utf-8',
    );
    const preSetupForeignRawSnapshot = foreignHookGroupSnapshot(
      await readFile(hooksPath, 'utf-8'),
      foreignMarker,
    );
    assert.equal(preSetupForeignRawSnapshot.length, 2, 'pre-approved foreign coordinates should be recorded');

    try {
      probeCodexVersion(projectDir, env);
    } catch (error) {
      if (skipUnsupportedInstalledCodex(t, error)) return;
      throw error;
    }

    const foreignApprovalServer = await CodexAppServer.start({ cwd: projectDir, env });
    try {
      await initializeCodexAppServer(foreignApprovalServer, 'omx-hook-trust-regression');
      const preSetupForeignHooks = (await listCodexHooks(foreignApprovalServer, projectDir, hooksPath)).hooks
        .filter((hook) => hook.command.includes(foreignMarker));
      assert.equal(preSetupForeignHooks.length, 2, 'Codex must discover both pre-seeded foreign hooks');
      assert.ok(
        preSetupForeignHooks.every((hook) => hook.trustStatus !== 'trusted'),
        'isolated Codex state must not pre-approve foreign hooks',
      );
      const approval = await foreignApprovalServer.request<unknown>(
        createCodexBatchWriteEnvelope(Object.fromEntries(
          preSetupForeignHooks.map((hook) => [hook.key, hook.currentHash]),
        )),
        CODEX_APP_SERVER_TIMEOUTS.requestMs,
      );
      assertCodexBatchWriteResult(approval, join(codexHome, 'config.toml'));
    } finally {
      await foreignApprovalServer.close();
    }
    const preapprovedForeignMetadata = foreignMetadataSnapshot(
      await observeHooks(projectDir, hooksPath, env),
      foreignMarker,
    );
    assert.equal(preapprovedForeignMetadata.length, 2);
    assert.ok(preapprovedForeignMetadata.every((hook) => hook.trustStatus === 'trusted'));

    // First installation appends the seven managed groups after both pre-approved foreign groups.
    runRepoOmx(projectDir, ['setup', '--scope', 'project', '--merge-agents', '--legacy'], env);
    const initialHooksContent = await readFile(hooksPath, 'utf-8');
    const initialConfig = await readFile(configPath, 'utf-8');
    const initialGeneratedTrust = generatedHookTrustState(initialConfig);
    assertForeignHookGroupsPreserved(preSetupForeignRawSnapshot, initialHooksContent, foreignMarker);

    const approvalServer = await CodexAppServer.start({ cwd: projectDir, env });
    try {
      await initializeCodexAppServer(approvalServer, 'omx-hook-trust-regression');
      const initialHooks = (await listCodexHooks(approvalServer, projectDir, hooksPath)).hooks;
      assertGeneratedTrustMatchesCodex(initialGeneratedTrust, initialHooks);
      assertUnapprovedOmxHooks(initialHooks);
      await approveManagedHooksInCodex(approvalServer, initialHooks, join(codexHome, 'config.toml'));
    } finally {
      await approvalServer.close();
    }

    // Restart after user-layer approval; setup-generated project trust alone is not the proof.
    const afterInitialApproval = await observeHooks(projectDir, hooksPath, env);
    assertTrustedOmxHooks(afterInitialApproval);
    assert.deepEqual(
      foreignMetadataSnapshot(afterInitialApproval, foreignMarker),
      preapprovedForeignMetadata,
      'setup changed pre-approved foreign key, hash, status, or display order',
    );

    // Add handlers to a pre-approved group to make foreign display-order changes observable.
    await writeFile(
      hooksPath,
      appendDisplayOrderStableForeignHookGroups(
        await readFile(hooksPath, 'utf-8'),
        foreignMarker,
        { appendGroups: false },
      ),
      'utf-8',
    );
    const postForeignHooksContent = await readFile(hooksPath, 'utf-8');
    const postForeignConfig = await readFile(configPath, 'utf-8');
    const foreignRawSnapshot = foreignHookGroupSnapshot(postForeignHooksContent, foreignMarker);
    assert.equal(foreignRawSnapshot.length, 4, 'foreign group and handler coordinates should be recorded');

    // Restart after the hooks mutation and snapshot the legitimate post-insertion display ordering.
    const postForeignHooks = await observeHooks(projectDir, hooksPath, env);
    assertTrustedOmxHooks(postForeignHooks);
    const expectedOmxMetadata = omxMetadataSnapshot(postForeignHooks);
    const expectedForeignMetadata = foreignMetadataSnapshot(postForeignHooks, foreignMarker);
    assert.equal(expectedForeignMetadata.length, 4, 'Codex must discover all foreign command hooks');
    assert.deepEqual(
      expectedForeignMetadata.filter((hook) => !hook.command.includes('-inserted.js')),
      preapprovedForeignMetadata,
      'foreign insertion changed pre-approved foreign metadata',
    );

    // Rerun must refresh OMX in place without moving the foreign groups or handlers.
    runRepoOmx(projectDir, ['setup', '--scope', 'project', '--merge-agents', '--legacy'], env);
    assert.equal(await readFile(hooksPath, 'utf-8'), postForeignHooksContent, 'rerun changed hooks.json');
    assert.equal(await readFile(configPath, 'utf-8'), postForeignConfig, 'rerun changed config.toml');
    assertForeignHookGroupsPreserved(foreignRawSnapshot, await readFile(hooksPath, 'utf-8'), foreignMarker);

    const afterRerunHooks = await observeHooks(projectDir, hooksPath, env);
    assertTrustedOmxHooks(afterRerunHooks);
    assert.deepEqual(omxMetadataSnapshot(afterRerunHooks), expectedOmxMetadata);
    assert.deepEqual(foreignMetadataSnapshot(afterRerunHooks, foreignMarker), expectedForeignMetadata);

    // A third setup is the idempotence check and must remain a byte no-op at the real boundary.
    runRepoOmx(projectDir, ['setup', '--scope', 'project', '--merge-agents', '--legacy'], env);
    assert.equal(await readFile(hooksPath, 'utf-8'), postForeignHooksContent, 'third setup changed hooks.json');
    assert.equal(await readFile(configPath, 'utf-8'), postForeignConfig, 'third setup changed config.toml');
    assertForeignHookGroupsPreserved(foreignRawSnapshot, await readFile(hooksPath, 'utf-8'), foreignMarker);
    const afterNoopHooks = await observeHooks(projectDir, hooksPath, env);
    assertTrustedOmxHooks(afterNoopHooks);
    assert.deepEqual(omxMetadataSnapshot(afterNoopHooks), expectedOmxMetadata);
    assert.deepEqual(foreignMetadataSnapshot(afterNoopHooks, foreignMarker), expectedForeignMetadata);

    runRepoOmx(projectDir, ['uninstall'], env);
    const afterUninstallHooksContent = await readFile(hooksPath, 'utf-8');
    assertForeignHookGroupsPreserved(foreignRawSnapshot, afterUninstallHooksContent, foreignMarker);
    const afterUninstallHooks = await observeHooks(projectDir, hooksPath, env);
    assert.deepEqual(
      foreignMetadataSnapshot(afterUninstallHooks, foreignMarker),
      expectedForeignMetadata,
      'uninstall changed foreign command key, hash, status, or display order',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Linux installed-Codex preserves managed-first foreign order and fails unsafe uninstall without writes', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('This regression records Linux-only Codex evidence and makes no macOS claim.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'omx-setup-hooks-managed-first-e2e-'));
  const projectDir = resolve(root, 'project');
  const home = join(root, 'home');
  const codexHome = join(root, 'codex-home');
  const hooksPath = join(projectDir, '.codex', 'hooks.json');
  const configPath = join(projectDir, '.codex', 'config.toml');
  const foreignMarker = 'omx-hook-trust-managed-first-foreign';
  const env = isolatedEnv(home, codexHome);

  try {
    await Promise.all([
      mkdir(join(projectDir, '.codex'), { recursive: true }),
      mkdir(home, { recursive: true }),
      mkdir(codexHome, { recursive: true }),
    ]);
    await writeFile(join(codexHome, 'config.toml'), trustedProjectConfig(projectDir), 'utf-8');
    try {
      probeCodexVersion(projectDir, env);
    } catch (error) {
      if (skipUnsupportedInstalledCodex(t, error)) return;
      throw error;
    }

    runRepoOmx(projectDir, ['setup', '--scope', 'project', '--merge-agents', '--legacy'], env);
    const approvalServer = await CodexAppServer.start({ cwd: projectDir, env });
    try {
      await initializeCodexAppServer(approvalServer, 'omx-hook-trust-regression');
      const initialManagedFirstHooks = (await listCodexHooks(approvalServer, projectDir, hooksPath)).hooks;
      assertUnapprovedOmxHooks(initialManagedFirstHooks);
      await approveManagedHooksInCodex(
        approvalServer,
        initialManagedFirstHooks,
        join(codexHome, 'config.toml'),
      );
    } finally {
      await approvalServer.close();
    }

    await writeFile(
      hooksPath,
      appendDisplayOrderStableForeignHookGroups(
        await readFile(hooksPath, 'utf-8'),
        foreignMarker,
        { appendGroups: true },
      ),
      'utf-8',
    );
    const beforeRerunHooks = await readFile(hooksPath, 'utf-8');
    const beforeRerunConfig = await readFile(configPath, 'utf-8');
    const foreignRawSnapshot = foreignHookGroupSnapshot(beforeRerunHooks, foreignMarker);
    assert.deepEqual(foreignRawSnapshot.map((entry) => (entry as { groupIndex: number }).groupIndex), [1, 2]);
    const beforeRerunCodexHooks = await observeHooks(projectDir, hooksPath, env);
    assertTrustedOmxHooks(beforeRerunCodexHooks);
    const beforeRerunMetadata = hookMetadataSnapshot(beforeRerunCodexHooks);

    runRepoOmx(projectDir, ['setup', '--scope', 'project', '--merge-agents', '--legacy'], env);
    assert.equal(await readFile(hooksPath, 'utf-8'), beforeRerunHooks, 'rerun reordered managed-first hooks.json');
    assert.equal(await readFile(configPath, 'utf-8'), beforeRerunConfig, 'rerun changed managed-first config.toml');
    assertForeignHookGroupsPreserved(foreignRawSnapshot, await readFile(hooksPath, 'utf-8'), foreignMarker);
    const afterRerunCodexHooks = await observeHooks(projectDir, hooksPath, env);
    assertTrustedOmxHooks(afterRerunCodexHooks);
    assert.deepEqual(
      hookMetadataSnapshot(afterRerunCodexHooks),
      beforeRerunMetadata,
      'rerun changed Codex key, hash, trust status, or display order',
    );
    const beforeUninstallHooksBytes = await readFile(hooksPath);
    const beforeUninstallConfigBytes = await readFile(configPath);

    const expectedUnsafeManagedRemovalDiagnostic =
      'Removing OMX hooks would shift a foreign coordinate or discard opaque metadata.';
    const unsafeRemoval = planManagedCodexHooksRemoval(beforeRerunHooks, hooksPath);
    assert.equal(unsafeRemoval.ok, false);
    if (unsafeRemoval.ok) return;
    assert.ok(unsafeRemoval.error instanceof ManagedCodexHooksPlanError);
    assert.equal(unsafeRemoval.error.code, 'unsafe_managed_removal');
    assert.equal(unsafeRemoval.error.message, expectedUnsafeManagedRemovalDiagnostic);

    const uninstall = runRepoOmxResult(projectDir, ['uninstall'], env);
    if (uninstall.error) throw uninstall.error;
    assert.equal(
      uninstall.status,
      1,
      `unsafe uninstall exited ${String(uninstall.status)}, expected 1\nstdout:\n${uninstall.stdout || ''}\nstderr:\n${uninstall.stderr || ''}`,
    );
    assert.equal(
      uninstall.stderr,
      `Error: ${expectedUnsafeManagedRemovalDiagnostic}\n`,
      'unsafe uninstall must report the exact unsafe_managed_removal diagnostic',
    );
    assert.deepEqual(await readFile(hooksPath), beforeUninstallHooksBytes, 'unsafe uninstall changed raw hooks.json bytes');
    assert.deepEqual(await readFile(configPath), beforeUninstallConfigBytes, 'unsafe uninstall changed raw config.toml bytes');
    await assertNoUninstallTransactionArtifacts(join(projectDir, '.codex'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
