/**
 * Tests for validation.ts — Zod schemas and validation helpers
 * Covers: all schemas, validateInput, validateInputSafe, edge cases
 */

import { describe, it, expect } from 'vitest';
import {
  StackPermissionsSchema,
  CreateSharedStackSchema,
  SwitchStackSchema,
  FrameContextSchema,
  BusinessContextSchema,
  HandoffRequestSchema,
  InitiateHandoffSchema,
  HandoffApprovalSchema,
  ConflictResolutionSchema,
  MergePolicyRuleSchema,
  CreateMergePolicySchema,
  StartMergeSessionSchema,
  validateInput,
  validateInputSafe,
} from '../validation.js';
import { ValidationError, ErrorCode } from '../../errors/index.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function validPermissions() {
  return {
    canRead: true,
    canWrite: true,
    canHandoff: false,
    canMerge: false,
    canAdminister: false,
  };
}

function validFrameContext() {
  return {
    totalFrames: 5,
    frameTypes: ['task'],
    estimatedSize: 1024,
    dependencies: [],
  };
}

function validHandoffRequest() {
  return {
    initiatedAt: new Date(),
    initiatorId: 'user-1',
    frameContext: validFrameContext(),
  };
}

// ── StackPermissionsSchema ───────────────────────────────────────────────

describe('StackPermissionsSchema', () => {
  it('should accept valid permissions', () => {
    const result = StackPermissionsSchema.parse(validPermissions());
    expect(result.canRead).toBe(true);
    expect(result.canAdminister).toBe(false);
  });

  it('should reject missing fields', () => {
    expect(() => StackPermissionsSchema.parse({ canRead: true })).toThrow();
  });

  it('should reject non-boolean values', () => {
    expect(() =>
      StackPermissionsSchema.parse({
        ...validPermissions(),
        canRead: 'yes',
      })
    ).toThrow();
  });
});

// ── CreateSharedStackSchema ──────────────────────────────────────────────

describe('CreateSharedStackSchema', () => {
  it('should accept valid input', () => {
    const result = CreateSharedStackSchema.parse({
      teamId: 'team-1',
      name: 'My Stack',
      ownerId: 'user-1',
    });
    expect(result.name).toBe('My Stack');
  });

  it('should accept optional permissions', () => {
    const result = CreateSharedStackSchema.parse({
      teamId: 'team-1',
      name: 'Stack',
      ownerId: 'user-1',
      permissions: validPermissions(),
    });
    expect(result.permissions?.canRead).toBe(true);
  });

  it('should reject empty name', () => {
    expect(() =>
      CreateSharedStackSchema.parse({
        teamId: 'team-1',
        name: '',
        ownerId: 'user-1',
      })
    ).toThrow();
  });

  it('should reject name exceeding 200 chars', () => {
    expect(() =>
      CreateSharedStackSchema.parse({
        teamId: 'team-1',
        name: 'x'.repeat(201),
        ownerId: 'user-1',
      })
    ).toThrow();
  });

  it('should reject empty teamId', () => {
    expect(() =>
      CreateSharedStackSchema.parse({
        teamId: '',
        name: 'Stack',
        ownerId: 'user-1',
      })
    ).toThrow();
  });
});

// ── SwitchStackSchema ────────────────────────────────────────────────────

describe('SwitchStackSchema', () => {
  it('should accept valid stackId', () => {
    const result = SwitchStackSchema.parse({ stackId: 'stack-123' });
    expect(result.stackId).toBe('stack-123');
  });

  it('should reject empty stackId', () => {
    expect(() => SwitchStackSchema.parse({ stackId: '' })).toThrow();
  });

  it('should reject stackId exceeding 200 chars', () => {
    expect(() =>
      SwitchStackSchema.parse({ stackId: 'x'.repeat(201) })
    ).toThrow();
  });
});

// ── FrameContextSchema ───────────────────────────────────────────────────

