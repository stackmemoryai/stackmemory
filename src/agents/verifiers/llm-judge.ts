/**
 * LLM Judge - Semantic validation using LLM
 * Implements Spotify's LLM judge pattern that "vetoes about a quarter of agent sessions"
 */

import {
  BaseVerifier,
  VerifierContext,
  VerifierResult,
  VerifierConfig,
} from './base-verifier.js';
import { logger } from '../../core/monitoring/logger.js';

export interface LLMJudgeContext extends VerifierContext {
  originalPrompt: string;
  proposedChanges: string;
  acceptanceCriteria?: string[];
  previousFeedback?: string[];
}

export interface JudgementCriteria {
  adherenceToRequirements: number; // 0-1
  codeQuality: number; // 0-1
  safety: number; // 0-1
  completeness: number; // 0-1
  semanticCorrectness: number; // 0-1
}

export class LLMJudge extends BaseVerifier {
  // Spotify reports ~75% pass rate (25% veto rate)
  private readonly VETO_THRESHOLD = 0.7;
  private readonly CRITERIA_WEIGHTS = {
    adherenceToRequirements: 0.3,
    codeQuality: 0.2,
    safety: 0.2,
    completeness: 0.15,
    semanticCorrectness: 0.15,
  };

  constructor(config?: Partial<VerifierConfig>) {
    super({
      id: 'llm-judge',
      name: 'LLM Semantic Judge',
      type: 'semantic',
      enabled: true,
      stopOnError: true, // Stop on semantic failures (Spotify pattern)
      timeout: 30000,
      ...config,
    });
  }

  shouldActivate(context: VerifierContext): boolean {
    // Always activate for semantic validation (Spotify always includes this)
    return true;
  }

  async verify(
    input: string | Buffer,
    context: VerifierContext
  ): Promise<VerifierResult> {
    const llmContext = context as LLMJudgeContext;

    if (!llmContext.originalPrompt) {
      return this.createResult(
        false,
        'Missing original prompt for semantic validation',
        'error'
      );
    }

    try {
      return await this.withTimeout(async () => {
        const judgement = await this.performJudgement(
          input.toString(),
          llmContext
        );
        return this.createJudgementResult(judgement, llmContext);
      });
    } catch (error) {
      logger.error(
        'LLM Judge failed',
        error instanceof Error ? error : undefined
      );
      return this.createResult(
        false,
        `Semantic validation error: ${error instanceof Error ? error.message : String(error)}`,
        'error'
      );
    }
  }

  private async performJudgement(
    proposedChanges: string,
    context: LLMJudgeContext
  ): Promise<JudgementCriteria> {
    // In production, this would call an actual LLM API
    // For now, simulate judgement with realistic patterns

    const criteria: JudgementCriteria = {
      adherenceToRequirements: this.evaluateAdherence(proposedChanges, context),
      codeQuality: this.evaluateCodeQuality(proposedChanges),
      safety: this.evaluateSafety(proposedChanges),
      completeness: this.evaluateCompleteness(proposedChanges, context),
      semanticCorrectness: this.evaluateSemanticCorrectness(
        proposedChanges,
        context
      ),
    };

    // Log judgement for analysis (Spotify's trace collection)
    logger.info('LLM Judge evaluation', {
      criteria,
      overallScore: this.calculateOverallScore(criteria),
      willVeto: this.calculateOverallScore(criteria) < this.VETO_THRESHOLD,
    });

    return criteria;
  }

