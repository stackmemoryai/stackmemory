import { existsSync } from 'node:fs';
import { Database } from '../../schema/database.js';

interface LogOverrideListOpts {
  db: string;
  limit: string;
}

interface LogOverrideResolveOpts {
  db: string;
  reasoning: string;
}

export function logOverrideList(opts: LogOverrideListOpts): void {
  if (!existsSync(opts.db)) {
    console.error('No database found.');
    process.exit(1);
  }

  const db = new Database(opts.db);

  try {
    const entries = db.getUnresolvedRejections();
    const limit = parseInt(opts.limit, 10) || 20;

    console.log(`Unresolved Rejections: ${entries.length}`);
    console.log('─'.repeat(60));

    const shown = entries.slice(0, limit);
    for (const entry of shown) {
      const age = Math.floor((Date.now() - entry.created_at) / 86_400_000);
      const suggestion = db.getNode(entry.suggestion_node);
      const override = entry.override_node
        ? db.getNode(entry.override_node)
        : undefined;

      console.log(
        `  ${entry.id.slice(0, 8)}  ${age}d ago  actor: ${entry.actor ?? '—'}`
      );
      console.log(
        `    suggestion: ${suggestion?.content.slice(0, 80) ?? entry.suggestion_node}${(suggestion?.content.length ?? 0) > 80 ? '...' : ''}`
      );
      if (override) {
        console.log(
          `    override:   ${override.content.slice(0, 80)}${override.content.length > 80 ? '...' : ''}`
        );
      }
      console.log();
    }

    if (entries.length > limit) {
      console.log(`  ... and ${entries.length - limit} more`);
    }

    if (entries.length === 0) {
      console.log('  No unresolved rejections.');
    }
  } finally {
    db.close();
  }
}

export function logOverrideResolve(
  id: string,
  opts: LogOverrideResolveOpts
): void {
  if (!existsSync(opts.db)) {
    console.error('No database found.');
    process.exit(1);
  }

  const db = new Database(opts.db);

  try {
    const entry = db.findRejection(id);
    if (!entry) {
      console.error(`No unresolved rejection matching: ${id}`);
      process.exit(1);
    }

    db.resolveRejectionReasoning(entry.id, opts.reasoning);
    console.log(`Resolved rejection ${entry.id.slice(0, 8)}`);
    console.log(`  reasoning: ${opts.reasoning}`);
  } finally {
    db.close();
  }
}