describe('FrameContextSchema', () => {
  it('should accept valid frame context', () => {
    const result = FrameContextSchema.parse(validFrameContext());
    expect(result.totalFrames).toBe(5);
  });

  it('should reject totalFrames < 1', () => {
    expect(() =>
      FrameContextSchema.parse({ ...validFrameContext(), totalFrames: 0 })
    ).toThrow();
  });

  it('should reject totalFrames > 10000', () => {
    expect(() =>
      FrameContextSchema.parse({ ...validFrameContext(), totalFrames: 10001 })
    ).toThrow();
  });

  it('should reject empty frameTypes', () => {
    expect(() =>
      FrameContextSchema.parse({ ...validFrameContext(), frameTypes: [] })
    ).toThrow();
  });

  it('should reject estimatedSize > 1MB', () => {
    expect(() =>
      FrameContextSchema.parse({
        ...validFrameContext(),
        estimatedSize: 1000001,
      })
    ).toThrow();
  });

  it('should reject negative estimatedSize', () => {
    expect(() =>
      FrameContextSchema.parse({ ...validFrameContext(), estimatedSize: -1 })
    ).toThrow();
  });

  it('should reject more than 100 dependencies', () => {
    expect(() =>
      FrameContextSchema.parse({
        ...validFrameContext(),
        dependencies: Array.from({ length: 101 }, (_, i) => `dep-${i}`),
      })
    ).toThrow();
  });
});

// ── BusinessContextSchema ────────────────────────────────────────────────

describe('BusinessContextSchema', () => {
  it('should accept empty object (all optional)', () => {
    const result = BusinessContextSchema.parse({});
    expect(result).toBeDefined();
  });

  it('should accept valid priority enum', () => {
    const result = BusinessContextSchema.parse({ priority: 'critical' });
    expect(result.priority).toBe('critical');
  });

  it('should reject invalid priority', () => {
    expect(() => BusinessContextSchema.parse({ priority: 'urgent' })).toThrow();
  });

  it('should reject milestone exceeding 100 chars', () => {
    expect(() =>
      BusinessContextSchema.parse({ milestone: 'x'.repeat(101) })
    ).toThrow();
  });

  it('should reject more than 20 stakeholders', () => {
    expect(() =>
      BusinessContextSchema.parse({
        stakeholders: Array.from({ length: 21 }, (_, i) => `user-${i}`),
      })
    ).toThrow();
  });
});

// ── HandoffRequestSchema ─────────────────────────────────────────────────

describe('HandoffRequestSchema', () => {
  it('should accept valid handoff request', () => {
    const result = HandoffRequestSchema.parse(validHandoffRequest());
    expect(result.initiatorId).toBe('user-1');
  });

  it('should accept optional businessContext', () => {
    const result = HandoffRequestSchema.parse({
      ...validHandoffRequest(),
      businessContext: { priority: 'high' },
    });
    expect(result.businessContext?.priority).toBe('high');
  });

  it('should reject missing initiatorId', () => {
    const { initiatorId: _, ...rest } = validHandoffRequest();
    expect(() => HandoffRequestSchema.parse(rest)).toThrow();
  });
});

// ── InitiateHandoffSchema ────────────────────────────────────────────────

describe('InitiateHandoffSchema', () => {
  it('should accept valid initiate handoff input', () => {
    const result = InitiateHandoffSchema.parse({
      targetStackId: 'stack-1',
      frameIds: ['frame-1'],
      handoffRequest: validHandoffRequest(),
    });
    expect(result.targetStackId).toBe('stack-1');
  });

  it('should reject empty frameIds', () => {
    expect(() =>
      InitiateHandoffSchema.parse({
        targetStackId: 'stack-1',
        frameIds: [],
        handoffRequest: validHandoffRequest(),
      })
    ).toThrow();
  });

  it('should reject more than 1000 frameIds', () => {
    expect(() =>
      InitiateHandoffSchema.parse({
        targetStackId: 'stack-1',
        frameIds: Array.from({ length: 1001 }, (_, i) => `frame-${i}`),
        handoffRequest: validHandoffRequest(),
      })
    ).toThrow();
  });

  it('should accept optional reviewerId and description', () => {
    const result = InitiateHandoffSchema.parse({
      targetStackId: 'stack-1',
      frameIds: ['frame-1'],
      handoffRequest: validHandoffRequest(),
      reviewerId: 'reviewer-1',
      description: 'Handoff description',
    });
    expect(result.reviewerId).toBe('reviewer-1');
  });

  it('should reject description exceeding 1000 chars', () => {
    expect(() =>
      InitiateHandoffSchema.parse({
        targetStackId: 'stack-1',
        frameIds: ['frame-1'],
        handoffRequest: validHandoffRequest(),
        description: 'x'.repeat(1001),
      })
    ).toThrow();
  });
});

