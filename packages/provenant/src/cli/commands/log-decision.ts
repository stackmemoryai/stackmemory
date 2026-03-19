import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from '../../schema/database.js';
import { ManualAdapter } from '../../adapters/manual.js';
import { scoreRecord } from '../../scoring/confidence.js';

interface LogDecisionOpts {
  content: string;
  actor?: string;
  reasoning?: string;
  sourceUrl?: string;
  sourceFile?: string;
  db: string;
}

export function logDecision(opts: LogDecisionOpts): void {
  mkdirSync(dirname(opts.db), { recursive: true });
  const db = new Database(opts.db);

  try {
    const adapter = new ManualAdapter();
    const record = adapter.createRecord({
      content: opts.content,
      actor: opts.actor,
      reasoning: opts.reasoning,
      sourceUrl: opts.sourceUrl,
      sourceFile: opts.sourceFile,
    });

    const result = scoreRecord(record, adapter.signalModel);

    // Write source record
    const source = db.insertSource({
      system: adapter.system,
      external_id: record.external_id,
      raw_payload: record.raw_payload,
      hash: adapter.hashRecord(record),
    });

    // Manual entries always create a node (skip review queue)
    const node = db.insertNode({
      type: 'decision',
      content: record.content,
      embedding: null,
      actor: record.actor ?? null,
      confidence: result.score,
    });

    // Link node to source
    db.linkNodeToSource(node.id, source.id, adapter.system, record.external_id);

    console.log(`Node ${node.id}`);
    console.log(`  type:       decision`);
    console.log(`  confidence: ${result.score.toFixed(2)} (${result.action})`);
    console.log(`  actor:      ${node.actor ?? '—'}`);
    if (opts.sourceUrl) {
      console.log(`  source-url: ${opts.sourceUrl}`);
    }
    if (opts.sourceFile) {
      console.log(`  source-file: ${opts.sourceFile}`);
    }
    console.log(`  signals:`);
    for (const s of result.signals) {
      const icon = s.matched ? (s.weight >= 0 ? '+' : '−') : ' ';
      console.log(
        `    ${icon} ${s.name} (${s.weight >= 0 ? '+' : ''}${s.weight})`
      );
    }
  } finally {
    db.close();
  }
}
