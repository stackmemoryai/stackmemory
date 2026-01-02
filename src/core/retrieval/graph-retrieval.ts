/**
 * Graph-Based Retrieval with Explicit Semantic Navigation
 * Models documents as nodes with explicit relationships
 * Query traverses edges instead of embedding space
 *
 * The "nuclear option" for next-gen RAG
 */

import Database from 'better-sqlite3';
import { logger } from '../monitoring/logger.js';
import { Trace, CompressedTrace } from '../trace/types.js';
import { Frame, Anchor } from '../context/frame-manager.js';
import crypto from 'crypto';

export type NodeType =
  | 'document'
  | 'concept'
  | 'entity'
  | 'event'
  | 'decision'
  | 'constraint'
  | 'topic';

export type EdgeType =
  | 'citation' // Document cites another
  | 'topic_overlap' // Shares topics
  | 'temporal' // Time sequence
  | 'causal' // Causality chain
  | 'semantic' // Semantic similarity
  | 'structural' // Code structure relation
  | 'dependency' // Depends on
  | 'evolution' // Evolves from
  | 'contradiction' // Contradicts
  | 'implementation'; // Implements concept

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  content?: string;
  importance: number; // 0-1, affects node size
  metadata: {
    created: number;
    modified: number;
    accessed: number;
    accessCount: number;
    traceIds?: string[];
    frameIds?: string[];
    tags?: string[];
    embeddings?: number[];
  };
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  weight: number; // 0-1, relationship strength
  metadata: {
    created: number;
    evidence?: string[];
    bidirectional?: boolean;
  };
}

export interface TraversalPath {
  nodes: GraphNode[];
  edges: GraphEdge[];
  score: number;
  reasoning: string;
}

export interface GraphQuery {
  startNodes?: string[]; // Start from specific nodes
  targetNodes?: string[]; // Find paths to targets
  edgeTypes?: EdgeType[]; // Allowed edge types
  maxHops?: number; // Max traversal depth
  minWeight?: number; // Min edge weight
  nodeTypes?: NodeType[]; // Filter node types
}

export interface GraphConfig {
  maxNodes: number;
  maxEdges: number;
  minEdgeWeight: number;
  importanceThreshold: number;
  traversalTimeout: number;
  enableBidirectional: boolean;
}

export const DEFAULT_GRAPH_CONFIG: GraphConfig = {
  maxNodes: 10000,
  maxEdges: 50000,
  minEdgeWeight: 0.1,
  importanceThreshold: 0.3,
  traversalTimeout: 5000,
  enableBidirectional: true,
};

/**
 * Graph-based retrieval system with explicit semantic relationships
 */
export class GraphRetrieval {
  private db: Database.Database;
  private config: GraphConfig;
  private nodeIndex: Map<string, GraphNode> = new Map();
  private adjacencyList: Map<string, GraphEdge[]> = new Map();
  private reverseAdjacencyList: Map<string, GraphEdge[]> = new Map();

  constructor(db: Database.Database, config: Partial<GraphConfig> = {}) {
    this.db = db;
    this.config = { ...DEFAULT_GRAPH_CONFIG, ...config };
    this.initializeSchema();
  }

