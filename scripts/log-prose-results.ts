#!/usr/bin/env tsx
/**
 * Run the PROSE platform-overview integration tests and log the results
 * into a Provenant knowledge graph as SOP-compliance decisions.
 *
 * Usage:
 *   npx tsx scripts/log-prose-results.ts [path/to/provenant.db]
 *
 * Requires PROVENANT_DB env var or a database path argument.
 */

import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '../packages/provenant/src/schema/database.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface VitestResult {
  testResults?: Array<{
    assertionResults: Array<{
      title: string;
      fullName: string;
      status: 'passed' | 'failed';
      duration: number;
    }>;
  }>;
  numPassedTests?: number;
  numFailedTests?: number;
}

function runTests(): VitestResult {
  const testFile = resolve(
    __dirname,
    '../src/__tests__/integration/platform-overview.test.ts'
  );
  const raw = execSync(
    `npx vitest run "${testFile}" --reporter=json --silent`,
    {
      cwd: resolve(__dirname, '..'),
      encoding: 'utf8',
      timeout: 300_000,
      env: {
        ...process.env,
        VITEST: undefined,
        NODE_ENV: undefined,
      },
    }
  );
  // vitest --reporter=json outputs one JSON object at the end; find the first '{'.
  const start = raw.indexOf('{');
  if (start === -1) {
    throw new Error('No JSON output from vitest');
  }
  return JSON.parse(raw.slice(start)) as VitestResult;
}

function mapTestToSop(testName: string, fullName: string): { sop?: string; proseId?: string } {
  const mapping: Record<string, { sop: string; proseId: string }> = {
    'active frame stack remains consistent': {
      sop: 'SOP-101 Frame Lifecycle',
      proseId: 'E.1',
    },
    'recorded decisions are immutable': {
      sop: 'SOP-102 Decision Record Keeping',
      proseId: 'E.2',
    },
    'projects in different directories are isolated': {
      sop: 'SOP-103 Project Boundary Enforcement',
      proseId: 'E.3',
    },
    'CLI commands return correct exit codes': {
      sop: 'SOP-201 CLI Exit-Code Compliance',
      proseId: 'E.4',
    },
    'SQLite database is self-contained in .stackmemory': {
      sop: 'SOP-202 Data Portability',
      proseId: 'E.5',
    },
  };

  for (const [key, value] of Object.entries(mapping)) {
    if (testName.includes(key) || fullName.includes(key)) {
      return value;
    }
  }
  return {};
}

function main(): void {
  const dbPath =
    process.argv[2] ?? process.env['PROVENANT_DB'] ?? '.provenant/graph.db';
  if (!dbPath) {
    console.error(
      'Provide a Provenant database path as an argument or set PROVENANT_DB'
    );
    process.exit(1);
  }

  mkdirSync(dirname(dbPath), { recursive: true });

  console.log('Running PROSE integration tests...');
  const result = runTests();
  const tests = result.testResults ?? [];

  if (tests.length === 0) {
    console.error('No test results found');
    process.exit(1);
  }

  console.log(`Test run complete: ${result.numPassedTests ?? 0} passed, ${result.numFailedTests ?? 0} failed`);

  const db = new Database(dbPath);
  try {
    const runId = `prose-run-${Date.now()}`;
    let logged = 0;

    const allTests = tests.flatMap((file) => file.assertionResults ?? []);

    for (const test of allTests) {
      const { sop, proseId } = mapTestToSop(test.title, test.fullName);
      if (!sop || !proseId) continue; // Only log SOP-backed Expectation tests

      const passed = test.status === 'passed';
      const content = passed
        ? `${proseId} / ${sop}: compliance verified by integration test`
        : `${proseId} / ${sop}: compliance NOT verified by integration test`;

      const node = db.insertNode({
        type: 'decision',
        content,
        embedding: null,
        actor: 'prose-harness',
        confidence: passed ? 0.95 : 0.4,
      });

      const source = db.insertSource({
        system: 'prose-test-run',
        external_id: `${runId}:${proseId}`,
        raw_payload: JSON.stringify({
          testName: test.title,
          fullName: test.fullName,
          status: test.status,
          duration: test.duration,
          proseId,
          sop,
        }),
        hash: `${runId}:${proseId}`,
      });

      db.linkNodeToSource(
        node.id,
        source.id,
        'prose-test-run',
        `${runId}:${proseId}`
      );
      logged++;
    }

    console.log(`Logged ${logged} SOP-compliance decisions to ${dbPath}`);
  } finally {
    db.close();
  }
}

main();
