/**
 * Pattern Applier
 *
 * Surfaces relevant patterns during context retrieval.
 * Called by the context retrieval pipeline to inject learned patterns.
 */

import { PatternStore } from './pattern-store.js';
import type { Pattern } from './types.js';

export class PatternApplier {
  constructor(private readonly store: PatternStore) {}

  /**
   * Find and format patterns relevant to a task.
   * Returns a markdown block to inject into context.
   */
  apply(taskDescription: string, projectId?: string): string {
    const patterns = this.store.search(taskDescription, projectId);
    if (patterns.length === 0) return '';

    // Record matches
    for (const p of patterns) {
      this.store.recordMatch(p.id);
    }

    // Format as context block
    const lines = ['## Learned Patterns', ''];
    for (const p of patterns) {
      const bar = this.confidenceBar(p.confidence);
      lines.push(
        `- ${bar} **${p.trigger}** → ${p.action} _(${p.domain}, ${p.observationCount} obs)_`
      );
    }

    return lines.join('\n');
  }

  /** Get patterns as structured data (for MCP tool) */
  query(taskDescription: string, projectId?: string): Pattern[] {
    return this.store.search(taskDescription, projectId);
  }

  private confidenceBar(confidence: number): string {
    const filled = Math.round(confidence * 5);
    return '█'.repeat(filled) + '░'.repeat(5 - filled);
  }
}
