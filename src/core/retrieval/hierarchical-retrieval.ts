/**
 * Hierarchical Retrieval System with Progressive Summarization
 * Implements multi-level tree structure to prevent semantic collapse at scale
 *
 * Based on: Encyclopedia → Chapter → Section → Paragraph model
 * Reduces search space from 50K to ~200 at each hop
 */

import Database from 'better-sqlite3';
import { logger } from '../monitoring/logger.js';
import { Trace, CompressedTrace } from '../trace/types.js';
import { Frame, Anchor, Event } from '../context/frame-manager.js';
import * as zlib from 'zlib';
import { promisify } from 'util';
import crypto from 'crypto';

const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);

export interface HierarchyLevel {
  level: 'encyclopedia' | 'chapter' | 'section' | 'paragraph' | 'atom';
  id: string;
  parentId?: string;
  title: string;
  summary: string;
  embeddings?: number[];
  childCount: number;
  tokenCount: number;
  score: number;
  timeRange: {
    start: number;
    end: number;
  };
  metadata: {
    compressionRatio?: number;
    semanticDensity?: number;
    accessPattern?: 'hot' | 'warm' | 'cold';
    lastAccessed?: number;
  };
}

export interface RetrievalNode {
  id: string;
  level: HierarchyLevel;
  children?: RetrievalNode[];
  content?: string; // Only for leaf nodes
  compressed?: boolean;
}

export interface HierarchicalConfig {
  maxEncyclopediaSize: number; // Total documents (~50K)
  maxChapterSize: number; // Documents per chapter (~6K)
  maxSectionSize: number; // Docs per section (~250)
  maxParagraphSize: number; // Docs per paragraph (~10-20)
  compressionThreshold: number; // Token threshold for compression
  semanticThreshold: number; // Similarity threshold for grouping
}

export const DEFAULT_HIERARCHY_CONFIG: HierarchicalConfig = {
  maxEncyclopediaSize: 50000,
  maxChapterSize: 6000,
  maxSectionSize: 250,
  maxParagraphSize: 20,
  compressionThreshold: 1000,
  semanticThreshold: 0.7,
};

/**
 * Manages hierarchical retrieval with progressive summarization
 */
export class HierarchicalRetrieval {
  private db: Database.Database;
  private config: HierarchicalConfig;
  private hierarchyCache: Map<string, RetrievalNode> = new Map();
  private summaryCache: Map<string, string> = new Map();

  constructor(db: Database.Database, config: Partial<HierarchicalConfig> = {}) {
    this.db = db;
    this.config = { ...DEFAULT_HIERARCHY_CONFIG, ...config };
    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hierarchy_nodes (
        id TEXT PRIMARY KEY,
        level TEXT NOT NULL,
        parent_id TEXT,
        title TEXT NOT NULL,
        summary TEXT,
        embeddings BLOB,
        child_count INTEGER DEFAULT 0,
        token_count INTEGER DEFAULT 0,
        score REAL DEFAULT 0,
        time_start INTEGER,
        time_end INTEGER,
        compression_ratio REAL,
        semantic_density REAL,
        access_pattern TEXT DEFAULT 'cold',
        last_accessed INTEGER,
        created_at INTEGER DEFAULT (unixepoch() * 1000),
        FOREIGN KEY (parent_id) REFERENCES hierarchy_nodes(id) ON DELETE CASCADE
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_hierarchy_level ON hierarchy_nodes(level);
      CREATE INDEX IF NOT EXISTS idx_hierarchy_parent ON hierarchy_nodes(parent_id);
      CREATE INDEX IF NOT EXISTS idx_hierarchy_score ON hierarchy_nodes(score DESC);
      CREATE INDEX IF NOT EXISTS idx_hierarchy_time ON hierarchy_nodes(time_start, time_end);
    `);

    // Content storage for leaf nodes
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hierarchy_content (
        node_id TEXT PRIMARY KEY,
        content TEXT,
        compressed BOOLEAN DEFAULT 0,
        original_size INTEGER,
        compressed_size INTEGER,
        FOREIGN KEY (node_id) REFERENCES hierarchy_nodes(id) ON DELETE CASCADE
      )
    `);
  }

