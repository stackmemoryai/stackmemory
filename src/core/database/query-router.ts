/**
 * Query Router for Tiered Storage
 * Routes database queries to appropriate storage tier based on data age, query type, and performance requirements
 */

import {
  DatabaseAdapter,
  SearchOptions,
  QueryOptions,
  AggregationOptions,
  BulkOperation,
} from './database-adapter.js';
import { SQLiteAdapter } from './sqlite-adapter.js';
import { ParadeDBAdapter } from './paradedb-adapter.js';
import { ConnectionPool } from './connection-pool.js';
import type { Frame, Event, Anchor } from '../context/frame-manager.js';
import { logger } from '../monitoring/logger.js';
import { EventEmitter } from 'events';

export interface StorageTier {
  name: string;
  adapter: DatabaseAdapter;
  priority: number;
  config: TierConfig;
}

export interface TierConfig {
  // Data age thresholds
  maxAge?: number; // Data older than this goes to next tier (ms)
  minAge?: number; // Data newer than this stays in this tier (ms)

  // Query type preferences
  preferredOperations: string[]; // ['read', 'write', 'search', 'analytics']
  supportedFeatures: string[]; // ['full_text', 'vector', 'aggregation']

  // Performance characteristics
  maxLatency?: number; // Max acceptable latency for this tier (ms)
  maxThroughput?: number; // Max queries per second this tier can handle

  // Capacity limits
  maxFrames?: number; // Max frames before promoting to next tier
  maxSizeMB?: number; // Max storage size in MB

  // Routing rules
  routingRules: RoutingRule[];
}

export interface RoutingRule {
  condition: string; // 'age' | 'size' | 'query_type' | 'load' | 'feature'
  operator: string; // '>', '<', '=', '!=', 'in', 'not_in'
  value: any; // Comparison value
  weight: number; // Rule weight (0-1)
}

export interface QueryContext {
  queryType: 'read' | 'write' | 'search' | 'analytics' | 'bulk';
  frames?: Frame[];
  frameIds?: string[];
  requiredFeatures?: string[];
  timeRange?: { start: Date; end: Date };
  priority?: 'low' | 'medium' | 'high' | 'critical';
  timeout?: number;
  cacheStrategy?: 'none' | 'read' | 'write' | 'read_write';
}

export interface RoutingDecision {
  primaryTier: StorageTier;
  fallbackTiers: StorageTier[];
  rationale: string;
  confidence: number; // 0-1 confidence in decision
  estimatedLatency: number; // Estimated query latency (ms)
  cacheRecommendation?: string;
}

export interface QueryMetrics {
  totalQueries: number;
  queriesByTier: Map<string, number>;
  queriesByType: Map<string, number>;
  averageLatency: number;
  latencyByTier: Map<string, number>;
  errorsByTier: Map<string, number>;
  cacheHitRate: number;
  routingDecisions: number;
}

export class QueryRouter extends EventEmitter {
  private tiers: Map<string, StorageTier> = new Map();
  private metrics: QueryMetrics;
  private decisionCache: Map<string, RoutingDecision> = new Map();
  private readonly cacheExpiration = 60000; // 1 minute
  private readonly maxCacheSize = 1000;

  constructor() {
    super();
    this.metrics = {
      totalQueries: 0,
      queriesByTier: new Map(),
      queriesByType: new Map(),
      averageLatency: 0,
      latencyByTier: new Map(),
      errorsByTier: new Map(),
      cacheHitRate: 0,
      routingDecisions: 0,
    };
  }

  /**
   * Register a storage tier with the router
   */
  registerTier(tier: StorageTier): void {
    this.tiers.set(tier.name, tier);
    logger.info(
      `Registered storage tier: ${tier.name} (priority: ${tier.priority})`
    );
    this.emit('tierRegistered', tier);
  }

  /**
   * Remove a storage tier from the router
   */
  unregisterTier(tierName: string): void {
    const tier = this.tiers.get(tierName);
    if (tier) {
      this.tiers.delete(tierName);
      logger.info(`Unregistered storage tier: ${tierName}`);
      this.emit('tierUnregistered', tier);
    }
  }

