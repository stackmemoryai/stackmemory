/**
 * Recursive Context Manager for RLM
 *
 * Handles context chunking, decomposition, and distribution
 * for recursive agent execution
 */

import { DualStackManager } from './dual-stack-manager.js';
import { ContextRetriever } from '../retrieval/context-retriever.js';
import { logger } from '../monitoring/logger.js';
import { estimateTokens } from '../cache/token-estimator.js';
import { ValidationError, ErrorCode } from '../errors/index.js';
import * as fs from 'fs';
import * as path from 'path';
import type { SubagentType } from '../../skills/recursive-agent-orchestrator.js';

export interface ContextChunk {
  id: string;
  type: 'code' | 'frame' | 'documentation' | 'test' | 'config';
  content: string;
  metadata: {
    filePath?: string;
    frameId?: string;
    language?: string;
    size: number;
    score: number;
    timestamp?: Date;
  };
  boundaries: {
    start?: number;
    end?: number;
    overlap?: number;
  };
}

export interface ChunkingStrategy {
  type: 'file' | 'semantic' | 'size' | 'time';
  maxChunkSize: number;
  overlapSize: number;
  priorityThreshold: number;
}

export interface AgentContextConfig {
  agent: SubagentType;
  _maxTokens: number;
  priorityWeights: {
    recent: number;
    relevant: number;
    dependency: number;
    error: number;
    test: number;
  };
  includeTypes: string[];
  excludeTypes: string[];
}

/**
 * Manages context for recursive agent execution
 */
export class RecursiveContextManager {
  private dualStackManager: DualStackManager;
  private contextRetriever: ContextRetriever;

  // Context cache for sharing between agents
  private sharedContextCache: Map<string, ContextChunk[]> = new Map();

  // Agent-specific configurations
  private agentConfigs: Map<SubagentType, AgentContextConfig>;

  constructor(
    dualStackManager: DualStackManager,
    contextRetriever: ContextRetriever
  ) {
    this.dualStackManager = dualStackManager;
    this.contextRetriever = contextRetriever;
    this.agentConfigs = this.initializeAgentConfigs();
  }

  /**
   * Initialize agent-specific context configurations
   */
  private initializeAgentConfigs(): Map<SubagentType, AgentContextConfig> {
    const configs = new Map<SubagentType, AgentContextConfig>();

    // Planning agent needs broad context
    configs.set('planning', {
      agent: 'planning',
      maxTokens: 20000,
      priorityWeights: {
        recent: 0.3,
        relevant: 0.4,
        dependency: 0.2,
        error: 0.05,
        test: 0.05,
      },
      includeTypes: ['frame', 'documentation', 'config'],
      excludeTypes: [],
    });

    // Code agent needs implementation context
    configs.set('code', {
      agent: 'code',
      maxTokens: 30000,
      priorityWeights: {
        recent: 0.2,
        relevant: 0.5,
        dependency: 0.2,
        error: 0.05,
        test: 0.05,
      },
      includeTypes: ['code', 'frame', 'test'],
      excludeTypes: ['documentation'],
    });

    // Testing agent needs code and existing tests
    configs.set('testing', {
      agent: 'testing',
      maxTokens: 25000,
      priorityWeights: {
        recent: 0.1,
        relevant: 0.3,
        dependency: 0.1,
        error: 0.1,
        test: 0.4,
      },
      includeTypes: ['code', 'test', 'frame'],
      excludeTypes: ['documentation', 'config'],
    });

    // Linting agent needs code and config
    configs.set('linting', {
      agent: 'linting',
      maxTokens: 15000,
      priorityWeights: {
        recent: 0.2,
        relevant: 0.4,
        dependency: 0.1,
        error: 0.2,
        test: 0.1,
      },
      includeTypes: ['code', 'config'],
      excludeTypes: ['documentation', 'test'],
    });

    // Review agent needs comprehensive context
    configs.set('review', {
      agent: 'review',
      maxTokens: 25000,
      priorityWeights: {
        recent: 0.3,
        relevant: 0.3,
        dependency: 0.1,
        error: 0.2,
        test: 0.1,
      },
      includeTypes: ['code', 'test', 'frame', 'documentation'],
      excludeTypes: [],
    });

    // Context agent for searching
    configs.set('context', {
      agent: 'context',
      maxTokens: 10000,
      priorityWeights: {
        recent: 0.1,
        relevant: 0.6,
        dependency: 0.2,
        error: 0.05,
        test: 0.05,
      },
      includeTypes: ['frame', 'documentation'],
      excludeTypes: [],
    });

    // Improvement agent needs review context
    configs.set('improve', {
      agent: 'improve',
      maxTokens: 30000,
      priorityWeights: {
        recent: 0.3,
        relevant: 0.4,
        dependency: 0.1,
        error: 0.15,
        test: 0.05,
      },
      includeTypes: ['code', 'test', 'frame'],
      excludeTypes: ['documentation'],
    });

    // Publish agent needs build/config context
    configs.set('publish', {
      agent: 'publish',
      maxTokens: 15000,
      priorityWeights: {
        recent: 0.4,
        relevant: 0.2,
        dependency: 0.1,
        error: 0.2,
        test: 0.1,
      },
      includeTypes: ['config', 'frame'],
      excludeTypes: ['code', 'test'],
    });

    return configs;
  }

