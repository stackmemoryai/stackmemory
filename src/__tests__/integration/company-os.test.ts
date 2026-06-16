/**
 * Company OS PROSE Integration Tests
 *
 * PROSE = Purpose, Rules & Constraints, Observables, Scenarios, Expectations
 * Spec source: docs/specs/COMPANY-OS-PROSE.md
 *
 * These tests validate that Company OS processes in wiki/ are structured as
 * SOPs, reference valid PROSE Expectations, and can be audited.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  readdirSync,
  readFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { WikiCompiler } from '../../core/wiki/wiki-compiler.js';

const WIKI_DIR = join(__dirname, '..', '..', '..', 'wiki');
const PROSE_SPEC_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'docs',
  'specs',
  'COMPANY-OS-PROSE.md'
);

function collectSopFiles(): string[] {
  if (!existsSync(WIKI_DIR)) return [];
  return readdirSync(WIKI_DIR)
    .filter((entry) => extname(entry) === '.md')
    .map((entry) => join(WIKI_DIR, entry));
}

function loadValidProseIds(): Set<string> {
  const content = readFileSync(PROSE_SPEC_PATH, 'utf8');
  const ids = new Set<string>();
  const headingRegex = /^###\s+(E\.\d+)\s+/gm;
  let match: RegExpExecArray | null;
  while ((match = headingRegex.exec(content)) !== null) {
    ids.add(match[1]!);
  }
  return ids;
}

describe('Company OS PROSE', { timeout: 30_000 }, () => {
  // ---------------------------------------------------------------------------
  // P — Purpose
  // ---------------------------------------------------------------------------

  describe('P.1 Process discoverability', () => {
    it('lists SOPs in the company OS wiki', () => {
      const files = collectSopFiles();
      expect(files.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // R — Rules & Constraints
  // ---------------------------------------------------------------------------

  describe('R.1 SOP schema', () => {
    it('each SOP has required sections', () => {
      const files = collectSopFiles();
      expect(files.length).toBeGreaterThan(0);

      const required = ['## Objective', '## Procedure', '## Verification'];
      for (const file of files) {
        const content = readFileSync(file, 'utf8');
        for (const section of required) {
          expect(content).toContain(section);
        }
      }
    });
  });

  describe('R.2 PROSE reference', () => {
    it('each SOP references a valid PROSE Expectation', () => {
      const files = collectSopFiles();
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

  // ---------------------------------------------------------------------------
  // E — Expectations
  // ---------------------------------------------------------------------------

  describe('E.1 Onboarding completeness (SOP-301)', () => {
    it('onboarding SOP covers accounts, hardware, and access', () => {
      const sopPath = join(WIKI_DIR, 'SOP-301-onboarding.md');
      expect(existsSync(sopPath)).toBe(true);

      const content = readFileSync(sopPath, 'utf8');
      expect(content).toMatch(/account|SSO|login/i);
      expect(content).toMatch(/hardware|laptop/i);
      expect(content).toMatch(/access/i);
    });
  });

  describe('E.2 Expense policy compliance (SOP-302)', () => {
    it('expense SOP requires manager and finance approval', () => {
      const sopPath = join(WIKI_DIR, 'SOP-302-expense-approval.md');
      expect(existsSync(sopPath)).toBe(true);

      const content = readFileSync(sopPath, 'utf8');
      expect(content).toMatch(/manager/i);
      expect(content).toMatch(/finance/i);
      expect(content).toMatch(/approval/i);
    });
  });

  describe('E.3 Offboarding access removal (SOP-303)', () => {
    it('offboarding SOP defines a 24-hour access revocation SLA', () => {
      const sopPath = join(WIKI_DIR, 'SOP-303-access-revocation.md');
      expect(existsSync(sopPath)).toBe(true);

      const content = readFileSync(sopPath, 'utf8');
      expect(content).toMatch(/24\s*hours/i);
      expect(content).toMatch(/revok|disabl|remov/i);
    });
  });

  describe('E.4 Security incident response SLA (SOP-304)', () => {
    it('incident response SOP defines severity-based containment SLA', () => {
      const sopPath = join(WIKI_DIR, 'SOP-304-security-incident-response.md');
      expect(existsSync(sopPath)).toBe(true);

      const content = readFileSync(sopPath, 'utf8');
      expect(content).toMatch(/severity/i);
      expect(content).toMatch(/2\s*hours|24\s*hours/i);
      expect(content).toMatch(/contain|respond/i);
    });
  });

  describe('E.5 PTO request approval workflow (SOP-305)', () => {
    it('PTO SOP requires manager approval before time off', () => {
      const sopPath = join(WIKI_DIR, 'SOP-305-pto-request.md');
      expect(existsSync(sopPath)).toBe(true);

      const content = readFileSync(sopPath, 'utf8');
      expect(content).toMatch(/manager/i);
      expect(content).toMatch(/approv/i);
      expect(content).toMatch(/PTO|time off/i);
    });
  });

  describe('E.6 Vendor security review (SOP-306)', () => {
    it('vendor SOP requires security review before data access', () => {
      const sopPath = join(WIKI_DIR, 'SOP-306-vendor-onboarding.md');
      expect(existsSync(sopPath)).toBe(true);

      const content = readFileSync(sopPath, 'utf8');
      expect(content).toMatch(/security/i);
      expect(content).toMatch(/vendor/i);
      expect(content).toMatch(/review|questionnaire/i);
    });
  });

  describe('E.7 Data retention enforcement (SOP-307)', () => {
    it('data retention SOP defines retention tiers and deletion logging', () => {
      const sopPath = join(WIKI_DIR, 'SOP-307-data-retention.md');
      expect(existsSync(sopPath)).toBe(true);

      const content = readFileSync(sopPath, 'utf8');
      expect(content).toMatch(/retention/i);
      expect(content).toMatch(/delet|archive/i);
      expect(content).toMatch(/quarterly|period/i);
    });
  });

  describe('E.8 Emergency contact completeness (SOP-308)', () => {
    it('emergency contact SOP requires annual verification', () => {
      const sopPath = join(WIKI_DIR, 'SOP-308-emergency-contact.md');
      expect(existsSync(sopPath)).toBe(true);

      const content = readFileSync(sopPath, 'utf8');
      expect(content).toMatch(/emergency contact/i);
      expect(content).toMatch(/annual|yearly/i);
      expect(content).toMatch(/update|verify/i);
    });
  });

  // ---------------------------------------------------------------------------
  // Derived SOPs from frame anchors
  // ---------------------------------------------------------------------------

  describe('E.9 Decision-derived process (SOP-401)', () => {
    it('decision-derived SOP is generated from DECISION anchors', async () => {
      const wikiDir = mkdtempSync(join(tmpdir(), 'stackmemory-wiki-test-'));
      try {
        const compiler = new WikiCompiler({ wikiDir });
        await compiler.initialize();

        await compiler.create({
          digests: [],
          entities: [],
          anchors: [
            {
              anchor_id: 'a1',
              frame_id: 'f1',
              frame_name: 'Architecture',
              type: 'DECISION',
              text: 'Use SQLite for local storage',
              priority: 1,
              created_at: Math.floor(Date.now() / 1000),
            },
          ],
        });

        const sopPath = join(
          wikiDir,
          'sops',
          'SOP-401-decision-derived-process.md'
        );
        expect(existsSync(sopPath)).toBe(true);

        const content = readFileSync(sopPath, 'utf8');
        expect(content).toMatch(/SOP-401/);
        expect(content).toMatch(/E\.9/);
        expect(content).toMatch(/Use SQLite for local storage/);
      } finally {
        rmSync(wikiDir, { recursive: true, force: true });
      }
    });
  });

  describe('E.10 Constraint-derived process (SOP-402)', () => {
    it('constraint-derived SOP is generated from CONSTRAINT anchors', async () => {
      const wikiDir = mkdtempSync(join(tmpdir(), 'stackmemory-wiki-test-'));
      try {
        const compiler = new WikiCompiler({ wikiDir });
        await compiler.initialize();

        await compiler.create({
          digests: [],
          entities: [],
          anchors: [
            {
              anchor_id: 'a2',
              frame_id: 'f2',
              frame_name: 'Planning',
              type: 'CONSTRAINT',
              text: 'No external database dependencies',
              priority: 1,
              created_at: Math.floor(Date.now() / 1000),
            },
          ],
        });

        const sopPath = join(
          wikiDir,
          'sops',
          'SOP-402-constraint-derived-process.md'
        );
        expect(existsSync(sopPath)).toBe(true);

        const content = readFileSync(sopPath, 'utf8');
        expect(content).toMatch(/SOP-402/);
        expect(content).toMatch(/E\.10/);
        expect(content).toMatch(/No external database dependencies/);
      } finally {
        rmSync(wikiDir, { recursive: true, force: true });
      }
    });
  });

  describe('E.11 Risk-derived process (SOP-403)', () => {
    it('risk-derived SOP is generated from RISK anchors', async () => {
      const wikiDir = mkdtempSync(join(tmpdir(), 'stackmemory-wiki-test-'));
      try {
        const compiler = new WikiCompiler({ wikiDir });
        await compiler.initialize();

        await compiler.create({
          digests: [],
          entities: [],
          anchors: [
            {
              anchor_id: 'a3',
              frame_id: 'f3',
              frame_name: 'Risk Review',
              type: 'RISK',
              text: 'API keys committed to repo',
              priority: 1,
              created_at: Math.floor(Date.now() / 1000),
            },
          ],
        });

        const sopPath = join(
          wikiDir,
          'sops',
          'SOP-403-risk-derived-process.md'
        );
        expect(existsSync(sopPath)).toBe(true);

        const content = readFileSync(sopPath, 'utf8');
        expect(content).toMatch(/SOP-403/);
        expect(content).toMatch(/E\.11/);
        expect(content).toMatch(/API keys committed to repo/);
      } finally {
        rmSync(wikiDir, { recursive: true, force: true });
      }
    });
  });

  describe('E.12 Fact-derived process (SOP-404)', () => {
    it('fact-derived SOP is generated from FACT anchors', async () => {
      const wikiDir = mkdtempSync(join(tmpdir(), 'stackmemory-wiki-test-'));
      try {
        const compiler = new WikiCompiler({ wikiDir });
        await compiler.initialize();

        await compiler.create({
          digests: [],
          entities: [],
          anchors: [
            {
              anchor_id: 'a4',
              frame_id: 'f4',
              frame_name: 'Discovery',
              type: 'FACT',
              text: 'Users prefer local-first storage',
              priority: 1,
              created_at: Math.floor(Date.now() / 1000),
            },
          ],
        });

        const sopPath = join(
          wikiDir,
          'sops',
          'SOP-404-fact-derived-process.md'
        );
        expect(existsSync(sopPath)).toBe(true);

        const content = readFileSync(sopPath, 'utf8');
        expect(content).toMatch(/SOP-404/);
        expect(content).toMatch(/E\.12/);
        expect(content).toMatch(/Users prefer local-first storage/);
      } finally {
        rmSync(wikiDir, { recursive: true, force: true });
      }
    });
  });
});
