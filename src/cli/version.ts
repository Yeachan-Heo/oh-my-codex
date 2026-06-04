import { resolveOmxDisplayVersionSync } from '../utils/version.js';

export function version(): void {
  const displayVersion = resolveOmxDisplayVersionSync();
  if (displayVersion) {
    console.log(`oh-my-codex ${displayVersion}`);
    console.log(`Node.js ${process.version}`);
    console.log(`Platform: ${process.platform} ${process.arch}`);
  } else {
    console.log('oh-my-codex (version unknown)');
  }
}
