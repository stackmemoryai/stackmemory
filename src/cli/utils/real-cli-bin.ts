import { execSync } from 'child_process';
import { createRequire } from 'node:module';
import * as fs from 'fs';
import * as path from 'path';

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

const CODEX_PLATFORM_TRIPLES: Record<string, Record<string, string>> = {
  darwin: { x64: 'x86_64-apple-darwin', arm64: 'aarch64-apple-darwin' },
  linux: {
    x64: 'x86_64-unknown-linux-musl',
    arm64: 'aarch64-unknown-linux-musl',
  },
  win32: { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' },
};

/**
 * Find the native Codex binary from the @openai/codex npm package.
 * Returns an array of candidate paths (0-2) ordered best-first.
 */
export function resolveNativeCodexBin(): string[] {
  const triple = CODEX_PLATFORM_TRIPLES[process.platform]?.[process.arch];
  if (!triple) return [];

  const binaryName = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const platformPkg = `@openai/codex-${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
  const candidates: string[] = [];

  // Strategy 1: resolve from npm's require tree
  try {
    const req = createRequire(
      path.join(
        process.execPath,
        '..',
        '..',
        'lib',
        'node_modules',
        '@openai',
        'codex',
        'package.json'
      )
    );
    const pkgJson = req.resolve(`${platformPkg}/package.json`);
    const vendorBin = path.join(
      path.dirname(pkgJson),
      'vendor',
      triple,
      'bin',
      binaryName
    );
    if (fs.existsSync(vendorBin)) candidates.push(vendorBin);
  } catch {
    // Not installed via npm global
  }

  // Strategy 2: walk from process.execPath (nvm/homebrew)
  try {
    const nodeDir = path.dirname(process.execPath);
    const globalModules = path.join(nodeDir, '..', 'lib', 'node_modules');
    const vendorBin = path.join(
      globalModules,
      '@openai',
      'codex',
      'node_modules',
      platformPkg,
      'vendor',
      triple,
      'bin',
      binaryName
    );
    if (fs.existsSync(vendorBin) && !candidates.includes(vendorBin)) {
      candidates.push(vendorBin);
    }
  } catch {
    // Fallback below
  }

  return candidates;
}

/**
 * Dynamically resolve the bin directory for the current Node version manager.
 * Works with nvm, fnm, volta, and homebrew Node.
 */
export function resolveNvmBin(name: string): string | undefined {
  try {
    const nodeDir = path.dirname(process.execPath);
    const candidate = path.join(nodeDir, name);
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    // Fallback
  }
  return undefined;
}
