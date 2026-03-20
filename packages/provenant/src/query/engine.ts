import Anthropic from '@anthropic-ai/sdk';
import { Database } from '../schema/database.js';
import type { EmbeddingProvider } from '../embed/client.js';
import { bufferToEmbedding, cosineSimilarity } from '../embed/client.js';
import type {
  Node,
  Edge,
  Source,
  Contradiction,
  StaleFlag,
} from '../schema/types.js';

export interface QueryResult {
  answer: string;
  citations: Citation[];
  staleFlags: StaleFlag[];
  contradictions: Contradiction[];
  unresolvedRejections: number;
}

export interface Citation {
  node: Node;
  sources: Source[];
  edges: Edge[];
  relevance: number;
}

export interface QueryConfig {
  anthropicApiKey?: string; // omit for keyword-only mode (no LLM)
  model?: string; // default: claude-sonnet-4-6
  maxNodes?: number; // max nodes to include in context (default 20)
  actorFilter?: string;
  since?: number; // unix ms
}

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_NODES = 20;

export async function query(
  db: Database,
  embedder: EmbeddingProvider | undefined,
  question: string,
  config: QueryConfig
): Promise<QueryResult> {
  const maxNodes = config.maxNodes ?? DEFAULT_MAX_NODES;

  // Step 1: Find relevant nodes
  const relevantNodes = await findRelevantNodes(
    db,
    embedder,
    question,
    maxNodes,
    config
  );

  // Step 2: Gather edges, sources, stale flags, contradictions for cited nodes
  const nodeIds = new Set(relevantNodes.map((n) => n.node.id));
  const citations = relevantNodes;

  const staleFlags: StaleFlag[] = [];
  const contradictions: Contradiction[] = [];

  for (const c of citations) {
    // Edges from/to this node
    c.edges = [...db.getEdgesFrom(c.node.id), ...db.getEdgesTo(c.node.id)];
    // Sources
    c.sources = db.getSourcesForNode(c.node.id);

    // Stale flags
    const flags = db.getStaleForNode(c.node.id);
    staleFlags.push(...flags);

    // Contradictions involving this node
    const contras = db.getContradictionsForNode(c.node.id);
    contradictions.push(...contras);
  }

  // Deduplicate
  const uniqueStale = dedup(staleFlags, (f) => f.id);
  const uniqueContradictions = dedup(contradictions, (c) => c.id);
  const unresolvedRejections = db.getUnresolvedRejections().length;

  // Step 3: Build context and optionally ask Claude
  const context = buildContext(
    citations,
    uniqueStale,
    uniqueContradictions,
    unresolvedRejections
  );
  let answer: string;
  if (!config.anthropicApiKey) {
    // Keyword-only mode — return raw context without LLM summarization
    answer = context;
  } else {
    try {
      answer = await askClaude(question, context, config);
    } catch (err) {
      // LLM unavailable — return raw context as the answer
      const msg = err instanceof Error ? err.message : 'unknown error';
      // Sanitize error message to avoid leaking API keys in auth errors
      const safeMsg = msg
        .replace(/sk-[a-zA-Z0-9-_]+/g, '[REDACTED]')
        .replace(/key[_-]?[a-zA-Z0-9]{16,}/gi, '[REDACTED]');
      answer = `[Claude unavailable: ${safeMsg}]\n\nRaw context:\n${context}`;
    }
  }

  return {
    answer,
    citations,
    staleFlags: uniqueStale,
    contradictions: uniqueContradictions,
    unresolvedRejections,
  };
}

// --- Node retrieval ---

async function findRelevantNodes(
  db: Database,
  embedder: EmbeddingProvider | undefined,
  question: string,
  maxNodes: number,
  config: QueryConfig
): Promise<Citation[]> {
  // Strategy: semantic search if embedder available, otherwise keyword fallback
  if (embedder) {
    try {
      return await semanticSearch(db, embedder, question, maxNodes, config);
    } catch (err) {
      console.warn(
        '[provenant] semantic search failed, falling back to keywords:',
        err
      );
    }
  }
  return keywordSearch(db, question, maxNodes, config);
}

async function semanticSearch(
  db: Database,
  embedder: EmbeddingProvider,
  question: string,
  maxNodes: number,
  config: QueryConfig
): Promise<Citation[]> {
  const { embedding: questionEmbed } = await embedder.embed(question);
  const allNodes = db.getNodesWithEmbeddings(config.actorFilter, config.since);

  const scored: Citation[] = [];
  for (const node of allNodes) {
    if (!node.embedding) continue;
    const nodeEmbed = bufferToEmbedding(node.embedding as Buffer);
    const relevance = cosineSimilarity(questionEmbed, nodeEmbed);
    scored.push({ node, sources: [], edges: [], relevance });
  }

  scored.sort((a, b) => b.relevance - a.relevance);
  return scored.slice(0, maxNodes);
}

