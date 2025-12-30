import { logger } from '../../core/monitoring/logger.js';
import crypto from 'crypto';

export interface EmbeddingProvider {
  createEmbedding(text: string): Promise<number[]>;
  getDimensions(): number;
  getName(): string;
}

/**
 * OpenAI Embeddings Provider
 * Requires OPENAI_API_KEY environment variable
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private apiKey: string | undefined;
  private model: string;
  private dimensions: number;

  constructor(model = 'text-embedding-ada-002') {
    this.apiKey = process.env.OPENAI_API_KEY;
    this.model = model;
    this.dimensions = model === 'text-embedding-ada-002' ? 1536 : 3072; // ada-002 vs text-embedding-3-small
  }

  async createEmbedding(text: string): Promise<number[]> {
    if (!this.apiKey) {
      throw new Error('OPENAI_API_KEY environment variable is not set');
    }

    try {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          input: text,
          model: this.model,
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        data: Array<{ embedding: number[] }>;
      };
      return data.data[0].embedding;
    } catch (error) {
      logger.error(
        'Failed to create OpenAI embedding',
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  getDimensions(): number {
    return this.dimensions;
  }

  getName(): string {
    return `OpenAI-${this.model}`;
  }
}

/**
 * Local Embeddings Provider using simple TF-IDF-like approach
 * Deterministic and doesn't require external APIs
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  private dimensions: number;
  private vocabulary: Map<string, number> = new Map();
  private idf: Map<string, number> = new Map();
  private documentCount = 0;

  constructor(dimensions = 384) {
    this.dimensions = dimensions;
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length > 2);
  }

  private getWordVector(word: string): number[] {
    // Use deterministic hashing to create a vector for each word
    const hash = crypto.createHash('sha256').update(word).digest();
    const vector = new Array(this.dimensions).fill(0);

    // Use hash bytes to set vector components
    for (let i = 0; i < Math.min(hash.length, this.dimensions); i++) {
      const value = (hash[i] - 128) / 128; // Normalize to [-1, 1]
      vector[i] = value;
    }

    return vector;
  }

  async createEmbedding(text: string): Promise<number[]> {
    const tokens = this.tokenize(text);
    const vector = new Array(this.dimensions).fill(0);

    if (tokens.length === 0) {
      return vector;
    }

    // Calculate TF-IDF weighted average of word vectors
    const termFreq = new Map<string, number>();

    // Count term frequencies
    for (const token of tokens) {
      termFreq.set(token, (termFreq.get(token) || 0) + 1);
    }

    // Build vocabulary and update document frequency
    this.documentCount++;
    for (const token of new Set(tokens)) {
      if (!this.vocabulary.has(token)) {
        this.vocabulary.set(token, this.vocabulary.size);
      }
      this.idf.set(token, (this.idf.get(token) || 0) + 1);
    }

    // Calculate weighted vector
    let totalWeight = 0;

    for (const [token, freq] of termFreq.entries()) {
      const tf = freq / tokens.length;
      const docFreq = this.idf.get(token) || 1;
      const idf = Math.log((this.documentCount + 1) / (docFreq + 1));
      const weight = tf * idf;

      const wordVector = this.getWordVector(token);
      for (let i = 0; i < this.dimensions; i++) {
        vector[i] += wordVector[i] * weight;
      }
      totalWeight += weight;
    }

    // Normalize the vector
    if (totalWeight > 0) {
      const magnitude = Math.sqrt(
        vector.reduce((sum, val) => sum + val * val, 0)
      );
      if (magnitude > 0) {
        for (let i = 0; i < this.dimensions; i++) {
          vector[i] /= magnitude;
        }
      }
    }

    return vector;
  }

  getDimensions(): number {
    return this.dimensions;
  }

  getName(): string {
    return 'Local-TFIDF';
  }
}

/**
 * Hybrid provider that tries OpenAI first, falls back to local
 */
export class HybridEmbeddingProvider implements EmbeddingProvider {
  private openai: OpenAIEmbeddingProvider;
  private local: LocalEmbeddingProvider;
  private useOpenAI: boolean;

  constructor(dimensions = 1536) {
    this.openai = new OpenAIEmbeddingProvider();
    this.local = new LocalEmbeddingProvider(dimensions);
    this.useOpenAI = !!process.env.OPENAI_API_KEY;

    if (!this.useOpenAI) {
      logger.warn('OPENAI_API_KEY not set, using local embeddings');
    }
  }

  async createEmbedding(text: string): Promise<number[]> {
    if (this.useOpenAI) {
      try {
        return await this.openai.createEmbedding(text);
      } catch (error) {
        logger.warn(
          'OpenAI embedding failed, falling back to local',
          error instanceof Error ? error : undefined
        );
        this.useOpenAI = false; // Disable for future calls
      }
    }

    const localEmbedding = await this.local.createEmbedding(text);

    // Pad or truncate to match expected dimensions
    const targetDimensions = this.getDimensions();
    if (localEmbedding.length < targetDimensions) {
      return [
        ...localEmbedding,
        ...new Array(targetDimensions - localEmbedding.length).fill(0),
      ];
    }
    return localEmbedding.slice(0, targetDimensions);
  }

  getDimensions(): number {
    return this.useOpenAI
      ? this.openai.getDimensions()
      : this.local.getDimensions();
  }

  getName(): string {
    return this.useOpenAI
      ? this.openai.getName()
      : `Hybrid-${this.local.getName()}`;
  }
}

// Factory function
export function createEmbeddingProvider(
  type?: 'openai' | 'local' | 'hybrid'
): EmbeddingProvider {
  switch (type) {
    case 'openai':
      return new OpenAIEmbeddingProvider();
    case 'local':
      return new LocalEmbeddingProvider();
    case 'hybrid':
    default:
      return new HybridEmbeddingProvider();
  }
}
