/**
 * MCP Integration with Attention-Based Importance Scoring
 * 
 * Automatically tracks what context Claude actually uses
 * and learns importance over time
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import AttentionTracker, { ContextItem } from './attention-tracker';
import { TeamContextManager } from '../../p2p-sync/src/team-context-sync';

// ============================================
// Smart MCP Server with Attention Tracking
// ============================================

export class SmartStackMemoryMCP {
  private server: Server;
  private attentionTracker: AttentionTracker;
  private teamContext: TeamContextManager;
  private activeProvisions: Map<string, string> = new Map();

  constructor(config: MCPConfig) {
    // Initialize attention tracking
    this.attentionTracker = new AttentionTracker(
      `.stackmemory/${config.projectId}/attention.db`
    );

    // Initialize team context
    this.teamContext = new TeamContextManager({
      projectId: config.projectId,
      teamId: config.teamId,
      userId: config.userId
    });

    // Setup MCP server
    this.server = new Server({
      name: 'stackmemory-smart',
      version: '2.0.0'
    }, {
      capabilities: {
        tools: {},
        resources: {}
      }
    });

    this.setupHandlers();
    this.setupLearningLoop();
  }

  // ============================================
  // MCP Request Handlers
  // ============================================

  private setupHandlers() {
    // Main context retrieval with attention tracking
    this.server.setRequestHandler('tools/call', async (request) => {
      if (request.params.name === 'get_context') {
        return this.getSmartContext(request.params.arguments);
      }
      
      // Other tool handlers...
      return { content: [] };
    });

    // Feedback handler for reinforcement learning
    this.server.setRequestHandler('feedback', async (request) => {
      const { responseId, helpful } = request.params;
      await this.attentionTracker.reinforcementUpdate({
        responseId,
        helpful
      });
      return { success: true };
    });
  }

  // ============================================
  // Smart Context Assembly
  // ============================================

  private async getSmartContext(params: any): Promise<any> {
    const { query, tokenBudget = 8000 } = params;
    
    // Start tracking this provision
    const provision = this.attentionTracker.startProvision(query);
    
    // Get base context from team system
    const baseContext = await this.teamContext.getContextBundle(query, tokenBudget);
    
    // Enhance with learned importance scores
    const enhancedContext = await this.enhanceWithAttention(baseContext, provision);
    
    // Track the provision and get response
    const trackedResponse = await provision.execute(async (contexts) => {
      // Format for Claude
      return this.formatForClaude(enhancedContext);
    });
    
    // Store provision ID for later feedback
    this.activeProvisions.set(query, trackedResponse.responseId);
    
    return {
      content: [{
        type: 'text',
        text: trackedResponse.response
      }],
      metadata: {
        responseId: trackedResponse.responseId,
        contextsUsed: trackedResponse.contextsUsed,
        latency: trackedResponse.latency
      }
    };
  }

  // ============================================
  // Attention-Based Enhancement
  // ============================================

  private async enhanceWithAttention(
    baseContext: any,
    provision: any
  ): Promise<EnhancedContext> {
    const enhanced: EnhancedContext = {
      items: [],
      totalTokens: 0,
      metadata: {
        enhanced: true,
        timestamp: Date.now()
      }
    };

    // Process shared context with importance scores
    for (const ctx of baseContext.shared) {
      const importance = this.attentionTracker.getImportanceScore(ctx.id || this.hashContext(ctx));
      
      const item: ContextItem = {
        id: ctx.id || this.hashContext(ctx),
        type: 'shared',
        content: ctx.content,
        tokenCount: this.estimateTokens(ctx.content),
        importance: importance
      };
      
      // Add to provision tracking
      provision.add(item);
      
      // Only include if importance above threshold
      if (importance > 0.3) {
        enhanced.items.push({
          ...ctx,
          importance,
          influenceHistory: await this.getInfluenceHistory(item.id)
        });
        enhanced.totalTokens += item.tokenCount;
      }
    }

    // Get recommended additional context based on patterns
    const recommendations = this.attentionTracker.getRecommendedContext(
      provision.query,
      enhanced.items.map(i => i.id)
    );

    // Add recommended contexts if budget allows
    for (const recId of recommendations) {
      const recContext = await this.loadContext(recId);
      if (recContext && enhanced.totalTokens + recContext.tokenCount < 6000) {
        provision.add(recContext);
        enhanced.items.push({
          ...recContext,
          recommended: true,
          importance: this.attentionTracker.getImportanceScore(recId)
        });
        enhanced.totalTokens += recContext.tokenCount;
      }
    }

    // Sort by importance (most important first)
    enhanced.items.sort((a, b) => (b.importance || 0) - (a.importance || 0));

    return enhanced;
  }

  // ============================================
  // Learning Loop
  // ============================================

  private setupLearningLoop() {
    // Periodic analysis of patterns
    setInterval(() => {
      this.analyzePatterns();
    }, 3600000); // Every hour

    // Real-time importance updates
    this.attentionTracker.on('importance-updated', (event) => {
      console.log(`Context ${event.contextId} importance: ${event.importance.toFixed(3)}`);
      
      // Could trigger re-ranking of active context
      this.updateActiveContext(event.contextId, event.importance);
    });
  }

  private async analyzePatterns() {
    // Get top performing context combinations
    const rankings = this.attentionTracker.getContextRanking();
    
    console.log('=== Attention Analysis ===');
    console.log('Top influential contexts:');
    rankings.slice(0, 10).forEach((r, i) => {
      console.log(`${i + 1}. ${r.contextId}: ${(r.importance * 100).toFixed(1)}% (used ${r.influenceRate.toFixed(2)} influence rate)`);
    });

    // Identify underutilized important contexts
    const underutilized = rankings.filter(r => 
      r.importance > 0.7 && r.influenceRate < 0.3
    );

    if (underutilized.length > 0) {
      console.log('\nUnderutilized important contexts:');
      underutilized.forEach(u => {
        console.log(`- ${u.contextId}: High importance but low usage`);
      });
    }

    // Generate attention heatmap
    const heatmap = this.attentionTracker.getAttentionHeatmap();
    this.visualizeHeatmap(heatmap);
  }

  // ============================================
  // Visualization
  // ============================================

  private visualizeHeatmap(heatmap: any) {
    // Create ASCII visualization of attention patterns
    console.log('\n=== Attention Heatmap ===');
    console.log('Position in context vs Influence:');
    
    const maxInfluence = Math.max(...heatmap.influences);
    const scale = 10;
    
    heatmap.positions.forEach((pos, i) => {
      const influence = heatmap.influences[i];
      const bars = Math.round((influence / maxInfluence) * scale);
      const bar = '█'.repeat(bars) + '░'.repeat(scale - bars);
      console.log(`Pos ${String(pos).padStart(2)}: ${bar} ${(influence * 100).toFixed(1)}%`);
    });
  }

  // ============================================
  // Real-time Context Updates
  // ============================================

  private updateActiveContext(contextId: string, newImportance: number) {
    // If context importance drops below threshold, remove from active
    if (newImportance < 0.2) {
      console.log(`Removing low-importance context: ${contextId}`);
      // Would trigger context refresh in active sessions
    }
    
    // If context importance rises above threshold, promote
    if (newImportance > 0.8) {
      console.log(`Promoting high-importance context: ${contextId}`);
      // Would add to priority context
    }
  }

  // ============================================
  // Formatting & Utilities
  // ============================================

  private formatForClaude(context: EnhancedContext): string {
    let output = '# Team Context (Attention-Weighted)\n\n';
    
    // Group by type and importance
    const grouped = this.groupByType(context.items);
    
    for (const [type, items] of Object.entries(grouped)) {
      output += `## ${this.formatType(type)}\n\n`;
      
      items.forEach(item => {
        const importanceBar = this.getImportanceBar(item.importance || 0.5);
        const flag = item.recommended ? ' [AI-RECOMMENDED]' : '';
        output += `${importanceBar} ${item.content}${flag}\n`;
        
        if (item.influenceHistory && item.influenceHistory.length > 0) {
          output += `   ↳ Previously influenced: ${item.influenceHistory.join(', ')}\n`;
        }
      });
      
      output += '\n';
    }
    
    // Add metadata
    output += `\n---\n`;
    output += `Contexts: ${context.items.length} | Tokens: ~${context.totalTokens}\n`;
    output += `Enhanced with attention-based importance scoring\n`;
    
    return output;
  }

  private getImportanceBar(importance: number): string {
    if (importance >= 0.8) return '🔴'; // Critical
    if (importance >= 0.6) return '🟠'; // Important
    if (importance >= 0.4) return '🟡'; // Normal
    return '⚪'; // Low
  }

  private groupByType(items: any[]): Record<string, any[]> {
    const grouped: Record<string, any[]> = {};
    items.forEach(item => {
      const type = item.type || 'other';
      if (!grouped[type]) grouped[type] = [];
      grouped[type].push(item);
    });
    return grouped;
  }

  private formatType(type: string): string {
    const typeMap: Record<string, string> = {
      'decision': '🎯 Decisions',
      'constraint': '⚠️ Constraints',
      'shared': '👥 Team Context',
      'personal': '📝 Personal Notes',
      'knowledge': '📚 Project Knowledge'
    };
    return typeMap[type] || type;
  }

  private hashContext(ctx: any): string {
    const crypto = require('crypto');
    return crypto.createHash('sha256')
      .update(JSON.stringify(ctx))
      .digest('hex')
      .substring(0, 16);
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private async getInfluenceHistory(contextId: string): Promise<string[]> {
    // Get last 3 significant influences
    // In production, query from attention_signals table
    return [];
  }

  private async loadContext(contextId: string): Promise<ContextItem | null> {
    // Load context from main storage
    // This would connect to your team context or local storage
    return null;
  }

  // ============================================
  // Startup
  // ============================================

  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    
    console.log('Smart StackMemory MCP Server started');
    console.log('Attention tracking enabled');
    console.log('Learning from usage patterns...');
  }
}

// ============================================
// Dashboard for Attention Analytics
// ============================================

export class AttentionDashboard {
  constructor(private tracker: AttentionTracker) {}

  async generateReport(): Promise<AttentionReport> {
    const rankings = this.tracker.getContextRanking();
    const heatmap = this.tracker.getAttentionHeatmap();
    
    // Calculate statistics
    const totalContexts = rankings.length;
    const avgImportance = rankings.reduce((sum, r) => sum + r.importance, 0) / totalContexts;
    const highInfluence = rankings.filter(r => r.avgInfluence > 0.7).length;
    
    // Identify patterns
    const alwaysUseful = rankings.filter(r => r.influenceRate > 0.8);
    const neverUseful = rankings.filter(r => r.influenceRate < 0.1 && r.importance < 0.3);
    
    return {
      summary: {
        totalContexts,
        avgImportance,
        highInfluenceCount: highInfluence,
        lastUpdated: Date.now()
      },
      topContexts: rankings.slice(0, 20),
      alwaysUseful,
      neverUseful,
      heatmap,
      recommendations: this.generateRecommendations(rankings)
    };
  }

  private generateRecommendations(rankings: any[]): string[] {
    const recs: string[] = [];
    
    // Find contexts that should be promoted
    const undervalued = rankings.filter(r => 
      r.avgInfluence > 0.7 && r.importance < 0.5
    );
    if (undervalued.length > 0) {
      recs.push(`Promote ${undervalued.length} undervalued contexts with high influence`);
    }
    
    // Find contexts that should be demoted
    const overvalued = rankings.filter(r => 
      r.avgInfluence < 0.2 && r.importance > 0.7
    );
    if (overvalued.length > 0) {
      recs.push(`Consider demoting ${overvalued.length} contexts with low actual influence`);
    }
    
    return recs;
  }
}

// ============================================
// Types
// ============================================

interface MCPConfig {
  projectId: string;
  teamId: string;
  userId: string;
}

interface EnhancedContext {
  items: Array<any>;
  totalTokens: number;
  metadata: {
    enhanced: boolean;
    timestamp: number;
  };
}

interface AttentionReport {
  summary: {
    totalContexts: number;
    avgImportance: number;
    highInfluenceCount: number;
    lastUpdated: number;
  };
  topContexts: any[];
  alwaysUseful: any[];
  neverUseful: any[];
  heatmap: any;
  recommendations: string[];
}

// ============================================
// CLI Usage
// ============================================

if (require.main === module) {
  const config = {
    projectId: process.env.PROJECT_ID || 'default',
    teamId: process.env.TEAM_ID || 'default',
    userId: process.env.USER_ID || 'default'
  };
  
  const server = new SmartStackMemoryMCP(config);
  server.start().catch(console.error);
}