// ── HandoffApprovalSchema ────────────────────────────────────────────────

describe('HandoffApprovalSchema', () => {
  it('should accept valid approval', () => {
    const result = HandoffApprovalSchema.parse({
      reviewerId: 'reviewer-1',
      decision: 'approved',
    });
    expect(result.decision).toBe('approved');
  });

  it('should accept all decision values', () => {
    for (const decision of ['approved', 'rejected', 'needs_changes']) {
      const result = HandoffApprovalSchema.parse({
        reviewerId: 'r-1',
        decision,
      });
      expect(result.decision).toBe(decision);
    }
  });

  it('should reject invalid decision', () => {
    expect(() =>
      HandoffApprovalSchema.parse({
        reviewerId: 'r-1',
        decision: 'maybe',
      })
    ).toThrow();
  });

  it('should accept optional suggestedChanges', () => {
    const result = HandoffApprovalSchema.parse({
      reviewerId: 'r-1',
      decision: 'needs_changes',
      suggestedChanges: [{ frameId: 'frame-1', suggestion: 'Fix naming' }],
    });
    expect(result.suggestedChanges).toHaveLength(1);
  });

  it('should reject feedback exceeding 2000 chars', () => {
    expect(() =>
      HandoffApprovalSchema.parse({
        reviewerId: 'r-1',
        decision: 'rejected',
        feedback: 'x'.repeat(2001),
      })
    ).toThrow();
  });
});

// ── ConflictResolutionSchema ─────────────────────────────────────────────

describe('ConflictResolutionSchema', () => {
  it('should accept valid resolution', () => {
    const result = ConflictResolutionSchema.parse({
      strategy: 'source_wins',
      resolvedBy: 'user-1',
    });
    expect(result.strategy).toBe('source_wins');
  });

  it('should accept all strategy values', () => {
    for (const strategy of [
      'source_wins',
      'target_wins',
      'merge_both',
      'manual',
    ]) {
      expect(() =>
        ConflictResolutionSchema.parse({ strategy, resolvedBy: 'u-1' })
      ).not.toThrow();
    }
  });

  it('should reject invalid strategy', () => {
    expect(() =>
      ConflictResolutionSchema.parse({
        strategy: 'auto',
        resolvedBy: 'u-1',
      })
    ).toThrow();
  });
});

// ── MergePolicyRuleSchema ────────────────────────────────────────────────

describe('MergePolicyRuleSchema', () => {
  it('should accept valid rule', () => {
    const result = MergePolicyRuleSchema.parse({
      condition: 'type == task',
      action: 'source_wins',
      priority: 1,
    });
    expect(result.priority).toBe(1);
  });

  it('should reject priority outside 1-10', () => {
    expect(() =>
      MergePolicyRuleSchema.parse({
        condition: 'x',
        action: 'source_wins',
        priority: 0,
      })
    ).toThrow();
    expect(() =>
      MergePolicyRuleSchema.parse({
        condition: 'x',
        action: 'source_wins',
        priority: 11,
      })
    ).toThrow();
  });

  it('should reject empty condition', () => {
    expect(() =>
      MergePolicyRuleSchema.parse({
        condition: '',
        action: 'source_wins',
        priority: 1,
      })
    ).toThrow();
  });
});

// ── CreateMergePolicySchema ──────────────────────────────────────────────