  /**
   * Route a query to the most appropriate storage tier
   */
  async route<T>(
    operation: string,
    context: QueryContext,
    executor: (adapter: DatabaseAdapter) => Promise<T>
  ): Promise<T> {
    const startTime = Date.now();
    this.metrics.totalQueries++;
    this.metrics.queriesByType.set(
      context.queryType,
      (this.metrics.queriesByType.get(context.queryType) || 0) + 1
    );

    try {
      // Get routing decision
      const decision = await this.makeRoutingDecision(operation, context);

      // Try primary tier first
      try {
        const result = await this.executeOnTier(decision.primaryTier, executor);
        this.updateMetrics(decision.primaryTier.name, startTime, true);
        return result;
      } catch (error) {
        logger.warn(
          `Query failed on primary tier ${decision.primaryTier.name}:`,
          error
        );
        this.updateMetrics(decision.primaryTier.name, startTime, false);

        // Try fallback tiers
        for (const fallbackTier of decision.fallbackTiers) {
          try {
            logger.info(`Attempting fallback to tier: ${fallbackTier.name}`);
            const result = await this.executeOnTier(fallbackTier, executor);
            this.updateMetrics(fallbackTier.name, startTime, true);
            return result;
          } catch (fallbackError) {
            logger.warn(
              `Query failed on fallback tier ${fallbackTier.name}:`,
              fallbackError
            );
            this.updateMetrics(fallbackTier.name, startTime, false);
          }
        }

        // If all tiers failed, throw the original error
        throw error;
      }
    } catch (error) {
      logger.error('Query routing failed:', error);
      this.emit('routingError', { operation, context, error });
      throw error;
    }
  }

  /**
   * Make routing decision based on query context
   */
  private async makeRoutingDecision(
    operation: string,
    context: QueryContext
  ): Promise<RoutingDecision> {
    // Check cache first
    const cacheKey = this.generateCacheKey(operation, context);
    const cached = this.decisionCache.get(cacheKey);
    if (cached && Date.now() - cached.estimatedLatency < this.cacheExpiration) {
      this.metrics.cacheHitRate =
        (this.metrics.cacheHitRate * this.metrics.routingDecisions + 1) /
        (this.metrics.routingDecisions + 1);
      return cached;
    }

    this.metrics.routingDecisions++;

    // Evaluate each tier
    const evaluations: Array<{
      tier: StorageTier;
      score: number;
      rationale: string;
    }> = [];

    for (const [name, tier] of this.tiers) {
      const score = await this.evaluateTier(tier, operation, context);
      const rationale = this.generateRationale(tier, operation, context, score);
      evaluations.push({ tier, score, rationale });
    }

    // Sort by score (highest first)
    evaluations.sort((a, b) => b.score - a.score);

    if (evaluations.length === 0) {
      throw new Error('No storage tiers available for routing');
    }

    const primaryEval = evaluations[0];
    const fallbackTiers = evaluations
      .slice(1)
      .map((evaluation) => evaluation.tier);

    const decision: RoutingDecision = {
      primaryTier: primaryEval.tier,
      fallbackTiers,
      rationale: primaryEval.rationale,
      confidence: primaryEval.score,
      estimatedLatency: this.estimateLatency(
        primaryEval.tier,
        operation,
        context
      ),
      cacheRecommendation: this.recommendCacheStrategy(
        primaryEval.tier,
        context
      ),
    };

    // Cache decision
    this.cacheDecision(cacheKey, decision);

    logger.debug(
      `Routing decision: ${decision.primaryTier.name} (confidence: ${decision.confidence.toFixed(2)})`
    );
    this.emit('routingDecision', { operation, context, decision });

    return decision;
  }

  /**
   * Evaluate how well a tier fits the query requirements
   */
  private async evaluateTier(
    tier: StorageTier,
    operation: string,
    context: QueryContext
  ): Promise<number> {
    let score = 0;
    let maxScore = 0;

    // Evaluate each routing rule
    for (const rule of tier.config.routingRules) {
      maxScore += rule.weight;

      if (this.evaluateRule(rule, operation, context, tier)) {
        score += rule.weight;
      }
    }

    // Check operation preference
    if (tier.config.preferredOperations.includes(context.queryType)) {
      score += 0.2;
      maxScore += 0.2;
    }

    // Check feature support
    if (context.requiredFeatures) {
      const supportedFeatures = context.requiredFeatures.filter((feature) =>
        tier.config.supportedFeatures.includes(feature)
      );
      if (supportedFeatures.length === context.requiredFeatures.length) {
        score += 0.3;
      }
      maxScore += 0.3;
    }

    // Check current load
    const currentLoad = await this.getCurrentLoad(tier);
    if (
      tier.config.maxThroughput &&
      currentLoad < tier.config.maxThroughput * 0.8
    ) {
      score += 0.1;
    }
    maxScore += 0.1;

    // Check capacity
    if (await this.isWithinCapacity(tier)) {
      score += 0.1;
    }
    maxScore += 0.1;

    return maxScore > 0 ? score / maxScore : 0;
  }

