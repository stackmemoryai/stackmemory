import { Command } from 'commander';
import chalk from 'chalk';
import {
  canonicalStateStore,
  type SharedToolName,
} from '../../core/shared-state/canonical-store.js';
import {
  getCurrentRepoGitHubInfo,
  refreshCurrentRepoPullRequestState,
} from '../../integrations/github/pr-state.js';

function parseJsonObject(input: string | undefined): Record<string, unknown> {
  if (!input) {
    return {};
  }

  const parsed = JSON.parse(input);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object');
  }

  return parsed as Record<string, unknown>;
}

export function createStateCommand(): Command {
  const cmd = new Command('state').description(
    'Manage canonical user-scoped shared state across instances and sessions'
  );

  const instance = cmd.command('instance').description('Manage instance state');
  instance
    .command('upsert')
    .requiredOption('--id <id>', 'Instance identifier')
    .requiredOption(
      '--tool <tool>',
      'Tool name (claude|codex|opencode|stackmemory)'
    )
    .option('--session <id>', 'Session identifier')
    .option('--project <id>', 'Project identifier')
    .option('--project-path <path>', 'Project path')
    .option('--branch <branch>', 'Git branch')
    .option('--worktree-path <path>', 'Worktree path')
    .option('--pid <pid>', 'Process id')
    .option('--status <status>', 'Status', 'active')
    .option('--metadata <json>', 'Metadata JSON object')
    .action(async (options) => {
      const record = await canonicalStateStore.upsertInstance({
        instanceId: options.id,
        tool: options.tool as SharedToolName,
        sessionId: options.session,
        projectId: options.project,
        projectPath: options.projectPath,
        branch: options.branch,
        worktreePath: options.worktreePath,
        pid: options.pid ? Number(options.pid) : undefined,
        status: options.status,
        metadata: parseJsonObject(options.metadata),
      });

      console.log(JSON.stringify(record, null, 2));
    });

  instance
    .command('end')
    .requiredOption('--id <id>', 'Instance identifier')
    .action(async (options) => {
      await canonicalStateStore.endInstance(options.id);
      console.log(chalk.green(`Ended instance ${options.id}`));
    });

  const session = cmd.command('session').description('Manage session state');
  session
    .command('upsert')
    .requiredOption('--id <id>', 'Session identifier')
    .requiredOption(
      '--tool <tool>',
      'Tool name (claude|codex|opencode|stackmemory)'
    )
    .option('--project <id>', 'Project identifier')
    .option('--project-path <path>', 'Project path')
    .option('--branch <branch>', 'Git branch')
    .option('--instance <id>', 'Associated instance identifier')
    .option('--status <status>', 'Status', 'active')
    .option('--metadata <json>', 'Metadata JSON object')
    .action(async (options) => {
      const record = await canonicalStateStore.upsertSession({
        sessionId: options.id,
        tool: options.tool as SharedToolName,
        projectId: options.project,
        projectPath: options.projectPath,
        branch: options.branch,
        instanceId: options.instance,
        status: options.status,
        metadata: parseJsonObject(options.metadata),
      });

      console.log(JSON.stringify(record, null, 2));
    });

  session
    .command('end')
    .requiredOption('--id <id>', 'Session identifier')
    .option('--status <status>', 'Status', 'closed')
    .action(async (options) => {
      await canonicalStateStore.endSession(options.id, options.status);
      console.log(chalk.green(`Ended session ${options.id}`));
    });

  cmd
    .command('event')
    .description('Append a shared-state event')
    .requiredOption('--type <type>', 'Event type')
    .option('--tool <tool>', 'Tool name (claude|codex|opencode|stackmemory)')
    .option('--instance <id>', 'Instance identifier')
    .option('--session <id>', 'Session identifier')
    .option('--project <id>', 'Project identifier')
    .option('--project-path <path>', 'Project path')
    .option('--branch <branch>', 'Git branch')
    .option('--payload <json>', 'Payload JSON object')
    .action(async (options) => {
      const event = await canonicalStateStore.appendEvent({
        type: options.type,
        tool: options.tool as SharedToolName | undefined,
        instanceId: options.instance,
        sessionId: options.session,
        projectId: options.project,
        projectPath: options.projectPath,
        branch: options.branch,
        payload: parseJsonObject(options.payload),
      });

      console.log(JSON.stringify(event, null, 2));
    });

  cmd
    .command('show')
    .description('Show canonical shared state for a project')
    .option('--project <id>', 'Project identifier')
    .option('--project-path <path>', 'Project path')
    .option('--limit <count>', 'Recent event limit', '10')
    .option('--json', 'Emit JSON output')
    .action(async (options) => {
      const summary = await canonicalStateStore.getProjectSummary({
        projectId: options.project,
        projectPath: options.projectPath,
        eventLimit: Number(options.limit),
      });

      if (options.json) {
        console.log(JSON.stringify(summary, null, 2));
        return;
      }

      console.log(chalk.bold('Canonical Shared State'));
      console.log(
        `  Active sessions: ${summary.activeSessions.length} | Active instances: ${summary.activeInstances.length} | Active claims: ${summary.activeClaims.length}`
      );
      if (summary.projectId) {
        console.log(`  Project: ${summary.projectId}`);
      }
      if (summary.activeSessions.length > 0) {
        console.log(chalk.bold('\nSessions'));
        for (const record of summary.activeSessions) {
          console.log(
            `  ${record.sessionId.slice(0, 8)} ${record.tool} ${record.branch || ''}`.trim()
          );
        }
      }
      if (summary.activeInstances.length > 0) {
        console.log(chalk.bold('\nInstances'));
        for (const record of summary.activeInstances) {
          console.log(
            `  ${record.instanceId} ${record.tool} ${record.branch || ''}`.trim()
          );
        }
      }
      if (summary.activeClaims.length > 0) {
        console.log(chalk.bold('\nClaims'));
        for (const claim of summary.activeClaims) {
          const scopes = [
            claim.branch ? `branch:${claim.branch}` : '',
            ...claim.paths.map((item) => `path:${item}`),
          ]
            .filter(Boolean)
            .join(', ');
          console.log(
            `  ${claim.claimId.slice(0, 8)} ${claim.tool} ${scopes || '(no scope)'}`.trim()
          );
        }
      }
      if (summary.recentEvents.length > 0) {
        console.log(chalk.bold('\nRecent events'));
        for (const event of summary.recentEvents) {
          console.log(
            `  ${event.type} ${new Date(event.timestamp).toISOString()}`
          );
        }
      }
    });

  const claims = cmd
    .command('claims')
    .description('Manage shared ownership claims');

  claims
    .command('claim')
    .requiredOption(
      '--tool <tool>',
      'Tool name (claude|codex|opencode|stackmemory)'
    )
    .option('--session <id>', 'Session identifier')
    .option('--instance <id>', 'Instance identifier')
    .option('--project <id>', 'Project identifier')
    .option('--project-path <path>', 'Project path')
    .option('--branch <branch>', 'Git branch')
    .option('--path <path...>', 'Claimed file or directory path(s)')
    .option('--ttl-ms <ttl>', 'Time to live in milliseconds', '86400000')
    .option('--metadata <json>', 'Metadata JSON object')
    .option('--json', 'Emit JSON output')
    .action(async (options) => {
      const result = await canonicalStateStore.claimPaths({
        tool: options.tool as SharedToolName,
        sessionId: options.session,
        instanceId: options.instance,
        projectId: options.project,
        projectPath: options.projectPath,
        branch: options.branch,
        paths: options.path || [],
        ttlMs: Number(options.ttlMs),
        metadata: parseJsonObject(options.metadata),
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(chalk.green(`Claimed ${result.record.claimId.slice(0, 8)}`));
      if (result.conflicts.length > 0) {
        console.log(chalk.yellow(`Conflicts: ${result.conflicts.length}`));
        for (const conflict of result.conflicts) {
          console.log(
            `  ${conflict.claimId.slice(0, 8)} ${conflict.branch || ''} ${conflict.paths.join(', ')}`.trim()
          );
        }
      }
    });

  claims
    .command('release')
    .option('--claim <id>', 'Claim identifier')
    .option('--session <id>', 'Session identifier')
    .option('--instance <id>', 'Instance identifier')
    .option('--project <id>', 'Project identifier')
    .option('--project-path <path>', 'Project path')
    .option('--branch <branch>', 'Git branch')
    .option('--reason <reason>', 'Release reason')
    .action(async (options) => {
      const released = await canonicalStateStore.releaseClaims({
        claimId: options.claim,
        sessionId: options.session,
        instanceId: options.instance,
        projectId: options.project,
        projectPath: options.projectPath,
        branch: options.branch,
        reason: options.reason,
      });
      console.log(chalk.green(`Released ${released} claim(s)`));
    });

  claims
    .command('show')
    .option('--project <id>', 'Project identifier')
    .option('--project-path <path>', 'Project path')
    .option('--all', 'Show released and expired claims too')
    .option('--json', 'Emit JSON output')
    .action(async (options) => {
      const records = await canonicalStateStore.listPathClaims({
        projectId: options.project,
        projectPath: options.projectPath,
        activeOnly: !options.all,
      });

      if (options.json) {
        console.log(JSON.stringify(records, null, 2));
        return;
      }

      if (records.length === 0) {
        console.log(chalk.yellow('No claims found'));
        return;
      }

      for (const claim of records) {
        const scopes = [
          claim.branch ? `branch:${claim.branch}` : '',
          ...claim.paths.map((item) => `path:${item}`),
        ]
          .filter(Boolean)
          .join(', ');
        console.log(
          `${claim.claimId.slice(0, 8)} ${claim.status} ${claim.tool} ${scopes || '(no scope)'}`
        );
      }
    });

  const github = cmd.command('github').description('GitHub projection state');

  github
    .command('refresh')
    .description('Refresh current repo branch PR state from GitHub CLI')
    .option('--json', 'Emit JSON output')
    .action(async (options) => {
      const projection = await refreshCurrentRepoPullRequestState();
      if (!projection) {
        console.log(
          chalk.yellow(
            'No GitHub PR projection available for current repo/branch'
          )
        );
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(projection, null, 2));
        return;
      }

      console.log(chalk.green(`Refreshed PR #${projection.prNumber}`));
      console.log(`${projection.state} ${projection.title}`);
      console.log(projection.url);
    });

  github
    .command('show')
    .description('Show cached current repo branch PR projection')
    .option('--json', 'Emit JSON output')
    .action(async (options) => {
      const info = getCurrentRepoGitHubInfo();
      if (!info) {
        console.log(chalk.yellow('Not in a GitHub repository'));
        return;
      }

      const projection = await canonicalStateStore.getGitHubPullRequest({
        repo: info.repo,
        branch: info.branch,
      });
      if (!projection) {
        console.log(
          chalk.yellow('No cached GitHub PR projection for current branch')
        );
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(projection, null, 2));
        return;
      }

      console.log(chalk.bold(`PR #${projection.prNumber}`));
      console.log(`${projection.state} ${projection.title}`);
      console.log(`Repo: ${projection.repo}`);
      console.log(
        `Branch: ${projection.headRefName} -> ${projection.baseRefName}`
      );
      if (projection.reviewDecision) {
        console.log(`Review: ${projection.reviewDecision}`);
      }
      if (projection.statusCheckRollup) {
        console.log(`Checks: ${projection.statusCheckRollup}`);
      }
      console.log(`Synced: ${new Date(projection.lastSyncedAt).toISOString()}`);
      console.log(projection.url);
    });

  return cmd;
}

export default createStateCommand;
