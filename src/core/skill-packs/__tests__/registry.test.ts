/**
 * Tests for skill pack registry
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SkillPackRegistry } from '../registry.js';
import type { SkillPack } from '../types.js';

function makePack(overrides: Partial<SkillPack['manifest']> = {}): SkillPack {
  return {
    manifest: {
      name: 'coding/typescript',
      version: '1.0.0',
      description: 'TypeScript development patterns',
      author: 'stackmemory',
      license: 'MIT',
      ...overrides,
    },
    instructions: 'Use strict mode. Prefer const.',
  };
}

describe('SkillPackRegistry', () => {
  let registry: SkillPackRegistry;
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackmemory-packreg-'));
    dbPath = path.join(tmpDir, 'skill-packs.db');
    registry = new SkillPackRegistry(dbPath);
  });

  afterEach(() => {
    registry.close();
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch {
      // cleanup best-effort
    }
  });

  describe('install / get', () => {
    it('should install and retrieve a pack', () => {
      const pack = makePack();
      registry.install(pack);

      const result = registry.get('coding/typescript');
      expect(result).toBeDefined();
      expect(result!.manifest.name).toBe('coding/typescript');
      expect(result!.manifest.version).toBe('1.0.0');
      expect(result!.instructions).toBe('Use strict mode. Prefer const.');
      expect(result!.metadata?.installedAt).toBeDefined();
    });

    it('should return undefined for missing pack', () => {
      expect(registry.get('coding/nonexistent')).toBeUndefined();
    });
  });

  describe('uninstall', () => {
    it('should uninstall an installed pack', () => {
      registry.install(makePack());
      expect(registry.uninstall('coding/typescript')).toBe(true);
      expect(registry.get('coding/typescript')).toBeUndefined();
    });

    it('should return false for missing pack', () => {
      expect(registry.uninstall('coding/nonexistent')).toBe(false);
    });
  });

  describe('list', () => {
    beforeEach(() => {
      registry.install(
        makePack({ name: 'coding/typescript', version: '1.0.0' })
      );
      registry.install(
        makePack({
          name: 'coding/python',
          version: '2.0.0',
          description: 'Python patterns',
          runtime: { type: 'e2b' },
        })
      );
      registry.install(
        makePack({
          name: 'infra/docker',
          version: '1.0.0',
          description: 'Docker patterns',
          runtime: { type: 'local' },
        })
      );
    });

    it('should list all packs', () => {
      const packs = registry.list();
      expect(packs).toHaveLength(3);
    });

    it('should filter by namespace', () => {
      const packs = registry.list({ namespace: 'coding' });
      expect(packs).toHaveLength(2);
      expect(packs.every((p) => p.manifest.name.startsWith('coding/'))).toBe(
        true
      );
    });

    it('should filter by runtime', () => {
      const packs = registry.list({ runtime: 'e2b' });
      expect(packs).toHaveLength(1);
      expect(packs[0]!.manifest.name).toBe('coding/python');
    });

    it('should combine namespace and runtime filters', () => {
      const packs = registry.list({ namespace: 'coding', runtime: 'e2b' });
      expect(packs).toHaveLength(1);
      expect(packs[0]!.manifest.name).toBe('coding/python');
    });

    it('should return empty for non-matching filters', () => {
      const packs = registry.list({ namespace: 'unknown' });
      expect(packs).toHaveLength(0);
    });
  });

  describe('duplicate install (upsert)', () => {
    it('should update version on re-install', () => {
      registry.install(makePack({ version: '1.0.0' }));
      registry.install(makePack({ version: '2.0.0' }));

      const result = registry.get('coding/typescript');
      expect(result!.manifest.version).toBe('2.0.0');

      // Should not create duplicates
      const all = registry.list();
      expect(
        all.filter((p) => p.manifest.name === 'coding/typescript')
      ).toHaveLength(1);
    });

    it('should update instructions on re-install', () => {
      const pack1 = makePack();
      pack1.instructions = 'Old instructions';
      registry.install(pack1);

      const pack2 = makePack({ version: '2.0.0' });
      pack2.instructions = 'New instructions';
      registry.install(pack2);

      const result = registry.get('coding/typescript');
      expect(result!.instructions).toBe('New instructions');
    });
  });

  describe('getByTool', () => {
    it('should find pack by MCP tool name', () => {
      const pack = makePack({
        mcp: {
          tools: [
            {
              name: 'analyze-component',
              description: 'Analyze a React component',
            },
            { name: 'lint-hooks', description: 'Lint React hooks' },
          ],
        },
      });
      registry.install(pack);

      const result = registry.getByTool('analyze-component');
      expect(result).toBeDefined();
      expect(result!.manifest.name).toBe('coding/typescript');

      const result2 = registry.getByTool('lint-hooks');
      expect(result2).toBeDefined();
    });

    it('should return undefined for unknown tool', () => {
      registry.install(makePack());
      expect(registry.getByTool('nonexistent-tool')).toBeUndefined();
    });
  });

  describe('search (FTS5)', () => {
    beforeEach(() => {
      registry.install(
        makePack({
          name: 'coding/typescript',
          description: 'TypeScript development patterns and best practices',
        })
      );

      const pythonPack = makePack({
        name: 'coding/python',
        description: 'Python data science and machine learning',
      });
      pythonPack.instructions =
        'Use numpy for numerical computing. Use pandas for data frames.';
      registry.install(pythonPack);

      registry.install(
        makePack({
          name: 'infra/docker',
          description: 'Docker containerization and orchestration',
        })
      );
    });

    it('should find packs by name', () => {
      const results = registry.search('typescript');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((p) => p.manifest.name === 'coding/typescript')).toBe(
        true
      );
    });

    it('should find packs by description keyword', () => {
      const results = registry.search('containerization');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((p) => p.manifest.name === 'infra/docker')).toBe(
        true
      );
    });

    it('should find packs by instructions content', () => {
      const results = registry.search('numpy');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((p) => p.manifest.name === 'coding/python')).toBe(
        true
      );
    });

    it('should return empty for no matches', () => {
      const results = registry.search('blockchain');
      expect(results).toHaveLength(0);
    });

    it('should handle special characters in query', () => {
      // Should not throw
      const results = registry.search('type (script) "best"');
      expect(Array.isArray(results)).toBe(true);
    });
  });
});
