/**
 * Workflow command for StackMemory
 * Manages workflow templates and execution
 */

import { Command } from 'commander';
import chalk from 'chalk';
import * as path from 'path';
import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { FrameManager } from '../../core/context/frame-manager';
import { WorkflowTemplates, WorkflowTemplate } from '../../core/frame/workflow-templates';
import ora from 'ora';
import inquirer from 'inquirer';
import * as fs from 'fs/promises';

export function createWorkflowCommand(): Command {
  const cmd = new Command('workflow')
    .description('Manage structured workflow templates')
    .option('-l, --list', 'List available workflow templates')
    .option('-s, --start <template>', 'Start a new workflow from template')
    .option('-t, --transition', 'Transition to next phase in active workflow')
    .option('--status', 'Show status of active workflow')
    .option('--validate', 'Validate current phase requirements')
    .option('--abandon', 'Abandon current workflow')
    .action(async (options) => {
      const spinner = ora();

      try {
        const projectRoot = await getProjectRoot();
        const dbPath = path.join(
          projectRoot,
          '.stackmemory',
          'db',
          'stackmemory.db'
        );

        // Check if StackMemory is initialized
        try {
          await fs.access(dbPath);
        } catch {
          console.error(chalk.red('✗ StackMemory not initialized'));
          console.log(chalk.yellow('Run: stackmemory init'));
          process.exit(1);
        }

        const db = new Database(dbPath);
        const frameManager = new FrameManager(db, 'current');
        const workflowManager = new WorkflowTemplates(frameManager);

        // Handle different options
        if (options.list) {
          await listWorkflows();
        } else if (options.start) {
          await startWorkflow(workflowManager, options.start, spinner);
        } else if (options.transition) {
          await transitionPhase(workflowManager, frameManager, spinner);
        } else if (options.status) {
          await showWorkflowStatus(frameManager);
        } else if (options.validate) {
          await validateCurrentPhase(workflowManager, frameManager);
        } else if (options.abandon) {
          await abandonWorkflow(frameManager, spinner);
        } else {
          // Interactive mode
          await interactiveWorkflow(workflowManager, frameManager);
        }
      } catch (error) {
        spinner.fail(chalk.red(`Error: ${error}`));
        process.exit(1);
      }
    });

  // Add subcommands for specific workflows
  cmd
    .command('tdd')
    .description('Start Test-Driven Development workflow')
    .action(async () => {
      await startSpecificWorkflow('tdd');
    });

  cmd
    .command('feature')
    .description('Start Feature Development workflow')
    .action(async () => {
      await startSpecificWorkflow('feature');
    });

  cmd
    .command('bugfix')
    .description('Start Bug Fix workflow')
    .action(async () => {
      await startSpecificWorkflow('bugfix');
    });

  cmd
    .command('refactor')
    .description('Start Refactoring workflow')
    .action(async () => {
      await startSpecificWorkflow('refactor');
    });

  return cmd;
}

/**
 * List available workflow templates
 */
async function listWorkflows() {
  console.log(chalk.bold('\n📋 Available Workflow Templates\n'));

  const templates = WorkflowTemplates.listTemplates();

  for (const template of templates) {
    console.log(
      chalk.cyan(`${template.name}`) + chalk.gray(` - ${template.description}`)
    );
    console.log('  Phases:');
    template.phases.forEach((phase, index) => {
      console.log(`    ${index + 1}. ${phase.name}`);
    });
    console.log();
  }

  console.log(
    chalk.gray('Start a workflow with: stackmemory workflow --start <template>')
  );
}

/**
 * Start a new workflow
 */
async function startWorkflow(
  workflowManager: WorkflowTemplates,
  templateName: string,
  spinner: any
) {
  spinner.start(`Starting ${templateName} workflow...`);

  // Get template
  const template = getTemplateByName(templateName);
  if (!template) {
    spinner.fail(chalk.red(`Unknown workflow template: ${templateName}`));
    console.log(
      chalk.yellow(
        'Run "stackmemory workflow --list" to see available templates'
      )
    );
    return;
  }

  try {
    const workflow = await workflowManager.startWorkflow(template);
    spinner.succeed(chalk.green(`✅ Started ${template.name} workflow`));

    console.log(chalk.bold('\n🚀 Workflow Started\n'));
    console.log(`Workflow: ${chalk.cyan(template.name)}`);
    console.log(`Current Phase: ${chalk.yellow(template.phases[0].name)}`);
    console.log('\nPhases to complete:');
    template.phases.forEach((phase, index) => {
      const icon = index === 0 ? '▶' : '○';
      console.log(`  ${icon} ${phase.name}`);
    });

    console.log(
      chalk.gray(
        '\nTransition to next phase: stackmemory workflow --transition'
      )
    );
  } catch (error) {
    spinner.fail(chalk.red(`Failed to start workflow: ${error}`));
  }
}

