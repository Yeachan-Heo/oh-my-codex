import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveOmxDisplayVersionSync } from '../version.js';

async function withVersionFixture(
  run: (fixture: { packageRoot: string; stampPath: string }) => Promise<void> | void,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'omx-version-fixture-'));
  try {
    await mkdir(join(root, 'pkg'), { recursive: true });
    await mkdir(join(root, 'state'), { recursive: true });
    await writeFile(join(root, 'pkg', 'package.json'), JSON.stringify({ version: '0.18.8' }, null, 2));
    await run({ packageRoot: join(root, 'pkg'), stampPath: join(root, 'state', 'install-state.json') });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('resolveOmxDisplayVersionSync', () => {
  it('returns a plain release version when no current dev install stamp is present', async () => {
    await withVersionFixture(({ packageRoot, stampPath }) => {
      assert.equal(resolveOmxDisplayVersionSync({ packageRoot, stampPath }), 'v0.18.8');
    });
  });

  it('adds dev revision from the current dev install stamp', async () => {
    await withVersionFixture(async ({ packageRoot, stampPath }) => {
      await writeFile(stampPath, JSON.stringify({
        installed_version: '0.18.8',
        setup_completed_version: '0.18.8',
        install_channel: 'dev',
        install_source: 'github:Yeachan-Heo/oh-my-codex#dev',
        install_revision: 'abcdef1234567890',
        updated_at: '2026-06-02T00:00:00.000Z',
      }, null, 2));

      assert.equal(resolveOmxDisplayVersionSync({ packageRoot, stampPath }), 'v0.18.8-dev-abcdef123456');
    });
  });



  it('uses a dev base version from the install stamp when package.json lags the release baseline', async () => {
    await withVersionFixture(async ({ packageRoot, stampPath }) => {
      await writeFile(stampPath, JSON.stringify({
        installed_version: '0.18.8',
        setup_completed_version: '0.18.8',
        dev_base_version: '0.18.9',
        install_channel: 'dev',
        install_source: 'github:Yeachan-Heo/oh-my-codex#dev',
        install_revision: 'feedfacecafebeef',
        updated_at: '2026-06-09T00:00:00.000Z',
      }, null, 2));

      assert.equal(resolveOmxDisplayVersionSync({ packageRoot, stampPath }), 'v0.18.9-dev-feedfacecafe');
    });
  });

  it('does not apply stale dev stamp metadata to a different package version', async () => {
    await withVersionFixture(async ({ packageRoot, stampPath }) => {
      await writeFile(stampPath, JSON.stringify({
        installed_version: '0.18.7',
        setup_completed_version: '0.18.7',
        install_channel: 'dev',
        install_revision: 'abcdef123456',
        updated_at: '2026-06-02T00:00:00.000Z',
      }, null, 2));

      assert.equal(resolveOmxDisplayVersionSync({ packageRoot, stampPath }), 'v0.18.8');
    });
  });

  it('does not let stale dev_base_version metadata make a mismatched stamp current', async () => {
    await withVersionFixture(async ({ packageRoot, stampPath }) => {
      await writeFile(stampPath, JSON.stringify({
        installed_version: '0.18.7',
        setup_completed_version: '0.18.7',
        dev_base_version: '0.18.11',
        install_channel: 'dev',
        install_revision: 'feedfacecafebeef',
        updated_at: '2026-06-09T00:00:00.000Z',
      }, null, 2));

      assert.equal(resolveOmxDisplayVersionSync({ packageRoot, stampPath }), 'v0.18.8');
    });
  });
});
