import { existsSync } from 'node:fs';
import { Database } from '../../schema/database.js';
import { createEmbeddingProvider } from '../../embed/client.js';
import { query } from '../../query/engine.js';

interface QueryOpts {
  db: string;
  actor?: string;
  since?: string;
  model?: string;
}

export async function runQuery(
  question: string,
  opts: QueryOpts
): Promise<void> {
  if (!existsSync(opts.db)) {
    console.error(
      'No database found. Run `provenant log-decision` or `provenant ingest` first.'
    );
    process.exit(1);
  }

  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    console.log(
      'Running in keyword-only mode (set ANTHROPIC_API_KEY for AI answers)'
    );
  }

  const db = new Database(opts.db);
  const embedder = createEmbeddingProvider();

  try {
    const since = opts.since ? new Date(opts.since).getTime() : undefined;

    const result = await query(db, embedder, question, {
      anthropicApiKey: apiKey,
      model: opts.model,
      actorFilter: opts.actor,
      since,
    });

    // Print answer
    console.log(result.answer);

    // Print metadata footer
    const meta: string[] = [];
    if (result.citations.length > 0) {
      meta.push(`${result.citations.length} nodes cited`);
    }
    if (result.staleFlags.length > 0) {
      meta.push(`${result.staleFlags.length} stale`);
    }
    if (result.contradictions.length > 0) {
      meta.push(`${result.contradictions.length} contradictions`);
    }
    if (result.unresolvedRejections > 0) {
      meta.push(`${result.unresolvedRejections} rejections need reasoning`);
    }

    if (meta.length > 0) {
      console.log('\n' + '─'.repeat(30));
      console.log(meta.join(' · '));
    }
  } finally {
    db.close();
  }
}