  /**
   * Build hierarchical structure from traces
   */
  async buildHierarchy(traces: Trace[]): Promise<RetrievalNode> {
    logger.info('Building hierarchical retrieval structure', {
      traceCount: traces.length,
    });

    // Sort traces by time and score
    traces.sort((a, b) => {
      const timeDiff = b.metadata.startTime - a.metadata.startTime;
      return timeDiff !== 0 ? timeDiff : b.score - a.score;
    });

    // Create root encyclopedia node
    const encyclopediaId = this.generateId('encyclopedia');
    const encyclopedia: RetrievalNode = {
      id: encyclopediaId,
      level: {
        level: 'encyclopedia',
        id: encyclopediaId,
        title: 'Knowledge Base',
        summary: await this.generateSummary(traces, 'encyclopedia'),
        childCount: 0,
        tokenCount: traces.reduce((sum, t) => sum + (t.tokenCount || 0), 0),
        score: Math.max(...traces.map((t) => t.score)),
        timeRange: {
          start: Math.min(...traces.map((t) => t.metadata.startTime)),
          end: Math.max(...traces.map((t) => t.metadata.endTime)),
        },
        metadata: {
          semanticDensity: 1.0,
          accessPattern: 'hot',
        },
      },
      children: [],
    };

    // Partition into chapters
    const chapters = await this.partitionIntoChapters(traces);

    for (const chapterTraces of chapters) {
      const chapter = await this.buildChapter(chapterTraces, encyclopediaId);
      encyclopedia.children!.push(chapter);
    }

    // Update child count
    encyclopedia.level.childCount = encyclopedia.children!.length;

    // Store in database
    await this.storeNode(encyclopedia);

    return encyclopedia;
  }

  /**
   * Partition traces into chapters based on semantic similarity and time
   */
  private async partitionIntoChapters(traces: Trace[]): Promise<Trace[][]> {
    const chapters: Trace[][] = [];
    let currentChapter: Trace[] = [];

    for (const trace of traces) {
      if (currentChapter.length >= this.config.maxChapterSize) {
        chapters.push(currentChapter);
        currentChapter = [trace];
      } else if (currentChapter.length > 0) {
        // Check semantic similarity with chapter
        const similarity = await this.calculateSimilarity(
          trace,
          currentChapter[currentChapter.length - 1]
        );

        if (similarity < this.config.semanticThreshold) {
          // Start new chapter if semantically different
          chapters.push(currentChapter);
          currentChapter = [trace];
        } else {
          currentChapter.push(trace);
        }
      } else {
        currentChapter.push(trace);
      }
    }

    if (currentChapter.length > 0) {
      chapters.push(currentChapter);
    }

    return chapters;
  }

  /**
   * Build a chapter node
   */
  private async buildChapter(
    traces: Trace[],
    parentId: string
  ): Promise<RetrievalNode> {
    const chapterId = this.generateId('chapter');

    const chapter: RetrievalNode = {
      id: chapterId,
      level: {
        level: 'chapter',
        id: chapterId,
        parentId,
        title: this.generateChapterTitle(traces),
        summary: await this.generateSummary(traces, 'chapter'),
        childCount: 0,
        tokenCount: traces.reduce((sum, t) => sum + (t.tokenCount || 0), 0),
        score: Math.max(...traces.map((t) => t.score)),
        timeRange: {
          start: Math.min(...traces.map((t) => t.metadata.startTime)),
          end: Math.max(...traces.map((t) => t.metadata.endTime)),
        },
        metadata: {
          compressionRatio: 0.8,
          semanticDensity: 0.8,
          accessPattern: 'warm',
        },
      },
      children: [],
    };

    // Partition into sections
    const sections = await this.partitionIntoSections(traces);

    for (const sectionTraces of sections) {
      const section = await this.buildSection(sectionTraces, chapterId);
      chapter.children!.push(section);
    }

    chapter.level.childCount = chapter.children!.length;
    return chapter;
  }