  /**
   * Prepare context for a specific agent type
   */
  async prepareAgentContext(
    agentType: SubagentType,
    baseContext: Record<string, any>,
    _maxTokens: number
  ): Promise<Record<string, any>> {
    const config = this.agentConfigs.get(agentType);
    if (!config) {
      throw new ValidationError(
        `Unknown agent type: ${agentType}`,
        ErrorCode.VALIDATION_FAILED,
        { agentType }
      );
    }

    logger.debug(`Preparing context for ${agentType} agent`, { maxTokens });

    // Collect relevant chunks
    const chunks = await this.collectRelevantChunks(
      baseContext,
      config,
      maxTokens
    );

    // Sort by priority
    const sortedChunks = this.prioritizeChunks(chunks, config.priorityWeights);

    // Fit within token budget
    const selectedChunks = this.fitChunksToTokenBudget(sortedChunks, maxTokens);

    // Build agent context
    const agentContext: Record<string, any> = {
      ...baseContext,
      chunks: selectedChunks.map((c) => ({
        type: c.type,
        content: c.content,
        metadata: c.metadata,
      })),
    };

    // Cache for potential reuse
    this.sharedContextCache.set(`${agentType}-${Date.now()}`, selectedChunks);

    logger.debug(`Prepared context for ${agentType}`, {
      chunksSelected: selectedChunks.length,
      totalSize: selectedChunks.reduce((sum, c) => sum + c.metadata.size, 0),
    });

    return agentContext;
  }

  /**
   * Chunk large codebase for processing
   */
  async chunkCodebase(
    rootPath: string,
    strategy: ChunkingStrategy
  ): Promise<ContextChunk[]> {
    const chunks: ContextChunk[] = [];

    logger.info('Chunking codebase', { rootPath, strategy: strategy.type });

    switch (strategy.type) {
      case 'file':
        chunks.push(...(await this.chunkByFile(rootPath, strategy)));
        break;

      case 'semantic':
        chunks.push(...(await this.chunkBySemantic(rootPath, strategy)));
        break;

      case 'size':
        chunks.push(...(await this.chunkBySize(rootPath, strategy)));
        break;

      default:
        throw new ValidationError(
          `Unknown chunking strategy: ${strategy.type}`,
          ErrorCode.VALIDATION_FAILED,
          { strategyType: strategy.type }
        );
    }

    logger.info('Codebase chunked', {
      totalChunks: chunks.length,
      totalSize: chunks.reduce((sum, c) => sum + c.metadata.size, 0),
    });

    return chunks;
  }

  /**
   * Chunk by file boundaries
   */
  private async chunkByFile(
    rootPath: string,
    strategy: ChunkingStrategy
  ): Promise<ContextChunk[]> {
    const chunks: ContextChunk[] = [];
    const files = await this.walkDirectory(rootPath);

    for (const file of files) {
      const content = await fs.promises.readFile(file, 'utf-8');

      // Skip files larger than max chunk size
      if (content.length > strategy.maxChunkSize) {
        // Split large files
        const fileChunks = this.splitLargeFile(file, content, strategy);
        chunks.push(...fileChunks);
      } else {
        chunks.push({
          id: `file-${path.basename(file)}`,
          type: 'code',
          content,
          metadata: {
            filePath: file,
            language: this.detectLanguage(file),
            size: content.length,
            score: 0.5,
          },
          boundaries: {
            start: 0,
            end: content.length,
          },
        });
      }
    }

    return chunks;
  }

