/**
 * Built-in rules derived from ProvenantAI development patterns.
 */

import type {
  RuleDefinition,
  RuleContext,
  RuleResult,
  RuleViolation,
  RuleRow,
} from './types.js';
import { prReviewRule } from './pr-review-rule.js';

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

function pass(): RuleResult {
  return { passed: true, violations: [] };
}

function fail(violations: RuleViolation[]): RuleResult {
  return { passed: false, violations };
}

/**
 * Simple glob matching (avoids external dependency).
 * Supports: *, **, ?, {a,b} patterns.
 */
function escapeGlobPart(part: string): string {
  return part
    .replace(/\./g, '\\.')
    .replace(
      /\{([^}]+)\}/g,
      (_m, choices: string) => `(${choices.split(',').join('|')})`
    )
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
}

function globToRegex(pattern: string): RegExp {
  // Handle leading ** (match any prefix)
  if (pattern.startsWith('**/')) {
    const rest = escapeGlobPart(pattern.slice(3));
    return new RegExp(`^(?:.+/)?${rest}$`);
  }
  // Split on /**/ to handle mid-pattern globstar
  const parts = pattern.split('/**/');
  if (parts.length === 1) {
    return new RegExp(`^${escapeGlobPart(pattern)}$`);
  }
  const regexParts = parts.map(escapeGlobPart);
  return new RegExp(`^${regexParts.join('(?:/.*?/|/)')}$`);
}

export function matchesScope(filePath: string, scope: string): boolean {
  if (scope === '**/*' || scope === '*') return true;
  const re = globToRegex(scope);
  return re.test(filePath);
}

export function filterByScope(files: string[], scope: string): string[] {
  return files.filter((f) => matchesScope(f, scope));
}

// ---------------------------------------------------------------------------
// Rule: no-coauthor
// ---------------------------------------------------------------------------
const noCoauthor: RuleDefinition = {
  id: 'no-coauthor',
  name: 'No Co-Authored-By',
  description: 'Block Co-Authored-By lines in commit messages',
  trigger: 'commit',
  severity: 'error',
  scope: '*',
  enabled: true,
  builtin: true,
  check(ctx: RuleContext): RuleResult {
    if (!ctx.commitMessage) return pass();
    if (/co-authored-by/i.test(ctx.commitMessage)) {
      return fail([
        violation(
          this.id,
          this.name,
          this.severity,
          'Commit message contains Co-Authored-By line',
          undefined,
          undefined,
          'Remove the Co-Authored-By trailer'
        ),
      ]);
    }
    return pass();
  },
};

// ---------------------------------------------------------------------------
// Rule: no-jest-globals
// ---------------------------------------------------------------------------
const noJestGlobals: RuleDefinition = {
  id: 'no-jest-globals',
  name: 'No @jest/globals imports',
  description:
    'Flag @jest/globals imports in src/ tests (causes redeclaration errors)',
  trigger: 'lint',
  severity: 'error',
  scope: 'src/**/*.test.{ts,js}',
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
        if (line && /@jest\/globals/.test(line)) {
          violations.push(
            violation(
              this.id,
              this.name,
              this.severity,
              `Import from @jest/globals found — use global jest instead`,
              file,
              i + 1,
              'Remove the import; jest/describe/it/expect are globally available'
            )
          );
        }
      }
    }
    return violations.length > 0 ? fail(violations) : pass();
  },
};

// ---------------------------------------------------------------------------
// Rule: catch-no-underscore
// ---------------------------------------------------------------------------
const catchNoUnderscore: RuleDefinition = {
  id: 'catch-no-underscore',
  name: 'Catch without underscore prefix',
  description:
    'Enforce catch {} not catch (_err) {} — underscore prefix not in allowed ESLint pattern',
  trigger: 'lint',
  severity: 'warn',
  scope: 'src/**/*.{ts,js}',
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
        if (line && /catch\s*\(\s*_\w*\s*\)/.test(line)) {
          violations.push(
            violation(
              this.id,
              this.name,
              this.severity,
              'catch with underscore-prefixed variable',
              file,
              i + 1,
              'Use catch {} (empty) or catch (err) {} (without underscore)'
            )
          );
        }
      }
    }
    return violations.length > 0 ? fail(violations) : pass();
  },
};

// ---------------------------------------------------------------------------
// Rule: return-dont-throw
// ---------------------------------------------------------------------------
const THROW_EXCLUDE_PATTERNS = [
  /middleware/i,
  /errors?\//i,
  /errors?\.(ts|js)$/i,
  /index\.(ts|js)$/,
  /\.test\.(ts|js)$/,
  /__tests__/,
];