  /**
   * Build a section node
   */
  private async buildSection(
    traces: Trace[],
    parentId: string
  ): Promise<RetrievalNode> {
    const sectionId = this.generateId('section');

    const section: RetrievalNode = {
      id: sectionId,
      level: {
        level: 'section',
        id: sectionId,
        parentId,
        title: this.generateSectionTitle(traces),
        summary: await this.generateSummary(traces, 'section'),
        childCount: 0,
        tokenCount: traces.reduce((sum, t) => sum + (t.tokenCount || 0), 0),
        score: Math.max(...traces.map((t) => t.score)),
        timeRange: {
          start: Math.min(...traces.map((t) => t.metadata.startTime)),
          end: Math.max(...traces.map((t) => t.metadata.endTime)),
        },
        metadata: {
          compressionRatio: 0.6,
          semanticDensity: 0.6,
          accessPattern: 'cold',
        },
      },
      children: [],
    };

    // Partition into paragraphs
    const paragraphs = await this.partitionIntoParagraphs(traces);

    for (const paragraphTraces of paragraphs) {
      const paragraph = await this.buildParagraph(paragraphTraces, sectionId);
      section.children!.push(paragraph);
    }

    section.level.childCount = section.children!.length;
    return section;
  }

  /**
   * Build a paragraph (leaf) node
   */
  private async buildParagraph(
    traces: Trace[],
    parentId: string
  ): Promise<RetrievalNode> {
    const paragraphId = this.generateId('paragraph');

    // Combine trace content
    const content = traces
      .map((t) => {
        return `[${new Date(t.metadata.startTime).toISOString()}] ${t.type}: ${t.summary}`;
      })
      .join('\n\n');

    // Compress if large
    let storedContent = content;
    let compressed = false;

    if (content.length > this.config.compressionThreshold) {
      const compressedData = await gzipAsync(content);
      storedContent = compressedData.toString('base64');
      compressed = true;
    }

    const paragraph: RetrievalNode = {
      id: paragraphId,
      level: {
        level: 'paragraph',
        id: paragraphId,
        parentId,
        title: this.generateParagraphTitle(traces),
        summary: await this.generateSummary(traces, 'paragraph'),
        childCount: traces.length,
        tokenCount: traces.reduce((sum, t) => sum + (t.tokenCount || 0), 0),
        score: Math.max(...traces.map((t) => t.score)),
        timeRange: {
          start: Math.min(...traces.map((t) => t.metadata.startTime)),
          end: Math.max(...traces.map((t) => t.metadata.endTime)),
        },
        metadata: {
          compressionRatio: compressed ? 0.3 : 1.0,
          semanticDensity: 0.4,
          accessPattern: 'cold',
        },
      },
      content: storedContent,
      compressed,
    };

    return paragraph;
  }

  /**
   * Partition traces into sections
   */
  private async partitionIntoSections(traces: Trace[]): Promise<Trace[][]> {
    const sections: Trace[][] = [];
    const sectionSize = Math.ceil(
      traces.length / Math.ceil(traces.length / this.config.maxSectionSize)
    );

    for (let i = 0; i < traces.length; i += sectionSize) {
      sections.push(traces.slice(i, i + sectionSize));
    }

    return sections;
  }

  /**
   * Partition traces into paragraphs
   */
  private async partitionIntoParagraphs(traces: Trace[]): Promise<Trace[][]> {
    const paragraphs: Trace[][] = [];
    const paragraphSize = Math.ceil(
      traces.length / Math.ceil(traces.length / this.config.maxParagraphSize)
    );

    for (let i = 0; i < traces.length; i += paragraphSize) {
      paragraphs.push(traces.slice(i, i + paragraphSize));
    }

    return paragraphs;
  }

