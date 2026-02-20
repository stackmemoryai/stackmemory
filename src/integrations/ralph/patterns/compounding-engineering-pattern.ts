/**
 * Compounding Engineering Pattern Implementation
 *
 * Transforms traditional engineering's diminishing returns into cumulative learning.
 * Each feature development improves future development capabilities.
 *
 * Core Philosophy: "Make the next feature easier to build from the feature that you just added."
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../../core/monitoring/logger.js';

export interface FeatureLearning {
  id: string;
  featureName: string;
  timestamp: number;
  developmentPhase: 'planning' | 'implementation' | 'testing' | 'deployment';

  // What worked well
  successes: {
    strategy: string;
    impact: 'high' | 'medium' | 'low';
    reusability: 'universal' | 'domain_specific' | 'feature_specific';
    description: string;
  }[];

  // What didn't work
  failures: {
    issue: string;
    cause: string;
    solution: string;
    prevention: string;
  }[];

  // Emerging patterns
  patterns: {
    name: string;
    context: string;
    solution: string;
    examples: string[];
  }[];

  // Agent improvements
  agentLearnings: {
    commonMistakes: string[];
    effectivePrompts: string[];
    toolUsagePatterns: string[];
    coordinationInsights: string[];
  };

  // Automation opportunities
  automationOpportunities: {
    task: string;
    frequency: 'always' | 'often' | 'sometimes';
    complexity: 'trivial' | 'simple' | 'complex';
    implementation: 'hook' | 'command' | 'subagent';
  }[];
}

export interface CompoundedKnowledge {
  totalFeatures: number;
  learningsByCategory: {
    planning: FeatureLearning[];
    implementation: FeatureLearning[];
    testing: FeatureLearning[];
    deployment: FeatureLearning[];
  };

  // Distilled wisdom
  bestPractices: {
    category: string;
    practice: string;
    evidence: string[];
    confidence: number;
  }[];

  // Generated artifacts
  automatedHooks: string[];
  specializedAgents: string[];
  customCommands: string[];

  // Metrics
  metrics: {
    developmentVelocityTrend: number[];
    errorRateReduction: number;
    codeReuseIncrease: number;
    onboardingTimeReduction: number;
  };
}

/**
 * Compounding Engineering Pattern Manager
 * Captures, processes, and compounds development learnings
 */
export class CompoundingEngineeringManager {
  private knowledgeBase: CompoundedKnowledge;
  private baseDir: string;
  private projectId: string;

  constructor(baseDir: string = './.compounding', projectId?: string) {
    this.baseDir = baseDir;
    this.projectId = projectId || 'default';
    this.knowledgeBase = {
      totalFeatures: 0,
      learningsByCategory: {
        planning: [],
        implementation: [],
        testing: [],
        deployment: [],
      },
      bestPractices: [],
      automatedHooks: [],
      specializedAgents: [],
      customCommands: [],
      metrics: {
        developmentVelocityTrend: [],
        errorRateReduction: 0,
        codeReuseIncrease: 0,
        onboardingTimeReduction: 0,
      },
    };
  }

  /**
   * Initialize the compounding system
   */
  async initialize(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
    await this.loadExistingKnowledge();
    logger.info('Compounding Engineering Manager initialized', {
      totalFeatures: this.knowledgeBase.totalFeatures,
      baseDir: this.baseDir,
    });
  }

  /**
   * Capture learning from a feature development session
   */
  async captureFeatureLearning(
    featureName: string,
    sessionData: any,
    agentOutputs: any[],
    userFeedback?: string
  ): Promise<string> {
    const learningId = uuidv4();

    logger.info('Capturing feature learning', {
      featureName,
      learningId,
      agentCount: agentOutputs.length,
    });

    // Analyze session for learnings
    const learning = await this.extractLearningsFromSession(
      learningId,
      featureName,
      sessionData,
      agentOutputs,
      userFeedback
    );

    // Store the learning
    await this.storeLearning(learning);

    // Update compounded knowledge
    await this.updateCompoundedKnowledge(learning);

    // Generate new artifacts if patterns emerge
    await this.generateArtifacts();

    return learningId;
  }

