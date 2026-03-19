// Embedding provider abstraction
// Implementations: OpenAI (default)
// TODO: Add Voyage AI provider (Anthropic-recommended, best retrieval benchmarks)

export interface EmbedResult {
  embedding: Float64Array;
  tokens: number;
}

export interface EmbeddingProvider {
  embed(text: string): Promise<EmbedResult>;
  embedBatch(texts: string[]): Promise<EmbedResult[]>;
}

// --- OpenAI provider ---

export interface OpenAIEmbedConfig {
  apiKey: string;
  model?: string; // default: text-embedding-3-small
  baseUrl?: string;
  batchSize?: number; // default 2048
}

const OPENAI_DEFAULTS = {
  model: 'text-embedding-3-small',
  baseUrl: 'https://api.openai.com/v1',
  batchSize: 2048,
};

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly batchSize: number;

  constructor(config: OpenAIEmbedConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? OPENAI_DEFAULTS.model;
    this.baseUrl = config.baseUrl ?? OPENAI_DEFAULTS.baseUrl;
    this.batchSize = config.batchSize ?? OPENAI_DEFAULTS.batchSize;
  }

  static fromEnv(model?: string): OpenAIEmbeddingProvider | undefined {
    const key = process.env['OPENAI_API_KEY'];
    if (!key) return undefined;
    return new OpenAIEmbeddingProvider({ apiKey: key, model });
  }

  async embed(text: string): Promise<EmbedResult> {
    const results = await this.embedBatch([text]);
    return results[0]!;
  }

  async embedBatch(texts: string[]): Promise<EmbedResult[]> {
    const results: EmbedResult[] = [];

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: batch,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`OpenAI embeddings error ${response.status}: ${body}`);
      }

      const json = (await response.json()) as {
        data: Array<{ embedding: number[]; index: number }>;
        usage: { total_tokens: number };
      };

      const tokensPerItem = Math.ceil(json.usage.total_tokens / batch.length);

      // OpenAI returns data sorted by index
      const sorted = json.data.sort((a, b) => a.index - b.index);
      for (const item of sorted) {
        results.push({
          embedding: new Float64Array(item.embedding),
          tokens: tokensPerItem,
        });
      }
    }

    return results;
  }
}

// --- Voyage AI provider ---

export interface VoyageEmbedConfig {
  apiKey: string;
  model?: string; // default: voyage-3-lite
  baseUrl?: string;
  batchSize?: number; // default 128
}

const VOYAGE_DEFAULTS = {
  model: 'voyage-3-lite',
  baseUrl: 'https://api.voyageai.com/v1',
  batchSize: 128,
};

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly batchSize: number;

  constructor(config: VoyageEmbedConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? VOYAGE_DEFAULTS.model;
    this.baseUrl = config.baseUrl ?? VOYAGE_DEFAULTS.baseUrl;
    this.batchSize = config.batchSize ?? VOYAGE_DEFAULTS.batchSize;
  }

  static fromEnv(model?: string): VoyageEmbeddingProvider | undefined {
    const key = process.env['VOYAGE_API_KEY'];
    if (!key) return undefined;
    return new VoyageEmbeddingProvider({ apiKey: key, model });
  }

  async embed(text: string): Promise<EmbedResult> {
    const results = await this.embedBatch([text]);
    return results[0]!;
  }

  async embedBatch(texts: string[]): Promise<EmbedResult[]> {
    const results: EmbedResult[] = [];

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: batch,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Voyage embeddings error ${response.status}: ${body}`);
      }

      const json = (await response.json()) as {
        data: Array<{ embedding: number[] }>;
        usage: { total_tokens: number };
      };

      const tokensPerItem = Math.ceil(json.usage.total_tokens / batch.length);

      for (const item of json.data) {
        results.push({
          embedding: new Float64Array(item.embedding),
          tokens: tokensPerItem,
        });
      }
    }

    return results;
  }
}

// --- Factory ---

export function createEmbeddingProvider(): EmbeddingProvider | undefined {
  // Try OpenAI first (most common)
  const openai = OpenAIEmbeddingProvider.fromEnv();
  if (openai) return openai;

  // Try Voyage AI
  const voyage = VoyageEmbeddingProvider.fromEnv();
  if (voyage) return voyage;

  return undefined;
}

// --- Utilities ---

/** Serialize Float64Array to Buffer for SQLite BLOB storage */
export function embeddingToBuffer(embedding: Float64Array): Buffer {
  return Buffer.from(embedding.buffer);
}

/** Deserialize Buffer from SQLite BLOB back to Float64Array */
export function bufferToEmbedding(buf: Buffer): Float64Array {
  return new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8);
}

/** Cosine similarity between two embeddings */
export function cosineSimilarity(a: Float64Array, b: Float64Array): number {
  if (a.length !== b.length) throw new Error('Embedding dimension mismatch');
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}