  /**
   * Evaluate a single routing rule
   */
  private evaluateRule(
    rule: RoutingRule,
    operation: string,
    context: QueryContext,
    tier: StorageTier
  ): boolean {
    let actualValue: any;

    switch (rule.condition) {
      case 'age':
        // Check data age if frames are provided
        if (context.frames && context.frames.length > 0) {
          const avgAge =
            context.frames.reduce(
              (sum, frame) => sum + (Date.now() - frame.created_at),
              0
            ) / context.frames.length;
          actualValue = avgAge;
        } else if (context.timeRange) {
          actualValue = Date.now() - context.timeRange.end.getTime();
        } else {
          return false;
        }
        break;

      case 'query_type':
        actualValue = context.queryType;
        break;

      case 'feature':
        actualValue = context.requiredFeatures || [];
        break;

      case 'priority':
        actualValue = context.priority || 'medium';
        break;

      case 'size':
        actualValue = context.frames ? context.frames.length : 0;
        break;

      default:
        return false;
    }

    return this.compareValues(actualValue, rule.operator, rule.value);
  }

  /**
   * Compare values based on operator
   */
  private compareValues(actual: any, operator: string, expected: any): boolean {
    switch (operator) {
      case '>':
        return actual > expected;
      case '<':
        return actual < expected;
      case '=':
      case '==':
        return actual === expected;
      case '!=':
        return actual !== expected;
      case 'in':
        return Array.isArray(expected) && expected.includes(actual);
      case 'not_in':
        return Array.isArray(expected) && !expected.includes(actual);
      case 'contains':
        return (
          Array.isArray(actual) &&
          actual.some((item) => expected.includes(item))
        );
      default:
        return false;
    }
  }

  /**
   * Execute query on specific tier
   */
  private async executeOnTier<T>(
    tier: StorageTier,
    executor: (adapter: DatabaseAdapter) => Promise<T>
  ): Promise<T> {
    const startTime = Date.now();

    try {
      const result = await executor(tier.adapter);
      const duration = Date.now() - startTime;

      logger.debug(`Query executed on tier ${tier.name} in ${duration}ms`);
      this.emit('queryExecuted', {
        tierName: tier.name,
        duration,
        success: true,
      });

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error(
        `Query failed on tier ${tier.name} after ${duration}ms:`,
        error
      );
      this.emit('queryExecuted', {
        tierName: tier.name,
        duration,
        success: false,
        error,
      });

      throw error;
    }
  }

  /**
   * Generate cache key for routing decisions
   */
  private generateCacheKey(operation: string, context: QueryContext): string {
    const keyParts = [
      operation,
      context.queryType,
      context.priority || 'medium',
      (context.requiredFeatures || []).sort().join(','),
      context.timeRange
        ? `${context.timeRange.start.getTime()}-${context.timeRange.end.getTime()}`
        : '',
    ];

    return keyParts.join('|');
  }

  /**
   * Cache routing decision
   */
  private cacheDecision(key: string, decision: RoutingDecision): void {
    // Implement LRU eviction if cache is full
    if (this.decisionCache.size >= this.maxCacheSize) {
      const firstKey = this.decisionCache.keys().next().value;
      this.decisionCache.delete(firstKey);
    }

    this.decisionCache.set(key, decision);
  }

  /**
   * Estimate query latency for a tier
   */
  private estimateLatency(
    tier: StorageTier,
    operation: string,
    context: QueryContext
  ): number {
    const baseLatency =
      this.metrics.latencyByTier.get(tier.name) ||
      tier.config.maxLatency ||
      100;

    // Adjust based on operation type
    let multiplier = 1;
    switch (context.queryType) {
      case 'search':
        multiplier = 1.5;
        break;
      case 'analytics':
        multiplier = 2.0;
        break;
      case 'bulk':
        multiplier = 3.0;
        break;
      default:
        multiplier = 1.0;
    }

    return baseLatency * multiplier;
  }

