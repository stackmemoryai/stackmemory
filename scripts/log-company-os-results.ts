#!/usr/bin/env tsx
/**
 * Run the Company OS PROSE integration tests and log the results
 * into a Provenant knowledge graph as SOP-compliance decisions.
 *
 * Usage:
 *   npx tsx scripts/log-company-os-results.ts [path/to/provenant.db]
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
    '../src/__tests__/integration/company-os.test.ts'
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
  const start = raw.indexOf('{');
  if (start === -1) {
    throw new Error('No JSON output from vitest');
  }
  return JSON.parse(raw.slice(start)) as VitestResult;
}

function mapTestToSop(
  testName: string,
  fullName: string
): { sop?: string; proseId?: string } {
  const mapping: Record<string, { sop: string; proseId: string }> = {
    'onboarding SOP covers accounts, hardware, and access': {
      sop: 'SOP-301 New Hire Onboarding',
      proseId: 'E.1',
    },
    'expense SOP requires manager and finance approval': {
      sop: 'SOP-302 Expense Approval',
      proseId: 'E.2',
    },
    'offboarding SOP defines a 24-hour access revocation SLA': {
      sop: 'SOP-303 Access Revocation',
      proseId: 'E.3',
    },
    'incident response SOP defines severity-based containment SLA': {
      sop: 'SOP-304 Security Incident Response',
      proseId: 'E.4',
    },
    'PTO SOP requires manager approval before time off': {
      sop: 'SOP-305 PTO Request',
      proseId: 'E.5',
    },
    'vendor SOP requires security review before data access': {
      sop: 'SOP-306 Vendor Onboarding',
      proseId: 'E.6',
    },
    'data retention SOP defines retention tiers and deletion logging': {
      sop: 'SOP-307 Data Retention',
      proseId: 'E.7',
    },
    'emergency contact SOP requires annual verification': {
      sop: 'SOP-308 Emergency Contact Update',
      proseId: 'E.8',
    },
    'decision-derived SOP is generated from DECISION anchors': {
      sop: 'SOP-401 Decision-derived Process',
      proseId: 'E.9',
    },
    'constraint-derived SOP is generated from CONSTRAINT anchors': {
      sop: 'SOP-402 Constraint-derived Process',
      proseId: 'E.10',
    },
    'risk-derived SOP is generated from RISK anchors': {
      sop: 'SOP-403 Risk-derived Process',
      proseId: 'E.11',
    },
    'fact-derived SOP is generated from FACT anchors': {
      sop: 'SOP-404 Fact-derived Process',
      proseId: 'E.12',
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

  console.log('Running Company OS integration tests...');
  const result = runTests();
  const tests = result.testResults ?? [];

  if (tests.length === 0) {
    console.error('No test results found');
    process.exit(1);
  }

  console.log(
    `Test run complete: ${result.numPassedTests ?? 0} passed, ${result.numFailedTests ?? 0} failed`
  );

  const db = new Database(dbPath);
  try {
    const runId = `company-os-run-${Date.now()}`;
    let logged = 0;

    const allTests = tests.flatMap((file) => file.assertionResults ?? []);

    for (const test of allTests) {
      const { sop, proseId } = mapTestToSop(test.title, test.fullName);
      if (!sop || !proseId) continue;

      const passed = test.status === 'passed';
      const content = passed
        ? `${proseId} / ${sop}: compliance verified by integration test`
        : `${proseId} / ${sop}: compliance NOT verified by integration test`;

      const node = db.insertNode({
        type: 'decision',
        content,
        embedding: null,
        actor: 'company-os-harness',
        confidence: passed ? 0.95 : 0.4,
      });

      const source = db.insertSource({
        system: 'company-os-test-run',
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
        'company-os-test-run',
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
