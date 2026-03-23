/**
 * PR review comment rule.
 * Checks for common patterns that PR reviewers flag.
 * Runs the same checks locally before push to catch issues early.
 */

import type {
  RuleDefinition,
  RuleContext,
  RuleResult,
  RuleViolation,
} from './types.js';
import { filterByScope } from './built-in-rules.js';

function violation(
  ruleId: string,
  ruleName: string,
  severity: RuleDefinition['severity'],
  message: string,
  file?: string,
  line?: number,
  suggestion?: string
): RuleViolation {
  return { ruleId, ruleName, severity, message, file, line, suggestion };
}

// Common patterns that PR reviewers flag
const PR_REVIEW_PATTERNS: Array<{
  id: string;
  pattern: RegExp;
  message: string;
  suggestion: string;
  severity: RuleDefinition['severity'];
}> = [
  {
    id: 'console-log',
    pattern: /console\.(log|debug|info)\(/,
    message: 'console.log left in code',
    suggestion: 'Remove or replace with structured logger',
    severity: 'warn',
  },
  {
    id: 'todo-fixme',
    pattern: /\/\/\s*(TODO|FIXME|HACK|XXX)(?!\s*\()/,
    message: 'TODO/FIXME without attribution',
    suggestion: 'Add author and ticket: // TODO(user): STA-XXX description',
    severity: 'info',
  },
  {
    id: 'hardcoded-secret',
    pattern: /(api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"]{8,}['"]/i,
    message: 'Possible hardcoded secret',
    suggestion: 'Move to environment variable',
    severity: 'error',
  },
  {
    id: 'any-type',
    pattern: /:\s*any\b/,
    message: 'Explicit any type',
    suggestion: 'Use a specific type or unknown',
    severity: 'warn',
  },
  {
    id: 'empty-catch',
    pattern: /catch\s*\{[\s]*\}/,
    message: 'Empty catch block (swallows errors silently)',
    suggestion:
      'Log the error or add a comment explaining why it is safe to ignore',
    severity: 'warn',
  },
];

export const prReviewRule: RuleDefinition = {
  id: 'pr-review-patterns',
  name: 'PR Review Patterns',
  description:
    'Catch common issues that PR reviewers flag (console.log, TODO, secrets, any type)',
  trigger: 'pre-commit',
  severity: 'warn',
  scope: 'src/**/*.{ts,js,tsx,jsx}',
  enabled: true,
  builtin: true,
  check(ctx: RuleContext): RuleResult {
    const violations: RuleViolation[] = [];
    const files = filterByScope(ctx.files, this.scope);
    for (const file of files) {
      const content = ctx.content.get(file);
      if (!content) continue;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        for (const check of PR_REVIEW_PATTERNS) {
          if (check.pattern.test(line)) {
            violations.push(
              violation(
                this.id,
                `${this.name}: ${check.id}`,
                check.severity,
                check.message,
                file,
                i + 1,
                check.suggestion
              )
            );
          }
        }
      }
    }
    return violations.length > 0
      ? { passed: false, violations }
      : { passed: true, violations: [] };
  },
};