describe('CreateMergePolicySchema', () => {
  it('should accept valid policy', () => {
    const result = CreateMergePolicySchema.parse({
      name: 'Default Policy',
      rules: [{ condition: 'always', action: 'source_wins', priority: 1 }],
      autoApplyThreshold: 'medium',
    });
    expect(result.name).toBe('Default Policy');
  });

  it('should reject empty rules', () => {
    expect(() =>
      CreateMergePolicySchema.parse({
        name: 'P',
        rules: [],
        autoApplyThreshold: 'low',
      })
    ).toThrow();
  });

  it('should reject more than 20 rules', () => {
    const rules = Array.from({ length: 21 }, (_, i) => ({
      condition: `cond-${i}`,
      action: 'source_wins' as const,
      priority: 1,
    }));
    expect(() =>
      CreateMergePolicySchema.parse({
        name: 'P',
        rules,
        autoApplyThreshold: 'low',
      })
    ).toThrow();
  });

  it('should reject invalid autoApplyThreshold', () => {
    expect(() =>
      CreateMergePolicySchema.parse({
        name: 'P',
        rules: [{ condition: 'x', action: 'source_wins', priority: 1 }],
        autoApplyThreshold: 'extreme',
      })
    ).toThrow();
  });
});

// ── StartMergeSessionSchema ──────────────────────────────────────────────

describe('StartMergeSessionSchema', () => {
  it('should accept valid merge session input', () => {
    const result = StartMergeSessionSchema.parse({
      sourceStackId: 'stack-a',
      targetStackId: 'stack-b',
    });
    expect(result.sourceStackId).toBe('stack-a');
  });

  it('should accept optional frameIds and policyName', () => {
    const result = StartMergeSessionSchema.parse({
      sourceStackId: 'a',
      targetStackId: 'b',
      frameIds: ['f1', 'f2'],
      policyName: 'default',
    });
    expect(result.frameIds).toHaveLength(2);
  });

  it('should reject empty sourceStackId', () => {
    expect(() =>
      StartMergeSessionSchema.parse({
        sourceStackId: '',
        targetStackId: 'b',
      })
    ).toThrow();
  });
});

// ── validateInput ────────────────────────────────────────────────────────

describe('validateInput', () => {
  it('should return parsed data for valid input', () => {
    const result = validateInput(SwitchStackSchema, { stackId: 'stack-1' });
    expect(result.stackId).toBe('stack-1');
  });

  it('should throw ValidationError for invalid input', () => {
    expect(() => validateInput(SwitchStackSchema, { stackId: '' })).toThrow(
      ValidationError
    );
  });

  it('should include field path in error message', () => {
    try {
      validateInput(SwitchStackSchema, { stackId: '' });
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).message).toContain('Validation failed');
      expect((error as ValidationError).code).toBe(ErrorCode.VALIDATION_FAILED);
    }
  });

  it('should re-throw non-Zod errors', () => {
    const badSchema = {
      parse: () => {
        throw new Error('Not a Zod error');
      },
    };
    expect(() => validateInput(badSchema as any, {})).toThrow(
      'Not a Zod error'
    );
  });

  it('should handle null input', () => {
    expect(() => validateInput(SwitchStackSchema, null)).toThrow(
      ValidationError
    );
  });

  it('should handle undefined input', () => {
    expect(() => validateInput(SwitchStackSchema, undefined)).toThrow(
      ValidationError
    );
  });
});

// ── validateInputSafe ────────────────────────────────────────────────────

describe('validateInputSafe', () => {
  it('should return success for valid input', () => {
    const result = validateInputSafe(SwitchStackSchema, { stackId: 's-1' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stackId).toBe('s-1');
    }
  });

  it('should return error string for invalid input', () => {
    const result = validateInputSafe(SwitchStackSchema, { stackId: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Validation failed');
    }
  });

  it('should return unknown error for non-Zod errors', () => {
    const badSchema = {
      parse: () => {
        throw new Error('Boom');
      },
    };
    const result = validateInputSafe(badSchema as any, {});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('Unknown validation error');
    }
  });

  it('should handle null input gracefully', () => {
    const result = validateInputSafe(SwitchStackSchema, null);
    expect(result.success).toBe(false);
  });
});
