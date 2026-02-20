/**
 * Project Isolation System
 * Ensures data separation between different projects/organizations
 */

import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { logger } from '../monitoring/logger.js';

export interface ProjectIdentification {
  projectId: string;
  organization: string;
  repository: string;
  workspaceFilter: string;
  linearTeamId?: string;
  linearOrganization?: string;
  projectPrefix: string;
}

export class ProjectIsolationManager {
  private static instance: ProjectIsolationManager;
  private projectCache = new Map<string, ProjectIdentification>();

  static getInstance(): ProjectIsolationManager {
    if (!ProjectIsolationManager.instance) {
      ProjectIsolationManager.instance = new ProjectIsolationManager();
    }
    return ProjectIsolationManager.instance;
  }

  /**
   * Get stable project identification based on git remote URL
   */
  getProjectIdentification(projectRoot: string): ProjectIdentification {
    const cacheKey = projectRoot;

    if (this.projectCache.has(cacheKey)) {
      return this.projectCache.get(cacheKey)!;
    }

    try {
      // Get git remote URL
      const remoteUrl = this.getGitRemoteUrl(projectRoot);
      const gitInfo = this.parseGitRemote(remoteUrl);

      // Create stable project ID from git remote
      const projectId = this.createStableProjectId(
        gitInfo.organization,
        gitInfo.repository
      );

      // Create workspace filter (stable across sessions)
      const workspaceFilter = this.createWorkspaceFilter(
        gitInfo.organization,
        gitInfo.repository,
        projectRoot
      );

      // Determine Linear configuration
      const linearConfig = this.getLinearConfiguration(
        gitInfo.organization,
        gitInfo.repository,
        projectRoot
      );

      const identification: ProjectIdentification = {
        projectId,
        organization: gitInfo.organization,
        repository: gitInfo.repository,
        workspaceFilter,
        linearTeamId: linearConfig.teamId,
        linearOrganization: linearConfig.organization,
        projectPrefix: linearConfig.prefix,
      };

      this.projectCache.set(cacheKey, identification);
      logger.info('Project identification created', {
        projectId: identification.projectId,
        workspaceFilter: identification.workspaceFilter,
        linearTeam: identification.linearTeamId,
      });

      return identification;
    } catch (error) {
      // Fallback for non-git projects
      logger.warn(
        'Could not determine git remote, using fallback identification',
        { error }
      );
      const fallback = this.createFallbackIdentification(projectRoot);
      this.projectCache.set(cacheKey, fallback);
      return fallback;
    }
  }

  /**
   * Find git repository root and get remote URL
   */
  private getGitRemoteUrl(projectRoot: string): string {
    try {
      // Find the git root directory (may be parent of current directory)
      const gitRoot = execSync('git rev-parse --show-toplevel', {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 5000,
      }).trim();

      // Get remote URL from git root
      const result = execSync('git config --get remote.origin.url', {
        cwd: gitRoot,
        encoding: 'utf8',
        timeout: 5000,
      });

      return result.trim();
    } catch (error) {
      throw new Error(`Failed to get git remote URL: ${error}`);
    }
  }

  /**
   * Get project name from git repository root directory
   */
  private getProjectNameFromGitRoot(projectRoot: string): string {
    try {
      const gitRoot = execSync('git rev-parse --show-toplevel', {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 5000,
      }).trim();

      // Get the folder name of the git root
      return gitRoot.split('/').pop() || 'unknown';
    } catch (error) {
      // Fallback to current directory name
      return projectRoot.split('/').pop() || 'unknown';
    }
  }

  /**
   * Parse git remote URL to extract organization and repository
   */
  private parseGitRemote(remoteUrl: string): {
    organization: string;
    repository: string;
  } {
    // Handle GitHub URLs (https and ssh)
    let match = remoteUrl.match(/github\.com[/:]([\w-]+)\/([\w-]+)(?:\.git)?/);
    if (match) {
      return {
        organization: match[1],
        repository: match[2],
      };
    }

    // Handle other git URLs
    match = remoteUrl.match(/[:/]([\w-]+)\/([\w-]+)(?:\.git)?$/);
    if (match) {
      return {
        organization: match[1],
        repository: match[2],
      };
    }

    throw new Error(`Could not parse git remote URL: ${remoteUrl}`);
  }