  /**
   * Recommend cache strategy for the context
   */
  private recommendCacheStrategy(
    tier: StorageTier,
    context: QueryContext
  ): string {
    if (context.cacheStrategy && context.cacheStrategy !== 'none') {
      return context.cacheStrategy;
    }

    // Default recommendations based on query type and tier
    if (tier.name === 'hot' || tier.name === 'memory') {
      return 'read_write';
    } else if (context.queryType === 'read') {
      return 'read';
    }

    return 'none';
  }

  /**
   * Generate human-readable rationale for routing decision
   */
  private generateRationale(
    tier: StorageTier,
    operation: string,
    context: QueryContext,
    score: number
  ): string {
    const reasons = [];

    if (tier.config.preferredOperations.includes(context.queryType)) {
      reasons.push(`optimized for ${context.queryType} operations`);
    }

    if (
      context.requiredFeatures?.every((feature) =>
        tier.config.supportedFeatures.includes(feature)
      )
    ) {
      reasons.push(
        `supports all required features (${context.requiredFeatures.join(', ')})`
      );
    }

    if (score > 0.8) {
      reasons.push('high confidence match');
    } else if (score > 0.6) {
      reasons.push('good match');
    } else if (score > 0.4) {
      reasons.push('acceptable match');
    }

    return reasons.length > 0 ? reasons.join(', ') : 'default tier selection';
  }

  /**
   * Get current load for a tier
   */
  private async getCurrentLoad(tier: StorageTier): Promise<number> {
    // This would integrate with actual monitoring
    // For now, return a placeholder based on recent queries
    return this.metrics.queriesByTier.get(tier.name) || 0;
  }

  /**
   * Check if tier is within capacity limits
   */
  private async isWithinCapacity(tier: StorageTier): Promise<boolean> {
    try {
      const stats = await tier.adapter.getStats();

      if (tier.config.maxFrames && stats.totalFrames >= tier.config.maxFrames) {
        return false;
      }

      if (
        tier.config.maxSizeMB &&
        stats.diskUsage >= tier.config.maxSizeMB * 1024 * 1024
      ) {
        return false;
      }

      return true;
    } catch (error) {
      logger.warn(`Failed to check capacity for tier ${tier.name}:`, error);
      return true; // Assume capacity is OK if we can't check
    }
  }

  /**
   * Update routing metrics
   */
  private updateMetrics(
    tierName: string,
    startTime: number,
    success: boolean
  ): void {
    const duration = Date.now() - startTime;

    // Update tier metrics
    this.metrics.queriesByTier.set(
      tierName,
      (this.metrics.queriesByTier.get(tierName) || 0) + 1
    );

    if (success) {
      // Update latency
      const currentAvg = this.metrics.latencyByTier.get(tierName) || 0;
      const count = this.metrics.queriesByTier.get(tierName) || 1;
      const newAvg = (currentAvg * (count - 1) + duration) / count;
      this.metrics.latencyByTier.set(tierName, newAvg);

      // Update overall average
      this.metrics.averageLatency =
        (this.metrics.averageLatency * (this.metrics.totalQueries - 1) +
          duration) /
        this.metrics.totalQueries;
    } else {
      // Update error count
      this.metrics.errorsByTier.set(
        tierName,
        (this.metrics.errorsByTier.get(tierName) || 0) + 1
      );
    }
  }

  /**
   * Get current routing metrics
   */
  getMetrics(): QueryMetrics {
    // Update cache hit rate
    const cacheRequests = this.metrics.routingDecisions;
    const cacheHits = cacheRequests - this.decisionCache.size; // Approximation
    this.metrics.cacheHitRate =
      cacheRequests > 0 ? cacheHits / cacheRequests : 0;

    return { ...this.metrics };
  }

  /**
   * Get registered tiers
   */
  getTiers(): StorageTier[] {
    return Array.from(this.tiers.values()).sort(
      (a, b) => b.priority - a.priority
    );
  }

  /**
   * Clear routing decision cache
   */
  clearCache(): void {
    this.decisionCache.clear();
    logger.info('Routing decision cache cleared');
  }

  /**
   * Get tier by name
   */
  getTier(name: string): StorageTier | undefined {
    return this.tiers.get(name);
  }
}
