/**
 * Rule engine types.
 */

export type RuleTrigger =
  | 'commit'
  | 'file-save'
  | 'pre-commit'
  | 'lint'
  | 'on-demand';
export type RuleSeverity = 'error' | 'warn' | 'info';

export interface RuleContext {
  trigger: RuleTrigger;
  files: string[];
  content: Map<string, string>;
  commitMessage: string;
  projectRoot: string;
}

export interface RuleViolation {
  ruleId: string;
  ruleName: string;
  severity: RuleSeverity;
  message: string;
  file: string | undefined;
  line: number | undefined;
  suggestion: string | undefined;
}

export interface RuleResult {
  passed: boolean;
  violations: RuleViolation[];
}

export interface RuleDefinition {
  id: string;
  name: string;
  description: string;
  trigger: RuleTrigger;
  severity: RuleSeverity;
  scope: string;
  check: (context: RuleContext) => RuleResult;
  enabled: boolean;
  builtin: boolean;
}

export interface RuleRow {
  id: string;
  name: string;
  description: string;
  trigger_type: string;
  severity: string;
  scope: string;
  enabled: number;
  builtin: number;
  created_at: number;
  updated_at: number;
}
