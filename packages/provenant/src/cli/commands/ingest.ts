import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from '../../schema/database.js';
import { ingest } from '../../pipeline/ingest.js';
import { createEmbeddingProvider } from '../../embed/client.js';
import { getAdapter, listAdapters } from '../registry.js';

interface IngestOpts {
  source: string;
  db: string;
  dryRun: boolean;
}

export async function runIngest(opts: IngestOpts): Promise<void> {
  const adapter = getAdapter(opts.source);
  if (!adapter) {
    console.error(`Unknown source adapter: "${opts.source}"`);
    console.error(`Available adapters: ${listAdapters().join(', ')}`);
    process.exit(1);
  }

  mkdirSync(dirname(opts.db), { recursive: true });
  const db = new Database(opts.db);
  const embedder = createEmbeddingProvider();

  if (!embedder) {
    console.log(
      'No embedding provider configured (set OPENAI_API_KEY). Dedup disabled.'
    );
  }

  try {
    const result = await ingest(db, adapter, embedder, { dryRun: opts.dryRun });

    console.log(`Ingest: ${opts.source}${opts.dryRun ? ' (dry run)' : ''}`);
    console.log('─'.repeat(30));
    console.log(`  Fetched:        ${result.fetched}`);
    console.log(`  Unchanged:      ${result.unchanged}`);
    console.log(`  Auto-accepted:  ${result.autoAccepted}`);
    console.log(`  Queued:         ${result.queued}`);
    console.log(`  Discarded:      ${result.discarded}`);
    console.log(`  Deduped:        ${result.deduped}`);
    console.log(`  Stale flags:    ${result.staleFlags}`);
  } finally {
    db.close();
  }
}
