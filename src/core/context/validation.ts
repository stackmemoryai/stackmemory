/**
 * Input validation schemas for collaboration layer
 */

import { z } from 'zod';

// Permission validation
export const StackPermissionsSchema = z.object({
  canRead: z.boolean(),
  canWrite: z.boolean(),
  canHandoff: z.boolean(),
  canMerge: z.boolean(),
  canAdminister: z.boolean(),
});

// Common string validations
const stackIdSchema = z.string().min(1).max(200);
const userIdSchema = z.string().min(1).max(100);
const frameIdSchema = z.string().min(1).max(100);
const teamIdSchema = z.string().min(1).max(100);

// Dual Stack Manager validation
export const CreateSharedStackSchema = z.object({
  teamId: teamIdSchema,
  name: z.string().min(1).max(200),
  ownerId: userIdSchema,
  permissions: StackPermissionsSchema.optional(),
});

export const SwitchStackSchema = z.object({
  stackId: stackIdSchema,
});

// Frame Handoff validation
export const FrameContextSchema = z.object({
  totalFrames: z.number().min(1).max(10000),
  frameTypes: z.array(z.string()).min(1).max(50),
  estimatedSize: z.number().min(0).max(1000000), // Max 1MB
  dependencies: z.array(z.string()).max(100),
});

export const BusinessContextSchema = z.object({
  milestone: z.string().max(100).optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  deadline: z.date().optional(),
  stakeholders: z.array(userIdSchema).max(20).optional(),
});

export const HandoffRequestSchema = z.object({
  initiatedAt: z.date(),
  initiatorId: userIdSchema,
  frameContext: FrameContextSchema,
  businessContext: BusinessContextSchema.optional(),
});

export const InitiateHandoffSchema = z.object({
  targetStackId: stackIdSchema,
  frameIds: z.array(frameIdSchema).min(1).max(1000),
  handoffRequest: HandoffRequestSchema,
  reviewerId: userIdSchema.optional(),
  description: z.string().max(1000).optional(),
});

export const HandoffApprovalSchema = z.object({
  reviewerId: userIdSchema,
  decision: z.enum(['approved', 'rejected', 'needs_changes']),
  feedback: z.string().max(2000).optional(),
  suggestedChanges: z
    .array(
      z.object({
        frameId: frameIdSchema,
        suggestion: z.string().max(500),
        reason: z.string().max(300).optional(),
      })
    )
    .max(50)
    .optional(),
});

// Merge Resolution validation
export const ConflictResolutionSchema = z.object({
  strategy: z.enum(['source_wins', 'target_wins', 'merge_both', 'manual']),
  resolvedBy: userIdSchema,
  notes: z.string().max(1000).optional(),
});

export const MergePolicyRuleSchema = z.object({
  condition: z.string().min(1).max(500),
  action: z.enum(['source_wins', 'target_wins', 'merge_both', 'manual_review']),
  priority: z.number().min(1).max(10),
});

export const CreateMergePolicySchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  rules: z.array(MergePolicyRuleSchema).min(1).max(20),
  autoApplyThreshold: z.enum(['low', 'medium', 'high']),
});

export const StartMergeSessionSchema = z.object({
  sourceStackId: stackIdSchema,
  targetStackId: stackIdSchema,
  frameIds: z.array(frameIdSchema).max(1000).optional(),
  policyName: z.string().max(100).optional(),
});

// Type exports for use in implementation
export type StackPermissions = z.infer<typeof StackPermissionsSchema>;
export type CreateSharedStackInput = z.infer<typeof CreateSharedStackSchema>;
export type SwitchStackInput = z.infer<typeof SwitchStackSchema>;
export type FrameContext = z.infer<typeof FrameContextSchema>;
export type BusinessContext = z.infer<typeof BusinessContextSchema>;
export type HandoffRequest = z.infer<typeof HandoffRequestSchema>;
export type InitiateHandoffInput = z.infer<typeof InitiateHandoffSchema>;
export type HandoffApprovalInput = z.infer<typeof HandoffApprovalSchema>;
export type ConflictResolutionInput = z.infer<typeof ConflictResolutionSchema>;
export type MergePolicyRule = z.infer<typeof MergePolicyRuleSchema>;
export type CreateMergePolicyInput = z.infer<typeof CreateMergePolicySchema>;
export type StartMergeSessionInput = z.infer<typeof StartMergeSessionSchema>;

// Validation helper functions
export function validateInput<T>(schema: z.ZodSchema<T>, input: unknown): T {
  try {
    return schema.parse(input);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const details = error.errors
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join(', ');
      throw new Error(`Validation failed: ${details}`);
    }
    throw error;
  }
}

export function validateInputSafe<T>(
  schema: z.ZodSchema<T>,
  input: unknown
): { success: true; data: T } | { success: false; error: string } {
  try {
    const data = schema.parse(input);
    return { success: true, data };
  } catch (error) {
    if (error instanceof z.ZodError) {
      const details = error.errors
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join(', ');
      return { success: false, error: `Validation failed: ${details}` };
    }
    return { success: false, error: 'Unknown validation error' };
  }
}