/**
 * Transition to next phase
 */
async function transitionPhase(
  workflowManager: WorkflowTemplates,
  frameManager: FrameManager,
  spinner: any
) {
  spinner.start('Validating current phase...');

  try {
    // Find active workflow
    const activeWorkflow = await findActiveWorkflow(frameManager);
    if (!activeWorkflow) {
      spinner.fail(chalk.yellow('No active workflow found'));
      console.log(
        chalk.gray(
          'Start a workflow with: stackmemory workflow --start <template>'
        )
      );
      return;
    }

    // Attempt transition
    const success = await workflowManager.transitionPhase(activeWorkflow.id);

    if (success) {
      spinner.succeed(chalk.green('✅ Transitioned to next phase'));

      const updatedWorkflow = await frameManager.getFrame(activeWorkflow.id);
      const currentPhase = updatedWorkflow?.metadata?.current_phase || 0;
      const phases = updatedWorkflow?.metadata?.phases || [];

      if (updatedWorkflow?.status === 'closed') {
        console.log(chalk.green('\n🎉 Workflow Complete!\n'));
      } else {
        console.log(chalk.bold('\n➡️ Phase Transition\n'));
        console.log(`New Phase: ${chalk.yellow(phases[currentPhase])}`);
        console.log('\nRemaining phases:');
        phases.slice(currentPhase).forEach((phase: string, index: number) => {
          const icon = index === 0 ? '▶' : '○';
          console.log(`  ${icon} ${phase}`);
        });
      }
    } else {
      spinner.fail(chalk.red('Phase validation failed'));
      console.log(chalk.yellow('\nPhase requirements not met. Check:'));
      console.log('  - Required outputs are present');
      console.log('  - Validation rules pass');
      console.log('  - Tests are passing (if applicable)');
      console.log(
        chalk.gray('\nValidate phase: stackmemory workflow --validate')
      );
    }
  } catch (error) {
    spinner.fail(chalk.red(`Transition failed: ${error}`));
  }
}

/**
 * Show workflow status
 */
async function showWorkflowStatus(frameManager: FrameManager) {
  const activeWorkflow = await findActiveWorkflow(frameManager);

  if (!activeWorkflow) {
    console.log(chalk.yellow('No active workflow'));
    return;
  }

  console.log(chalk.bold('\n📊 Workflow Status\n'));
  console.log(`Type: ${chalk.cyan(activeWorkflow.metadata?.workflow)}`);
  console.log(
    `Started: ${new Date(activeWorkflow.metadata?.started_at).toLocaleString()}`
  );

  const currentPhase = activeWorkflow.metadata?.current_phase || 0;
  const phases = activeWorkflow.metadata?.phases || [];

  console.log('\nPhases:');
  phases.forEach((phase: string, index: number) => {
    let icon = '○';
    let color = chalk.gray;

    if (index < currentPhase) {
      icon = '✓';
      color = chalk.green;
    } else if (index === currentPhase) {
      icon = '▶';
      color = chalk.yellow;
    }

    console.log(color(`  ${icon} ${phase}`));
  });

  // Show current phase details
  const children = await frameManager.getChildren(activeWorkflow.id);
  const currentPhaseFrame = children.find(
    (f) => f.type === 'phase' && f.status === 'open'
  );

  if (currentPhaseFrame) {
    console.log(chalk.bold('\nCurrent Phase Details:'));
    console.log(`Name: ${currentPhaseFrame.metadata?.phase_name}`);

    if (currentPhaseFrame.metadata?.required_outputs) {
      console.log('Required outputs:');
      currentPhaseFrame.metadata.required_outputs.forEach((output: string) => {
        const hasOutput = currentPhaseFrame.metadata?.[output];
        const icon = hasOutput ? '✓' : '○';
        const color = hasOutput ? chalk.green : chalk.gray;
        console.log(color(`  ${icon} ${output}`));
      });
    }
  }
}

/**
 * Validate current phase
 */
