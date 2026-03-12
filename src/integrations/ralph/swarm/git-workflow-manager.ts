/**
 * Git Workflow Manager for Swarm Agents
 * Manages git operations, branching, and commits for each agent
 */

import { execSync } from 'child_process';
import { logger } from '../../../core/monitoring/logger.js';
import { Agent, SwarmTask } from '../types.js';

export class GitWorkflowError extends Error {
  constructor(
    message: string,
    public context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'GitWorkflowError';
  }
}

export interface GitConfig {
  enableGitWorkflow: boolean;
  branchStrategy: 'feature' | 'agent' | 'task';
  autoCommit: boolean;
  commitFrequency: number; // minutes
  mergStrategy: 'squash' | 'merge' | 'rebase';
  requirePR: boolean;
}

export class GitWorkflowManager {
  private config: GitConfig;
  private agentBranches: Map<string, string> = new Map();
  private baselineBranch: string;
  private mainBranch: string;

  constructor(config?: Partial<GitConfig>) {
    this.config = {
      enableGitWorkflow: true,
      branchStrategy: 'agent',
      autoCommit: true,
      commitFrequency: 5,
      mergStrategy: 'squash',
      requirePR: false,
      ...config,
    };

    // Get current branch as baseline
    try {
      this.baselineBranch = this.getCurrentBranch();
      this.mainBranch = this.getMainBranch();
    } catch {
      logger.warn('Git not initialized, workflow features disabled');
      this.config.enableGitWorkflow = false;
    }
  }

  /**
   * Initialize git workflow for an agent
   */
  async initializeAgentWorkflow(agent: Agent, task: SwarmTask): Promise<void> {
    if (!this.config.enableGitWorkflow) return;

    let branchName = this.generateBranchName(agent, task);

    try {
      // Check if branch already exists and handle accordingly
      if (this.branchExists(branchName)) {
        // Branch exists, either reuse or create unique name
        const existingHasChanges = this.branchHasUnmergedChanges(branchName);

        if (existingHasChanges) {
          // Create a unique branch name by adding timestamp
          const timestamp = Date.now();
          branchName = `${branchName}-${timestamp}`;
          logger.info(
            `Branch already exists with changes, creating unique branch: ${branchName}`
          );
          this.createBranch(branchName);
        } else {
          // Reuse existing branch
          logger.info(
            `Reusing existing branch for agent ${agent.role}: ${branchName}`
          );
          this.checkoutBranch(branchName);
        }
      } else {
        // Create new branch
        this.createBranch(branchName);
        logger.info(
          `Created git branch for agent ${agent.role}: ${branchName}`
        );
      }

      this.agentBranches.set(agent.id, branchName);

      // Set up commit timer if auto-commit enabled
      if (this.config.autoCommit) {
        this.scheduleAutoCommit(agent, task);
      }
    } catch (error: unknown) {
      logger.error(
        `Failed to initialize git workflow for agent ${agent.role}`,
        error as Error
      );
    }
  }

  /**
   * Commit agent work
   */
  async commitAgentWork(
    agent: Agent,
    task: SwarmTask,
    message?: string
  ): Promise<void> {
    if (!this.config.enableGitWorkflow) return;

    const branchName = this.agentBranches.get(agent.id);
    if (!branchName) {
      logger.warn(`No branch found for agent ${agent.id}`);
      return;
    }

    try {
      // Ensure we're on the agent's branch
      this.checkoutBranch(branchName);

      // Check for changes
      const hasChanges = this.hasUncommittedChanges();
      if (!hasChanges) {
        logger.debug(`No changes to commit for agent ${agent.role}`);
        return;
      }

      // Stage all changes
      execSync('git add -A', { encoding: 'utf8' });

      // Generate commit message
      const commitMessage = message || this.generateCommitMessage(agent, task);

      // Commit changes
      execSync(`git commit -m "${commitMessage}"`, { encoding: 'utf8' });

      logger.info(`Agent ${agent.role} committed: ${commitMessage}`);

      // Push if remote exists
      if (this.hasRemote()) {
        try {
          execSync(`git push origin ${branchName}`, { encoding: 'utf8' });
          logger.info(`Pushed branch ${branchName} to remote`);
        } catch (error) {
          logger.warn(`Could not push to remote: ${error}`);
        }
      }
    } catch (error: unknown) {
      logger.error(`Failed to commit agent work`, error as Error);
    }
  }