  /**
   * Traverse hierarchy to retrieve relevant content
   */
  async retrieve(
    query: string,
    maxDepth: number = 4,
    tokenBudget: number = 4000
  ): Promise<string> {
    logger.info('Hierarchical retrieval', { query, maxDepth, tokenBudget });

    // Start from encyclopedia
    const encyclopedia = await this.loadRootNode();
    if (!encyclopedia) {
      return 'No content available';
    }

    const path: RetrievalNode[] = [encyclopedia];
    let currentNode = encyclopedia;
    let tokensUsed = 0;

    // Traverse down the hierarchy
    for (let depth = 1; depth < maxDepth && tokensUsed < tokenBudget; depth++) {
      if (!currentNode.children || currentNode.children.length === 0) {
        break;
      }

      // Select best matching child
      const bestChild = await this.selectBestChild(
        currentNode.children,
        query,
        tokenBudget - tokensUsed
      );

      if (!bestChild) break;

      path.push(bestChild);
      currentNode = bestChild;
      tokensUsed += bestChild.level.tokenCount;

      // Update access pattern
      await this.updateAccessPattern(bestChild.id);
    }

    // Build context from path
    return this.buildContextFromPath(path, tokenBudget);
  }

  /**
   * Select best matching child node
   */
  private async selectBestChild(
    children: RetrievalNode[],
    query: string,
    remainingBudget: number
  ): Promise<RetrievalNode | null> {
    let bestChild: RetrievalNode | null = null;
    let bestScore = 0;

    for (const child of children) {
      if (child.level.tokenCount > remainingBudget) {
        continue;
      }

      // Calculate relevance score
      const score = await this.calculateRelevance(child, query);

      if (score > bestScore) {
        bestScore = score;
        bestChild = child;
      }
    }

    return bestChild;
  }

  /**
   * Calculate relevance of node to query
   */
  private async calculateRelevance(
    node: RetrievalNode,
    query: string
  ): Promise<number> {
    // Simple keyword matching for now
    // In production, use embeddings
    const queryWords = query.toLowerCase().split(/\s+/);
    const nodeText = `${node.level.title} ${node.level.summary}`.toLowerCase();

    let matches = 0;
    for (const word of queryWords) {
      if (nodeText.includes(word)) {
        matches++;
      }
    }

    const keywordScore = matches / queryWords.length;
    const recencyScore =
      1 / (1 + (Date.now() - node.level.timeRange.end) / (1000 * 60 * 60 * 24));
    const importanceScore = node.level.score;

    return keywordScore * 0.5 + recencyScore * 0.3 + importanceScore * 0.2;
  }

  /**
   * Build context string from retrieval path
   */
  private async buildContextFromPath(
    path: RetrievalNode[],
    tokenBudget: number
  ): Promise<string> {
    const sections: string[] = [];

    sections.push('## Retrieval Path');
    sections.push(path.map((n) => n.level.title).join(' → '));
    sections.push('');

    // Add summaries from each level
    for (const node of path) {
      sections.push(`### ${node.level.level}: ${node.level.title}`);
      sections.push(node.level.summary);

      if (node.content) {
        // Decompress if needed
        let content = node.content;
        if (node.compressed) {
          const compressed = Buffer.from(content, 'base64');
          const decompressed = await gunzipAsync(compressed);
          content = decompressed.toString();
        }
        sections.push('');
        sections.push('**Content:**');
        sections.push(content);
      }
      sections.push('');
    }

    // Add statistics
    sections.push('## Retrieval Statistics');
    sections.push(`- Levels traversed: ${path.length}`);
    sections.push(
      `- Search space reduction: ${this.calculateReduction(path)}x`
    );
    sections.push(
      `- Semantic density: ${this.calculateDensity(path).toFixed(2)}`
    );

    return sections.join('\n');
  }

  /**
   * Calculate search space reduction
   */
  private calculateReduction(path: RetrievalNode[]): number {
    if (path.length < 2) return 1;

    const initial = path[0].level.childCount;
    const final = path[path.length - 1].level.childCount || 1;

    return Math.round(initial / final);
  }

  /**
   * Calculate semantic density along path
   */
  private calculateDensity(path: RetrievalNode[]): number {
    const densities = path.map((n) => n.level.metadata.semanticDensity || 1);
    return densities.reduce((sum, d) => sum + d, 0) / densities.length;
  }

