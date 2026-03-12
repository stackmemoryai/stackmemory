/**
 * Linear Workspace Migration Tool
 * Migrates all tasks from one Linear workspace to another
 */

import { LinearRestClient } from './rest-client.js';
import { logger } from '../../core/monitoring/logger.js';
import { IntegrationError, ErrorCode } from '../../core/errors/index.js';
import chalk from 'chalk';

export interface MigrationConfig {
  sourceApiKey: string;
  targetApiKey: string;
  dryRun?: boolean;
  includeStates?: string[]; // Filter by state
  taskPrefix?: string; // Only migrate tasks with this identifier prefix (e.g., "STA-")
  deleteFromSource?: boolean; // Delete tasks from source after successful migration
  batchSize?: number;
  delayMs?: number; // Delay between API calls
}

export interface MigrationResult {
  totalTasks: number;
  exported: number;
  imported: number;
  failed: number;
  deleted: number;
  deleteFailed: number;
  errors: string[];
  taskMappings: Array<{
    sourceId: string;
    sourceIdentifier: string;
    targetId?: string;
    targetIdentifier?: string;
    deleted?: boolean;
    error?: string;
  }>;
}

export class LinearMigrator {
  private sourceClient: LinearRestClient;
  private targetClient: LinearRestClient;
  private config: MigrationConfig;

  constructor(config: MigrationConfig) {
    this.config = config;
    this.sourceClient = new LinearRestClient(config.sourceApiKey);
    this.targetClient = new LinearRestClient(config.targetApiKey);
  }

  /**
   * Test connections to both workspaces
   */
  async testConnections(): Promise<{
    source: { success: boolean; info?: any; error?: string };
    target: { success: boolean; info?: any; error?: string };
  }> {
    const result: {
      source: {
        success: boolean;
        info?: Record<string, unknown>;
        error?: string;
      };
      target: {
        success: boolean;
        info?: Record<string, unknown>;
        error?: string;
      };
    } = {
      source: { success: false },
      target: { success: false },
    };

    // Test source connection
    try {
      const sourceViewer = await this.sourceClient.getViewer();
      const sourceTeam = await this.sourceClient.getTeam();
      result.source = {
        success: true,
        info: {
          user: sourceViewer,
          team: sourceTeam,
        },
      };
    } catch (error: unknown) {
      result.source = {
        success: false,
        error: (error as Error).message,
      };
    }

    // Test target connection
    try {
      const targetViewer = await this.targetClient.getViewer();
      const targetTeam = await this.targetClient.getTeam();
      result.target = {
        success: true,
        info: {
          user: targetViewer,
          team: targetTeam,
        },
      };
    } catch (error: unknown) {
      result.target = {
        success: false,
        error: (error as Error).message,
      };
    }

    return result;
  }

