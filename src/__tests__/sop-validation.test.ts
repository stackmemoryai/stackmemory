import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';

const SOP_DIR = join(__dirname, '..', '..', 'docs', 'sops');
const SOP_GENERATED_DIR = join(SOP_DIR, 'generated');
const WIKI_DIR = join(__dirname, '..', '..', 'wiki');
const WIKI_SOPS_DIR = join(WIKI_DIR, 'sops');
const PROSE_SPECS = [
  join(__dirname, '..', '..', 'docs', 'specs', 'PROSE-platform-overview.md'),
  join(__dirname, '..', '..', 'docs', 'specs', 'COMPANY-OS-PROSE.md'),
];

function loadValidProseIds(): Set<string> {
  const ids = new Set<string>();
  const headingRegex = /^###\s+(E\.\d+)\s+/gm;
  for (const specPath of PROSE_SPECS) {
    const content = readFileSync(specPath, 'utf8');
    let match: RegExpExecArray | null;
    while ((match = headingRegex.exec(content)) !== null) {
      ids.add(match[1]!);
    }
  }
  return ids;
}

function collectSopFiles(): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(SOP_DIR)) {
    const path = join(SOP_DIR, entry);
    if (extname(entry) === '.md') {
      files.push(path);
    }
  }
  try {
    for (const entry of readdirSync(SOP_GENERATED_DIR)) {
      const path = join(SOP_GENERATED_DIR, entry);
      if (extname(entry) === '.md') {
        files.push(path);
      }
    }
  } catch {
    // generated dir may not exist
  }
  try {
    for (const entry of readdirSync(WIKI_DIR)) {
      const path = join(WIKI_DIR, entry);
      if (extname(entry) === '.md') {
        files.push(path);
      }
    }
  } catch {
    // wiki dir may not exist
  }
  try {
    for (const entry of readdirSync(WIKI_SOPS_DIR)) {
      const path = join(WIKI_SOPS_DIR, entry);
      if (extname(entry) === '.md') {
        files.push(path);
      }
    }
  } catch {
    // wiki/sops dir may not exist
  }
  return files;
}

describe('SOP validation', () => {
  const files = collectSopFiles();

  it('finds more than 5 SOP files', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('each SOP has a unique ID', () => {
    const ids = new Set<string>();
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      const match = content.match(/# (SOP-\d+)/);
      expect(match).toBeTruthy();
      const id = match![1]!;
      expect(ids.has(id)).toBe(false);
      ids.add(id);
    }
  });

  it('each SOP has required sections', () => {
    const required = ['## Objective', '## Procedure', '## Verification'];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      for (const section of required) {
        expect(content).toContain(section);
      }
    }
  });

  it('each SOP references a PROSE Expectation', () => {
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      expect(content).toMatch(/Related PROSE Expectation.*E\.\d+/);
    }
  });

  it('each SOP references a PROSE Expectation that exists in the spec', () => {
    const validIds = loadValidProseIds();
    expect(validIds.size).toBeGreaterThan(0);

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      const match = content.match(/Related PROSE Expectation.*\[(E\.\d+)/);
      expect(match).toBeTruthy();
      const proseId = match![1]!;
      expect(validIds.has(proseId)).toBe(true);
    }
  });
});
