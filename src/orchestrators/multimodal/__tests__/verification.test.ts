import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { runVerificationCommands } from '../providers.js';

describe('multimodal verification commands', () => {
  it('captures passing and failing command results', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'stackmemory-verify-'));

    try {
      const results = runVerificationCommands(repoPath, [
        'node -e "console.log(\'pass-signal\')"',
        'node -e "console.error(\'fail-signal\'); process.exit(7)"',
      ]);

      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({ ok: true });
      expect(results[0]?.output).toContain('pass-signal');
      expect(results[1]).toMatchObject({ ok: false });
      expect(results[1]?.output).toContain('fail-signal');
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