  /**
   * Migrate all tasks from source to target workspace
   */
  async migrate(): Promise<MigrationResult> {
    const result: MigrationResult = {
      totalTasks: 0,
      exported: 0,
      imported: 0,
      failed: 0,
      deleted: 0,
      deleteFailed: 0,
      errors: [],
      taskMappings: [],
    };

    try {
      console.log(chalk.yellow('Starting Linear workspace migration...'));

      // Get all tasks from source
      const sourceTasks = await this.sourceClient.getAllTasks(true); // Force refresh
      result.totalTasks = sourceTasks.length;
      console.log(
        chalk.cyan(`Found ${sourceTasks.length} tasks in source workspace`)
      );

      // Filter by prefix (e.g., "STA-" tasks only)
      let tasksToMigrate = sourceTasks;
      if (this.config.taskPrefix) {
        tasksToMigrate = sourceTasks.filter((task: any) =>
          task.identifier.startsWith(this.config.taskPrefix!)
        );
        console.log(
          chalk.cyan(
            `Filtered to ${tasksToMigrate.length} tasks with prefix "${this.config.taskPrefix}"`
          )
        );
      }

      // Filter by states if specified
      if (this.config.includeStates?.length) {
        tasksToMigrate = tasksToMigrate.filter((task: any) =>
          this.config.includeStates!.includes(task.state.type)
        );
        const stateStr = this.config.includeStates.join(', ');
        console.log(
          chalk.cyan(
            `Further filtered to ${tasksToMigrate.length} tasks matching states: ${stateStr}`
          )
        );
      }

      result.exported = tasksToMigrate.length;

      if (this.config.dryRun) {
        console.log(chalk.yellow('DRY RUN - No tasks will be created'));
        tasksToMigrate.forEach((task) => {
          result.taskMappings.push({
            sourceId: task.id,
            sourceIdentifier: task.identifier,
            targetId: 'DRY_RUN',
            targetIdentifier: 'DRY_RUN',
          });
        });
        result.imported = tasksToMigrate.length;
        return result;
      }

      // Get target team info
      const targetTeam = await this.targetClient.getTeam();
      console.log(
        chalk.cyan(`Target team: ${targetTeam.name} (${targetTeam.key})`)
      );

      // Migrate tasks in batches
      const batchSize = this.config.batchSize || 5;
      const delayMs = this.config.delayMs || 2000;

      for (let i = 0; i < tasksToMigrate.length; i += batchSize) {
        const batch = tasksToMigrate.slice(i, i + batchSize);
        console.log(
          chalk.yellow(
            `Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(tasksToMigrate.length / batchSize)}`
          )
        );

        for (const task of batch) {
          try {
            const newTask = await this.migrateTask(task, targetTeam.id);
            const mapping = {
              sourceId: task.id,
              sourceIdentifier: task.identifier,
              targetId: newTask.id,
              targetIdentifier: newTask.identifier,
              deleted: false,
            };

            result.imported++;
            console.log(
              chalk.green(
                `${task.identifier} → ${newTask.identifier}: ${task.title}`
              )
            );

            // Delete from source if configured
            if (this.config.deleteFromSource) {
              try {
                await this.deleteTask(task.id);
                mapping.deleted = true;
                result.deleted++;
                console.log(
                  chalk.gray(`Deleted ${task.identifier} from source`)
                );
              } catch (deleteError: unknown) {
                result.deleteFailed++;
                result.errors.push(
                  `Delete failed for ${task.identifier}: ${(deleteError as Error).message}`
                );
                console.log(
                  chalk.yellow(
                    `Failed to delete ${task.identifier} from source: ${(deleteError as Error).message}`
                  )
                );
              }
            }

            result.taskMappings.push(mapping);
          } catch (error: unknown) {
            const errorMsg = (error as Error).message;
            result.errors.push(`${task.identifier}: ${errorMsg}`);
            result.taskMappings.push({
              sourceId: task.id,
              sourceIdentifier: task.identifier,
              error: errorMsg,
            });
            result.failed++;
            console.log(chalk.red(`${task.identifier}: ${errorMsg}`));
          }
        }

        // Delay between batches to avoid rate limits
        if (i + batchSize < tasksToMigrate.length) {
          console.log(chalk.gray(`Waiting ${delayMs}ms before next batch...`));
          await this.delay(delayMs);
        }
      }
    } catch (error: unknown) {
      result.errors.push(`Migration failed: ${(error as Error).message}`);
      logger.error('Migration failed:', error as Error);
    }

    return result;
  }

  /**
   * Migrate a single task
   */
  private async migrateTask(
    sourceTask: any,
    targetTeamId: string
  ): Promise<any> {
    // Map states from source to target format
    const _stateMapping: Record<string, string> = {
      backlog: 'backlog',
      unstarted: 'unstarted',
      started: 'started',
      completed: 'completed',
      canceled: 'canceled',
    };

    // Create task in target workspace using GraphQL
    const createTaskQuery = `
      mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue {
            id
            identifier
            title
            description
            state {
              id
              name
              type
            }
            priority
            createdAt
            updatedAt
            url
          }
        }
      }
    `;

    // Prepare task input
    const taskInput = {
      title: `[MIGRATED] ${sourceTask.title}`,
      description: this.formatMigratedDescription(sourceTask),
      teamId: targetTeamId,
      priority: this.mapPriority(sourceTask.priority),
    };

    const response = await this.targetClient.makeRequest<{
      data: {
        issueCreate: {
          success: boolean;
          issue: any;
        };
      };
    }>(createTaskQuery, { input: taskInput });

    if (!response.data?.issueCreate?.success) {
      throw new IntegrationError(
        'Failed to create task in target workspace',
        ErrorCode.LINEAR_SYNC_FAILED,
        { sourceTaskId: sourceTask.id, sourceIdentifier: sourceTask.identifier }
      );
    }

    return response.data.issueCreate.issue;
  }