  /**
   * Extract actionable learnings from development session
   */
  private async extractLearningsFromSession(
    id: string,
    featureName: string,
    sessionData: any,
    agentOutputs: any[],
    userFeedback?: string
  ): Promise<FeatureLearning> {
    // Analyze what worked well
    const successes = this.identifySuccesses(sessionData, agentOutputs);

    // Analyze failures and resolutions
    const failures = this.identifyFailures(sessionData, agentOutputs);

    // Extract emerging patterns
    const patterns = this.extractPatterns(sessionData, agentOutputs);

    // Analyze agent behavior
    const agentLearnings = this.analyzeAgentBehavior(agentOutputs);

    // Identify automation opportunities
    const automationOpportunities = this.identifyAutomationOpportunities(
      sessionData,
      agentOutputs
    );

    return {
      id,
      featureName,
      timestamp: Date.now(),
      developmentPhase: this.inferDevelopmentPhase(sessionData),
      successes,
      failures,
      patterns,
      agentLearnings,
      automationOpportunities,
    };
  }

  /**
   * Identify what worked well in the session
   */
  private identifySuccesses(
    sessionData: any,
    agentOutputs: any[]
  ): FeatureLearning['successes'] {
    const successes = [];

    // Analyze successful agent strategies
    for (const output of agentOutputs) {
      if (output.success && output.strategy) {
        successes.push({
          strategy: output.strategy,
          impact: this.assessImpact(output),
          reusability: this.assessReusability(output),
          description: output.description || 'Successful agent execution',
        });
      }
    }

    // Analyze successful patterns in code
    if (sessionData.codePatterns) {
      for (const pattern of sessionData.codePatterns) {
        if (pattern.successful) {
          successes.push({
            strategy: `Code pattern: ${pattern.name}`,
            impact: 'high',
            reusability: 'universal',
            description: pattern.description,
          });
        }
      }
    }

    return successes;
  }

  /**
   * Identify failures and their resolutions
   */
  private identifyFailures(
    sessionData: any,
    agentOutputs: any[]
  ): FeatureLearning['failures'] {
    const failures = [];

    // Analyze agent failures
    for (const output of agentOutputs) {
      if (output.errors && output.errors.length > 0) {
        for (const error of output.errors) {
          failures.push({
            issue: error.message || 'Agent execution failed',
            cause: error.cause || 'Unknown cause',
            solution: error.resolution || 'Manual intervention required',
            prevention: this.generatePreventionStrategy(error),
          });
        }
      }
    }

    // Analyze build/test failures
    if (sessionData.buildErrors) {
      for (const error of sessionData.buildErrors) {
        failures.push({
          issue: `Build error: ${error.type}`,
          cause: error.details,
          solution: error.fix,
          prevention: 'Add pre-build validation hook',
        });
      }
    }

    return failures;
  }

  /**
   * Extract reusable patterns from the session
   */
  private extractPatterns(
    sessionData: any,
    agentOutputs: any[]
  ): FeatureLearning['patterns'] {
    const patterns = [];

    // Agent coordination patterns
    if (agentOutputs.length > 1) {
      const coordinationPattern = this.analyzeCoordinationPattern(agentOutputs);
      if (coordinationPattern) {
        patterns.push(coordinationPattern);
      }
    }

    // Code structure patterns
    if (sessionData.codeStructure) {
      const structurePattern = this.analyzeCodeStructurePattern(
        sessionData.codeStructure
      );
      if (structurePattern) {
        patterns.push(structurePattern);
      }
    }

    return patterns;
  }

  /**
   * Analyze agent behavior for improvements
   */
  private analyzeAgentBehavior(
    agentOutputs: any[]
  ): FeatureLearning['agentLearnings'] {
    const commonMistakes = [];
    const effectivePrompts = [];
    const toolUsagePatterns = [];
    const coordinationInsights = [];

    for (const output of agentOutputs) {
      // Common mistakes
      if (output.retries && output.retries.length > 0) {
        commonMistakes.push(...output.retries.map((r: any) => r.reason));
      }

      // Effective prompts
      if (output.success && output.promptUsed) {
        effectivePrompts.push(output.promptUsed);
      }

      // Tool usage
      if (output.toolsUsed) {
        toolUsagePatterns.push(...output.toolsUsed);
      }

      // Coordination
      if (output.coordination) {
        coordinationInsights.push(output.coordination.insight);
      }
    }

    return {
      commonMistakes: [...new Set(commonMistakes)],
      effectivePrompts: [...new Set(effectivePrompts)],
      toolUsagePatterns: [...new Set(toolUsagePatterns)],
      coordinationInsights: [...new Set(coordinationInsights)],
    };
  }

