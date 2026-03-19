import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from '../../schema/database.js';
import { scoreRecord } from '../../scoring/confidence.js';
import type { RawRecord } from '../../adapters/adapter.js';

interface CalibrateOpts {
  db: string;
  since?: string;
  autoAccept?: string;
  review?: string;
  sweep?: boolean;
}

interface BucketStats {
  total: number;
  byAction: Record<string, number>;
  avgConfidence: number;
  examples: Array<{ content: string; score: number; action: string }>;
}

export function calibrate(opts: CalibrateOpts): void {
  mkdirSync(dirname(opts.db), { recursive: true });
  const db = new Database(opts.db);

  try {
    const status = db.getStatus();
    if (status.nodeCount === 0) {
      console.error('No nodes in graph. Ingest data first before calibrating.');
      process.exit(1);
    }

    // Load all nodes as records for re-scoring
    const sinceMs = opts.since ? new Date(opts.since).getTime() : 0;
    const nodes = db.searchNodesByKeywords(
      [],
      10000,
      undefined,
      sinceMs || undefined
    );

    console.log(`Calibrating against ${nodes.length} nodes`);
    console.log('═'.repeat(50));

    if (opts.sweep) {
      runThresholdSweep(nodes);
    } else {
      const autoAccept = opts.autoAccept ? parseFloat(opts.autoAccept) : 0.7;
      const reviewThreshold = opts.review ? parseFloat(opts.review) : 0.4;
      runCalibration(nodes, autoAccept, reviewThreshold);
    }
  } finally {
    db.close();
  }
}

function nodeToRecord(node: {
  content: string;
  actor: string | null;
}): RawRecord {
  return {
    external_id: 'calibration',
    content: node.content,
    raw_payload: JSON.stringify({ content: node.content }),
    actor: node.actor ?? undefined,
  };
}

function runCalibration(
  nodes: Array<{ content: string; actor: string | null; confidence: number }>,
  autoAccept: number,
  reviewThreshold: number
): void {
  const buckets: Record<string, BucketStats> = {
    auto_accept: { total: 0, byAction: {}, avgConfidence: 0, examples: [] },
    review: { total: 0, byAction: {}, avgConfidence: 0, examples: [] },
    discard: { total: 0, byAction: {}, avgConfidence: 0, examples: [] },
  };

  let confidenceSum = 0;
  let mismatchCount = 0;

  for (const node of nodes) {
    const record = nodeToRecord(node);
    const result = scoreRecord(record, undefined, {
      autoAccept,
      review: reviewThreshold,
    });

    const bucket = buckets[result.action]!;
    bucket.total++;
    confidenceSum += result.score;

    // Track original confidence vs re-scored action
    // Nodes in the graph were auto-accepted, so any that now score as
    // 'review' or 'discard' are potential false positives
    if (result.action !== 'auto_accept') {
      mismatchCount++;
    }

    if (bucket.examples.length < 3) {
      bucket.examples.push({
        content: node.content.slice(0, 80),
        score: result.score,
        action: result.action,
      });
    }
  }

  const fpRate = nodes.length > 0 ? (mismatchCount / nodes.length) * 100 : 0;

  console.log(
    `\nThresholds: autoAccept=${autoAccept}, review=${reviewThreshold}`
  );
  console.log('─'.repeat(50));

  for (const [action, stats] of Object.entries(buckets)) {
    if (stats.total === 0) continue;
    const pct = ((stats.total / nodes.length) * 100).toFixed(1);
    console.log(`\n${action.toUpperCase()} — ${stats.total} nodes (${pct}%)`);
    for (const ex of stats.examples) {
      console.log(`  ${ex.score.toFixed(2)} │ ${ex.content}`);
    }
  }

  console.log('\n' + '═'.repeat(50));
  console.log(
    `FP rate (accepted nodes that would now be filtered): ${fpRate.toFixed(1)}%`
  );
  if (fpRate > 10) {
    console.log(
      `⚠ FP rate exceeds 10% target — consider lowering autoAccept threshold`
    );
  } else {
    console.log(`✓ FP rate within 10% target`);
  }
}

function runThresholdSweep(
  nodes: Array<{ content: string; actor: string | null; confidence: number }>
): void {
  console.log('\nThreshold sweep (autoAccept / review → FP%)');
  console.log('─'.repeat(50));
  console.log('autoAccept │ review │ accept% │ review% │ discard% │ FP%');
  console.log('───────────┼────────┼─────────┼─────────┼──────────┼─────');

  const thresholds = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
  const reviewThresholds = [0.2, 0.3, 0.4];

  for (const autoAccept of thresholds) {
    for (const review of reviewThresholds) {
      if (review >= autoAccept) continue;

      let accepted = 0;
      let reviewed = 0;
      let discarded = 0;

      for (const node of nodes) {
        const record = nodeToRecord(node);
        const result = scoreRecord(record, undefined, { autoAccept, review });
        if (result.action === 'auto_accept') accepted++;
        else if (result.action === 'review') reviewed++;
        else discarded++;
      }

      const total = nodes.length;
      const fpRate =
        total > 0 ? (((reviewed + discarded) / total) * 100).toFixed(1) : '0.0';
      const acceptPct =
        total > 0 ? ((accepted / total) * 100).toFixed(1) : '0.0';
      const reviewPct =
        total > 0 ? ((reviewed / total) * 100).toFixed(1) : '0.0';
      const discardPct =
        total > 0 ? ((discarded / total) * 100).toFixed(1) : '0.0';

      const marker = parseFloat(fpRate) <= 10 ? ' ✓' : '';
      console.log(
        `    ${autoAccept.toFixed(1)}    │  ${review.toFixed(1)}   │  ${acceptPct.padStart(5)}  │  ${reviewPct.padStart(5)}  │   ${discardPct.padStart(5)}  │ ${fpRate.padStart(5)}${marker}`
      );
    }
  }

  console.log('\n✓ = FP rate ≤ 10% target');
}
