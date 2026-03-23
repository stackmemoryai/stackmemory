/**
 * Rule evaluation engine.
 * Orchestrates rule checking against project context.
 */

import type Database from 'better-sqlite3';
import type {
  RuleDefinition,
  RuleContext,
  RuleResult,
  RuleViolation,
  RuleTrigger,
  RuleRow,
} from './types.js';
import { RuleStore } from './rule-store.js';
import {
  BUILT_IN_RULES,
  getBuiltinRows,
  filterByScope,
} from './built-in-rules.js';

export class RuleEngine {
  private store: RuleStore;
  private checkFns = new Map<string, RuleDefinition['check']>();

  constructor(db: Database.Database) {
    this.store = new RuleStore(db);
    this.store.seedBuiltins(getBuiltinRows());
    for (const rule of BUILT_IN_RULES) {
      this.checkFns.set(rule.id, rule.check.bind(rule));
    }
  }

  registerRule(rule: RuleDefinition): void {
    this.store.upsert({
      id: rule.id,
      name: rule.name,
      description: rule.description,
      trigger_type: rule.trigger,
      severity: rule.severity,
      scope: rule.scope,
      enabled: rule.enabled ? 1 : 0,
      builtin: rule.builtin ? 1 : 0,
    });
    this.checkFns.set(rule.id, rule.check.bind(rule));
  }

  evaluate(context: RuleContext): RuleResult {
    const rows = this.store.getByTrigger(context.trigger);
    return this.runRules(rows, context);
  }

  evaluateAll(context: RuleContext): RuleResult {
    const rows = this.store.getEnabled();
    return this.runRules(rows, context);
  }

  listRules(filter?: {
    trigger?: RuleTrigger | undefined;
    enabled?: boolean | undefined;
  }): RuleRow[] {
    if (filter?.trigger) {
      return this.store.getByTrigger(filter.trigger);
    }
    if (filter?.enabled === false) {
      return this.store.getAll();
    }
    return this.store.getEnabled();
  }

  enableRule(id: string): boolean {
    return this.store.setEnabled(id, true);
  }

  disableRule(id: string): boolean {
    return this.store.setEnabled(id, false);
  }

  getStore(): RuleStore {
    return this.store;
  }

  private runRules(rows: RuleRow[], context: RuleContext): RuleResult {
    const allViolations: RuleViolation[] = [];
    for (const row of rows) {
      const checkFn = this.checkFns.get(row.id);
      if (!checkFn) continue;
      const scopedFiles = filterByScope(context.files, row.scope);
      if (
        scopedFiles.length === 0 &&
        row.trigger_type !== 'commit' &&
        row.trigger_type !== 'pre-commit'
      )
        continue;
      const scopedCtx: RuleContext = {
        ...context,
        files: scopedFiles,
      };
      const result = checkFn(scopedCtx);
      if (!result.passed) {
        allViolations.push(...result.violations);
      }
    }
    return {
      passed: allViolations.length === 0,
      violations: allViolations,
    };
  }
}