  /**
   * Merge agent work back to baseline
   */
  async mergeAgentWork(agent: Agent, task: SwarmTask): Promise<void> {
    if (!this.config.enableGitWorkflow) return;

    const branchName = this.agentBranches.get(agent.id);
    if (!branchName) {
      logger.warn(`No branch found for agent ${agent.id}`);
      return;
    }

    try {
      // Switch to baseline branch
      this.checkoutBranch(this.baselineBranch);

      if (this.config.requirePR) {
        // Create pull request
        await this.createPullRequest(agent, task, branchName);
      } else {
        // Direct merge based on strategy
        this.mergeBranch(branchName);
        logger.info(`Merged agent ${agent.role} work from ${branchName}`);
      }

      // Clean up branch
      this.deleteBranch(branchName);
      this.agentBranches.delete(agent.id);
    } catch (error: unknown) {
      logger.error(`Failed to merge agent work`, error as Error);
    }
  }

  /**
   * Coordinate merges between multiple agents
   */
  async coordinateMerges(agents: Agent[]): Promise<void> {
    if (!this.config.enableGitWorkflow) return;

    logger.info('Coordinating merges from all agents');

    // Create integration branch
    const integrationBranch = `swarm-integration-${Date.now()}`;
    this.createBranch(integrationBranch);

    // Merge each agent's work
    for (const agent of agents) {
      const branchName = this.agentBranches.get(agent.id);
      if (branchName && this.branchExists(branchName)) {
        try {
          this.mergeBranch(branchName);
          logger.info(`Integrated ${agent.role} work`);
        } catch (error) {
          logger.error(`Failed to integrate ${agent.role} work: ${error}`);
        }
      }
    }

    // Run tests on integration branch
    const testsPass = await this.runIntegrationTests();

    if (testsPass) {
      // Merge to baseline
      this.checkoutBranch(this.baselineBranch);
      this.mergeBranch(integrationBranch);
      logger.info('Successfully integrated all agent work');
    } else {
      logger.warn(
        'Integration tests failed, keeping changes in branch: ' +
          integrationBranch
      );
    }
  }

  /**
   * Handle merge conflicts
   */
  async resolveConflicts(agent: Agent): Promise<void> {
    const conflicts = this.getConflictedFiles();

    if (conflicts.length === 0) return;

    logger.warn(
      `Agent ${agent.role} encountering merge conflicts: ${conflicts.join(', ')}`
    );

    // Strategy 1: Try to auto-resolve
    for (const file of conflicts) {
      try {
        // Accept current changes for agent's own files
        if (this.isAgentFile(file, agent)) {
          execSync(`git checkout --ours ${file}`, { encoding: 'utf8' });
          execSync(`git add ${file}`, { encoding: 'utf8' });
        } else {
          // Accept incoming changes for other files
          execSync(`git checkout --theirs ${file}`, { encoding: 'utf8' });
          execSync(`git add ${file}`, { encoding: 'utf8' });
        }
      } catch {
        logger.error(`Could not auto-resolve conflict in ${file}`);
      }
    }

    // Complete merge if all conflicts resolved
    const remainingConflicts = this.getConflictedFiles();
    if (remainingConflicts.length === 0) {
      execSync('git commit --no-edit', { encoding: 'utf8' });
      logger.info('All conflicts resolved automatically');
    } else {
      logger.error(
        `Manual intervention needed for: ${remainingConflicts.join(', ')}`
      );
    }
  }