  /**
   * Format description with migration context
   */
  private formatMigratedDescription(sourceTask: any): string {
    let description = sourceTask.description || '';

    description += `\n\n---\n**Migration Info:**\n`;
    description += `- Original ID: ${sourceTask.identifier}\n`;
    description += `- Migrated: ${new Date().toISOString()}\n`;
    description += `- Original State: ${sourceTask.state.name}\n`;

    if (sourceTask.assignee) {
      description += `- Original Assignee: ${sourceTask.assignee.name}\n`;
    }

    if (sourceTask.estimate) {
      description += `- Original Estimate: ${sourceTask.estimate} points\n`;
    }

    return description;
  }

  /**
   * Map priority values
   */
  private mapPriority(priority?: number): number {
    // Linear priorities: 0=none, 1=urgent, 2=high, 3=medium, 4=low
    return priority || 0;
  }

  /**
   * Delete a task from the source workspace
   */
  private async deleteTask(taskId: string): Promise<void> {
    const deleteQuery = `
      mutation DeleteIssue($id: String!) {
        issueDelete(id: $id) {
          success
        }
      }
    `;

    const response = await (
      this.sourceClient as unknown as {
        makeRequest: (
          query: string,
          vars: Record<string, string>
        ) => Promise<{ data?: { issueDelete?: { success: boolean } } }>;
      }
    ).makeRequest(deleteQuery, {
      id: taskId,
    });

    if (!response.data?.issueDelete?.success) {
      throw new IntegrationError(
        'Failed to delete task from source workspace',
        ErrorCode.LINEAR_SYNC_FAILED,
        { taskId }
      );
    }
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * CLI function to run migration
 */
export async function runMigration(config: MigrationConfig): Promise<void> {
  const migrator = new LinearMigrator(config);

  console.log(chalk.blue('Testing connections...'));
  const connectionTest = await migrator.testConnections();

  if (!connectionTest.source.success) {
    console.error(
      chalk.red(`Source connection failed: ${connectionTest.source.error}`)
    );
    return;
  }

  if (!connectionTest.target.success) {
    console.error(
      chalk.red(`Target connection failed: ${connectionTest.target.error}`)
    );
    return;
  }

  console.log(chalk.green('Both connections successful'));
  console.log(
    chalk.cyan(
      `Source: ${connectionTest.source.info.user.name} @ ${connectionTest.source.info.team.name}`
    )
  );
  console.log(
    chalk.cyan(
      `Target: ${connectionTest.target.info.user.name} @ ${connectionTest.target.info.team.name}`
    )
  );

  const result = await migrator.migrate();

  console.log(chalk.blue('\nMigration Summary:'));
  console.log(`  Total tasks: ${result.totalTasks}`);
  console.log(`  Exported: ${result.exported}`);
  console.log(chalk.green(`  Imported: ${result.imported}`));
  console.log(chalk.red(`  Failed: ${result.failed}`));
  if (config.deleteFromSource) {
    console.log(chalk.gray(`  Deleted: ${result.deleted}`));
    if (result.deleteFailed > 0) {
      console.log(chalk.yellow(`  Delete failed: ${result.deleteFailed}`));
    }
  }

  if (result.errors.length > 0) {
    console.log(chalk.red('\nErrors:'));
    result.errors.forEach((error) => console.log(chalk.red(`  - ${error}`)));
  }

  if (result.imported > 0) {
    console.log(
      chalk.green(
        `\nMigration completed! ${result.imported} tasks migrated successfully.`
      )
    );
    if (config.deleteFromSource && result.deleted > 0) {
      console.log(
        chalk.gray(`   ${result.deleted} tasks deleted from source workspace.`)
      );
    }
  }
}