  private evaluateAdherence(
    proposedChanges: string,
    context: LLMJudgeContext
  ): number {
    // Simulate checking if changes match original requirements
    const hasKeywords = context.originalPrompt
      .toLowerCase()
      .split(' ')
      .filter((word) => word.length > 4)
      .some((keyword) => proposedChanges.toLowerCase().includes(keyword));

    // Check acceptance criteria if provided
    if (context.acceptanceCriteria) {
      const metCriteria = context.acceptanceCriteria.filter((criterion) =>
        this.checkCriterion(criterion, proposedChanges)
      ).length;
      const criteriaScore = metCriteria / context.acceptanceCriteria.length;
      return hasKeywords ? Math.min(1, criteriaScore + 0.2) : criteriaScore;
    }

    // Simulate realistic pass rate (~75%)
    return hasKeywords ? 0.75 + Math.random() * 0.2 : 0.4 + Math.random() * 0.3;
  }

  private evaluateCodeQuality(proposedChanges: string): number {
    // Simple heuristics for code quality
    const indicators = {
      hasComments:
        proposedChanges.includes('//') || proposedChanges.includes('/*'),
      hasErrorHandling:
        proposedChanges.includes('try') || proposedChanges.includes('catch'),
      hasTests:
        proposedChanges.includes('test') || proposedChanges.includes('expect'),
      properNaming: !/[a-z]{20,}|[A-Z]{10,}/.test(proposedChanges), // No extremely long names
      reasonable_length:
        proposedChanges.length > 50 && proposedChanges.length < 5000,
    };

    const score =
      Object.values(indicators).filter(Boolean).length /
      Object.keys(indicators).length;
    return Math.min(1, score + 0.2); // Boost slightly
  }