  /**
   * Identify tasks that can be automated
   */
  private identifyAutomationOpportunities(
    sessionData: any,
    agentOutputs: any[]
  ): FeatureLearning['automationOpportunities'] {
    const opportunities = [];

    // Repeated agent tasks
    const taskFrequency = this.analyzeTaskFrequency(agentOutputs);
    for (const [task, frequency] of Object.entries(taskFrequency)) {
      if (frequency > 2) {
        opportunities.push({
          task,
          frequency: 'often',
          complexity: 'simple',
          implementation: 'hook',
        });
      }
    }

    // Manual interventions
    if (sessionData.manualSteps) {
      for (const step of sessionData.manualSteps) {
        opportunities.push({
          task: step.description,
          frequency: 'sometimes',
          complexity: step.complexity || 'simple',
          implementation: 'command',
        });
      }
    }

    return opportunities;
  }

  /**
   * Update compounded knowledge with new learning
   */
  private async updateCompoundedKnowledge(
    learning: FeatureLearning
  ): Promise<void> {
    // Add to appropriate category
    this.knowledgeBase.learningsByCategory[learning.developmentPhase].push(
      learning
    );
    this.knowledgeBase.totalFeatures++;

    // Update best practices
    await this.updateBestPractices(learning);

    // Update metrics
    await this.updateMetrics(learning);

    // Save updated knowledge
    await this.saveKnowledge();
  }

  /**
   * Generate artifacts (hooks, commands, agents) from accumulated learnings
   */
  private async generateArtifacts(): Promise<void> {
    // Generate hooks from automation opportunities
    await this.generateHooks();

    // Generate specialized agents from patterns
    await this.generateSpecializedAgents();

    // Generate custom commands from repeated tasks
    await this.generateCustomCommands();
  }

  /**
   * Generate automation hooks
   */
  private async generateHooks(): Promise<void> {
    const allOpportunities = Object.values(
      this.knowledgeBase.learningsByCategory
    )
      .flat()
      .flatMap((learning) => learning.automationOpportunities)
      .filter((opp) => opp.implementation === 'hook');

    const hookCounts = new Map<string, number>();
    for (const opp of allOpportunities) {
      hookCounts.set(opp.task, (hookCounts.get(opp.task) || 0) + 1);
    }

    // Generate hooks for frequently occurring tasks
    for (const [task, count] of hookCounts) {
      if (count >= 3 && !this.knowledgeBase.automatedHooks.includes(task)) {
        await this.createHook(task);
        this.knowledgeBase.automatedHooks.push(task);
      }
    }
  }

  /**
   * Create an automation hook
   */
  private async createHook(task: string): Promise<void> {
    const hookName = task.replace(/\s+/g, '-').toLowerCase();
    const hookPath = path.join(this.baseDir, 'hooks', `${hookName}.ts`);

    await fs.mkdir(path.dirname(hookPath), { recursive: true });

    const hookContent = `
/**
 * Auto-generated hook for: ${task}
 * Generated by Compounding Engineering Pattern
 */

export async function ${hookName.replace(/-/g, '')}Hook() {
  // TODO: Implement automation for: ${task}
  console.log('Executing automated hook: ${task}');
}
    `;

    await fs.writeFile(hookPath, hookContent);
    logger.info('Generated automation hook', { task, hookPath });
  }

  /**
   * Load existing knowledge base
   */
  private async loadExistingKnowledge(): Promise<void> {
    const knowledgePath = path.join(this.baseDir, 'knowledge.json');

    try {
      const content = await fs.readFile(knowledgePath, 'utf-8');
      this.knowledgeBase = JSON.parse(content);
    } catch (error) {
      // No existing knowledge, start fresh
      logger.info('Starting fresh knowledge base');
    }
  }

