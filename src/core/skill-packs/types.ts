/**
 * Skill Pack Types — Zod schemas + TypeScript types for pack.yaml format
 *
 * Skill packs are versioned, distributable bundles that include instructions,
 * MCP tool definitions, examples, and runtime configuration. They are distinct
 * from individual learned Skills (src/core/skills/types.ts).
 */

import { z } from 'zod';

// ============================================================
// SEMVER
// ============================================================

const SemverSchema = z
  .string()
  .regex(
    /^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/,
    'version must be valid semver (e.g. 1.0.0)'
  );

// ============================================================
// RUNTIME
// ============================================================

export const SkillPackRuntimeTypeSchema = z.enum([
  'local',
  'e2b',
  'cua',
  'modal',
]);

export type SkillPackRuntimeType = z.infer<typeof SkillPackRuntimeTypeSchema>;

export const SkillPackRuntimeSchema = z.object({
  type: SkillPackRuntimeTypeSchema.default('local'),
  template: z.string().optional(),
});

export type SkillPackRuntime = z.infer<typeof SkillPackRuntimeSchema>;

// ============================================================
// INGESTION
// ============================================================

export const SkillPackIngestionSchema = z.object({
  sources: z.array(z.string()).default([]),
  scope: z.string().optional(),
});

export type SkillPackIngestion = z.infer<typeof SkillPackIngestionSchema>;

// ============================================================
// ONTOLOGY
// ============================================================

export const SkillPackOntologySchema = z.object({
  entities: z.array(z.string()).default([]),
  relations: z.array(z.string()).default([]),
});

export type SkillPackOntology = z.infer<typeof SkillPackOntologySchema>;

// ============================================================
// MCP TOOLS
// ============================================================

export const SkillPackMcpToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  inputSchema: z.record(z.unknown()).optional(),
});

export type SkillPackMcpTool = z.infer<typeof SkillPackMcpToolSchema>;

export const SkillPackMcpSchema = z.object({
  tools: z.array(SkillPackMcpToolSchema).default([]),
});

export type SkillPackMcp = z.infer<typeof SkillPackMcpSchema>;

// ============================================================
// EXAMPLES
// ============================================================

export const SkillPackExampleSchema = z.object({
  input: z.string().min(1),
  output: z.string().min(1),
});

export type SkillPackExample = z.infer<typeof SkillPackExampleSchema>;

// ============================================================
// LICENSE
// ============================================================

/**
 * Known licenses for skill packs.
 * Code licenses (MIT, Apache-2.0, ISC) and content licenses (CC-BY-4.0, CC-BY-SA-4.0)
 * are both valid — skills are often prompt text (content) rather than executable code.
 */
export const KnownLicenseSchema = z.enum([
  'MIT',
  'Apache-2.0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC-BY-4.0',
  'CC-BY-SA-4.0',
  'CC0-1.0',
  'UNLICENSED',
]);

export type KnownLicense = z.infer<typeof KnownLicenseSchema>;

/** Accepts known SPDX identifiers or any custom string */
const LicenseSchema = KnownLicenseSchema.or(z.string().min(1));

// ============================================================
// PACK NAME (namespace/pack-name)
// ============================================================

const PackNameSchema = z
  .string()
  .min(1)
  .regex(
    /^[\w-]+\/[\w-]+$/,
    'name must be namespace/pack-name (e.g. "coding/typescript-react")'
  );

// ============================================================
// SKILL PACK MANIFEST (pack.yaml contents)
// ============================================================

export const SkillPackManifestSchema = z.object({
  name: PackNameSchema,
  version: SemverSchema,
  description: z.string().min(1),
  author: z.string().min(1),
  license: LicenseSchema.default('MIT'),
  runtime: SkillPackRuntimeSchema.optional(),
  ingestion: SkillPackIngestionSchema.optional(),
  ontology: SkillPackOntologySchema.optional(),
  mcp: SkillPackMcpSchema.optional(),
  examples: z.array(SkillPackExampleSchema).optional(),
  instructions: z.string().optional(),
});

export type SkillPackManifest = z.infer<typeof SkillPackManifestSchema>;

// ============================================================
// SKILL PACK (manifest + resolved instructions)
// ============================================================

export interface SkillPackMetadata {
  installedAt: string;
  source?: string;
}

export interface SkillPack {
  manifest: SkillPackManifest;
  instructions: string | undefined;
  metadata?: SkillPackMetadata;
}
