/**
 * Package root resolution utility
 */

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

/**
 * Get the package root directory (where agents/, skills/, prompts/ live).
 * Works from dist/utils/, src/utils/, and bin/.
 */
export function getPackageRoot(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    // Try going up from dist/utils/ or src/utils/
    const candidate = join(__dirname, '..', '..');
    if (existsSync(join(candidate, 'package.json'))) {
      return candidate;
    }
    // Try going up one more (from bin/)
    const candidate2 = join(__dirname, '..');
    if (existsSync(join(candidate2, 'package.json'))) {
      return candidate2;
    }
  } catch {
    // Fallback
  }
  return process.cwd();
}