  /**
   * Save knowledge base to disk
   */
  private async saveKnowledge(): Promise<void> {
    const knowledgePath = path.join(this.baseDir, 'knowledge.json');
    await fs.writeFile(
      knowledgePath,
      JSON.stringify(this.knowledgeBase, null, 2)
    );
  }

  /**
   * Get current compounding metrics
   */
  getCompoundingMetrics(): {
    totalFeatures: number;
    automationLevel: number;
    learningVelocity: number;
    knowledgeReuse: number;
  } {
    const totalLearnings = Object.values(
      this.knowledgeBase.learningsByCategory
    ).flat().length;

    const automationLevel =
      this.knowledgeBase.automatedHooks.length / Math.max(totalLearnings, 1);

    const recentLearnings =
      totalLearnings > 5 ? totalLearnings / 5 : totalLearnings;

    return {
      totalFeatures: this.knowledgeBase.totalFeatures,
      automationLevel,
      learningVelocity: recentLearnings,
      knowledgeReuse: this.knowledgeBase.bestPractices.length,
    };
  }

  // Helper methods
  private assessImpact(output: any): 'high' | 'medium' | 'low' {
    if (output.linesChanged > 100) return 'high';
    if (output.linesChanged > 20) return 'medium';
    return 'low';
  }

  private assessReusability(
    output: any
  ): 'universal' | 'domain_specific' | 'feature_specific' {
    if (output.pattern === 'generic') return 'universal';
    if (output.domain) return 'domain_specific';
    return 'feature_specific';
  }

  private generatePreventionStrategy(error: any): string {
    return `Add validation for: ${error.type || 'unknown error type'}`;
  }

  private inferDevelopmentPhase(
    sessionData: any
  ): 'planning' | 'implementation' | 'testing' | 'deployment' {
    if (sessionData.phase) return sessionData.phase;
    if (sessionData.testsRun) return 'testing';
    if (sessionData.codeGenerated) return 'implementation';
    return 'planning';
  }

  private analyzeCoordinationPattern(agentOutputs: any[]): any {
    return {
      name: 'Multi-agent coordination',
      context: `${agentOutputs.length} agents worked together`,
      solution: 'Successful multi-agent coordination pattern',
      examples: agentOutputs.map((a) => a.role || 'unknown'),
    };
  }

  private analyzeCodeStructurePattern(structure: any): any {
    return {
      name: 'Code structure pattern',
      context: structure.type,
      solution: structure.pattern,
      examples: structure.examples || [],
    };
  }

  private analyzeTaskFrequency(agentOutputs: any[]): Record<string, number> {
    const frequency: Record<string, number> = {};
    for (const output of agentOutputs) {
      if (output.task) {
        frequency[output.task] = (frequency[output.task] || 0) + 1;
      }
    }
    return frequency;
  }

  private async updateBestPractices(learning: FeatureLearning): Promise<void> {
    // Extract best practices from successes
    for (const success of learning.successes) {
      if (success.impact === 'high' && success.reusability === 'universal') {
        const existing = this.knowledgeBase.bestPractices.find(
          (bp) => bp.practice === success.strategy
        );

        if (existing) {
          existing.evidence.push(learning.featureName);
          existing.confidence = Math.min(existing.confidence + 0.1, 1.0);
        } else {
          this.knowledgeBase.bestPractices.push({
            category: learning.developmentPhase,
            practice: success.strategy,
            evidence: [learning.featureName],
            confidence: 0.7,
          });
        }
      }
    }
  }

  private async updateMetrics(learning: FeatureLearning): Promise<void> {
    // Update development velocity trend
    const velocityScore = learning.successes.length - learning.failures.length;
    this.knowledgeBase.metrics.developmentVelocityTrend.push(velocityScore);

    // Keep only last 10 measurements
    if (this.knowledgeBase.metrics.developmentVelocityTrend.length > 10) {
      this.knowledgeBase.metrics.developmentVelocityTrend.shift();
    }
  }

  private async generateSpecializedAgents(): Promise<void> {
    // Implementation for generating specialized agents from patterns
  }

  private async generateCustomCommands(): Promise<void> {
    // Implementation for generating custom commands from repeated tasks
  }
}

export default CompoundingEngineeringManager;
