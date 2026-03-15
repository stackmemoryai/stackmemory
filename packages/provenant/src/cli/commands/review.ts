import { existsSync } from 'node:fs';
import { Database } from '../../schema/database.js';

interface ReviewListOpts {
  db: string;
  limit: string;
}

interface ReviewActionOpts {
  db: string;
}

export function reviewList(opts: ReviewListOpts): void {
  if (!existsSync(opts.db)) {
    console.error('No database found.');
    process.exit(1);
  }

  const db = new Database(opts.db);

  try {
    const limit = parseInt(opts.limit, 10) || 20;
    const items = db.getPendingQueue();
    const expired = items.filter((i) => i.expires_at < Date.now());
    const active = items.filter((i) => i.expires_at >= Date.now());

    console.log(
      `Review Queue: ${active.length} pending, ${expired.length} expired`
    );
    console.log('─'.repeat(60));

    const shown = active.slice(0, limit);
    for (const item of shown) {
      const age = Math.floor((Date.now() - item.created_at) / 86_400_000);
      const ttl = Math.floor((item.expires_at - Date.now()) / 86_400_000);
      console.log(
        `  ${item.id.slice(0, 8)}  ${item.confidence.toFixed(2)}  [${item.queue_reason}]  ${age}d old, ${ttl}d left`
      );
      console.log(
        `    ${item.candidate_content.slice(0, 100)}${item.candidate_content.length > 100 ? '...' : ''}`
      );
      console.log();
    }

    if (active.length > limit) {
      console.log(`  ... and ${active.length - limit} more`);
    }

    if (expired.length > 0) {
      console.log(
        `\n${expired.length} expired items. Run \`provenant review expire\` to process them.`
      );
    }
  } finally {
    db.close();
  }
}

export function reviewApprove(id: string, opts: ReviewActionOpts): void {
  if (!existsSync(opts.db)) {
    console.error('No database found.');
    process.exit(1);
  }

  const db = new Database(opts.db);

  try {
    const item = db.findQueueItem(id);
    if (!item) {
      console.error(`No pending queue item matching: ${id}`);
      process.exit(1);
    }

    // Promote to node
    const node = db.insertNode({
      type: 'decision',
      content: item.candidate_content,
      embedding: null,
      actor: null,
      confidence: item.confidence,
    });

    // Link to source
    db.linkNodeToSource(node.id, item.source_id, 'review', item.id);

    // Mark resolved
    db.resolveQueueItem(item.id);

    console.log(
      `Approved → Node ${node.id.slice(0, 8)} (confidence: ${item.confidence.toFixed(2)})`
    );
    console.log(`  ${item.candidate_content.slice(0, 100)}`);
  } finally {
    db.close();
  }
}

export function reviewDismiss(id: string, opts: ReviewActionOpts): void {
  if (!existsSync(opts.db)) {
    console.error('No database found.');
    process.exit(1);
  }

  const db = new Database(opts.db);

  try {
    const item = db.findQueueItem(id);
    if (!item) {
      console.error(`No pending queue item matching: ${id}`);
      process.exit(1);
    }

    db.resolveQueueItem(item.id);
    console.log(`Dismissed queue item ${item.id.slice(0, 8)}`);
  } finally {
    db.close();
  }
}

export function reviewExpire(opts: ReviewActionOpts): void {
  if (!existsSync(opts.db)) {
    console.error('No database found.');
    process.exit(1);
  }

  const db = new Database(opts.db);

  try {
    const items = db.getPendingQueue();
    const expired = items.filter((i) => i.expires_at < Date.now());

    let promoted = 0;
    let discarded = 0;

    for (const item of expired) {
      if (item.confidence >= 0.55) {
        // Auto-promote with decayed flag
        const node = db.insertNode({
          type: 'decision',
          content: item.candidate_content,
          embedding: null,
          actor: null,
          confidence: item.confidence,
        });
        db.linkNodeToSource(node.id, item.source_id, 'review', item.id);
        // Flag as confidence-decayed
        db.flagStale(node.id, `confidence_decayed:${item.id}`);
        promoted++;
      } else {
        discarded++;
      }
      db.resolveQueueItem(item.id);
    }

    console.log(`Processed ${expired.length} expired items:`);
    console.log(`  Promoted (>=0.55): ${promoted}`);
    console.log(`  Discarded (<0.55): ${discarded}`);
  } finally {
    db.close();
  }
}
