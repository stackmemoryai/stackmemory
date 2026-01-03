/**
 * Workflow Templates for StackMemory
 * Inspired by Continuous-Claude's structured approach
 *
 * Each workflow auto-creates child frames for phases
 * and enforces completion gates between transitions
 */

import { Frame } from '../types';
import { FrameManager } from './frame-manager';

export interface WorkflowPhase {
  name: string;
  requiredOutputs?: string[];
  validationRules?: ((frame: Frame) => boolean)[];
  autoTransition?: boolean;
}

export interface WorkflowTemplate {
  name: string;
  description: string;
  phases: WorkflowPhase[];
  metadata?: Record<string, any>;
}

export class WorkflowTemplates {
  private frameManager: FrameManager;

  constructor(frameManager: FrameManager) {
    this.frameManager = frameManager;
  }

  /**
   * TDD Workflow: Red → Green → Refactor
   */
  static TDD: WorkflowTemplate = {
    name: 'tdd',
    description: 'Test-Driven Development workflow',
    phases: [
      {
        name: 'write-failing-tests',
        requiredOutputs: ['test_file', 'test_count'],
        validationRules: [(frame) => frame.metadata?.tests_failing === true],
      },
      {
        name: 'implement-minimal',
        requiredOutputs: ['implementation_file'],
        validationRules: [(frame) => frame.metadata?.tests_passing === true],
      },
      {
        name: 'refactor',
        requiredOutputs: ['refactored_files'],
        validationRules: [
          (frame) => frame.metadata?.tests_passing === true,
          (frame) => frame.metadata?.complexity_reduced === true,
        ],
        autoTransition: true,
      },
    ],
  };

  /**
   * Feature Development Workflow
   */
  static FEATURE: WorkflowTemplate = {
    name: 'feature',
    description: 'Feature development workflow',
    phases: [
      {
        name: 'research',
        requiredOutputs: ['requirements', 'constraints', 'dependencies'],
        validationRules: [
          (frame) => frame.metadata?.research_complete === true,
        ],
      },
      {
        name: 'design',
        requiredOutputs: ['architecture_decision', 'api_design'],
        validationRules: [(frame) => frame.metadata?.design_reviewed === true],
      },
      {
        name: 'implement',
        requiredOutputs: ['implementation_files', 'tests'],
        validationRules: [
          (frame) => frame.metadata?.tests_passing === true,
          (frame) => frame.metadata?.lint_passing === true,
        ],
      },
      {
        name: 'validate',
        requiredOutputs: ['test_results', 'performance_metrics'],
        validationRules: [
          (frame) => frame.metadata?.validation_complete === true,
        ],
        autoTransition: true,
      },
    ],
  };

  /**
   * Bug Fix Workflow
   */
  static BUGFIX: WorkflowTemplate = {
    name: 'bugfix',
    description: 'Bug fixing workflow',
    phases: [
      {
        name: 'reproduce',
        requiredOutputs: ['reproduction_steps', 'failing_test'],
        validationRules: [(frame) => frame.metadata?.bug_reproduced === true],
      },
      {
        name: 'diagnose',
        requiredOutputs: ['root_cause', 'affected_code'],
        validationRules: [(frame) => frame.metadata?.cause_identified === true],
      },
      {
        name: 'fix',
        requiredOutputs: ['fix_commits', 'updated_tests'],
        validationRules: [(frame) => frame.metadata?.fix_applied === true],
      },
      {
        name: 'verify',
        requiredOutputs: ['verification_results', 'regression_tests'],
        validationRules: [
          (frame) => frame.metadata?.bug_fixed === true,
          (frame) => frame.metadata?.no_regressions === true,
        ],
        autoTransition: true,
      },
    ],
  };

  /**
   * Refactoring Workflow
   */
  static REFACTOR: WorkflowTemplate = {
    name: 'refactor',
    description: 'Code refactoring workflow',
    phases: [
      {
        name: 'analyze',
        requiredOutputs: [
          'code_metrics',
          'smell_detection',
          'complexity_report',
        ],
        validationRules: [
          (frame) => frame.metadata?.analysis_complete === true,
        ],
      },
      {
        name: 'plan',
        requiredOutputs: ['refactor_plan', 'risk_assessment'],
        validationRules: [(frame) => frame.metadata?.plan_approved === true],
      },
      {
        name: 'refactor',
        requiredOutputs: ['refactored_code', 'preserved_tests'],
        validationRules: [(frame) => frame.metadata?.tests_passing === true],
      },
      {
        name: 'validate',
        requiredOutputs: ['before_after_metrics', 'performance_comparison'],
        validationRules: [
          (frame) => frame.metadata?.metrics_improved === true,
          (frame) => frame.metadata?.behavior_preserved === true,
        ],
        autoTransition: true,
      },
    ],
  };