const returnDontThrow: RuleDefinition = {
  id: 'return-dont-throw',
  name: 'Return undefined over throw',
  description:
    'Warn on throw in non-boundary code — prefer return undefined + log',
  trigger: 'lint',
  severity: 'info',
  scope: 'src/**/*.{ts,js}',
  enabled: true,
  builtin: true,
  check(ctx: RuleContext): RuleResult {
    const violations: RuleViolation[] = [];
    const files = filterByScope(ctx.files, this.scope);
    for (const file of files) {
      if (THROW_EXCLUDE_PATTERNS.some((p) => p.test(file))) continue;
      const content = ctx.content.get(file);
      if (!content) continue;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line && /throw\s+new\s+/.test(line)) {
          violations.push(
            violation(
              this.id,
              this.name,
              this.severity,
              'throw statement in non-boundary code',
              file,
              i + 1,
              'Consider returning undefined and logging the error instead'
            )
          );
        }
      }
    }
    return violations.length > 0 ? fail(violations) : pass();
  },
};

// ---------------------------------------------------------------------------
// Rule: migration-sequential
// ---------------------------------------------------------------------------
const migrationSequential: RuleDefinition = {
  id: 'migration-sequential',
  name: 'Sequential migration numbering',
  description: 'Validate migration files have no numbering gaps',
  trigger: 'on-demand',
  severity: 'error',
  scope: '**/migrations/*.sql',
  enabled: true,
  builtin: true,
  check(ctx: RuleContext): RuleResult {
    const files = filterByScope(ctx.files, this.scope);
    const numbers: number[] = [];
    for (const file of files) {
      const basename = file.split('/').pop() ?? '';
      const match = /^(\d+)/.exec(basename);
      if (match?.[1]) {
        numbers.push(parseInt(match[1], 10));
      }
    }
    if (numbers.length < 2) return pass();

    numbers.sort((a, b) => a - b);
    const violations: RuleViolation[] = [];
    for (let i = 1; i < numbers.length; i++) {
      const prev = numbers[i - 1]!;
      const curr = numbers[i]!;
      if (curr - prev > 1) {
        violations.push(
          violation(
            this.id,
            this.name,
            this.severity,
            `Migration gap: ${String(prev).padStart(3, '0')} → ${String(curr).padStart(3, '0')} (missing ${curr - prev - 1} file(s))`,
            undefined,
            undefined,
            `Add migration(s) for numbers ${prev + 1}–${curr - 1}`
          )
        );
      }
    }
    return violations.length > 0 ? fail(violations) : pass();
  },
};

// ---------------------------------------------------------------------------
// Rule: mock-lifecycle
// ---------------------------------------------------------------------------
const mockLifecycle: RuleDefinition = {
  id: 'mock-lifecycle',
  name: 'Mock lifecycle in tests',
  description:
    'Warn if clearAllMocks() is called without re-setting mocks in beforeEach',
  trigger: 'lint',
  severity: 'warn',
  scope: 'src/**/*.test.{ts,js}',
  enabled: true,
  builtin: true,
  check(ctx: RuleContext): RuleResult {
    const violations: RuleViolation[] = [];
    const files = filterByScope(ctx.files, this.scope);
    for (const file of files) {
      const content = ctx.content.get(file);
      if (!content) continue;
      const hasClearAll = /clearAllMocks\(\)/.test(content);
      if (!hasClearAll) continue;
      // Check if there's a beforeEach that re-sets mocks after clearing
      const hasBeforeEach = /beforeEach/.test(content);
      const hasMockSetup =
        /mock(ReturnValue|ResolvedValue|Implementation)\s*\(/.test(content);
      if (hasClearAll && hasBeforeEach && !hasMockSetup) {
        violations.push(
          violation(
            this.id,
            this.name,
            this.severity,
            'clearAllMocks() used but no mock re-setup found (mockReturnValue/mockResolvedValue/mockImplementation)',
            file,
            undefined,
            'Re-set mock return values in beforeEach after clearAllMocks resets them'
          )
        );
      }
    }
    return violations.length > 0 ? fail(violations) : pass();
  },
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const BUILT_IN_RULES: RuleDefinition[] = [
  noCoauthor,
  noJestGlobals,
  catchNoUnderscore,
  returnDontThrow,
  migrationSequential,
  mockLifecycle,
  prReviewRule,
];

export function getBuiltinRows(): Array<
  Omit<RuleRow, 'created_at' | 'updated_at'>
> {
  return BUILT_IN_RULES.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    trigger_type: r.trigger,
    severity: r.severity,
    scope: r.scope,
    enabled: r.enabled ? 1 : 0,
    builtin: r.builtin ? 1 : 0,
  }));
}
