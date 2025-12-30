import { z } from 'zod';

// ============================================================
// USER & AUTHENTICATION SCHEMAS
// ============================================================

/**
 * Email validation with additional security checks
 */
const EmailSchema = z
  .string()
  .email('Invalid email format')
  .min(5, 'Email too short')
  .max(255, 'Email too long')
  .toLowerCase()
  .transform((email) => email.trim())
  .refine((email) => !email.includes('..'), 'Invalid email format')
  .refine((email) => !email.startsWith('.'), 'Invalid email format')
  .refine((email) => !email.endsWith('.'), 'Invalid email format');

/**
 * User tier validation
 */
const UserTierSchema = z.enum(['free', 'pro', 'enterprise']);

/**
 * Permission validation
 */
const PermissionSchema = z.enum([
  'read',
  'write',
  'delete',
  'admin',
  'moderate',
]);

/**
 * Organization schema
 */
const OrganizationSchema = z.object({
  id: z.string().uuid('Invalid organization ID'),
  name: z.string().min(1).max(255),
  role: z.enum(['member', 'admin', 'owner']).default('member'),
});

/**
 * User metadata validation with strict typing
 */
const UserMetadataSchema = z
  .object({
    lastLoginIp: z.string().ip().optional(),
    userAgent: z.string().max(500).optional(),
    createdVia: z.string().max(50).optional(),
    signupSource: z.string().max(50).optional(),
    isDevelopmentUser: z.boolean().optional(),
    auth0: z.record(z.unknown()).optional(),
    customFields: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/**
 * User creation schema
 */
export const CreateUserSchema = z.object({
  sub: z.string().min(1).max(255),
  email: EmailSchema,
  name: z.string().min(1).max(255).optional(),
  avatar: z.string().url().optional(),
  tier: UserTierSchema.default('free'),
  permissions: z.array(PermissionSchema).default(['read', 'write']),
  organizations: z.array(OrganizationSchema).default([]),
  metadata: UserMetadataSchema.optional(),
});

/**
 * User update schema (partial)
 */
export const UpdateUserSchema = CreateUserSchema.partial().extend({
  id: z.string().uuid('Invalid user ID'),
});

/**
 * API key creation schema
 */
export const CreateApiKeySchema = z.object({
  userId: z.string().uuid('Invalid user ID'),
  name: z.string().min(1).max(100).default('API Key'),
  expiresIn: z.number().int().positive().optional(), // seconds
});

// ============================================================
// SESSION & AUTHENTICATION SCHEMAS
// ============================================================

/**
 * Session creation schema
 */
export const CreateSessionSchema = z.object({
  userId: z.string().uuid('Invalid user ID'),
  expiresIn: z
    .number()
    .int()
    .min(60)
    .max(86400 * 30)
    .default(86400), // 1 minute to 30 days
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * JWT token payload schema
 */
export const JWTPayloadSchema = z.object({
  sub: z.string().min(1),
  email: EmailSchema.optional(),
  name: z.string().optional(),
  picture: z.string().url().optional(),
  iat: z.number(),
  exp: z.number(),
  aud: z.string().or(z.array(z.string())).optional(),
  iss: z.string().optional(),
  permissions: z.array(z.string()).optional(),
  roles: z.array(z.string()).optional(),
  org_id: z.string().optional(),
  org_name: z.string().optional(),
  org_role: z.string().optional(),
});

// ============================================================
// CONTEXT & MEMORY SCHEMAS
// ============================================================

/**
 * Context frame type validation
 */
const ContextTypeSchema = z.enum([
  'code',
  'documentation',
  'conversation',
  'decision',
  'task',
  'error',
  'analysis',
]);

/**
 * Context frame creation schema
 */
export const CreateContextFrameSchema = z.object({
  projectId: z.string().uuid('Invalid project ID'),
  branch: z.string().max(255).optional(),
  content: z.string().min(1).max(1000000), // 1MB max
  summary: z.string().max(5000).optional(),
  type: ContextTypeSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Trace data schema
 */
export const CreateTraceSchema = z.object({
  sessionId: z.string().uuid('Invalid session ID'),
  type: z.string().min(1).max(100),
  data: z.record(z.string(), z.unknown()),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ============================================================
// EMBEDDING & SEARCH SCHEMAS
// ============================================================

/**
 * Embedding dimension validation
 */
const EmbeddingDimensionsSchema = z
  .number()
  .int()
  .positive()
  .refine(
    (dim) => [384, 768, 1024, 1536, 3072].includes(dim),
    'Invalid embedding dimensions. Must be 384, 768, 1024, 1536, or 3072'
  );

/**
 * Semantic search configuration schema
 */
export const SemanticSearchConfigSchema = z.object({
  tableName: z
    .string()
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'Invalid table name')
    .max(63), // PostgreSQL table name limit
  embeddingColumn: z
    .string()
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'Invalid column name')
    .max(63),
  contentColumn: z
    .string()
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'Invalid column name')
    .max(63),
  vectorDimensions: EmbeddingDimensionsSchema,
});

/**
 * Search query schema
 */
export const SearchQuerySchema = z.object({
  query: z.string().min(1).max(5000),
  limit: z.number().int().min(1).max(100).default(10),
  threshold: z.number().min(0).max(1).default(0.7),
  filters: z.record(z.string(), z.unknown()).optional(),
});

// ============================================================
// DATABASE & CONFIGURATION SCHEMAS
// ============================================================

/**
 * PostgreSQL connection configuration schema
 */
export const PostgresConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(5432),
  database: z.string().min(1).max(63),
  user: z.string().min(1).max(63),
  password: z.string().min(1),
  ssl: z
    .union([
      z.boolean(),
      z.object({
        rejectUnauthorized: z.boolean().optional(),
        ca: z.string().optional(),
        cert: z.string().optional(),
        key: z.string().optional(),
      }),
    ])
    .optional(),
  max: z.number().int().min(1).max(100).default(20), // Connection pool size
  idleTimeoutMillis: z.number().int().positive().default(30000),
  connectionTimeoutMillis: z.number().int().positive().default(5000),
  enableTimescale: z.boolean().default(false),
  enablePgvector: z.boolean().default(false),
  vectorDimensions: EmbeddingDimensionsSchema.optional(),
});

/**
 * Redis configuration schema
 */
export const RedisConfigSchema = z.object({
  host: z.string().default('localhost'),
  port: z.number().int().min(1).max(65535).default(6379),
  password: z.string().optional(),
  db: z.number().int().min(0).max(15).default(0),
  keyPrefix: z.string().optional(),
  retryStrategy: z.function().optional(),
  maxRetriesPerRequest: z.number().int().positive().optional(),
});

// ============================================================
// METRICS & MONITORING SCHEMAS
// ============================================================

/**
 * Metric entry schema
 */
export const MetricEntrySchema = z.object({
  metric: z.string().min(1).max(255),
  value: z.number(),
  type: z.enum(['counter', 'gauge', 'timing']),
  tags: z.record(z.string(), z.string()).optional(),
});

/**
 * Log level schema
 */
export const LogLevelSchema = z.enum(['ERROR', 'WARN', 'INFO', 'DEBUG']);

// ============================================================
// LINEAR INTEGRATION SCHEMAS
// ============================================================

/**
 * Linear webhook payload schema
 */
export const LinearWebhookPayloadSchema = z.object({
  action: z.enum(['create', 'update', 'delete']),
  type: z.enum(['issue', 'comment', 'project', 'cycle']),
  data: z.object({
    id: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    state: z.string().optional(),
    priority: z.number().optional(),
    assignee: z
      .object({
        id: z.string(),
        email: EmailSchema.optional(),
        name: z.string().optional(),
      })
      .optional(),
  }),
  createdAt: z.string().datetime(),
  organizationId: z.string(),
});

// ============================================================
// REQUEST VALIDATION SCHEMAS
// ============================================================

/**
 * Pagination parameters schema
 */
export const PaginationSchema = z.object({
  page: z.number().int().positive().default(1),
  limit: z.number().int().min(1).max(100).default(20),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

/**
 * Date range filter schema
 */
export const DateRangeSchema = z
  .object({
    from: z.string().datetime().or(z.date()),
    to: z.string().datetime().or(z.date()),
  })
  .refine((data) => {
    const from =
      typeof data.from === 'string' ? new Date(data.from) : data.from;
    const to = typeof data.to === 'string' ? new Date(data.to) : data.to;
    return from <= to;
  }, 'From date must be before or equal to To date');

/**
 * File upload schema
 */
export const FileUploadSchema = z.object({
  filename: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Invalid filename'),
  mimetype: z
    .string()
    .regex(/^[a-zA-Z]+\/[a-zA-Z0-9.+-]+$/, 'Invalid MIME type'),
  size: z
    .number()
    .int()
    .positive()
    .max(10 * 1024 * 1024), // 10MB max
  encoding: z.string().optional(),
});

// ============================================================
// SANITIZATION UTILITIES
// ============================================================

/**
 * SQL identifier sanitization (table/column names)
 */
export const sanitizeSQLIdentifier = (identifier: string): string => {
  // Only allow alphanumeric and underscore
  const sanitized = identifier.replace(/[^a-zA-Z0-9_]/g, '');

  // Ensure it starts with letter or underscore
  if (!/^[a-zA-Z_]/.test(sanitized)) {
    throw new Error('Invalid SQL identifier');
  }

  // Limit length
  if (sanitized.length > 63) {
    throw new Error('SQL identifier too long');
  }

  return sanitized;
};

/**
 * XSS sanitization for user input
 */
export const sanitizeHTML = (input: string): string => {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
};

// ============================================================
// TYPE EXPORTS
// ============================================================

export type CreateUserInput = z.infer<typeof CreateUserSchema>;
export type UpdateUserInput = z.infer<typeof UpdateUserSchema>;
export type CreateApiKeyInput = z.infer<typeof CreateApiKeySchema>;
export type CreateSessionInput = z.infer<typeof CreateSessionSchema>;
export type JWTPayload = z.infer<typeof JWTPayloadSchema>;
export type CreateContextFrameInput = z.infer<typeof CreateContextFrameSchema>;
export type CreateTraceInput = z.infer<typeof CreateTraceSchema>;
export type SemanticSearchConfig = z.infer<typeof SemanticSearchConfigSchema>;
export type SearchQuery = z.infer<typeof SearchQuerySchema>;
export type PostgresConfig = z.infer<typeof PostgresConfigSchema>;
export type RedisConfig = z.infer<typeof RedisConfigSchema>;
export type MetricEntry = z.infer<typeof MetricEntrySchema>;
export type LinearWebhookPayload = z.infer<typeof LinearWebhookPayloadSchema>;
export type Pagination = z.infer<typeof PaginationSchema>;
export type DateRange = z.infer<typeof DateRangeSchema>;
export type FileUpload = z.infer<typeof FileUploadSchema>;
