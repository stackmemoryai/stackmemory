import { existsSync } from 'node:fs';
import { Database } from '../../schema/database.js';

interface ResolveOpts {
  winner?: string;
  dismiss: boolean;
  db: string;
}

export function resolve(nodeA: string, nodeB: string, opts: ResolveOpts): void {
  if (!existsSync(opts.db)) {
    console.error('No database found.');
    process.exit(1);
  }

  if (!opts.winner && !opts.dismiss) {
    console.error('Specify --winner <id> or --dismiss');
    process.exit(1);
  }

  const db = new Database(opts.db);

  try {
    // Find the contradiction between these two nodes (match by prefix)
    const contradiction = db.findContradiction(nodeA, nodeB);

    if (!contradiction) {
      console.error(`No pending contradiction between ${nodeA} and ${nodeB}`);
      const pending = db.getPendingContradictions();
      if (pending.length > 0) {
        console.log('\nPending contradictions:');
        for (const c of pending) {
          console.log(
            `  ${c.node_a.slice(0, 8)} ↔ ${c.node_b.slice(0, 8)} (score: ${c.conflict_score.toFixed(2)})`
          );
        }
      }
      process.exit(1);
    }

    if (opts.dismiss) {
      db.resolveContradiction(contradiction.id, 'human', 'dismissed');
      console.log(`Dismissed contradiction ${contradiction.id.slice(0, 8)}`);
      console.log(
        `  ${contradiction.node_a.slice(0, 8)} ↔ ${contradiction.node_b.slice(0, 8)}`
      );
    } else if (opts.winner) {
      // Validate winner is one of the two nodes
      const winnerNode = [contradiction.node_a, contradiction.node_b].find(
        (id) => id.startsWith(opts.winner!)
      );
      if (!winnerNode) {
        console.error(
          `Winner must be one of: ${contradiction.node_a.slice(0, 8)}, ${contradiction.node_b.slice(0, 8)}`
        );
        process.exit(1);
      }

      const loserNode =
        winnerNode === contradiction.node_a
          ? contradiction.node_b
          : contradiction.node_a;

      db.resolveContradiction(contradiction.id, winnerNode, 'resolved');

      // Create a supersedes edge from winner to loser
      db.insertEdge({
        from_node: winnerNode,
        to_node: loserNode,
        rel_type: 'supersedes',
        confidence: 1.0,
      });

      console.log(
        `Resolved: ${winnerNode.slice(0, 8)} supersedes ${loserNode.slice(0, 8)}`
      );
    }
  } finally {
    db.close();
  }
}
