import { existsSync } from 'node:fs';
import { Database } from '../../schema/database.js';

interface StatusOpts {
  db: string;
}

export function status(opts: StatusOpts): void {
  if (!existsSync(opts.db)) {
    console.log(
      'No database found. Run `provenant log-decision` to create one.'
    );
    return;
  }

  const db = new Database(opts.db);

  try {
    const s = db.getStatus();

    console.log('Provenant Graph Status');
    console.log('─'.repeat(30));
    console.log(`  Nodes:                    ${s.nodeCount}`);
    console.log(`  Edges:                    ${s.edgeCount}`);
    console.log(`  Review queue (pending):   ${s.pendingQueue}`);
    console.log(`  Contradictions (open):    ${s.unresolvedContradictions}`);
    console.log(`  Stale flags (open):       ${s.unresolvedStaleFlags}`);
    console.log(`  Rejections (no reason):   ${s.unresolvedRejections}`);
  } finally {
    db.close();
  }
}
