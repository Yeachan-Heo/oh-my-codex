import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const LOCK_ROOT = join(process.cwd(), '.omx', 'test-locks');
const LOCK_DIR = join(LOCK_ROOT, 'packaged-explore-harness.lock');
const LOCK_TIMEOUT_MS = 120_000;
const LOCK_POLL_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withPackagedExploreHarnessLock<T>(fn: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  await mkdir(LOCK_ROOT, { recursive: true });

  while (true) {
    try {
      await mkdir(LOCK_DIR);
      break;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw error;
      if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for packaged explore harness test lock at ${LOCK_DIR}`);
      }
      await sleep(LOCK_POLL_MS);
    }
  }

  try {
    return await fn();
  } finally {
    await rm(LOCK_DIR, { recursive: true, force: true });
  }
}

export async function withPackagedExploreHarnessHidden<T>(fn: () => Promise<T>): Promise<T> {
  return withPackagedExploreHarnessLock(async () => {
    const packageBinDir = join(process.cwd(), 'bin');
    const packagedBinary = join(packageBinDir, process.platform === 'win32' ? 'omx-explore-harness.exe' : 'omx-explore-harness');
    const packagedMeta = join(packageBinDir, 'omx-explore-harness.meta.json');
    const originalBinary = existsSync(packagedBinary) ? await readFile(packagedBinary) : null;
    const originalMeta = existsSync(packagedMeta) ? await readFile(packagedMeta) : null;

    await rm(packagedBinary, { force: true });
    await rm(packagedMeta, { force: true });

    try {
      return await fn();
    } finally {
      if (originalBinary) {
        await writeFile(packagedBinary, originalBinary);
        if (process.platform !== 'win32') {
          await chmod(packagedBinary, 0o755);
        }
      } else {
        await rm(packagedBinary, { force: true });
      }
      if (originalMeta) {
        await writeFile(packagedMeta, originalMeta);
      } else {
        await rm(packagedMeta, { force: true });
      }
    }
  });
}
