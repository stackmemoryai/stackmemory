/**
 * Frame Enrichment - Optional LLM-based chunk enrichment at frame close.
 * Resolves pronouns/entities and extracts entity states from frame content.
 * Registers as a frame lifecycle close hook.
 */

import { logger } from '../monitoring/logger.js';
import { frameLifecycleHooks } from './frame-lifecycle-hooks.js';
import type { Frame } from './frame-types.js';
import type { EnrichmentConfig } from '../config/types.js';

export interface EnrichmentResult {
  enrichedDigest: string;
  entities: ExtractedEntity[];
}

export interface ExtractedEntity {
  name: string;
  relation: string;
  value: string;
  context?: string;
}

export interface FrameEnrichmentDeps {
  getParentFrames: (frameId: string, depth: number) => Promise<Frame[]>;
  updateDigest: (frameId: string, digest: string) => Promise<void>;
  recordEntity: (
    projectId: string,
    name: string,
    relation: string,
    value: string,
    context?: string,
    sourceFrameId?: string
  ) => void;
}

const ENRICHMENT_PROMPT = `You are a context enrichment engine. Given a frame digest and its parent context, do two things:
1. Rewrite the digest to be fully self-contained — resolve all pronouns ("it", "that", "the project") using parent context.
2. Extract entity-relation-value triples from the content.

Respond in JSON only:
{"enrichedDigest":"...","entities":[{"name":"...","relation":"...","value":"...","context":"..."}]}`;

function buildEnrichmentInput(frame: Frame, parents: Frame[]): string {
  const parentCtx = parents
    .map((p) => `[${p.name}]: ${p.digest_text ?? ''}`)
    .join('\n');
  return `Parent context:\n${parentCtx}\n\nCurrent frame "${frame.name}":\n${frame.digest_text ?? ''}`;
}

export async function enrichFrame(
  frame: Frame,
  parents: Frame[],
  apiKey: string
): Promise<EnrichmentResult | undefined> {
  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey });
    const input = buildEnrichmentInput(frame, parents);

    const response = await client.messages.create({
      model: 'claude-3-5-haiku-latest',
      max_tokens: 1024,
      system: ENRICHMENT_PROMPT,
      messages: [{ role: 'user', content: input }],
    });

    const text =
      response.content[0].type === 'text' ? response.content[0].text : '';
    return JSON.parse(text) as EnrichmentResult;
  } catch (err) {
    logger.warn('Frame enrichment LLM call failed', {
      error: err instanceof Error ? err.message : String(err),
      frameId: frame.frame_id,
    });
    return undefined;
  }
}

let unregister: (() => void) | null = null;

export function registerEnrichmentHook(
  config: EnrichmentConfig,
  deps: FrameEnrichmentDeps
): () => void {
  if (unregister) unregister();
  if (!config.enabled) return () => {};

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.warn('Enrichment enabled but ANTHROPIC_API_KEY not set');
    return () => {};
  }

  unregister = frameLifecycleHooks.onFrameClosed(
    'frame-enrichment',
    async (data) => {
      if (!data.frame.digest_text) return;

      const parents = await deps.getParentFrames(
        data.frame.frame_id,
        config.lookbackDepth
      );

      const result = await enrichFrame(data.frame, parents, apiKey);
      if (!result) return;

      await deps.updateDigest(data.frame.frame_id, result.enrichedDigest);

      if (config.extractEntities) {
        for (const entity of result.entities) {
          try {
            deps.recordEntity(
              data.frame.project_id,
              entity.name,
              entity.relation,
              entity.value,
              entity.context,
              data.frame.frame_id
            );
          } catch {
            // best-effort per entity
          }
        }
      }
    },
    -10 // low priority — runs after other hooks
  );

  return () => {
    if (unregister) {
      unregister();
      unregister = null;
    }
  };
}
