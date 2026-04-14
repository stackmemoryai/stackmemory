import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface ProjectHandoffMetadata {
  branch?: string;
  capturedAt?: string;
  gitHead?: string;
  projectRoot?: string;
}

export interface LoadedProjectHandoff {
  content: string;
  branch: string | null;
  compatible: boolean;
  mismatchReason?: string;
}

export function getProjectHandoffPaths(projectRoot: string): {
  handoffPath: string;
  metadataPath: string;
} {
  return {
    handoffPath: join(projectRoot, '.stackmemory', 'last-handoff.md'),
    metadataPath: join(projectRoot, '.stackmemory', 'last-handoff-meta.json'),
  };
}

export function parseBranchFromHandoffContent(content: string): string | null {
  const compactMatch = content.match(/^# Handoff:\s+.+?@([^\n]+)$/m);
  if (compactMatch?.[1]) {
    return compactMatch[1].trim();
  }

  const verboseMatch = content.match(/^\*\*Branch\*\*:\s+([^\n]+)$/m);
  if (verboseMatch?.[1]) {
    return verboseMatch[1].trim();
  }

  const ultraMatch = content.match(/^\[H\].+?@([^|\n]+)\|/m);
  if (ultraMatch?.[1]) {
    return ultraMatch[1].trim();
  }

  return null;
}

export function loadProjectHandoff(
  projectRoot: string,
  currentBranch?: string
): LoadedProjectHandoff | null {
  const { handoffPath, metadataPath } = getProjectHandoffPaths(projectRoot);
  if (!existsSync(handoffPath)) {
    return null;
  }

  const content = readFileSync(handoffPath, 'utf8').trim();
  if (!content) {
    return null;
  }

  let metadata: ProjectHandoffMetadata | null = null;
  if (existsSync(metadataPath)) {
    try {
      metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    } catch {
      metadata = null;
    }
  }

  const branch = metadata?.branch || parseBranchFromHandoffContent(content);
  if (currentBranch && branch && branch !== currentBranch) {
    return {
      content,
      branch,
      compatible: false,
      mismatchReason: `handoff is for branch ${branch}, current branch is ${currentBranch}`,
    };
  }

  return {
    content,
    branch: branch || null,
    compatible: true,
  };
}
