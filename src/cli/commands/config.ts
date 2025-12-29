/**
 * Config command for StackMemory CLI
 */

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import chalk from 'chalk';
import { ConfigManager } from '../../core/config/config-manager';
import { DEFAULT_CONFIG, PRESET_PROFILES } from '../../core/config/types';

export function createConfigCommand(): Command {
  const config = new Command('config')
    .description('Manage StackMemory configuration');

  config
    .command('validate')
    .description('Validate configuration file')
    .option('-f, --file <path>', 'Path to config file', '.stackmemory/config.yaml')
    .option('--fix', 'Attempt to auto-fix common issues')
    .action(async (options) => {
      console.log(chalk.blue('🔍 Validating configuration...'));
      
      const configPath = path.resolve(options.file);
      const manager = new ConfigManager(configPath);
      const result = manager.validate();

      // Display errors
      if (result.errors.length > 0) {
        console.log(chalk.red('\n✗ Errors:'));
        result.errors.forEach(error => {
          console.log(chalk.red(`  • ${error}`));
        });
      }

      // Display warnings
      if (result.warnings.length > 0) {
        console.log(chalk.yellow('\n⚠ Warnings:'));
        result.warnings.forEach(warning => {
          console.log(chalk.yellow(`  • ${warning}`));
        });
      }

      // Display suggestions
      if (result.suggestions.length > 0) {
        console.log(chalk.cyan('\n💡 Suggestions:'));
        result.suggestions.forEach(suggestion => {
          console.log(chalk.cyan(`  • ${suggestion}`));
        });
      }

      // Auto-fix if requested
      if (options.fix && result.errors.length > 0) {
        console.log(chalk.blue('\n🔧 Attempting auto-fix...'));
        
        const config = manager.getConfig();
        const weights = config.scoring.weights;
        const weightSum = weights.base + weights.impact + weights.persistence + weights.reference;
        
        if (Math.abs(weightSum - 1.0) > 0.001) {
          // Normalize weights to sum to 1.0
          const factor = 1.0 / weightSum;
          manager.updateWeights({
            base: weights.base * factor,
            impact: weights.impact * factor,
            persistence: weights.persistence * factor,
            reference: weights.reference * factor,
          });
          manager.save();
          console.log(chalk.green('  ✓ Normalized weights to sum to 1.0'));
        }
      }

      // Final status
      if (result.valid) {
        console.log(chalk.green('\n✅ Configuration is valid'));
        process.exit(0);
      } else {
        console.log(chalk.red('\n❌ Configuration has errors'));
        process.exit(1);
      }
    });

  config
    .command('init')
    .description('Initialize configuration file with defaults')
    .option('-p, --profile <name>', 'Use a preset profile', 'default')
    .option('-f, --force', 'Overwrite existing config')
    .action(async (options) => {
      const configPath = path.join(process.cwd(), '.stackmemory', 'config.yaml');
      
      if (fs.existsSync(configPath) && !options.force) {
        console.log(chalk.yellow('⚠ Config file already exists. Use --force to overwrite.'));
        process.exit(1);
      }

      const dir = path.dirname(configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const config = { ...DEFAULT_CONFIG };
      if (options.profile && options.profile !== 'default') {
        config.profile = options.profile;
      }

      const content = yaml.dump(config, {
        indent: 2,
        lineWidth: 120,
        noRefs: true,
      });

      fs.writeFileSync(configPath, content, 'utf-8');
      console.log(chalk.green(`✅ Created config file at ${configPath}`));
      
      if (options.profile !== 'default') {
        console.log(chalk.cyan(`📋 Using profile: ${options.profile}`));
      }
    });

  config
    .command('show')
    .description('Show current configuration')
    .option('-p, --profile <name>', 'Show specific profile')
    .action(async (options) => {
      const manager = new ConfigManager();
      const config = manager.getConfig();

      if (options.profile) {
        const profiles = manager.getProfiles();
        const profile = profiles[options.profile];
        
        if (!profile) {
          console.log(chalk.red(`❌ Profile '${options.profile}' not found`));
          console.log(chalk.cyan('Available profiles:'));
          Object.keys(profiles).forEach(name => {
            console.log(`  • ${name}`);
          });
          process.exit(1);
        }

        console.log(chalk.blue(`\n📋 Profile: ${profile.name}`));
        if (profile.description) {
          console.log(chalk.gray(`   ${profile.description}`));
        }
        console.log('\n' + yaml.dump(profile, { indent: 2 }));
      } else {
        console.log(chalk.blue('\n📋 Current Configuration:'));
        if (config.profile) {
          console.log(chalk.cyan(`   Active Profile: ${config.profile}`));
        }
        console.log('\n' + yaml.dump(config, { indent: 2 }));
      }
    });

  config
    .command('set-profile <name>')
    .description('Set active profile')
    .action(async (name) => {
      const manager = new ConfigManager();
      
      if (manager.setProfile(name)) {
        manager.save();
        console.log(chalk.green(`✅ Active profile set to: ${name}`));
      } else {
        console.log(chalk.red(`❌ Profile '${name}' not found`));
        console.log(chalk.cyan('Available profiles:'));
        Object.keys(manager.getProfiles()).forEach(profile => {
          console.log(`  • ${profile}`);
        });
        process.exit(1);
      }
    });

  config
    .command('list-profiles')
    .description('List available profiles')
    .action(async () => {
      const manager = new ConfigManager();
      const profiles = manager.getProfiles();
      const currentProfile = manager.getConfig().profile;

      console.log(chalk.blue('\n📋 Available Profiles:'));
      Object.entries(profiles).forEach(([name, profile]) => {
        const marker = name === currentProfile ? chalk.green(' ✓') : '';
        console.log(`  • ${chalk.cyan(name)}${marker}`);
        if (profile.description) {
          console.log(chalk.gray(`    ${profile.description}`));
        }
      });
    });

  config
    .command('test-score <tool>')
    .description('Test importance scoring for a tool')
    .option('-f, --files <number>', 'Number of files affected', parseInt)
    .option('-p, --permanent', 'Is change permanent')
    .option('-r, --references <number>', 'Reference count', parseInt)
    .action(async (tool, options) => {
      const manager = new ConfigManager();
      
      const score = manager.calculateScore(tool, {
        filesAffected: options.files,
        isPermanent: options.permanent,
        referenceCount: options.references,
      });

      const config = manager.getConfig();
      const baseScore = config.scoring.tool_scores[tool] || 0.5;

      console.log(chalk.blue('\n📊 Score Calculation:'));
      console.log(`  Tool: ${chalk.cyan(tool)}`);
      console.log(`  Base Score: ${chalk.yellow(baseScore.toFixed(3))}`);
      
      if (options.files !== undefined) {
        console.log(`  Files Affected: ${options.files}`);
      }
      if (options.permanent) {
        console.log(`  Permanent: ${chalk.green('Yes')}`);
      }
      if (options.references !== undefined) {
        console.log(`  References: ${options.references}`);
      }

      console.log(chalk.blue('\n  Weights:'));
      console.log(`    Base: ${config.scoring.weights.base}`);
      console.log(`    Impact: ${config.scoring.weights.impact}`);
      console.log(`    Persistence: ${config.scoring.weights.persistence}`);
      console.log(`    Reference: ${config.scoring.weights.reference}`);

      console.log(chalk.green(`\n  Final Score: ${score.toFixed(3)}`));

      // Show importance level
      let level = 'Low';
      let color = chalk.gray;
      if (score >= 0.8) {
        level = 'Critical';
        color = chalk.red;
      } else if (score >= 0.6) {
        level = 'High';
        color = chalk.yellow;
      } else if (score >= 0.4) {
        level = 'Medium';
        color = chalk.cyan;
      }

      console.log(`  Importance: ${color(level)}`);
    });

  return config;
}