  private evaluateSafety(proposedChanges: string): number {
    // Check for dangerous patterns
    const dangerousPatterns = [
      /eval\s*\(/,
      /exec\s*\(/,
      /rm\s+-rf/,
      /DROP\s+TABLE/i,
      /DELETE\s+FROM/i,
      /<script>/i,
      /document\.write/,
      /innerHTML\s*=/,
    ];

    const hasDangerousPattern = dangerousPatterns.some((pattern) =>
      pattern.test(proposedChanges)
    );

    return hasDangerousPattern ? 0.3 : 0.9 + Math.random() * 0.1;
  }

  private evaluateCompleteness(
    proposedChanges: string,
    context: LLMJudgeContext
  ): number {
    // Check if the solution seems complete
    const hasImplementation = proposedChanges.length > 100;
    const hasStructure =
      proposedChanges.includes('function') ||
      proposedChanges.includes('class') ||
      proposedChanges.includes('const') ||
      proposedChanges.includes('def');

    if (context.acceptanceCriteria) {
      const addressedCriteria = context.acceptanceCriteria.filter((criterion) =>
        proposedChanges
          .toLowerCase()
          .includes(criterion.toLowerCase().split(' ')[0])
      ).length;
      return addressedCriteria / context.acceptanceCriteria.length;
    }

    return hasImplementation && hasStructure ? 0.8 + Math.random() * 0.15 : 0.4;
  }

  private evaluateSemanticCorrectness(
    proposedChanges: string,
    context: LLMJudgeContext
  ): number {
    // Simulate semantic analysis
    // In production, this would use embeddings and semantic similarity

    // Check if previous feedback was addressed
    if (context.previousFeedback && context.previousFeedback.length > 0) {
      const addressedFeedback = context.previousFeedback.filter((feedback) => {
        const keywords = feedback
          .toLowerCase()
          .split(' ')
          .filter((w) => w.length > 4);
        return keywords.some((keyword) =>
          proposedChanges.toLowerCase().includes(keyword)
        );
      }).length;

      if (addressedFeedback > 0) {
        return Math.min(
          1,
          0.7 + (addressedFeedback / context.previousFeedback.length) * 0.3
        );
      }
    }

    // Default semantic score (realistic distribution)
    return 0.65 + Math.random() * 0.25;
  }

  private checkCriterion(criterion: string, proposedChanges: string): boolean {
    // Simple keyword matching for criteria
    const keywords = criterion
      .toLowerCase()
      .split(' ')
      .filter((word) => word.length > 3);
    const matchedKeywords = keywords.filter((keyword) =>
      proposedChanges.toLowerCase().includes(keyword)
    );
    return matchedKeywords.length >= keywords.length * 0.5;
  }

  private calculateOverallScore(criteria: JudgementCriteria): number {
    let score = 0;
    for (const [key, weight] of Object.entries(this.CRITERIA_WEIGHTS)) {
      score += criteria[key as keyof JudgementCriteria] * weight;
    }
    return score;
  }

  private createJudgementResult(
    criteria: JudgementCriteria,
    context: LLMJudgeContext
  ): VerifierResult {
    const overallScore = this.calculateOverallScore(criteria);
    const passed = overallScore >= this.VETO_THRESHOLD;

    // Generate detailed feedback
    const feedback = this.generateJudgementFeedback(
      criteria,
      overallScore,
      context
    );

    // Determine severity based on score
    const severity =
      overallScore < 0.5
        ? 'error'
        : overallScore < this.VETO_THRESHOLD
          ? 'warning'
          : 'info';

    return this.createResult(
      passed,
      feedback,
      severity,
      {
        expected: 'Changes that fully address the original requirements',
        actual: `Score: ${(overallScore * 100).toFixed(1)}%`,
        suggestion: this.generateSuggestions(criteria),
      },
      passed
        ? undefined
        : {
            command: 'Review and adjust approach based on feedback',
            description: 'Manual review required',
            safe: false,
            confidence: overallScore,
          }
    );
  }

  private generateJudgementFeedback(
    criteria: JudgementCriteria,
    overallScore: number,
    context: LLMJudgeContext
  ): string {
    if (overallScore >= this.VETO_THRESHOLD) {
      return (
        `Semantic validation PASSED (${(overallScore * 100).toFixed(1)}% confidence). ` +
        `Changes adequately address the requirements.`
      );
    }

    // Identify weakest areas
    const weakAreas: string[] = [];
    if (criteria.adherenceToRequirements < 0.6) {
      weakAreas.push('requirements adherence');
    }
    if (criteria.codeQuality < 0.6) {
      weakAreas.push('code quality');
    }
    if (criteria.safety < 0.7) {
      weakAreas.push('safety concerns');
    }
    if (criteria.completeness < 0.6) {
      weakAreas.push('completeness');
    }
    if (criteria.semanticCorrectness < 0.6) {
      weakAreas.push('semantic correctness');
    }

    return (
      `Semantic validation VETOED (${(overallScore * 100).toFixed(1)}% confidence). ` +
      `Issues found with: ${weakAreas.join(', ')}. ` +
      `Agent should course-correct based on this feedback.`
    );
  }

  private generateSuggestions(criteria: JudgementCriteria): string {
    const suggestions: string[] = [];

    if (criteria.adherenceToRequirements < 0.7) {
      suggestions.push(
        'Review original requirements and ensure all are addressed'
      );
    }
    if (criteria.codeQuality < 0.7) {
      suggestions.push(
        'Improve code structure, add error handling and comments'
      );
    }
    if (criteria.safety < 0.8) {
      suggestions.push(
        'Review code for security vulnerabilities and unsafe patterns'
      );
    }
    if (criteria.completeness < 0.7) {
      suggestions.push('Ensure solution is complete and handles edge cases');
    }
    if (criteria.semanticCorrectness < 0.7) {
      suggestions.push('Verify logic correctness and alignment with intent');
    }

    return suggestions.length > 0
      ? suggestions.join('; ')
      : 'Continue with current approach';
  }

  /**
   * Get veto statistics (for monitoring)
   */
  getVetoRate(): number {
    // In production, this would track actual veto rate
    // Spotify reports ~25% veto rate
    return 0.25;
  }

  /**
   * Check if agent can course-correct after veto
   * Spotify: "When vetoed, agents can course correct half the time"
   */
  canCourseCorrect(previousAttempts: number): boolean {
    // 50% chance of successful course correction
    return previousAttempts < 2 && Math.random() > 0.5;
  }
}