async function validateCurrentPhase(
  workflowManager: WorkflowTemplates,
  frameManager: FrameManager
) {
  const activeWorkflow = await findActiveWorkflow(frameManager);

  if (!activeWorkflow) {
    console.log(chalk.yellow('No active workflow'));
    return;
  }

  const children = await frameManager.getChildren(activeWorkflow.id);
  const currentPhaseFrame = children.find(
    (f) => f.type === 'phase' && f.status === 'open'
  );

  if (!currentPhaseFrame) {
    console.log(chalk.yellow('No active phase'));
    return;
  }

  console.log(chalk.bold('\n✅ Phase Validation\n'));
  console.log(`Phase: ${chalk.cyan(currentPhaseFrame.metadata?.phase_name)}`);

  // Check required outputs
  const requiredOutputs = currentPhaseFrame.metadata?.required_outputs || [];
  let allOutputsPresent = true;

  if (requiredOutputs.length > 0) {
    console.log('\nRequired outputs:');
    requiredOutputs.forEach((output: string) => {
      const hasOutput = currentPhaseFrame.metadata?.[output];
      const icon = hasOutput ? '✓' : '✗';
      const color = hasOutput ? chalk.green : chalk.red;
      console.log(color(`  ${icon} ${output}`));
      if (!hasOutput) allOutputsPresent = false;
    });
  }

  // Overall validation status
  console.log(
    '\n' +
      (allOutputsPresent
        ? chalk.green('✅ Phase is ready for transition')
        : chalk.yellow('⚠️ Phase requirements not met'))
  );

  if (!allOutputsPresent) {
    console.log(chalk.gray('\nComplete missing outputs before transitioning'));
  }
}

/**
 * Abandon current workflow
 */
async function abandonWorkflow(frameManager: FrameManager, spinner: ora.Ora) {
  const activeWorkflow = await findActiveWorkflow(frameManager);

  if (!activeWorkflow) {
    console.log(chalk.yellow('No active workflow to abandon'));
    return;
  }

  // Confirm abandonment
  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: `Abandon ${activeWorkflow.metadata?.workflow} workflow?`,
      default: false,
    },
  ]);

  if (!confirm) {
    console.log(chalk.gray('Workflow not abandoned'));
    return;
  }

  spinner.start('Abandoning workflow...');

  try {
    await frameManager.close(activeWorkflow.id, {
      abandoned: true,
      abandoned_at: new Date().toISOString(),
    });

    spinner.succeed(chalk.yellow('Workflow abandoned'));
  } catch (error) {
    spinner.fail(chalk.red(`Failed to abandon workflow: ${error}`));
  }
}

/**
 * Interactive workflow management
 */
async function interactiveWorkflow(
  workflowManager: WorkflowTemplates,
  frameManager: FrameManager
) {
  const activeWorkflow = await findActiveWorkflow(frameManager);

  if (activeWorkflow) {
    // Show status and options for active workflow
    await showWorkflowStatus(frameManager);

    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'What would you like to do?',
        choices: [
          { name: 'Transition to next phase', value: 'transition' },
          { name: 'Validate current phase', value: 'validate' },
          { name: 'Abandon workflow', value: 'abandon' },
          { name: 'Exit', value: 'exit' },
        ],
      },
    ]);

    const spinner = ora();

    switch (action) {
      case 'transition':
        await transitionPhase(workflowManager, frameManager, spinner);
        break;
      case 'validate':
        await validateCurrentPhase(workflowManager, frameManager);
        break;
      case 'abandon':
        await abandonWorkflow(frameManager, spinner);
        break;
    }
  } else {
    // No active workflow, offer to start one
    const templates = WorkflowTemplates.listTemplates();

    const { template } = await inquirer.prompt([
      {
        type: 'list',
        name: 'template',
        message: 'Select a workflow template to start:',
        choices: [
          ...templates.map((t) => ({
            name: `${t.name} - ${t.description}`,
            value: t.name,
          })),
          { name: 'Cancel', value: null },
        ],
      },
    ]);

    if (template) {
      const spinner = ora();
      await startWorkflow(workflowManager, template, spinner);
    }
  }
}

/**
 * Start a specific workflow by command
 */
async function startSpecificWorkflow(templateName: string) {
  const spinner = ora();

  try {
    const projectRoot = await getProjectRoot();
    const dbPath = path.join(
      projectRoot,
      '.stackmemory',
      'db',
      'stackmemory.db'
    );

    const db = new Database(dbPath);
    const frameManager = new FrameManager(db, 'current');
    const workflowManager = new WorkflowTemplates(frameManager);

    await startWorkflow(workflowManager, templateName, spinner);
  } catch (error) {
    spinner.fail(chalk.red(`Error: ${error}`));
    process.exit(1);
  }
}

// Helper functions

async function getProjectRoot(): Promise<string> {
  return process.cwd();
}

/**
 * Find active workflow frame
 */
async function findActiveWorkflow(frameManager: FrameManager): Promise<any> {
  const stack = await frameManager.getStack();
  return stack.frames.find(
    (f: any) => f.type === 'workflow' && f.status === 'open'
  );
}

/**
 * Get workflow template by name
 */
function getTemplateByName(name: string): WorkflowTemplate | null {
  const templates: Record<string, WorkflowTemplate> = {
    tdd: WorkflowTemplates.TDD,
    feature: WorkflowTemplates.FEATURE,
    bugfix: WorkflowTemplates.BUGFIX,
    refactor: WorkflowTemplates.REFACTOR,
  };

  return templates[name.toLowerCase()] || null;
}

// Export for use in main CLI
export default createWorkflowCommand();