  /**
   * Chunk by semantic boundaries (classes, functions)
   */
  private async chunkBySemantic(
    rootPath: string,
    strategy: ChunkingStrategy
  ): Promise<ContextChunk[]> {
    const chunks: ContextChunk[] = [];
    const files = await this.walkDirectory(rootPath);

    for (const file of files) {
      const content = await fs.promises.readFile(file, 'utf-8');
      const language = this.detectLanguage(file);

      // Extract semantic units based on language
      const semanticUnits = this.extractSemanticUnits(content, language);

      for (const unit of semanticUnits) {
        if (unit.content.length <= strategy.maxChunkSize) {
          chunks.push({
            id: `semantic-${file}-${unit.name}`,
            type: 'code',
            content: unit.content,
            metadata: {
              filePath: file,
              language,
              size: unit.content.length,
              score: unit.importance,
            },
            boundaries: {
              start: unit.start,
              end: unit.end,
            },
          });
        }
      }
    }

    return chunks;
  }

  /**
   * Chunk by fixed size with overlap
   */
  private async chunkBySize(
    rootPath: string,
    strategy: ChunkingStrategy
  ): Promise<ContextChunk[]> {
    const chunks: ContextChunk[] = [];
    const files = await this.walkDirectory(rootPath);

    for (const file of files) {
      const content = await fs.promises.readFile(file, 'utf-8');
      const lines = content.split('\n');

      let currentChunk = '';
      let startLine = 0;

      for (let i = 0; i < lines.length; i++) {
        currentChunk += lines[i] + '\n';

        if (currentChunk.length >= strategy.maxChunkSize) {
          chunks.push({
            id: `size-${file}-${startLine}`,
            type: 'code',
            content: currentChunk,
            metadata: {
              filePath: file,
              language: this.detectLanguage(file),
              size: currentChunk.length,
              score: 0.5,
            },
            boundaries: {
              start: startLine,
              end: i,
              overlap: strategy.overlapSize,
            },
          });

          // Move window with overlap
          const overlapLines = Math.floor(strategy.overlapSize / 50); // Estimate lines
          startLine = Math.max(0, i - overlapLines);
          currentChunk = lines.slice(startLine, i + 1).join('\n');
        }
      }

      // Add remaining chunk
      if (currentChunk.trim()) {
        chunks.push({
          id: `size-${file}-${startLine}`,
          type: 'code',
          content: currentChunk,
          metadata: {
            filePath: file,
            language: this.detectLanguage(file),
            size: currentChunk.length,
            score: 0.5,
          },
          boundaries: {
            start: startLine,
            end: lines.length - 1,
          },
        });
      }
    }

    return chunks;
  }

  /**
   * Collect relevant chunks for agent context
   */
  private async collectRelevantChunks(
    baseContext: Record<string, any>,
    config: AgentContextConfig,
    _maxTokens: number
  ): Promise<ContextChunk[]> {
    const chunks: ContextChunk[] = [];

    // Get recent frames
    if (config.includeTypes.includes('frame')) {
      const recentFrames = await this.getRecentFrameChunks(10);
      chunks.push(...recentFrames);
    }

    // Get relevant code files
    if (config.includeTypes.includes('code') && baseContext.files) {
      const codeChunks = await this.getCodeChunks(baseContext.files);
      chunks.push(...codeChunks);
    }

    // Get test files
    if (config.includeTypes.includes('test') && baseContext.testFiles) {
      const testChunks = await this.getTestChunks(baseContext.testFiles);
      chunks.push(...testChunks);
    }

    // Search for relevant context
    if (baseContext.query) {
      const searchResults = await this.contextRetriever.retrieve({
        query: baseContext.query,
        limit: 20,
      });

      for (const result of searchResults) {
        chunks.push({
          id: `search-${result.frameId}`,
          type: 'frame',
          content: result.content,
          metadata: {
            frameId: result.frameId,
            size: result.content.length,
            score: result.score,
            timestamp: new Date(result.timestamp),
          },
          boundaries: {},
        });
      }
    }

    // Check shared cache for relevant chunks
    const cachedChunks = this.getRelevantCachedChunks(config.agent);
    chunks.push(...cachedChunks);

    return chunks;
  }

