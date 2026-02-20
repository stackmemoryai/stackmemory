/**
 * Config command for StackMemory CLI
 */

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import chalk from 'chalk';
import { ConfigManager } from '../../core/config/config-manager.js';
import {
  DEFAULT_CONFIG,
  ProfileConfig,
  ScoringWeights,
  DEFAULT_WEIGHTS,
  DEFAULT_TOOL_SCORES,
} from '../../core/config/types.js';

export function createConfigCommand(): Command {
  const config = new Command('config').description(
    'Manage StackMemory configuration'
  );

  config
    .command('validate')
    .description('Validate configuration file')
    .option(
      '-f, --file <path>',
      'Path to config file',
      '.stackmemory/config.yaml'
    )
    .option('--fix', 'Attempt to auto-fix common issues')
    .action(async (options) => {
      console.log(chalk.blue('🔍 Validating configuration...'));

      const configPath = path.resolve(options.file);
      const manager = new ConfigManager(configPath);
      const result = manager.validate();

      // Display errors
      if (result.errors.length > 0) {
        console.log(chalk.red('\n✗ Errors:'));
        result.errors.forEach((error) => {
          console.log(chalk.red(`  • ${error}`));
        });
      }

      // Display warnings
      if (result.warnings.length > 0) {
        console.log(chalk.yellow('\n⚠ Warnings:'));
        result.warnings.forEach((warning) => {
          console.log(chalk.yellow(`  • ${warning}`));
        });
      }

      // Display suggestions
      if (result.suggestions.length > 0) {
        console.log(chalk.cyan('\n💡 Suggestions:'));
        result.suggestions.forEach((suggestion) => {
          console.log(chalk.cyan(`  • ${suggestion}`));
        });
      }

      // Auto-fix if requested
      if (options.fix && result.errors.length > 0) {
        console.log(chalk.blue('\n🔧 Attempting auto-fix...'));

        const config = manager.getConfig();
        const weights = config.scoring.weights;
        const weightSum =
          weights.base +
          weights.impact +
          weights.persistence +
          weights.reference;

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
      const configPath = path.join(
        process.cwd(),
        '.stackmemory',
        'config.yaml'
      );

      if (fs.existsSync(configPath) && !options.force) {
        console.log(
          chalk.yellow(
            '⚠ Config file already exists. Use --force to overwrite.'
          )
        );
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
          Object.keys(profiles).forEach((name) => {
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
        Object.keys(manager.getProfiles()).forEach((profile) => {
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

  config
    .command('create-profile <name>')
    .description('Create a custom configuration profile')
    .option('-d, --description <text>', 'Profile description')
    .option('-b, --base-weight <number>', 'Base weight (0-1)', parseFloat)
    .option('-i, --impact-weight <number>', 'Impact weight (0-1)', parseFloat)
    .option(
      '-p, --persistence-weight <number>',
      'Persistence weight (0-1)',
      parseFloat
    )
    .option(
      '-r, --reference-weight <number>',
      'Reference weight (0-1)',
      parseFloat
    )
    .option('--copy-from <profile>', 'Copy settings from existing profile')
    .action(async (name, options) => {
      const manager = new ConfigManager();
      const config = manager.getConfig();

      // Check if profile already exists
      if (config.profiles && config.profiles[name]) {
        console.log(
          chalk.yellow(
            `⚠ Profile '${name}' already exists. Use 'edit-profile' to modify it.`
          )
        );
        process.exit(1);
      }

      let newProfile: ProfileConfig;

      if (options.copyFrom) {
        // Copy from existing profile
        const sourceProfile = config.profiles?.[options.copyFrom];
        if (!sourceProfile) {
          console.log(
            chalk.red(`❌ Source profile '${options.copyFrom}' not found`)
          );
          process.exit(1);
        }
        newProfile = {
          ...sourceProfile,
          name,
          description: options.description,
        };
      } else {
        // Create new profile with custom weights
        const weights: ScoringWeights = {
          base: options.baseWeight ?? DEFAULT_WEIGHTS.base,
          impact: options.impactWeight ?? DEFAULT_WEIGHTS.impact,
          persistence: options.persistenceWeight ?? DEFAULT_WEIGHTS.persistence,
          reference: options.referenceWeight ?? DEFAULT_WEIGHTS.reference,
        };

        // Validate weights sum to 1.0
        const sum =
          weights.base +
          weights.impact +
          weights.persistence +
          weights.reference;
        if (Math.abs(sum - 1.0) > 0.001) {
          console.log(
            chalk.red(`❌ Weights must sum to 1.0 (current: ${sum.toFixed(3)})`)
          );
          console.log(chalk.yellow('\nNormalizing weights to sum to 1.0...'));

          const factor = 1.0 / sum;
          weights.base *= factor;
          weights.impact *= factor;
          weights.persistence *= factor;
          weights.reference *= factor;
        }

        newProfile = {
          name,
          description:
            options.description ||
            `Custom profile created ${new Date().toLocaleDateString()}`,
          scoring: {
            weights,
            tool_scores: DEFAULT_TOOL_SCORES,
          },
        };
      }

      // Add profile to config
      if (!config.profiles) {
        config.profiles = {};
      }
      config.profiles[name] = newProfile;

      // Save config
      manager.save();

      console.log(chalk.green(`✅ Created profile: ${name}`));
      console.log(chalk.blue('\nProfile Configuration:'));
      console.log(yaml.dump(newProfile, { indent: 2 }));
      console.log(
        chalk.cyan(`\nActivate with: stackmemory config set-profile ${name}`)
      );
    });

  config
    .command('edit-profile <name>')
    .description('Edit an existing profile')
    .option(
      '-s, --set-tool <tool:score>',
      'Set tool score (e.g., search:0.95)',
      (value, previous) => {
        const result = previous || {};
        const [tool, score] = value.split(':');
        result[tool] = parseFloat(score);
        return result;
      },
      {}
    )
    .option(
      '-w, --set-weight <type:value>',
      'Set weight (e.g., base:0.4)',
      (value, previous) => {
        const result = previous || {};
        const [type, weight] = value.split(':');
        result[type] = parseFloat(weight);
        return result;
      },
      {}
    )
    .action(async (name, options) => {
      const manager = new ConfigManager();
      const config = manager.getConfig();

      if (!config.profiles?.[name]) {
        console.log(chalk.red(`❌ Profile '${name}' not found`));
        process.exit(1);
      }

      const profile = config.profiles[name];

      // Update tool scores
      if (Object.keys(options.setTool).length > 0) {
        if (!profile.scoring) {
          profile.scoring = {};
        }
        if (!profile.scoring.tool_scores) {
          profile.scoring.tool_scores = {};
        }
        Object.assign(profile.scoring.tool_scores, options.setTool);
        console.log(chalk.green('✓ Updated tool scores'));
      }

      // Update weights
      if (Object.keys(options.setWeight).length > 0) {
        if (!profile.scoring) {
          profile.scoring = {};
        }
        if (!profile.scoring.weights) {
          profile.scoring.weights = { ...DEFAULT_WEIGHTS };
        }
        Object.assign(profile.scoring.weights, options.setWeight);

        // Validate weights
        const weights = profile.scoring.weights;
        const sum =
          (weights.base || 0) +
          (weights.impact || 0) +
          (weights.persistence || 0) +
          (weights.reference || 0);

        if (Math.abs(sum - 1.0) > 0.001) {
          console.log(
            chalk.yellow(`⚠ Weights sum to ${sum.toFixed(3)}, normalizing...`)
          );
          const factor = 1.0 / sum;
          if (weights.base) weights.base *= factor;
          if (weights.impact) weights.impact *= factor;
          if (weights.persistence) weights.persistence *= factor;
          if (weights.reference) weights.reference *= factor;
        }

        console.log(chalk.green('✓ Updated weights'));
      }

      // Save changes
      manager.save();

      console.log(chalk.green(`\n✅ Profile '${name}' updated`));
      console.log(chalk.blue('\nUpdated Configuration:'));
      console.log(yaml.dump(profile, { indent: 2 }));
    });

  config
    .command('profile-report [profile]')
    .description('Show profile effectiveness report')
    .action(async (profile) => {
      // This would integrate with the ToolScoringMiddleware
      // For now, show a placeholder
      console.log(chalk.blue('\n📊 Profile Effectiveness Report'));

      if (profile) {
        console.log(chalk.cyan(`\nProfile: ${profile}`));
        console.log('Note: Run tools with this profile to generate metrics');
      } else {
        console.log(
          '\nNote: Tool scoring metrics will be available after running MCP tools'
        );
      }

      console.log(chalk.gray('\nMetrics tracked:'));
      console.log('  • Average score per tool');
      console.log('  • High-importance operations');
      console.log('  • Profile usage frequency');
      console.log('  • Score trends over time');
    });

  return config;
}
