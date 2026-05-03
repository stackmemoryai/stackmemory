/**
 * Skill Pack Parser — parse and validate pack.yaml files
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { SkillPackManifestSchema } from './types.js';
import type { SkillPack, SkillPackManifest } from './types.js';
import { logger } from '../monitoring/logger.js';

/**
 * Parse raw YAML string into a validated SkillPack.
 * Throws ZodError on invalid input.
 */
export function parsePackYaml(content: string): SkillPack {
  const raw = yaml.load(content) as Record<string, unknown>;
  const manifest: SkillPackManifest = SkillPackManifestSchema.parse(raw);

  // Instructions may be inline in the manifest
  const instructions = manifest.instructions;

  return { manifest, instructions };
}

/**
 * Load a skill pack from a directory containing pack.yaml.
 * If the manifest's `instructions` field references an external file
 * (ends with .md), resolve and read it from the same directory.
 */
export async function loadPackFromDir(dir: string): Promise<SkillPack> {
  const yamlPath = path.join(dir, 'pack.yaml');

  if (!fs.existsSync(yamlPath)) {
    throw new Error(`pack.yaml not found in ${dir}`);
  }

  const content = fs.readFileSync(yamlPath, 'utf-8');
  const pack = parsePackYaml(content);

  // Resolve external instructions file
  if (pack.manifest.instructions?.endsWith('.md')) {
    const instrPath = path.join(dir, pack.manifest.instructions);
    if (fs.existsSync(instrPath)) {
      pack.instructions = fs.readFileSync(instrPath, 'utf-8');
      logger.debug(
        `Loaded instructions from ${instrPath} for pack ${pack.manifest.name}`
      );
    } else {
      logger.warn(
        `Instructions file ${instrPath} referenced but not found for pack ${pack.manifest.name}`
      );
      pack.instructions = undefined;
    }
  }

  return pack;
}