  // Private helper methods
  private getCurrentBranch(): string {
    try {
      return execSync('git rev-parse --abbrev-ref HEAD', {
        encoding: 'utf8',
      }).trim();
    } catch (error: unknown) {
      logger.warn('Failed to get current branch', error as Error);
      return 'main';
    }
    return execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf8',
    }).trim();
  }

  private getMainBranch(): string {
    try {
      const branches = execSync('git branch -r', { encoding: 'utf8' });
      if (branches.includes('origin/main')) return 'main';
      if (branches.includes('origin/master')) return 'master';
    } catch (error: unknown) {
      logger.debug('Could not detect main branch from remotes', error as Error);
    }
    return this.getCurrentBranch();
  }

  private generateBranchName(agent: Agent, task: SwarmTask): string {
    const sanitizedTitle = task.title
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .substring(0, 30);

    switch (this.config.branchStrategy) {
      case 'feature':
        return `feature/${sanitizedTitle}`;
      case 'task':
        return `task/${task.id}`;
      case 'agent':
      default:
        return `swarm/${agent.role}-${sanitizedTitle}`;
    }
  }

  private createBranch(branchName: string): void {
    try {
      // Check if branch already exists and delete it for clean test runs
      try {
        // First check if this is the current branch
        const currentBranch = execSync('git branch --show-current', {
          encoding: 'utf8',
        }).trim();
        if (currentBranch === branchName) {
          // Switch to main/master before deleting
          try {
            execSync('git checkout main', { encoding: 'utf8' });
          } catch {
            execSync('git checkout master', { encoding: 'utf8' });
          }
        }

        // Remove any worktrees using this branch
        try {
          const worktrees = execSync('git worktree list --porcelain', {
            encoding: 'utf8',
          });
          const lines = worktrees.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (
              lines[i].startsWith('branch ') &&
              lines[i].includes(branchName)
            ) {
              const worktreetPath = lines[i - 1].replace('worktree ', '');
              execSync(`git worktree remove --force "${worktreetPath}"`, {
                encoding: 'utf8',
              });
              logger.info(
                `Removed worktree at ${worktreetPath} for branch ${branchName}`
              );
            }
          }
        } catch (worktreeError) {
          logger.warn(
            'Failed to check/remove worktrees',
            worktreeError as Error
          );
        }

        execSync(`git branch -D ${branchName}`, { encoding: 'utf8' });
        logger.info(`Deleted existing branch ${branchName} for fresh start`);
      } catch {
        // Branch doesn't exist, which is fine
      }

      execSync(`git checkout -b ${branchName}`, { encoding: 'utf8' });
    } catch (error: unknown) {
      logger.error(`Failed to create branch ${branchName}`, error as Error);
      throw new GitWorkflowError(`Failed to create branch: ${branchName}`, {
        branchName,
      });
    }
  }

  private checkoutBranch(branchName: string): void {
    try {
      execSync(`git checkout ${branchName}`, { encoding: 'utf8' });
    } catch (error: unknown) {
      logger.error(`Failed to checkout branch ${branchName}`, error as Error);
      throw new GitWorkflowError(`Failed to checkout branch: ${branchName}`, {
        branchName,
      });
    }
  }

  private branchExists(branchName: string): boolean {
    try {
      execSync(`git rev-parse --verify ${branchName}`, {
        encoding: 'utf8',
        stdio: 'pipe',
      });
      return true;
    } catch {
      return false;
    }
  }

  private deleteBranch(branchName: string): void {
    try {
      execSync(`git branch -d ${branchName}`, { encoding: 'utf8' });
    } catch {
      // Force delete if needed
      execSync(`git branch -D ${branchName}`, { encoding: 'utf8' });
    }
  }

  private mergeBranch(branchName: string): void {
    const strategy = this.config.mergStrategy;

    switch (strategy) {
      case 'squash':
        execSync(`git merge --squash ${branchName}`, { encoding: 'utf8' });
        execSync('git commit -m "Squashed agent changes"', {
          encoding: 'utf8',
        });
        break;
      case 'rebase':
        execSync(`git rebase ${branchName}`, { encoding: 'utf8' });
        break;
      case 'merge':
      default:
        execSync(`git merge ${branchName}`, { encoding: 'utf8' });
        break;
    }
  }

  private hasUncommittedChanges(): boolean {
    try {
      const status = execSync('git status --porcelain', { encoding: 'utf8' });
      return status.trim().length > 0;
    } catch (error: unknown) {
      logger.warn('Failed to check git status', error as Error);
      return false;
    }
  }

  private hasRemote(): boolean {
    try {
      execSync('git remote get-url origin', { encoding: 'utf8' });
      return true;
    } catch {
      return false;
    }
  }

  private getConflictedFiles(): string[] {
    try {
      const conflicts = execSync('git diff --name-only --diff-filter=U', {
        encoding: 'utf8',
      });
      return conflicts
        .trim()
        .split('\n')
        .filter((f) => f.length > 0);
    } catch {
      return [];
    }
  }

  private isAgentFile(file: string, agent: Agent): boolean {
    if (!file || !agent?.role || !agent?.id) {
      return false;
    }
    return file.includes(agent.role) || file.includes(agent.id);
  }

  private generateCommitMessage(agent: Agent, task: SwarmTask): string {
    const role = agent?.role || 'agent';
    const title = task?.title || 'task';
    const iteration = agent?.performance?.tasksCompleted || 1;
    return `[${role}] ${title} - Iteration ${iteration}`;
  }

  private scheduleAutoCommit(agent: Agent, task: SwarmTask): void {
    const intervalMs = this.config.commitFrequency * 60 * 1000;

    setInterval(async () => {
      await this.commitAgentWork(
        agent,
        task,
        `[${agent.role}] Auto-commit: ${task.title}`
      );
    }, intervalMs);
  }

  private async createPullRequest(
    agent: Agent,
    task: SwarmTask,
    _branchName: string
  ): Promise<void> {
    try {
      const title = `[Swarm ${agent.role}] ${task.title}`;
      const body = `
## Agent: ${agent.role}
## Task: ${task.title}

### Acceptance Criteria:
${task.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}

### Status:
- Tasks Completed: ${agent.performance?.tasksCompleted || 0}
- Success Rate: ${agent.performance?.successRate || 0}%

Generated by Swarm Coordinator
      `;

      execSync(
        `gh pr create --title "${title}" --body "${body}" --base ${this.baselineBranch}`,
        {
          encoding: 'utf8',
        }
      );

      logger.info(`Created PR for agent ${agent.role}`);
    } catch (error) {
      logger.warn(`Could not create PR: ${error}`);
    }
  }

  private async runIntegrationTests(): Promise<boolean> {
    try {
      // Try to run tests
      execSync('npm test', { encoding: 'utf8' });
      return true;
    } catch {
      // Tests failed or not available
      return false;
    }
  }

  private branchHasUnmergedChanges(branchName: string): boolean {
    try {
      // Check if branch has commits not in the current branch
      const currentBranch = this.getCurrentBranch();
      const unmerged = execSync(
        `git log ${currentBranch}..${branchName} --oneline`,
        { encoding: 'utf8', stdio: 'pipe' }
      );
      return unmerged.trim().length > 0;
    } catch {
      // If we can't determine, assume it has changes to be safe
      return true;
    }
  }

  /**
   * Get status of all agent branches
   */
  getGitStatus(): object {
    const status: any = {
      enabled: this.config.enableGitWorkflow,
      currentBranch: this.getCurrentBranch(),
      agentBranches: Array.from(this.agentBranches.entries()).map(
        ([agentId, branch]) => ({
          agentId,
          branch,
          exists: this.branchExists(branch),
        })
      ),
      hasUncommittedChanges: this.hasUncommittedChanges(),
    };

    return status;
  }
}

export const gitWorkflowManager = new GitWorkflowManager();