  /**
   * Generate summary for a level
   */
  private async generateSummary(
    traces: Trace[],
    level: string
  ): Promise<string> {
    // Cache key
    const cacheKey = `${level}:${traces.map((t) => t.id).join(',')}`;

    if (this.summaryCache.has(cacheKey)) {
      return this.summaryCache.get(cacheKey)!;
    }

    // Generate summary based on level
    let summary: string;

    switch (level) {
      case 'encyclopedia':
        summary = `Complete knowledge base with ${traces.length} traces covering ${this.getTopics(traces).join(', ')}`;
        break;
      case 'chapter':
        summary = `${traces.length} operations focused on ${this.getDominantOperation(traces)}`;
        break;
      case 'section':
        summary = `${traces.length} traces: ${this.getKeyActivities(traces).join(', ')}`;
        break;
      case 'paragraph':
        summary = traces
          .slice(0, 3)
          .map((t) => t.summary)
          .join('. ');
        break;
      default:
        summary = `${traces.length} items`;
    }

    this.summaryCache.set(cacheKey, summary);
    return summary;
  }

  /**
   * Extract topics from traces
   */
  private getTopics(traces: Trace[]): string[] {
    const topics = new Set<string>();

    for (const trace of traces) {
      topics.add(trace.type);
    }

    return Array.from(topics).slice(0, 5);
  }

  /**
   * Get dominant operation type
   */
  private getDominantOperation(traces: Trace[]): string {
    const counts: Record<string, number> = {};

    for (const trace of traces) {
      counts[trace.type] = (counts[trace.type] || 0) + 1;
    }

    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return sorted[0]?.[0] || 'mixed operations';
  }

  /**
   * Get key activities
   */
  private getKeyActivities(traces: Trace[]): string[] {
    return traces.slice(0, 3).map((t) => t.type);
  }

  /**
   * Generate titles
   */
  private generateChapterTitle(traces: Trace[]): string {
    const start = new Date(traces[0].metadata.startTime);
    const operation = this.getDominantOperation(traces);
    return `${operation} (${start.toLocaleDateString()})`;
  }

  private generateSectionTitle(traces: Trace[]): string {
    const start = new Date(traces[0].metadata.startTime);
    return `Section ${start.toLocaleTimeString()}`;
  }

  private generateParagraphTitle(traces: Trace[]): string {
    return `${traces.length} traces`;
  }

  /**
   * Calculate similarity between traces
   */
  private async calculateSimilarity(a: Trace, b: Trace): Promise<number> {
    // Simple similarity based on type and time
    const typeSimilarity = a.type === b.type ? 1 : 0;
    const timeDiff = Math.abs(a.metadata.startTime - b.metadata.startTime);
    const timeSimilarity = 1 / (1 + timeDiff / (1000 * 60 * 60)); // Hour scale

    return typeSimilarity * 0.5 + timeSimilarity * 0.5;
  }

  /**
   * Store node in database
   */
  private async storeNode(node: RetrievalNode): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO hierarchy_nodes (
        id, level, parent_id, title, summary,
        child_count, token_count, score,
        time_start, time_end,
        compression_ratio, semantic_density, access_pattern
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      node.id,
      node.level.level,
      node.level.parentId || null,
      node.level.title,
      node.level.summary,
      node.level.childCount,
      node.level.tokenCount,
      node.level.score,
      node.level.timeRange.start,
      node.level.timeRange.end,
      node.level.metadata.compressionRatio || 1,
      node.level.metadata.semanticDensity || 1,
      node.level.metadata.accessPattern || 'cold'
    );

    // Store content if present
    if (node.content) {
      this.db
        .prepare(
          `
        INSERT OR REPLACE INTO hierarchy_content (
          node_id, content, compressed, original_size, compressed_size
        ) VALUES (?, ?, ?, ?, ?)
      `
        )
        .run(
          node.id,
          node.content,
          node.compressed ? 1 : 0,
          node.compressed ? node.content.length * 2 : node.content.length,
          node.content.length
        );
    }

