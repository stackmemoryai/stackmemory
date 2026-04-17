import { execSync } from 'child_process';
import * as fs from 'fs';

const DEFAULT_WRAPPER_PATH_SNIPPETS = [
  '/Applications/cmux.app/Contents/Resources/bin/',
];

function isWrapperPath(
  candidate: string,
  wrapperPathSnippets: string[]
): boolean {
  const normalized = candidate.trim();
  return wrapperPathSnippets.some((snippet) => normalized.includes(snippet));
}

export interface ResolveRealCliBinOptions {
  explicitBin?: string;
  envBin?: string;
  preferredPaths?: string[];
  pathCommands: string[];
  wrapperPathSnippets?: string[];
}

export function resolveRealCliBin(
  options: ResolveRealCliBinOptions
): string | null {
  if (options.explicitBin?.trim()) {
    return options.explicitBin.trim();
  }
  if (options.envBin?.trim()) {
    return options.envBin.trim();
  }

  const wrapperPathSnippets =
    options.wrapperPathSnippets || DEFAULT_WRAPPER_PATH_SNIPPETS;

  for (const candidate of options.preferredPaths || []) {
    if (
      fs.existsSync(candidate) &&
      !isWrapperPath(candidate, wrapperPathSnippets)
    ) {
      return candidate;
    }
  }

  for (const command of options.pathCommands) {
    try {
      const output = execSync(`which -a ${command}`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const resolved = output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .find((candidate) => !isWrapperPath(candidate, wrapperPathSnippets));
      if (resolved) {
        return resolved;
      }
    } catch {
      // Continue searching.
    }
  }

  return null;
}
