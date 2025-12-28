#!/usr/bin/env node
/**
 * Project Management CLI Commands
 * Auto-manages multi-project across GitHub orgs
 */

import { Command } from 'commander';
import { ProjectManager } from '../core/project-manager.js';
import chalk from 'chalk';
// @ts-ignore - No types available for cli-table3
import Table from 'cli-table3';

export function registerProjectCommands(program: Command): void {
  const projects = program
    .command('projects')
    .description('Manage multi-project organization');

  // Auto-detect current project
  projects
    .command('detect')
    .description('Auto-detect current project')
    .action(async () => {
      const manager = ProjectManager.getInstance();
      const project = await manager.detectProject();
      
      console.log(chalk.green('✓ Project detected:'));
      console.log(chalk.cyan('  Name:'), project.name);
      console.log(chalk.cyan('  Organization:'), project.organization || 'none');
      console.log(chalk.cyan('  Account Type:'), project.accountType);
      console.log(chalk.cyan('  Private:'), project.isPrivate ? 'Yes' : 'No');
      console.log(chalk.cyan('  Language:'), project.primaryLanguage || 'unknown');
      console.log(chalk.cyan('  Framework:'), project.framework || 'unknown');
      console.log(chalk.cyan('  ID:'), project.id);
    });

  // Scan all projects
  projects
    .command('scan')
    .description('Scan and auto-categorize all Git projects')
    .option('-p, --paths <paths...>', 'Custom paths to scan')
    .action(async (options) => {
      const manager = ProjectManager.getInstance();
      
      console.log(chalk.yellow('🔍 Scanning for Git repositories...'));
      await manager.scanAndCategorizeAllProjects(options.paths);
      
      const allProjects = manager.getAllProjects();
      console.log(chalk.green(`✓ Found ${allProjects.length} projects`));
      
      // Show summary
      const byType: Record<string, number> = {};
      const byOrg: Record<string, number> = {};
      
      for (const project of allProjects) {
        byType[project.accountType] = (byType[project.accountType] || 0) + 1;
        if (project.organization) {
          byOrg[project.organization] = (byOrg[project.organization] || 0) + 1;
        }
      }
      
      console.log('\n📊 Summary by Account Type:');
      for (const [type, count] of Object.entries(byType)) {
        console.log(`  ${type}: ${count} projects`);
      }
      
      console.log('\n🏢 Top Organizations:');
      const topOrgs = Object.entries(byOrg)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
      for (const [org, count] of topOrgs) {
        console.log(`  ${org}: ${count} projects`);
      }
    });

  // List all projects
  projects
    .command('list')
    .description('List all discovered projects')
    .option('-t, --type <type>', 'Filter by account type (personal/work/opensource/client)')
    .option('-o, --org <org>', 'Filter by organization')
    .option('-l, --language <lang>', 'Filter by language')
    .action((options) => {
      const manager = ProjectManager.getInstance();
      let projectList = manager.getAllProjects();
      
      // Apply filters
      if (options.type) {
        projectList = projectList.filter(p => p.accountType === options.type);
      }
      if (options.org) {
        projectList = projectList.filter(p => p.organization === options.org);
      }
      if (options.language) {
        projectList = projectList.filter(p => 
          p.primaryLanguage?.toLowerCase().includes(options.language.toLowerCase())
        );
      }
      
      if (projectList.length === 0) {
        console.log(chalk.yellow('No projects found matching criteria'));
        return;
      }
      
      // Create table
      const table = new Table({
        head: ['Name', 'Organization', 'Type', 'Language', 'Framework', 'Last Accessed'],
        style: { head: ['cyan'] }
      });
      
      for (const project of projectList.slice(0, 20)) {
        table.push([
          project.name,
          project.organization || '-',
          project.accountType,
          project.primaryLanguage || '-',
          project.framework || '-',
          new Date(project.lastAccessed).toLocaleDateString()
        ]);
      }
      
      console.log(table.toString());
      
      if (projectList.length > 20) {
        console.log(chalk.gray(`\n... and ${projectList.length - 20} more projects`));
      }
    });

  // Show organizations
  projects
    .command('orgs')
    .description('List all detected organizations')
    .action(() => {
      const manager = ProjectManager.getInstance();
      const allProjects = manager.getAllProjects();
      
      const orgMap: Record<string, { count: number; types: Set<string> }> = {};
      
      for (const project of allProjects) {
        if (project.organization) {
          if (!orgMap[project.organization]) {
            orgMap[project.organization] = { count: 0, types: new Set() };
          }
          orgMap[project.organization].count++;
          orgMap[project.organization].types.add(project.accountType);
        }
      }
      
      const table = new Table({
        head: ['Organization', 'Projects', 'Account Types'],
        style: { head: ['cyan'] }
      });
      
      const sorted = Object.entries(orgMap)
        .sort((a, b) => b[1].count - a[1].count);
      
      for (const [org, data] of sorted) {
        table.push([
          org,
          data.count.toString(),
          Array.from(data.types).join(', ')
        ]);
      }
      
      console.log(table.toString());
    });

  // Configure organization
  projects
    .command('config-org <name>')
    .description('Configure an organization')
    .option('-t, --type <type>', 'Organization type (company/personal/opensource/client)')
    .option('-a, --account <account>', 'Account type (personal/work/opensource/client)')
    .option('-d, --domain <domain>', 'Add domain pattern')
    .action((name, options) => {
      const manager = ProjectManager.getInstance();
      
      manager.saveOrganization({
        name,
        type: options.type || 'company',
        accountType: options.account || 'work',
        domains: options.domain ? [options.domain] : [],
        githubOrgs: [name],
        autoPatterns: []
      });
      
      console.log(chalk.green(`✓ Organization '${name}' configured`));
    });

  // Show project report
  projects
    .command('report')
    .description('Generate project statistics report')
    .action(() => {
      const manager = ProjectManager.getInstance();
      const report = manager.generateReport();
      
      console.log(chalk.cyan('\n📊 Project Statistics:\n'));
      console.log(report);
    });

  // Switch context based on project
  projects
    .command('switch <path>')
    .description('Switch to a different project context')
    .action(async (projectPath) => {
      const manager = ProjectManager.getInstance();
      const project = await manager.detectProject(projectPath);
      
      console.log(chalk.green(`✓ Switched to project: ${project.name}`));
      console.log(chalk.cyan(`  Organization: ${project.organization || 'none'}`));
      console.log(chalk.cyan(`  Account Type: ${project.accountType}`));
    });

  // Auto-organize projects by patterns
  projects
    .command('organize')
    .description('Auto-organize projects into accounts')
    .action(async () => {
      const manager = ProjectManager.getInstance();
      
      console.log(chalk.yellow('🔄 Auto-organizing projects...'));
      
      // First scan
      await manager.scanAndCategorizeAllProjects();
      
      const allProjects = manager.getAllProjects();
      const organized: Record<string, string[]> = {
        personal: [],
        work: [],
        opensource: [],
        client: []
      };
      
      for (const project of allProjects) {
        organized[project.accountType].push(project.name);
      }
      
      console.log(chalk.green('\n✓ Projects organized by account type:\n'));
      
      for (const [type, projects] of Object.entries(organized)) {
        if (projects.length > 0) {
          console.log(chalk.cyan(`${type.toUpperCase()} (${projects.length} projects):`));
          for (const proj of projects.slice(0, 5)) {
            console.log(`  - ${proj}`);
          }
          if (projects.length > 5) {
            console.log(chalk.gray(`  ... and ${projects.length - 5} more`));
          }
          console.log();
        }
      }
    });
}