  private initializeSchema(): void {
    // Nodes table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS graph_nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        label TEXT NOT NULL,
        content TEXT,
        importance REAL DEFAULT 0.5,
        created INTEGER DEFAULT (unixepoch() * 1000),
        modified INTEGER DEFAULT (unixepoch() * 1000),
        accessed INTEGER DEFAULT (unixepoch() * 1000),
        access_count INTEGER DEFAULT 0,
        trace_ids TEXT,
        frame_ids TEXT,
        tags TEXT,
        embeddings BLOB
      )
    `);

    // Edges table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS graph_edges (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        target TEXT NOT NULL,
        type TEXT NOT NULL,
        weight REAL DEFAULT 0.5,
        created INTEGER DEFAULT (unixepoch() * 1000),
        evidence TEXT,
        bidirectional BOOLEAN DEFAULT 0,
        FOREIGN KEY (source) REFERENCES graph_nodes(id) ON DELETE CASCADE,
        FOREIGN KEY (target) REFERENCES graph_nodes(id) ON DELETE CASCADE,
        UNIQUE(source, target, type)
      )
    `);

    // Indexes for efficient traversal
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_type ON graph_nodes(type);
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_importance ON graph_nodes(importance DESC);
      CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges(source);
      CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges(target);
      CREATE INDEX IF NOT EXISTS idx_graph_edges_type ON graph_edges(type);
      CREATE INDEX IF NOT EXISTS idx_graph_edges_weight ON graph_edges(weight DESC);
    `);
  }

  /**
   * Build graph from traces and frames
   */
  async buildGraph(traces: Trace[], frames: Frame[]): Promise<void> {
    logger.info('Building semantic graph', {
      traceCount: traces.length,
      frameCount: frames.length,
    });

    // Create document nodes from traces
    for (const trace of traces) {
      await this.createDocumentNode(trace);
    }

    // Create concept nodes from frames
    for (const frame of frames) {
      await this.createConceptNode(frame);
    }

    // Establish edges based on relationships
    await this.establishTemporalEdges(traces);
    await this.establishCausalEdges(traces);
    await this.establishSemanticEdges(traces);
    await this.establishTopicEdges(traces);

    // Load graph into memory for fast traversal
    await this.loadGraphIntoMemory();

    logger.info('Graph built successfully', {
      nodes: this.nodeIndex.size,
      edges: this.adjacencyList.size,
    });
  }

  /**
   * Create document node from trace
   */
  private async createDocumentNode(trace: Trace): Promise<GraphNode> {
    const node: GraphNode = {
      id: `doc_${trace.id}`,
      type: 'document',
      label: trace.summary.substring(0, 100),
      content: JSON.stringify(trace),
      importance: trace.score,
      metadata: {
        created: trace.metadata.startTime,
        modified: trace.metadata.endTime,
        accessed: Date.now(),
        accessCount: 0,
        traceIds: [trace.id],
        tags: [trace.type, ...trace.metadata.filesModified.slice(0, 3)],
      },
    };

    await this.insertNode(node);
    return node;
  }

  /**
   * Create concept node from frame
   */
  private async createConceptNode(frame: Frame): Promise<GraphNode> {
    const node: GraphNode = {
      id: `concept_${frame.id}`,
      type: 'concept',
      label: frame.name,
      importance: frame.score,
      metadata: {
        created: frame.created_at,
        modified: frame.updated_at || frame.created_at,
        accessed: Date.now(),
        accessCount: 0,
        frameIds: [frame.id],
        tags: [frame.type],
      },
    };

    await this.insertNode(node);
    return node;
  }

  /**
   * Establish temporal edges between traces
   */
  private async establishTemporalEdges(traces: Trace[]): Promise<void> {
    // Sort by time
    const sorted = [...traces].sort(
      (a, b) => a.metadata.startTime - b.metadata.startTime
    );

    for (let i = 0; i < sorted.length - 1; i++) {
      const current = sorted[i];
      const next = sorted[i + 1];

      // Only link if within reasonable time window (1 hour)
      const timeDiff = next.metadata.startTime - current.metadata.endTime;
      if (timeDiff < 60 * 60 * 1000) {
        const weight = 1 / (1 + timeDiff / (1000 * 60)); // Decay by minutes

        await this.createEdge({
          id: this.generateId('edge'),
          source: `doc_${current.id}`,
          target: `doc_${next.id}`,
          type: 'temporal',
          weight,
          metadata: {
            created: Date.now(),
            evidence: [`${timeDiff}ms gap`],
          },
        });
      }
    }
  }

  /**
   * Establish causal edges based on trace relationships
   */
  private async establishCausalEdges(traces: Trace[]): Promise<void> {
    for (const trace of traces) {
      if (trace.metadata.causalChain && trace.metadata.causalChain.length > 0) {
        for (const parentId of trace.metadata.causalChain) {
          const parentExists = traces.find((t) => t.id === parentId);
          if (parentExists) {
            await this.createEdge({
              id: this.generateId('edge'),
              source: `doc_${parentId}`,
              target: `doc_${trace.id}`,
              type: 'causal',
              weight: 0.9, // Strong causal relationship
              metadata: {
                created: Date.now(),
                evidence: ['explicit causal chain'],
              },
            });
          }
        }
      }
    }
  }

  /**
   * Establish semantic edges based on similarity
   */
  private async establishSemanticEdges(traces: Trace[]): Promise<void> {
    // Compare each pair (expensive but thorough)
    for (let i = 0; i < traces.length - 1; i++) {
      for (let j = i + 1; j < traces.length; j++) {
        const similarity = this.calculateSimilarity(traces[i], traces[j]);

        if (similarity > this.config.minEdgeWeight) {
          await this.createEdge({
            id: this.generateId('edge'),
            source: `doc_${traces[i].id}`,
            target: `doc_${traces[j].id}`,
            type: 'semantic',
            weight: similarity,
            metadata: {
              created: Date.now(),
              evidence: [`similarity: ${similarity.toFixed(2)}`],
              bidirectional: true,
            },
          });
        }
      }
    }
  }

  /**
   * Establish topic overlap edges
   */
  private async establishTopicEdges(traces: Trace[]): Promise<void> {
    // Group by topic
    const topicGroups: Map<string, Trace[]> = new Map();

    for (const trace of traces) {
      const topic = trace.type;
      if (!topicGroups.has(topic)) {
        topicGroups.set(topic, []);
      }
      topicGroups.get(topic)!.push(trace);
    }

    // Connect traces within same topic
    for (const [topic, group] of topicGroups) {
      if (group.length < 2) continue;

      // Create topic hub node
      const topicNode: GraphNode = {
        id: `topic_${topic}`,
        type: 'topic',
        label: topic,
        importance: 0.7,
        metadata: {
          created: Date.now(),
          modified: Date.now(),
          accessed: Date.now(),
          accessCount: 0,
          tags: [topic],
        },
      };

      await this.insertNode(topicNode);

      // Connect all traces to topic hub
      for (const trace of group) {
        await this.createEdge({
          id: this.generateId('edge'),
          source: `doc_${trace.id}`,
          target: topicNode.id,
          type: 'topic_overlap',
          weight: 0.6,
          metadata: {
            created: Date.now(),
            bidirectional: true,
          },
        });
      }
    }
  }

  /**
   * Traverse graph to find relevant paths
   */
  async traverse(query: string, config?: GraphQuery): Promise<TraversalPath[]> {
    const startTime = Date.now();
    const queryConfig = config || {};
    const maxHops = queryConfig.maxHops || 3;
    const paths: TraversalPath[] = [];

    // Find starting nodes based on query
    const startNodes = await this.findStartNodes(query, queryConfig);

    if (startNodes.length === 0) {
      logger.warn('No starting nodes found for query', { query });
      return [];
    }

    // Perform BFS/DFS traversal from each start node
    for (const startNode of startNodes) {
      const nodePaths = await this.traverseFromNode(
        startNode,
        query,
        maxHops,
        queryConfig
      );
      paths.push(...nodePaths);
    }

    // Sort by score and limit results
    paths.sort((a, b) => b.score - a.score);
    const topPaths = paths.slice(0, 10);

    logger.info('Graph traversal complete', {
      query: query.substring(0, 50),
      startNodes: startNodes.length,
      pathsFound: paths.length,
      timeMs: Date.now() - startTime,
    });

    return topPaths;
  }

  /**
   * Find starting nodes for traversal
   */
  private async findStartNodes(
    query: string,
    config: GraphQuery
  ): Promise<GraphNode[]> {
    if (config.startNodes) {
      return config.startNodes
        .map((id) => this.nodeIndex.get(id))
        .filter((n) => n !== undefined) as GraphNode[];
    }

    // Find nodes matching query
    const queryWords = query.toLowerCase().split(/\s+/);
    const candidates: Array<{ node: GraphNode; score: number }> = [];

    for (const node of this.nodeIndex.values()) {
      if (config.nodeTypes && !config.nodeTypes.includes(node.type)) {
        continue;
      }

      const label = node.label.toLowerCase();
      const tags = (node.metadata.tags || []).join(' ').toLowerCase();

      let score = 0;
      for (const word of queryWords) {
        if (label.includes(word)) score += 2;
        if (tags.includes(word)) score += 1;
      }

      if (score > 0) {
        score *= node.importance; // Weight by importance
        candidates.push({ node, score });
      }
    }

    // Sort and return top candidates
    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, 5).map((c) => c.node);
  }

  /**
   * Traverse from a specific node
   */
  private async traverseFromNode(
    startNode: GraphNode,
    query: string,
    maxHops: number,
    config: GraphQuery
  ): Promise<TraversalPath[]> {
    const paths: TraversalPath[] = [];
    const visited = new Set<string>();

    // BFS queue: [node, path, depth]
    const queue: Array<{
      node: GraphNode;
      path: TraversalPath;
      depth: number;
    }> = [
      {
        node: startNode,
        path: {
          nodes: [startNode],
          edges: [],
          score: startNode.importance,
          reasoning: `Starting from ${startNode.type}: ${startNode.label}`,
        },
        depth: 0,
      },
    ];

    while (queue.length > 0) {
      const current = queue.shift()!;

      if (current.depth >= maxHops) {
        paths.push(current.path);
        continue;
      }

      if (visited.has(current.node.id)) {
        continue;
      }
      visited.add(current.node.id);

      // Get outgoing edges
      const edges = this.adjacencyList.get(current.node.id) || [];

      for (const edge of edges) {
        // Filter by edge type if specified
        if (config.edgeTypes && !config.edgeTypes.includes(edge.type)) {
          continue;
        }

        // Filter by minimum weight
        if (config.minWeight && edge.weight < config.minWeight) {
          continue;
        }

        const targetNode = this.nodeIndex.get(edge.target);
        if (!targetNode) continue;

        // Calculate path score
        const pathScore = this.calculatePathScore(
          current.path,
          edge,
          targetNode,
          query
        );

        // Create new path
        const newPath: TraversalPath = {
          nodes: [...current.path.nodes, targetNode],
          edges: [...current.path.edges, edge],
          score: pathScore,
          reasoning: `${current.path.reasoning} → ${edge.type} → ${targetNode.label}`,
        };

        queue.push({
          node: targetNode,
          path: newPath,
          depth: current.depth + 1,
        });
      }
    }

    return paths;
  }

  /**
   * Calculate path score
   */
  private calculatePathScore(
    currentPath: TraversalPath,
    edge: GraphEdge,
    targetNode: GraphNode,
    query: string
  ): number {
    // Base score from current path
    let score = currentPath.score;

    // Edge weight contribution
    score *= edge.weight;

    // Target node importance
    score *= targetNode.importance;

    // Query relevance
    const queryWords = query.toLowerCase().split(/\s+/);
    const targetLabel = targetNode.label.toLowerCase();
    let relevance = 0;
    for (const word of queryWords) {
      if (targetLabel.includes(word)) relevance += 1;
    }
    score *= 1 + relevance * 0.2;

    // Path length penalty (prefer shorter paths)
    score *= Math.pow(0.9, currentPath.nodes.length);

    return score;
  }

  /**
   * Calculate similarity between traces
   */
  private calculateSimilarity(a: Trace, b: Trace): number {
    // Type similarity
    const typeSim = a.type === b.type ? 0.3 : 0;

    // File overlap
    const filesA = new Set(a.metadata.filesModified);
    const filesB = new Set(b.metadata.filesModified);
    const intersection = new Set([...filesA].filter((x) => filesB.has(x)));
    const union = new Set([...filesA, ...filesB]);
    const fileSim = union.size > 0 ? (intersection.size / union.size) * 0.3 : 0;

    // Tool overlap
    const toolsA = new Set(a.tools.map((t) => t.tool));
    const toolsB = new Set(b.tools.map((t) => t.tool));
    const toolIntersection = new Set([...toolsA].filter((x) => toolsB.has(x)));
    const toolUnion = new Set([...toolsA, ...toolsB]);
    const toolSim =
      toolUnion.size > 0 ? (toolIntersection.size / toolUnion.size) * 0.2 : 0;

    // Summary text similarity (simple word overlap)
    const wordsA = new Set(a.summary.toLowerCase().split(/\s+/));
    const wordsB = new Set(b.summary.toLowerCase().split(/\s+/));
    const wordIntersection = new Set([...wordsA].filter((x) => wordsB.has(x)));
    const wordUnion = new Set([...wordsA, ...wordsB]);
    const textSim =
      wordUnion.size > 0 ? (wordIntersection.size / wordUnion.size) * 0.2 : 0;

    return typeSim + fileSim + toolSim + textSim;
  }

  /**
   * Insert node into database
   */
  private async insertNode(node: GraphNode): Promise<void> {
    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO graph_nodes (
        id, type, label, content, importance,
        created, modified, accessed, access_count,
        trace_ids, frame_ids, tags, embeddings
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        node.id,
        node.type,
        node.label,
        node.content || null,
        node.importance,
        node.metadata.created,
        node.metadata.modified,
        node.metadata.accessed,
        node.metadata.accessCount,
        JSON.stringify(node.metadata.traceIds || []),
        JSON.stringify(node.metadata.frameIds || []),
        JSON.stringify(node.metadata.tags || []),
        node.metadata.embeddings ? Buffer.from(node.metadata.embeddings) : null
      );
  }

  /**
   * Create edge in database
   */
  private async createEdge(edge: GraphEdge): Promise<void> {
    try {
      this.db
        .prepare(
          `
        INSERT OR IGNORE INTO graph_edges (
          id, source, target, type, weight,
          created, evidence, bidirectional
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
        )
        .run(
          edge.id,
          edge.source,
          edge.target,
          edge.type,
          edge.weight,
          edge.metadata.created,
          JSON.stringify(edge.metadata.evidence || []),
          edge.metadata.bidirectional ? 1 : 0
        );
    } catch (error) {
      // Ignore duplicate edges
    }
  }

  /**
   * Load graph into memory for fast traversal
   */
  private async loadGraphIntoMemory(): Promise<void> {
    // Load nodes
    const nodes = this.db.prepare('SELECT * FROM graph_nodes').all() as any[];

    for (const row of nodes) {
      const node: GraphNode = {
        id: row.id,
        type: row.type as NodeType,
        label: row.label,
        content: row.content,
        importance: row.importance,
        metadata: {
          created: row.created,
          modified: row.modified,
          accessed: row.accessed,
          accessCount: row.access_count,
          traceIds: JSON.parse(row.trace_ids || '[]'),
          frameIds: JSON.parse(row.frame_ids || '[]'),
          tags: JSON.parse(row.tags || '[]'),
        },
      };
      this.nodeIndex.set(node.id, node);
    }

    // Load edges
    const edges = this.db.prepare('SELECT * FROM graph_edges').all() as any[];

    for (const row of edges) {
      const edge: GraphEdge = {
        id: row.id,
        source: row.source,
        target: row.target,
        type: row.type as EdgeType,
        weight: row.weight,
        metadata: {
          created: row.created,
          evidence: JSON.parse(row.evidence || '[]'),
          bidirectional: row.bidirectional === 1,
        },
      };

      // Add to adjacency list
      if (!this.adjacencyList.has(edge.source)) {
        this.adjacencyList.set(edge.source, []);
      }
      this.adjacencyList.get(edge.source)!.push(edge);

      // Add to reverse adjacency list
      if (!this.reverseAdjacencyList.has(edge.target)) {
        this.reverseAdjacencyList.set(edge.target, []);
      }
      this.reverseAdjacencyList.get(edge.target)!.push(edge);

      // If bidirectional, add reverse edge
      if (edge.metadata.bidirectional) {
        const reverseEdge = {
          ...edge,
          source: edge.target,
          target: edge.source,
        };
        if (!this.adjacencyList.has(reverseEdge.source)) {
          this.adjacencyList.set(reverseEdge.source, []);
        }
        this.adjacencyList.get(reverseEdge.source)!.push(reverseEdge);
      }
    }
  }

  /**
   * Generate unique ID
   */
  private generateId(prefix: string): string {
    return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
  }

  /**
   * Get graph statistics
   */
  getStatistics(): any {
    const nodeStats = this.db
      .prepare(
        `
      SELECT 
        type,
        COUNT(*) as count,
        AVG(importance) as avg_importance,
        MAX(importance) as max_importance
      FROM graph_nodes
      GROUP BY type
    `
      )
      .all();

    const edgeStats = this.db
      .prepare(
        `
      SELECT 
        type,
        COUNT(*) as count,
        AVG(weight) as avg_weight,
        MAX(weight) as max_weight
      FROM graph_edges
      GROUP BY type
    `
      )
      .all();

    return {
      nodes: {
        total: this.nodeIndex.size,
        byType: nodeStats,
        inMemory: this.nodeIndex.size,
      },
      edges: {
        total: edgeStats.reduce((sum: number, e: any) => sum + e.count, 0),
        byType: edgeStats,
        adjacencyListSize: this.adjacencyList.size,
      },
      connectivity: {
        avgDegree: this.calculateAverageDegree(),
        maxDegree: this.calculateMaxDegree(),
      },
    };
  }

  /**
   * Calculate average node degree
   */
  private calculateAverageDegree(): number {
    if (this.nodeIndex.size === 0) return 0;

    let totalDegree = 0;
    for (const nodeId of this.nodeIndex.keys()) {
      const outgoing = this.adjacencyList.get(nodeId)?.length || 0;
      const incoming = this.reverseAdjacencyList.get(nodeId)?.length || 0;
      totalDegree += outgoing + incoming;
    }

    return totalDegree / this.nodeIndex.size;
  }

  /**
   * Calculate maximum node degree
   */
  private calculateMaxDegree(): number {
    let maxDegree = 0;

    for (const nodeId of this.nodeIndex.keys()) {
      const outgoing = this.adjacencyList.get(nodeId)?.length || 0;
      const incoming = this.reverseAdjacencyList.get(nodeId)?.length || 0;
      maxDegree = Math.max(maxDegree, outgoing + incoming);
    }

    return maxDegree;
  }

  /**
   * Export graph for visualization
   */
  exportForVisualization(): any {
    const nodes = Array.from(this.nodeIndex.values()).map((node) => ({
      id: node.id,
      label: node.label,
      type: node.type,
      size: node.importance * 10,
      color: this.getNodeColor(node.type),
    }));

    const edges = [];
    for (const edgeList of this.adjacencyList.values()) {
      for (const edge of edgeList) {
        edges.push({
          source: edge.source,
          target: edge.target,
          type: edge.type,
          weight: edge.weight,
          color: this.getEdgeColor(edge.type),
        });
      }
    }

    return { nodes, edges };
  }

  /**
   * Get node color for visualization
   */
  private getNodeColor(type: NodeType): string {
    const colors: Record<NodeType, string> = {
      document: '#4A90E2',
      concept: '#7ED321',
      entity: '#F5A623',
      event: '#D0021B',
      decision: '#9013FE',
      constraint: '#50E3C2',
      topic: '#B8E986',
    };
    return colors[type] || '#CCCCCC';
  }

  /**
   * Get edge color for visualization
   */
  private getEdgeColor(type: EdgeType): string {
    const colors: Record<EdgeType, string> = {
      citation: '#4A90E2',
      topic_overlap: '#7ED321',
      temporal: '#F5A623',
      causal: '#D0021B',
      semantic: '#9013FE',
      structural: '#50E3C2',
      dependency: '#B8E986',
      evolution: '#417505',
      contradiction: '#FF0000',
      implementation: '#0099FF',
    };
    return colors[type] || '#999999';
  }
}
