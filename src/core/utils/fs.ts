/**
 * Shared filesystem utilities.
 */

import { readdirSync, unlinkSync } from 'fs';
import { join } from 'path';

export function pruneOldFiles(dir: string, ext: string, maxKeep: number): void {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(ext))
      .sort()
      .reverse();

    for (const old of files.slice(maxKeep)) {
      unlinkSync(join(dir, old));
    }
  } catch {
    // Not critical
  }
}
