#!/usr/bin/env tsx
/**
 * Generate randomized SOP files for testing the PROSE → Provenant pipeline.
 *
 * Usage:
 *   npx tsx scripts/generate-random-sops.ts <count>
 *
 * Example:
 *   npx tsx scripts/generate-random-sops.ts 20
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT_DIR = resolve(__dirname, '../.tmp/generated-sops');

const CONCERNS = [
  'Error Handling',
  'Observability',
  'Backup and Recovery',
  'Authentication',
  'Authorization',
  'Data Encryption',
  'Input Validation',
  'Rate Limiting',
  'Audit Logging',
  'Dependency Management',
  'Secret Rotation',
  'Multi-Agent Coordination',
  'API Versioning',
  'Configuration Management',
  'Schema Migration',
  'Performance Budget',
  'Caching Strategy',
  'Retry Policy',
  'Circuit Breaking',
  'Feature Flagging',
];

// Maps each concern to a stable PROSE Expectation ID (E.6–E.25).
const CONCERN_TO_PROSE_ID: Record<string, number> = {
  'Error Handling': 6,
  Observability: 7,
  'Backup and Recovery': 8,
  Authentication: 9,
  Authorization: 10,
  'Data Encryption': 11,
  'Input Validation': 12,
  'Rate Limiting': 13,
  'Audit Logging': 14,
  'Dependency Management': 15,
  'Secret Rotation': 16,
  'Multi-Agent Coordination': 17,
  'API Versioning': 18,
  'Configuration Management': 19,
  'Schema Migration': 20,
  'Performance Budget': 21,
  'Caching Strategy': 22,
  'Retry Policy': 23,
  'Circuit Breaking': 24,
  'Feature Flagging': 25,
};

const VERBS = ['must', 'should', 'shall', 'is required to', 'must always'];

const ACTIONS = [
  'return a structured error response',
  'log the event with context',
  'retry with exponential backoff',
  'reject invalid input before processing',
  'enforce the configured rate limit',
  'emit a metric for monitoring',
  'persist an audit record',
  'validate the digital signature',
  'expire cached entries on update',
  'isolate failures to the affected scope',
];

const SCOPES = [
  'for all CLI commands',
  'for every API endpoint',
  'when processing webhooks',
  'during ingestion',
  'when querying the graph',
  'for cross-project operations',
  'when handling external adapters',
  'during snapshot capture',
];

function rand<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function generateSopId(index: number): string {
  // Start at 1000 to avoid collisions with hand-written SOPs (100-202).
  // Use deterministic IDs so re-running the generator is idempotent.
  return `SOP-${1000 + index + 1}`;
}

function generateSopContent(id: string, concern: string): string {
  const verb = rand(VERBS);
  const action = rand(ACTIONS);
  const scope = rand(SCOPES);
  const proseId = CONCERN_TO_PROSE_ID[concern] ?? 6;
  return `# ${id} ${concern}

**Owner:** Platform Team  
**Status:** Active  
**Related PROSE Expectation:** [E.${proseId} ${concern}](../specs/PROSE-platform-overview.md#e${proseId}-${concern.toLowerCase().replace(/\s+/g, '-')})

## Objective
Ensure ${concern.toLowerCase()} is handled consistently across the platform.

## Procedure

1. **Trigger detection**
   - The system ${verb} detect conditions that require ${concern.toLowerCase()} ${scope}.

2. **Action**
   - Upon detection, the system ${verb} ${action} ${scope}.

3. **Verification**
   - Each occurrence ${verb} be traceable to a decision node or audit log entry.

## Verification

- Run the relevant integration test suite.
- Expected result: no violations of the ${concern.toLowerCase()} rule are observed.

## Non-compliance

Failure to ${action} ${scope} is considered non-compliant.
`;
}

function main(): void {
  const outDir = process.argv[2] ?? DEFAULT_OUT_DIR;
  const count = parseInt(process.argv[3] ?? '10', 10);
  if (isNaN(count) || count < 1 || count > 1000) {
    console.error(
      'Usage: npx tsx scripts/generate-random-sops.ts [outDir] <count>'
    );
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });

  const generated: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = generateSopId(i);
    const concern = rand(CONCERNS);
    const filename = `${id.toLowerCase()}-${concern.toLowerCase().replace(/\s+/g, '-')}.md`;
    const content = generateSopContent(id, concern);
    writeFileSync(resolve(outDir, filename), content);
    generated.push(id);
  }

  console.log(
    `Generated ${generated.length} randomized SOP files in ${outDir}`
  );
  console.log(
    generated.slice(0, 10).join(', ') + (generated.length > 10 ? '...' : '')
  );
}

main();