  /**
   * Prioritize chunks based on agent weights
   */
  private prioritizeChunks(
    chunks: ContextChunk[],
    weights: AgentContextConfig['priorityWeights']
  ): ContextChunk[] {
    return chunks
      .map((chunk) => {
        let priority = 0;

        // Recent weight
        if (chunk.metadata.timestamp) {
          const age = Date.now() - chunk.metadata.timestamp.getTime();
          const recentScore = Math.max(0, 1 - age / (24 * 60 * 60 * 1000)); // Decay over 24h
          priority += recentScore * weights.recent;
        }

        // Relevance weight
        priority += (chunk.metadata.score || 0.5) * weights.relevant;

        // Type-specific weights
        if (chunk.type === 'test') {
          priority += weights.test;
        }
        if (chunk.metadata.filePath?.includes('error')) {
          priority += weights.error;
        }

        return { ...chunk, priority };
      })
      .sort(
        (a, b) =>
          (b as { priority: number }).priority -
          (a as { priority: number }).priority
      );
  }

  /**
   * Fit chunks within token budget
   */
  private fitChunksToTokenBudget(
    chunks: ContextChunk[],
    _maxTokens: number
  ): ContextChunk[] {
    const selected: ContextChunk[] = [];
    let totalTokens = 0;

    for (const chunk of chunks) {
      const chunkTokens = estimateTokens(chunk.content);

      if (totalTokens + chunkTokens <= maxTokens) {
        selected.push(chunk);
        totalTokens += chunkTokens;
      } else if (selected.length === 0) {
        // Always include at least one chunk, truncated if necessary
        const truncatedContent = chunk.content.slice(0, maxTokens * 4);
        selected.push({
          ...chunk,
          content: truncatedContent,
          metadata: {
            ...chunk.metadata,
            size: truncatedContent.length,
          },
        });
        break;
      } else {
        break;
      }
    }

    return selected;
  }

  /**
   * Helper methods
   */

