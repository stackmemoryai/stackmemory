import { Database } from '../schema/database.js';
import type { SourceAdapter, RawRecord } from '../adapters/adapter.js';
import { scoreRecord, type ScoreThresholds } from '../scoring/confidence.js';
import type { EmbeddingProvider } from '../embed/client.js';
import {
  embeddingToBuffer,
  cosineSimilarity,
  bufferToEmbedding,
} from '../embed/client.js';

export interface IngestConfig {
  thresholds?: Partial<ScoreThresholds>;
  dedupMergeThreshold?: number; // default 0.88
  dedupReviewThreshold?: number; // default 0.72
  dedupWindowMs?: number; // default 72h
  reviewTtlDays?: number; // default 14
  dryRun?: boolean; // log actions without writing
}

export interface IngestResult {
  fetched: number;
  unchanged: number; // hash match, skipped
  autoAccepted: number;
  queued: number;
  discarded: number;
  deduped: number; // merged into existing node
  staleFlags: number;
}

const DEFAULTS = {
  dedupMergeThreshold: 0.88,
  dedupReviewThreshold: 0.72,
  dedupWindowMs: 72 * 60 * 60 * 1000,
  reviewTtlDays: 14,
};

export async function ingest(
  db: Database,
  adapter: SourceAdapter,
  embedder: EmbeddingProvider | undefined,
  config?: IngestConfig
): Promise<IngestResult> {
  const cfg = { ...DEFAULTS, ...config };
  const result: IngestResult = {
    fetched: 0,
    unchanged: 0,
    autoAccepted: 0,
    queued: 0,
    discarded: 0,
    deduped: 0,
    staleFlags: 0,
  };

  // Fetch delta since last sync
  const lastSync = db.getLastSync(adapter.system);
  const since = lastSync ? new Date(lastSync) : new Date(0);
  const records = await adapter.fetch(since);
  result.fetched = records.length;

  for (const record of records) {
    const hash = adapter.hashRecord(record);

    // Hash check — skip unchanged records
    const existing = db.getSourceByExternalId(
      adapter.system,
      record.external_id
    );
    if (existing && existing.hash === hash) {
      result.unchanged++;
      continue;
    }

    // If hash changed on an existing source, flag downstream nodes as stale
    if (existing && existing.hash !== hash) {
      const staleCount = flagDownstreamStale(db, existing.id);
      result.staleFlags += staleCount;
    }

    // Write/update source record
    const source = existing
      ? db.updateSourceHash(existing.id, hash, record.raw_payload)
      : db.insertSource({
          system: adapter.system,
          external_id: record.external_id,
          raw_payload: record.raw_payload,
          hash,
        });

    // Score
    const score = scoreRecord(record, adapter.signalModel, cfg.thresholds);

    if (score.action === 'discard') {
      result.discarded++;
      continue;
    }

    if (score.action === 'review') {
      if (!cfg.dryRun) {
        db.enqueue({
          source_id: source.id,
          candidate_content: record.content,
          confidence: score.score,
          queue_reason: 'low_confidence',
          ttl_days: cfg.reviewTtlDays,
        });
      }
      result.queued++;
      continue;
    }

    // auto_accept — check for dedup before writing node
    if (embedder) {
      let dedupResult: DedupResult;
      try {
        dedupResult = await checkDedup(db, embedder, record, cfg);
      } catch (err) {
        console.warn(
          '[provenant] dedup check failed, treating as independent:',
          err
        );
        dedupResult = { outcome: 'independent' };
      }
      if (dedupResult.outcome === 'merged') {
        if (!cfg.dryRun) {
          db.linkNodeToSource(
            dedupResult.nodeId,
            source.id,
            adapter.system,
            record.external_id
          );
        }
        result.deduped++;
        continue;
      }
      if (dedupResult.outcome === 'queued') {
        if (!cfg.dryRun) {
          db.enqueue({
            source_id: source.id,
            candidate_content: record.content,
            confidence: score.score,
            queue_reason: 'probable_duplicate',
            ttl_days: cfg.reviewTtlDays,
          });
        }
        result.queued++;
        continue;
      }
    }

    // Write node
    if (!cfg.dryRun) {
      let embedding: Buffer | null = null;
      if (embedder) {
        try {
          embedding = embeddingToBuffer(
            (await embedder.embed(record.content)).embedding
          );
        } catch (err) {
          console.warn(
            '[provenant] embedding failed, writing node without embedding:',
            err
          );
        }
      }

      const node = db.insertNode({
        type: classifyNodeType(record, adapter.system),
        content: record.content,
        embedding,
        actor: record.actor ?? null,
        confidence: score.score,
      });

      db.linkNodeToSource(
        node.id,
        source.id,
        adapter.system,
        record.external_id
      );
    }

    result.autoAccepted++;
  }

  // Update last sync timestamp
  if (!cfg.dryRun) {
    db.setLastSync(adapter.system, Date.now());
  }

  return result;
}

// --- Dedup ---

type DedupResult =
  | { outcome: 'independent' }
  | { outcome: 'merged'; nodeId: string }
  | { outcome: 'queued' };

async function checkDedup(
  db: Database,
  embedder: EmbeddingProvider,
  record: RawRecord,
  cfg: typeof DEFAULTS
): Promise<DedupResult> {
  const { embedding } = await embedder.embed(record.content);
  const windowStart = Date.now() - cfg.dedupWindowMs;

  // Get recent nodes with embeddings within the dedup window
  const candidates = db.getRecentNodesWithEmbeddings(windowStart);

  let bestSimilarity = 0;
  let bestNodeId: string | undefined;

  for (const candidate of candidates) {
    if (!candidate.embedding) continue;
    const candidateEmbedding = bufferToEmbedding(candidate.embedding as Buffer);
    const similarity = cosineSimilarity(embedding, candidateEmbedding);
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestNodeId = candidate.id;
    }
  }

  if (bestSimilarity >= cfg.dedupMergeThreshold && bestNodeId) {
    return { outcome: 'merged', nodeId: bestNodeId };
  }
  if (bestSimilarity >= cfg.dedupReviewThreshold) {
    return { outcome: 'queued' };
  }
  return { outcome: 'independent' };
}

// --- Staleness propagation ---

function flagDownstreamStale(db: Database, sourceId: string): number {
  // Find all nodes linked to this source
  const nodeIds = db.getNodeIdsForSource(sourceId);
  let count = 0;

  for (const nodeId of nodeIds) {
    // Flag the node itself
    db.flagStale(nodeId, sourceId);
    count++;

    // Flag all descendants via dependency index
    const descendants = db.getDescendants(nodeId);
    for (const d of descendants) {
      db.flagStale(d.descendant_node, sourceId);
      count++;
    }
  }

  return count;
}

// --- Node type classification ---

function classifyNodeType(record: RawRecord, system: string): string {
  if (system === 'manual') return 'decision';
  if (system === 'linear') return 'ticket';
  if (system === 'slack') return 'thread';
  if (system === 'github') return 'commit';
  return 'message';
}