  /**
   * Start a workflow, creating the parent frame and first phase frame
   */
  async startWorkflow(
    template: WorkflowTemplate,
    parentFrameId?: string
  ): Promise<Frame> {
    // Create parent workflow frame
    const workflowFrame = await this.frameManager.push(
      {
        type: 'workflow',
        description: `${template.name} workflow`,
        metadata: {
          workflow: template.name,
          current_phase: 0,
          phases: template.phases.map((p) => p.name),
          started_at: new Date().toISOString(),
        },
      },
      parentFrameId
    );

    // Auto-create first phase frame
    await this.startPhase(workflowFrame.id, 0);

    return workflowFrame;
  }

  /**
   * Transition to next phase if current phase is complete
   */
  async transitionPhase(frameId: string): Promise<boolean> {
    const frame = await this.frameManager.getFrame(frameId);
    if (!frame || frame.type !== 'workflow') return false;

    const currentPhase = frame.metadata?.current_phase || 0;
    const template = this.getTemplate(frame.metadata?.workflow);
    if (!template) return false;

    // Validate current phase completion
    const phaseFrame = await this.getCurrentPhaseFrame(frameId);
    if (!phaseFrame) return false;

    const phase = template.phases[currentPhase];
    const isComplete = await this.validatePhase(phaseFrame, phase);

    if (!isComplete) {
      console.log(`Phase ${phase.name} validation failed`);
      return false;
    }

    // Close current phase frame
    await this.frameManager.close(phaseFrame.id, {
      completed: true,
      phase: phase.name,
    });

    // Check if workflow is complete
    if (currentPhase >= template.phases.length - 1) {
      await this.frameManager.close(frameId, {
        workflow_complete: true,
        completed_at: new Date().toISOString(),
      });
      return true;
    }

    // Start next phase
    await this.frameManager.updateMetadata(frameId, {
      current_phase: currentPhase + 1,
    });
    await this.startPhase(frameId, currentPhase + 1);

    return true;
  }

  /**
   * Start a specific phase within a workflow
   */
  private async startPhase(
    workflowFrameId: string,
    phaseIndex: number
  ): Promise<Frame> {
    const frame = await this.frameManager.getFrame(workflowFrameId);
    const template = this.getTemplate(frame?.metadata?.workflow);
    if (!template || phaseIndex >= template.phases.length) {
      throw new Error('Invalid phase index');
    }

    const phase = template.phases[phaseIndex];
    return await this.frameManager.push(
      {
        type: 'phase',
        description: `Phase: ${phase.name}`,
        metadata: {
          phase_name: phase.name,
          phase_index: phaseIndex,
          required_outputs: phase.requiredOutputs,
          started_at: new Date().toISOString(),
        },
      },
      workflowFrameId
    );
  }

  /**
   * Validate a phase frame against its requirements
   */
  private async validatePhase(
    frame: Frame,
    phase: WorkflowPhase
  ): Promise<boolean> {
    // Check required outputs
    if (phase.requiredOutputs) {
      for (const output of phase.requiredOutputs) {
        if (!frame.metadata?.[output]) {
          return false;
        }
      }
    }

    // Run validation rules
    if (phase.validationRules) {
      for (const rule of phase.validationRules) {
        if (!rule(frame)) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Get current phase frame for a workflow
   */
  private async getCurrentPhaseFrame(
    workflowFrameId: string
  ): Promise<Frame | null> {
    const children = await this.frameManager.getChildren(workflowFrameId);
    return (
      children.find((f) => f.type === 'phase' && f.status === 'open') || null
    );
  }

  /**
   * Get template by name
   */
  private getTemplate(name?: string): WorkflowTemplate | null {
    if (!name) return null;

    const templates: Record<string, WorkflowTemplate> = {
      tdd: WorkflowTemplates.TDD,
      feature: WorkflowTemplates.FEATURE,
      bugfix: WorkflowTemplates.BUGFIX,
      refactor: WorkflowTemplates.REFACTOR,
    };

    return templates[name] || null;
  }

  /**
   * List available workflow templates
   */
  static listTemplates(): WorkflowTemplate[] {
    return [
      WorkflowTemplates.TDD,
      WorkflowTemplates.FEATURE,
      WorkflowTemplates.BUGFIX,
      WorkflowTemplates.REFACTOR,
    ];
  }
}