  private async walkDirectory(dir: string): Promise<string[]> {
    const files: string[] = [];
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Skip node_modules, .git, etc
        if (!['node_modules', '.git', 'dist', 'build'].includes(entry.name)) {
          files.push(...(await this.walkDirectory(fullPath)));
        }
      } else if (entry.isFile()) {
        // Include code files
        if (/\.(ts|tsx|js|jsx|py|java|go|rs|cpp|c|h)$/.test(entry.name)) {
          files.push(fullPath);
        }
      }
    }

    return files;
  }

  private detectLanguage(filePath: string): string {
    const ext = path.extname(filePath);
    const langMap: Record<string, string> = {
      '.ts': 'typescript',
      '.tsx': 'typescript',
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.py': 'python',
      '.java': 'java',
      '.go': 'go',
      '.rs': 'rust',
      '.cpp': 'cpp',
      '.c': 'c',
      '.h': 'c',
    };
    return langMap[ext] || 'unknown';
  }

  private splitLargeFile(
    filePath: string,
    content: string,
    strategy: ChunkingStrategy
  ): ContextChunk[] {
    const chunks: ContextChunk[] = [];
    const lines = content.split('\n');
    const linesPerChunk = Math.ceil(strategy.maxChunkSize / 50); // Estimate

    for (let i = 0; i < lines.length; i += linesPerChunk) {
      const chunkLines = lines.slice(i, i + linesPerChunk);
      const chunkContent = chunkLines.join('\n');

      chunks.push({
        id: `file-${path.basename(filePath)}-part-${i}`,
        type: 'code',
        content: chunkContent,
        metadata: {
          filePath,
          language: this.detectLanguage(filePath),
          size: chunkContent.length,
          score: 0.5,
        },
        boundaries: {
          start: i,
          end: Math.min(i + linesPerChunk, lines.length),
          overlap: strategy.overlapSize,
        },
      });
    }

    return chunks;
  }

  private extractSemanticUnits(
    content: string,
    language: string
  ): Array<{
    name: string;
    content: string;
    start: number;
    end: number;
    importance: number;
  }> {
    const units: Array<{
      name: string;
      content: string;
      start: number;
      end: number;
      importance: number;
    }> = [];

    // Simple regex-based extraction (would need proper AST parsing for production)
    if (language === 'typescript' || language === 'javascript') {
      // Extract classes
      const classRegex = /class\s+(\w+)[^{]*\{[^}]+\}/g;
      let match;
      while ((match = classRegex.exec(content)) !== null) {
        units.push({
          name: match[1],
          content: match[0],
          start: match.index,
          end: match.index + match[0].length,
          importance: 0.8,
        });
      }

      // Extract functions
      const funcRegex =
        /(?:function|const|let)\s+(\w+)\s*=?\s*(?:\([^)]*\)|\w+)\s*(?:=>|{)[^}]+}/g;
      while ((match = funcRegex.exec(content)) !== null) {
        units.push({
          name: match[1],
          content: match[0],
          start: match.index,
          end: match.index + match[0].length,
          importance: 0.6,
        });
      }
    }

    return units;
  }

  private async getRecentFrameChunks(limit: number): Promise<ContextChunk[]> {
    const activeStack = this.dualStackManager.getActiveStack();
    const frames = await activeStack.getAllFrames();

    return frames.slice(-limit).map((frame) => ({
      id: `frame-${frame.frameId}`,
      type: 'frame',
      content: JSON.stringify(frame, null, 2),
      metadata: {
        frameId: frame.frameId,
        size: JSON.stringify(frame).length,
        score: 0.7,
        timestamp: new Date(frame.timestamp),
      },
      boundaries: {},
    }));
  }

  private async getCodeChunks(files: string[]): Promise<ContextChunk[]> {
    const chunks: ContextChunk[] = [];

    for (const file of files) {
      if (fs.existsSync(file)) {
        const content = await fs.promises.readFile(file, 'utf-8');
        chunks.push({
          id: `code-${path.basename(file)}`,
          type: 'code',
          content,
          metadata: {
            filePath: file,
            language: this.detectLanguage(file),
            size: content.length,
            score: 0.8,
          },
          boundaries: {},
        });
      }
    }

    return chunks;
  }

  private async getTestChunks(testFiles: string[]): Promise<ContextChunk[]> {
    const chunks: ContextChunk[] = [];

    for (const file of testFiles) {
      if (fs.existsSync(file)) {
        const content = await fs.promises.readFile(file, 'utf-8');
        chunks.push({
          id: `test-${path.basename(file)}`,
          type: 'test',
          content,
          metadata: {
            filePath: file,
            language: this.detectLanguage(file),
            size: content.length,
            score: 0.7,
          },
          boundaries: {},
        });
      }
    }

    return chunks;
  }

  private getRelevantCachedChunks(agentType: SubagentType): ContextChunk[] {
    const relevantChunks: ContextChunk[] = [];

    // Get chunks from cache that might be relevant
    for (const [key, chunks] of this.sharedContextCache.entries()) {
      // Skip very old cache entries
      const timestamp = parseInt(key.split('-').pop() || '0');
      if (Date.now() - timestamp > 5 * 60 * 1000) {
        // 5 minutes
        continue;
      }

      // Add relevant chunks based on agent type
      if (agentType === 'review' || agentType === 'improve') {
        relevantChunks.push(...chunks.filter((c) => c.type === 'code'));
      }
    }

    return relevantChunks;
  }

  /**
   * Clear context cache
   */
  clearCache(): void {
    this.sharedContextCache.clear();
    logger.debug('Context cache cleared');
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    const stats = {
      cacheSize: this.sharedContextCache.size,
      totalChunks: 0,
      totalBytes: 0,
    };

    for (const chunks of this.sharedContextCache.values()) {
      stats.totalChunks += chunks.length;
      stats.totalBytes += chunks.reduce((sum, c) => sum + c.metadata.size, 0);
    }

    return stats;
  }
}
