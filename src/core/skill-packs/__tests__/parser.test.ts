/**
 * Tests for skill pack parser
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import { parsePackYaml, loadPackFromDir } from '../parser.js';

describe('parsePackYaml', () => {
  const validManifest = {
    name: 'coding/typescript-react',
    version: '1.0.0',
    description: 'TypeScript + React development patterns',
    author: 'stackmemory',
    license: 'MIT',
    runtime: { type: 'local' },
    ingestion: { sources: ['github', 'slack'], scope: 'detect-decisions' },
    ontology: {
      entities: ['Component', 'Hook'],
      relations: ['uses', 'extends'],
    },
    mcp: {
      tools: [
        {
          name: 'analyze-component',
          description: 'Analyze React component structure',
          inputSchema: {
            type: 'object',
            properties: { filePath: { type: 'string' } },
          },
        },
      ],
    },
    examples: [
      {
        input: 'How do I use useEffect?',
        output: 'useEffect runs side effects...',
      },
    ],
    instructions: 'Always prefer functional components with hooks.',
  };

  it('should parse a valid pack.yaml', () => {
    const content = yaml.dump(validManifest);
    const pack = parsePackYaml(content);

    expect(pack.manifest.name).toBe('coding/typescript-react');
    expect(pack.manifest.version).toBe('1.0.0');
    expect(pack.manifest.author).toBe('stackmemory');
    expect(pack.manifest.license).toBe('MIT');
    expect(pack.manifest.runtime?.type).toBe('local');
    expect(pack.manifest.mcp?.tools).toHaveLength(1);
    expect(pack.manifest.mcp?.tools[0]?.name).toBe('analyze-component');
    expect(pack.manifest.examples).toHaveLength(1);
    expect(pack.instructions).toBe(
      'Always prefer functional components with hooks.'
    );
  });

  it('should apply defaults for optional fields', () => {
    const minimal = {
      name: 'infra/docker',
      version: '0.1.0',
      description: 'Docker patterns',
      author: 'test',
    };
    const pack = parsePackYaml(yaml.dump(minimal));

    expect(pack.manifest.license).toBe('MIT');
    expect(pack.manifest.runtime).toBeUndefined();
    expect(pack.manifest.mcp).toBeUndefined();
    expect(pack.manifest.examples).toBeUndefined();
    expect(pack.instructions).toBeUndefined();
  });

  it('should reject missing name', () => {
    const bad = { version: '1.0.0', description: 'x', author: 'y' };
    expect(() => parsePackYaml(yaml.dump(bad))).toThrow();
  });

  it('should reject invalid name format', () => {
    const bad = {
      name: 'no-namespace',
      version: '1.0.0',
      description: 'x',
      author: 'y',
    };
    expect(() => parsePackYaml(yaml.dump(bad))).toThrow(/namespace\/pack-name/);
  });

  it('should reject invalid semver', () => {
    const bad = {
      name: 'coding/ts',
      version: 'not-semver',
      description: 'x',
      author: 'y',
    };
    expect(() => parsePackYaml(yaml.dump(bad))).toThrow(/semver/);
  });

  it('should reject unknown runtime type', () => {
    const bad = {
      name: 'coding/ts',
      version: '1.0.0',
      description: 'x',
      author: 'y',
      runtime: { type: 'kubernetes' },
    };
    expect(() => parsePackYaml(yaml.dump(bad))).toThrow();
  });

  it('should accept content licenses like CC-BY-4.0', () => {
    const manifest = {
      name: 'learning/opportunities',
      version: '1.0.0',
      description: 'Learning exercises for AI-assisted coding',
      author: 'drcathicks',
      license: 'CC-BY-4.0',
    };
    const pack = parsePackYaml(yaml.dump(manifest));
    expect(pack.manifest.license).toBe('CC-BY-4.0');
  });

  it('should accept custom license strings', () => {
    const manifest = {
      name: 'test/custom',
      version: '1.0.0',
      description: 'Custom license pack',
      author: 'test',
      license: 'Proprietary',
    };
    const pack = parsePackYaml(yaml.dump(manifest));
    expect(pack.manifest.license).toBe('Proprietary');
  });

  it('should accept all valid runtime types', () => {
    for (const type of ['local', 'e2b', 'cua', 'modal']) {
      const manifest = {
        name: 'test/rt',
        version: '1.0.0',
        description: 'x',
        author: 'y',
        runtime: { type },
      };
      const pack = parsePackYaml(yaml.dump(manifest));
      expect(pack.manifest.runtime?.type).toBe(type);
    }
  });

  it('should handle semver with prerelease and build metadata', () => {
    const manifest = {
      name: 'test/pre',
      version: '1.0.0-beta.1+build.42',
      description: 'x',
      author: 'y',
    };
    const pack = parsePackYaml(yaml.dump(manifest));
    expect(pack.manifest.version).toBe('1.0.0-beta.1+build.42');
  });
});

describe('loadPackFromDir', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackmemory-pack-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch {
      // cleanup best-effort
    }
  });

  it('should load pack.yaml from directory', async () => {
    const manifest = {
      name: 'test/simple',
      version: '1.0.0',
      description: 'Simple test pack',
      author: 'test',
      instructions: 'Inline instructions here.',
    };
    fs.writeFileSync(path.join(tmpDir, 'pack.yaml'), yaml.dump(manifest));

    const pack = await loadPackFromDir(tmpDir);
    expect(pack.manifest.name).toBe('test/simple');
    expect(pack.instructions).toBe('Inline instructions here.');
  });

  it('should resolve external instructions.md file', async () => {
    const manifest = {
      name: 'test/external',
      version: '1.0.0',
      description: 'Pack with external instructions',
      author: 'test',
      instructions: 'instructions.md',
    };
    fs.writeFileSync(path.join(tmpDir, 'pack.yaml'), yaml.dump(manifest));
    fs.writeFileSync(
      path.join(tmpDir, 'instructions.md'),
      '# External Instructions\n\nUse hooks for state management.'
    );

    const pack = await loadPackFromDir(tmpDir);
    expect(pack.instructions).toBe(
      '# External Instructions\n\nUse hooks for state management.'
    );
  });

  it('should handle missing instructions.md gracefully', async () => {
    const manifest = {
      name: 'test/missing',
      version: '1.0.0',
      description: 'Pack with missing instructions file',
      author: 'test',
      instructions: 'nonexistent.md',
    };
    fs.writeFileSync(path.join(tmpDir, 'pack.yaml'), yaml.dump(manifest));

    const pack = await loadPackFromDir(tmpDir);
    expect(pack.instructions).toBeUndefined();
  });

  it('should throw if pack.yaml does not exist', async () => {
    await expect(loadPackFromDir(tmpDir)).rejects.toThrow(
      'pack.yaml not found'
    );
  });

  it('should keep inline instructions that do not end with .md', async () => {
    const manifest = {
      name: 'test/inline',
      version: '1.0.0',
      description: 'Inline pack',
      author: 'test',
      instructions: 'Always use semicolons. Never use var.',
    };
    fs.writeFileSync(path.join(tmpDir, 'pack.yaml'), yaml.dump(manifest));

    const pack = await loadPackFromDir(tmpDir);
    expect(pack.instructions).toBe('Always use semicolons. Never use var.');
  });
});