  /**
   * Create stable project ID from organization and repository
   */
  private createStableProjectId(
    organization: string,
    repository: string
  ): string {
    const content = `${organization}/${repository}`;
    const hash = createHash('sha256').update(content).digest('hex');
    return `proj-${hash.substring(0, 12)}`;
  }

  /**
   * Create stable workspace filter using git root folder name
   */
  private createWorkspaceFilter(
    organization: string,
    repository: string,
    projectRoot: string
  ): string {
    // Get dynamic project name from git root
    const projectName = this.getProjectNameFromGitRoot(projectRoot);

    // Use project name as primary filter, with organization fallback for uniqueness
    return `${projectName}:${organization}`;
  }

  /**
   * Get Linear configuration based on project
   */
  private getLinearConfiguration(
    organization: string,
    repository: string,
    projectRoot?: string
  ): {
    teamId?: string;
    organization?: string;
    prefix: string;
  } {
    // Get dynamic project name from git root
    const projectName = projectRoot
      ? this.getProjectNameFromGitRoot(projectRoot)
      : repository;

    // Project-specific Linear configurations
    const projectConfigs: Record<
      string,
      { teamId?: string; organization?: string; prefix: string }
    > = {
      'jonathanpeterwu/stackmemory': {
        teamId: process.env.LINEAR_TEAM_ID || 'stackmemory',
        organization: process.env.LINEAR_ORGANIZATION || 'stackmemoryai',
        prefix: 'SM',
      },
      'Lift-Coefficient/*': {
        teamId: 'STA',
        organization: 'lift-cl',
        prefix: 'STA',
      },
    };

    // Check for exact match
    const exactKey = `${organization}/${repository}`;
    if (projectConfigs[exactKey]) {
      return projectConfigs[exactKey];
    }

    // Check for organization wildcard match
    const wildcardKey = `${organization}/*`;
    if (projectConfigs[wildcardKey]) {
      return projectConfigs[wildcardKey];
    }

    // Default configuration using dynamic project name
    const sanitizedProjectName = projectName.replace(/[^a-zA-Z0-9]/g, '');
    return {
      teamId: sanitizedProjectName.toLowerCase(),
      organization: `${organization.toLowerCase()}ai`,
      prefix: sanitizedProjectName.substring(0, 3).toUpperCase(),
    };
  }

  /**
   * Create fallback identification for non-git projects
   */
  private createFallbackIdentification(
    projectRoot: string
  ): ProjectIdentification {
    const folderName = projectRoot.split('/').pop() || 'unknown';
    const projectId = this.createStableProjectId('local', folderName);

    return {
      projectId,
      organization: 'local',
      repository: folderName,
      workspaceFilter: `local:${folderName}`,
      linearTeamId: folderName.toLowerCase().replace(/[^a-z0-9]/g, ''),
      linearOrganization: 'local',
      projectPrefix: folderName.substring(0, 3).toUpperCase(),
    };
  }

  /**
   * Validate that current project isolation is working
   */
  validateProjectIsolation(projectRoot: string): boolean {
    try {
      const identification = this.getProjectIdentification(projectRoot);

      // Check that we have required fields
      if (!identification.projectId || !identification.workspaceFilter) {
        return false;
      }

      // Check that workspace filter is stable
      const secondCall = this.getProjectIdentification(projectRoot);
      if (identification.workspaceFilter !== secondCall.workspaceFilter) {
        return false;
      }

      return true;
    } catch (error) {
      logger.error('Project isolation validation failed', { error });
      return false;
    }
  }

  /**
   * Clear project cache (for testing)
   */
  clearCache(): void {
    this.projectCache.clear();
  }
}
