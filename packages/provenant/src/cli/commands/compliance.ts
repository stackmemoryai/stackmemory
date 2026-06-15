import { existsSync } from 'node:fs';
import { Database } from '../../schema/database.js';

interface ComplianceOpts {
  db: string;
  system?: string;
}

interface ComplianceEntry {
  proseId: string;
  sop: string;
  status: 'pass' | 'fail' | 'unknown';
  confidence: number;
  runId: string;
  runAt: string;
}

export function compliance(opts: ComplianceOpts): void {
  if (!existsSync(opts.db)) {
    console.error('No database found. Run `provenant log-decision` or ingest first.');
    process.exit(1);
  }

  const db = new Database(opts.db);

  try {
    const system = opts.system ?? 'prose-test-run';
    const nodes = db.getNodesBySourceSystem(system);

    const entries: ComplianceEntry[] = [];
    const seen = new Set<string>();

    for (const node of nodes) {
      const sources = db.getSourcesForNode(node.id);
      const source = sources.find((s) => s.system === system);
      if (!source) continue;

      let metadata: Record<string, unknown> = {};
      try {
        metadata = JSON.parse(source.raw_payload) as Record<string, unknown>;
      } catch {
        // ignore malformed payload
      }

      const proseId = (metadata['proseId'] as string) ?? extractProseId(node.content);
      const sop = (metadata['sop'] as string) ?? extractSop(node.content);
      if (!proseId || seen.has(proseId)) continue;
      seen.add(proseId);

      const passed = node.content.includes('compliance verified');
      const failed = node.content.includes('compliance NOT verified');

      entries.push({
        proseId,
        sop,
        status: passed ? 'pass' : failed ? 'fail' : 'unknown',
        confidence: node.confidence,
        runId: source.external_id.split(':')[0] ?? 'unknown',
        runAt: new Date(node.created_at).toISOString(),
      });
    }

    // Sort by PROSE ID
    entries.sort((a, b) => a.proseId.localeCompare(b.proseId));

    console.log(`SOP Compliance Report (${system})`);
    console.log('─'.repeat(60));

    if (entries.length === 0) {
      console.log('No compliance decisions found.');
      console.log(`Run: npx tsx scripts/log-prose-results.ts ${opts.db}`);
      return;
    }

    const passed = entries.filter((e) => e.status === 'pass').length;
    const failed = entries.filter((e) => e.status === 'fail').length;

    for (const entry of entries) {
      const icon = entry.status === 'pass' ? '✓' : entry.status === 'fail' ? '✗' : '?';
      console.log(
        `${icon} ${entry.proseId}  ${entry.sop.slice(0, 40).padEnd(40)}  confidence ${entry.confidence.toFixed(2)}`
      );
    }

    console.log('─'.repeat(60));
    console.log(`Total: ${entries.length}  Passed: ${passed}  Failed: ${failed}`);
  } finally {
    db.close();
  }
}

function extractProseId(content: string): string | undefined {
  const match = content.match(/^(E\.\d+)/);
  return match?.[1];
}

function extractSop(content: string): string {
  const match = content.match(/^E\.\d+ \/ ([^:]+):/);
  return match?.[1] ?? 'Unknown SOP';
}