    // Recursively store children
    if (node.children) {
      for (const child of node.children) {
        await this.storeNode(child);
      }
    }
  }

  /**
   * Load root encyclopedia node
   */
  private async loadRootNode(): Promise<RetrievalNode | null> {
    const row = this.db
      .prepare(
        `
      SELECT * FROM hierarchy_nodes
      WHERE level = 'encyclopedia'
      ORDER BY created_at DESC
      LIMIT 1
    `
      )
      .get() as any;

    if (!row) return null;

    return this.loadNode(row.id);
  }

  /**
   * Load node from database
   */
  private async loadNode(nodeId: string): Promise<RetrievalNode | null> {
    // Check cache
    if (this.hierarchyCache.has(nodeId)) {
      return this.hierarchyCache.get(nodeId)!;
    }

    const nodeRow = this.db
      .prepare(
        `
      SELECT * FROM hierarchy_nodes WHERE id = ?
    `
      )
      .get(nodeId) as any;

    if (!nodeRow) return null;

    // Load content if exists
    const contentRow = this.db
      .prepare(
        `
      SELECT * FROM hierarchy_content WHERE node_id = ?
    `
      )
      .get(nodeId) as any;

    // Load children
    const childRows = this.db
      .prepare(
        `
      SELECT id FROM hierarchy_nodes WHERE parent_id = ?
    `
      )
      .all(nodeId) as any[];

    const children: RetrievalNode[] = [];
    for (const childRow of childRows) {
      const child = await this.loadNode(childRow.id);
      if (child) children.push(child);
    }

    const node: RetrievalNode = {
      id: nodeRow.id,
      level: {
        level: nodeRow.level as any,
        id: nodeRow.id,
        parentId: nodeRow.parent_id,
        title: nodeRow.title,
        summary: nodeRow.summary,
        childCount: nodeRow.child_count,
        tokenCount: nodeRow.token_count,
        score: nodeRow.score,
        timeRange: {
          start: nodeRow.time_start,
          end: nodeRow.time_end,
        },
        metadata: {
          compressionRatio: nodeRow.compression_ratio,
          semanticDensity: nodeRow.semantic_density,
          accessPattern: nodeRow.access_pattern as any,
          lastAccessed: nodeRow.last_accessed,
        },
      },
      children: children.length > 0 ? children : undefined,
      content: contentRow?.content,
      compressed: contentRow?.compressed === 1,
    };

    // Cache the node
    this.hierarchyCache.set(nodeId, node);

    return node;
  }

  /**
   * Update access pattern for a node
   */
  private async updateAccessPattern(nodeId: string): Promise<void> {
    this.db
      .prepare(
        `
      UPDATE hierarchy_nodes
      SET last_accessed = ?, access_pattern = 'hot'
      WHERE id = ?
    `
      )
      .run(Date.now(), nodeId);
  }

  /**
   * Generate unique ID
   */
  private generateId(prefix: string): string {
    return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
  }

  /**
   * Get hierarchy statistics
   */
  getStatistics(): any {
    const stats = this.db
      .prepare(
        `
      SELECT 
        level,
        COUNT(*) as count,
        AVG(token_count) as avg_tokens,
        AVG(child_count) as avg_children,
        AVG(compression_ratio) as avg_compression,
        AVG(semantic_density) as avg_density
      FROM hierarchy_nodes
      GROUP BY level
    `
      )
      .all();

    const totalNodes = this.db
      .prepare(
        `
      SELECT COUNT(*) as count FROM hierarchy_nodes
    `
      )
      .get() as any;

    const totalContent = this.db
      .prepare(
        `
      SELECT 
        SUM(original_size) as original,
        SUM(compressed_size) as compressed
      FROM hierarchy_content
    `
      )
      .get() as any;

    return {
      nodesByLevel: stats,
      totalNodes: totalNodes.count,
      totalContent: {
        original: totalContent?.original || 0,
        compressed: totalContent?.compressed || 0,
        ratio: totalContent?.original
          ? (1 - totalContent.compressed / totalContent.original).toFixed(2)
          : 0,
      },
      cacheSize: this.hierarchyCache.size,
    };
  }
}
