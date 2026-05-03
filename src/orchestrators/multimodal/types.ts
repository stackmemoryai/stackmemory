export interface PlanningInput {
  task: string;
  repoPath: string;
  contextNotes?: string;
}

export interface PlanStep {
  id: string;
  title: string;
  rationale: string;
  acceptanceCriteria: string[];
}

export interface ImplementationPlan {
  summary: string;
  steps: PlanStep[];
  risks?: string[];
}

export interface CritiqueResult {
  approved: boolean;
  issues: string[];
  suggestions: string[];
}

export interface VerificationCommandResult {
  command: string;
  ok: boolean;
  output: string;
}

export interface PostImplementationChecks {
  lintOk: boolean;
  lintOutput: string;
  testsOk: boolean;
  testOutput: string;
  verifications: VerificationCommandResult[];
}

export interface HarnessOptions {
  plannerModel?: string; // e.g. 'claude-3-opus' or 'claude-3.5-sonnet'
  reviewerModel?: string;
  dryRun?: boolean; // if true, do not spawn external tools
  implementer?: 'codex' | 'claude';
  maxIters?: number; // retry loop for critique → fix cycles
  auditDir?: string; // where to persist spike results
  persistAudit?: boolean; // if false, skip writing audit artifacts/metrics
  record?: boolean; // store plan/critique in local context DB
  recordFrame?: boolean; // create a real frame and anchors
  deterministicFixture?: boolean; // force deterministic fixture mode for smoke/replay checks
  verificationCommands?: string[]; // task-specific repro/harness commands to gate approval
}

export interface ImplementationResult {
  success: boolean;
  summary: string;
  commands?: string[];
}

export interface HarnessResult {
  plan: ImplementationPlan;
  implementation: ImplementationResult;
  critique: CritiqueResult;
  iterations?: Array<{
    command: string;
    ok: boolean;
    outputPreview: string;
    critique: CritiqueResult;
    checks?: PostImplementationChecks | null;
  }>;
  verification?: PostImplementationChecks | null;
}