function keywordSearch(
  db: Database,
  question: string,
  maxNodes: number,
  config: QueryConfig
): Citation[] {
  // Extract keywords (strip common words)
  const stopwords = new Set([
    'the',
    'a',
    'an',
    'is',
    'was',
    'were',
    'are',
    'we',
    'our',
    'this',
    'that',
    'it',
    'to',
    'of',
    'in',
    'for',
    'on',
    'with',
    'did',
    'do',
    'not',
    'why',
    'how',
    'what',
    'when',
    'and',
    'or',
    'but',
  ]);
  const keywords = question
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopwords.has(w));

  const nodes = db.searchNodesByKeywords(
    keywords,
    maxNodes,
    config.actorFilter,
    config.since
  );

  return nodes.map((node) => ({
    node,
    sources: [],
    edges: [],
    relevance: 0.5, // unknown relevance without embeddings
  }));
}

// --- Context building ---

function buildContext(
  citations: Citation[],
  staleFlags: StaleFlag[],
  contradictions: Contradiction[],
  unresolvedRejections: number
): string {
  const parts: string[] = [];

  parts.push('## Relevant Decision Nodes\n');
  for (const c of citations) {
    parts.push(`### Node ${c.node.id.slice(0, 8)}`);
    parts.push(`- Type: ${c.node.type}`);
    parts.push(`- Content: ${c.node.content}`);
    parts.push(`- Actor: ${c.node.actor ?? 'unknown'}`);
    parts.push(`- Confidence: ${c.node.confidence.toFixed(2)}`);
    parts.push(`- Created: ${new Date(c.node.created_at).toISOString()}`);
    if (c.relevance > 0) {
      parts.push(`- Relevance: ${c.relevance.toFixed(3)}`);
    }
    if (c.sources.length > 0) {
      parts.push(
        `- Sources: ${c.sources.map((s) => `${s.system}:${s.external_id}`).join(', ')}`
      );
    }
    if (c.edges.length > 0) {
      for (const e of c.edges) {
        const dir = e.from_node === c.node.id ? '→' : '←';
        const other =
          e.from_node === c.node.id
            ? e.to_node.slice(0, 8)
            : e.from_node.slice(0, 8);
        parts.push(`- Edge: ${dir} ${e.rel_type} ${other}`);
      }
    }
    parts.push('');
  }

  if (staleFlags.length > 0) {
    parts.push(`## Stale Flags (${staleFlags.length})`);
    parts.push(
      'The following cited nodes have upstream sources that changed since the node was created:'
    );
    for (const f of staleFlags) {
      parts.push(
        `- Node ${f.node_id.slice(0, 8)} flagged at ${new Date(f.flagged_at).toISOString()}`
      );
    }
    parts.push('');
  }

  if (contradictions.length > 0) {
    parts.push(`## Unresolved Contradictions (${contradictions.length})`);
    for (const c of contradictions) {
      parts.push(
        `- Node ${c.node_a.slice(0, 8)} ↔ Node ${c.node_b.slice(0, 8)} (conflict score: ${c.conflict_score.toFixed(2)}, status: ${c.status})`
      );
    }
    parts.push('');
  }

  if (unresolvedRejections > 0) {
    parts.push(
      `## Note: ${unresolvedRejections} rejection log entries are missing reasoning.\n`
    );
  }

  return parts.join('\n');
}

// --- Claude call ---

async function askClaude(
  question: string,
  context: string,
  config: QueryConfig
): Promise<string> {
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  const response = await client.messages.create({
    model: config.model ?? DEFAULT_MODEL,
    max_tokens: 4096,
    system: `You are the query engine for Provenant, an organization's decision knowledge graph. The user is a founder who needs fast, cited answers to product decision questions. Your job is to trace claims to their origin in the graph and surface anything that might invalidate those claims.

<response_format>
1. First, quote the most relevant node content verbatim in <evidence> tags.
2. Then provide your answer, citing nodes by their short ID (first 8 characters) inline.
3. After the answer, include a <flags> section listing:
   - Any cited nodes marked as stale (upstream source changed since recording)
   - Any unresolved contradictions between cited nodes
   - Any rejection log entries with missing reasoning
4. If the graph lacks enough evidence to answer confidently, say so and explain what's missing.
</response_format>

<guidelines>
- Be concise and direct. The founder is making decisions, not reading essays.
- Never speculate beyond what the graph nodes contain. If a node's reasoning is absent, flag it rather than inferring.
- When nodes contradict each other, present both sides with their confidence scores and creation dates. Do not pick a winner — that's the human's job.
- Staleness matters: a node derived from a source that changed after recording may no longer be valid. Always flag this.
</guidelines>`,
    messages: [
      {
        role: 'user',
        content: `<question>${question}</question>\n\n<graph_context>\n${context}\n</graph_context>`,
      },
    ],
  });

  const block = response.content[0];
  if (block && block.type === 'text') {
    return block.text;
  }
  return 'No response generated.';
}

// --- Util ---

function dedup<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
