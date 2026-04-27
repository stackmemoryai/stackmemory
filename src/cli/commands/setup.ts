/**
 * Setup commands for StackMemory onboarding
 * - setup-mcp: Auto-configure Claude Code MCP integration
 * - doctor: Diagnose common issues
 */

import { Command } from 'commander';
import chalk from 'chalk';
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';

// Claude config paths
const CLAUDE_DIR = join(homedir(), '.claude');
const CLAUDE_CONFIG_FILE = join(CLAUDE_DIR, 'config.json');
const MCP_CONFIG_FILE = join(CLAUDE_DIR, 'stackmemory-mcp.json');

interface DiagnosticResult {
  name: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
  fix?: string;
}

/**
 * Create setup-mcp command
 */
export function createSetupMCPCommand(): Command {
  return new Command('setup-mcp')
    .description('Auto-configure Claude Code MCP integration')
    .option('--dry-run', 'Show what would be configured without making changes')
    .option('--reset', 'Reset MCP configuration to defaults')
    .action(async (options) => {
      console.log(chalk.cyan('\nStackMemory MCP Setup\n'));

      if (options.dryRun) {
        console.log(chalk.yellow('[DRY RUN] No changes will be made.\n'));
      }

      // Step 1: Ensure Claude directory exists
      if (!existsSync(CLAUDE_DIR)) {
        if (options.dryRun) {
          console.log(chalk.gray(`Would create: ${CLAUDE_DIR}`));
        } else {
          mkdirSync(CLAUDE_DIR, { recursive: true });
          console.log(chalk.green('[OK]') + ' Created ~/.claude directory');
        }
      }

      // Step 2: Create MCP server configuration
      const mcpConfig = {
        mcpServers: {
          stackmemory: {
            command: 'stackmemory',
            args: ['mcp-server'],
            env: {
              NODE_ENV: 'production',
            },
          },
        },
      };

      if (options.dryRun) {
        console.log(
          chalk.gray(`Would write MCP config to: ${MCP_CONFIG_FILE}`)
        );
        console.log(chalk.gray(JSON.stringify(mcpConfig, null, 2)));
      } else {
        writeFileSync(MCP_CONFIG_FILE, JSON.stringify(mcpConfig, null, 2));
        console.log(chalk.green('[OK]') + ' Created MCP server configuration');
      }

      // Step 3: Update Claude config.json to reference MCP config
      let claudeConfig: Record<string, unknown> = {};
      if (existsSync(CLAUDE_CONFIG_FILE)) {
        try {
          claudeConfig = JSON.parse(readFileSync(CLAUDE_CONFIG_FILE, 'utf8'));
        } catch {
          console.log(
            chalk.yellow('[WARN]') +
              ' Could not parse existing config.json, creating new'
          );
        }
      }

      // Ensure mcp.configFiles array includes our config
      if (!claudeConfig.mcp) {
        claudeConfig.mcp = {};
      }
      const mcp = claudeConfig.mcp as Record<string, unknown>;
      if (!mcp.configFiles) {
        mcp.configFiles = [];
      }
      const configFiles = mcp.configFiles as string[];
      if (!configFiles.includes(MCP_CONFIG_FILE)) {
        configFiles.push(MCP_CONFIG_FILE);
      }

      if (options.dryRun) {
        console.log(chalk.gray(`Would update: ${CLAUDE_CONFIG_FILE}`));
      } else {
        writeFileSync(
          CLAUDE_CONFIG_FILE,
          JSON.stringify(claudeConfig, null, 2)
        );
        console.log(chalk.green('[OK]') + ' Updated Claude config.json');
      }

      // Step 4: Validate configuration
      console.log(chalk.cyan('\nValidating configuration...'));

      // Check stackmemory command is available
      try {
        execSync('stackmemory --version', { stdio: 'pipe' });
        console.log(chalk.green('[OK]') + ' stackmemory CLI is installed');
      } catch {
        console.log(chalk.yellow('[WARN]') + ' stackmemory CLI not in PATH');
        console.log(chalk.gray('  You may need to restart your terminal'));
      }

      // Check Claude Code is available
      try {
        execSync('claude --version', { stdio: 'pipe' });
        console.log(chalk.green('[OK]') + ' Claude Code is installed');
      } catch {
        console.log(chalk.yellow('[WARN]') + ' Claude Code not found');
        console.log(chalk.gray('  Install from: https://claude.ai/code'));
      }

      // Final instructions
      if (!options.dryRun) {
        console.log(chalk.green('\nMCP setup complete!'));
        console.log(chalk.cyan('\nNext steps:'));
        console.log(chalk.white('  1. Restart Claude Code'));
        console.log(
          chalk.white(
            '  2. The StackMemory MCP tools will be available automatically'
          )
        );
        console.log(
          chalk.gray(
            '\nTo verify: Run "stackmemory doctor" to check all integrations'
          )
        );
      }
    });
}

/**
 * Create doctor command for diagnostics
 */
export function createDoctorCommand(): Command {
  return new Command('doctor')
    .description('Diagnose StackMemory configuration and common issues')
    .option('--fix', 'Attempt to automatically fix issues')
    .action(async (options) => {
      console.log(chalk.cyan('\nStackMemory Doctor\n'));
      console.log(chalk.gray('Checking configuration and dependencies...\n'));

      const results: DiagnosticResult[] = [];

      // 1. Check project initialization
      const projectDir = join(process.cwd(), '.stackmemory');
      const dbPath = join(projectDir, 'context.db');
      if (existsSync(dbPath)) {
        results.push({
          name: 'Project Initialization',
          status: 'ok',
          message: 'StackMemory is initialized in this project',
        });
      } else if (existsSync(projectDir)) {
        results.push({
          name: 'Project Initialization',
          status: 'warn',
          message: '.stackmemory directory exists but database not found',
          fix: 'Run: stackmemory init',
        });
      } else {
        results.push({
          name: 'Project Initialization',
          status: 'error',
          message: 'StackMemory not initialized in this project',
          fix: 'Run: stackmemory init',
        });
      }

      // 2. Check database integrity
      if (existsSync(dbPath)) {
        try {
          const Database = (await import('better-sqlite3')).default;
          const db = new Database(dbPath, { readonly: true });
          const tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .all() as { name: string }[];
          db.close();

          const hasFrames = tables.some((t) => t.name === 'frames');
          if (hasFrames) {
            results.push({
              name: 'Database Integrity',
              status: 'ok',
              message: `Database has ${tables.length} tables`,
            });
          } else {
            results.push({
              name: 'Database Integrity',
              status: 'warn',
              message: 'Database exists but missing expected tables',
              fix: 'Run: stackmemory init --interactive',
            });
          }
        } catch (error) {
          results.push({
            name: 'Database Integrity',
            status: 'error',
            message: `Database error: ${(error as Error).message}`,
            fix: 'Remove .stackmemory/context.db and run: stackmemory init',
          });
        }
      }

      // 3. Check MCP configuration
      if (existsSync(MCP_CONFIG_FILE)) {
        try {
          const config = JSON.parse(readFileSync(MCP_CONFIG_FILE, 'utf8'));
          if (config.mcpServers?.stackmemory) {
            results.push({
              name: 'MCP Configuration',
              status: 'ok',
              message: 'MCP server configured',
            });
          } else {
            results.push({
              name: 'MCP Configuration',
              status: 'warn',
              message:
                'MCP config file exists but stackmemory server not configured',
              fix: 'Run: stackmemory setup-mcp',
            });
          }
        } catch {
          results.push({
            name: 'MCP Configuration',
            status: 'error',
            message: 'Invalid MCP configuration file',
            fix: 'Run: stackmemory setup-mcp --reset',
          });
        }
      } else {
        results.push({
          name: 'MCP Configuration',
          status: 'warn',
          message: 'MCP not configured for Claude Code',
          fix: 'Run: stackmemory setup-mcp',
        });
      }

      // 4. Check Claude hooks (settings.json)
      {
        const settingsFile = join(homedir(), '.claude', 'settings.json');
        let hookCount = 0;
        if (existsSync(settingsFile)) {
          try {
            const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
            if (settings.hooks) {
              for (const groups of Object.values(settings.hooks) as Array<
                Array<{ hooks: Array<{ command: string }> }>
              >) {
                for (const group of groups) {
                  hookCount += group.hooks.length;
                }
              }
            }
          } catch {
            // Cannot parse settings.json
          }
        }

        if (hookCount > 0) {
          results.push({
            name: 'Claude Hooks',
            status: 'ok',
            message: `${hookCount} hooks registered in settings.json`,
          });
        } else {
          results.push({
            name: 'Claude Hooks',
            status: 'warn',
            message: 'No hooks registered in settings.json',
            fix: 'Run: stackmemory hooks install',
          });
        }
      }

      // 5. Check MCP tool definitions
      try {
        const { MCPToolDefinitions } =
          await import('../../integrations/mcp/tool-definitions.js');
        const toolDefs = new MCPToolDefinitions();
        const allTools = toolDefs.getAllToolDefinitions();
        const toolNames = allTools.map((t: { name: string }) => t.name);
        const expectedTools = ['sm_digest', 'get_context', 'create_task'];
        const missing = expectedTools.filter((t) => !toolNames.includes(t));

        if (missing.length === 0) {
          results.push({
            name: 'MCP Tools',
            status: 'ok',
            message: `${allTools.length} tool definitions loaded`,
          });
        } else {
          results.push({
            name: 'MCP Tools',
            status: 'warn',
            message: `${allTools.length} tools loaded, missing: ${missing.join(', ')}`,
          });
        }
      } catch (error) {
        results.push({
          name: 'MCP Tools',
          status: 'error',
          message: `Failed to load tool definitions: ${(error as Error).message}`,
        });
      }

      // 6. Auto-detect Linear API token
      {
        let linearTokenFound = false;
        let linearTokenSource = '';

        // Check process.env first
        if (process.env['LINEAR_API_KEY']) {
          linearTokenFound = true;
          linearTokenSource = 'process.env';
        }

        // Check .env file
        if (!linearTokenFound) {
          const envPath = join(process.cwd(), '.env');
          if (existsSync(envPath)) {
            try {
              const envContent = readFileSync(envPath, 'utf8');
              if (/^LINEAR_API_KEY\s*=/m.test(envContent)) {
                linearTokenFound = true;
                linearTokenSource = '.env';
              }
            } catch {
              // Cannot read .env
            }
          }
        }

        // Check .env.local file
        if (!linearTokenFound) {
          const envLocalPath = join(process.cwd(), '.env.local');
          if (existsSync(envLocalPath)) {
            try {
              const envContent = readFileSync(envLocalPath, 'utf8');
              if (/^LINEAR_API_KEY\s*=/m.test(envContent)) {
                linearTokenFound = true;
                linearTokenSource = '.env.local';
              }
            } catch {
              // Cannot read .env.local
            }
          }
        }

        if (linearTokenFound) {
          results.push({
            name: 'Linear API Token',
            status: 'ok',
            message: `Token found via ${linearTokenSource}`,
          });
        } else {
          results.push({
            name: 'Linear API Token',
            status: 'warn',
            message:
              'LINEAR_API_KEY not found (checked process.env, .env, .env.local)',
            fix: 'Add LINEAR_API_KEY=lin_api_... to your .env file',
          });
        }
      }

      // 7. Detect existing hooks (settings.json canonical hooks)
      {
        const settingsPath = join(homedir(), '.claude', 'settings.json');
        const projectHooksDir = join(process.cwd(), '.claude', 'hooks');
        const globalHooksDir = join(homedir(), '.claude', 'hooks');

        const expectedHookScripts = [
          'session-rescue.sh',
          'stop-checkpoint.js',
          'chime-on-stop.sh',
          'auto-checkpoint.js',
          'cord-trace.js',
        ];

        // Check settings.json for registered hooks
        const registeredHooks: string[] = [];
        if (existsSync(settingsPath)) {
          try {
            const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
            if (settings.hooks) {
              for (const eventType of Object.keys(settings.hooks)) {
                const groups = settings.hooks[eventType] as Array<{
                  hooks: Array<{ command: string }>;
                }>;
                for (const group of groups) {
                  for (const hook of group.hooks) {
                    registeredHooks.push(hook.command);
                  }
                }
              }
            }
          } catch {
            // Cannot parse settings.json
          }
        }

        // Check which expected scripts are present on disk
        const presentScripts: string[] = [];
        const missingScripts: string[] = [];
        for (const script of expectedHookScripts) {
          const inGlobal = existsSync(join(globalHooksDir, script));
          const inProject = existsSync(join(projectHooksDir, script));
          if (inGlobal || inProject) {
            presentScripts.push(script);
          } else {
            missingScripts.push(script);
          }
        }

        // Check which are registered in settings.json
        const unregisteredScripts = expectedHookScripts.filter(
          (script) => !registeredHooks.some((cmd) => cmd.includes(script))
        );

        if (
          presentScripts.length === expectedHookScripts.length &&
          unregisteredScripts.length === 0
        ) {
          results.push({
            name: 'Hook Scripts',
            status: 'ok',
            message: `All ${expectedHookScripts.length} hook scripts present and registered`,
          });
        } else if (presentScripts.length > 0) {
          const parts: string[] = [];
          if (missingScripts.length > 0) {
            parts.push(`missing files: ${missingScripts.join(', ')}`);
          }
          if (unregisteredScripts.length > 0) {
            parts.push(
              `not in settings.json: ${unregisteredScripts.join(', ')}`
            );
          }
          results.push({
            name: 'Hook Scripts',
            status: 'warn',
            message: `${presentScripts.length}/${expectedHookScripts.length} hooks present; ${parts.join('; ')}`,
            fix: 'Run: stackmemory hooks install',
          });
        } else {
          results.push({
            name: 'Hook Scripts',
            status: 'warn',
            message: 'No StackMemory hook scripts found',
            fix: 'Run: stackmemory hooks install',
          });
        }
      }

      // 8. Check Node.js version (requires >= 20.0.0)
      {
        const nodeVersion = process.version; // e.g. "v20.11.0"
        const major = parseInt(nodeVersion.slice(1), 10);
        if (major >= 20) {
          results.push({
            name: 'Node.js Version',
            status: 'ok',
            message: `${nodeVersion} (requires >= 20.0.0)`,
          });
        } else {
          results.push({
            name: 'Node.js Version',
            status: 'error',
            message: `${nodeVersion} is too old (requires >= 20.0.0)`,
            fix: 'Upgrade Node.js: https://nodejs.org/',
          });
        }
      }

      // 9. Check npm version (requires >= 10.0.0)
      {
        try {
          const npmVersion = execSync('npm --version', {
            encoding: 'utf-8',
            timeout: 5000,
          }).trim();
          const npmMajor = parseInt(npmVersion.split('.')[0], 10);
          if (npmMajor >= 10) {
            results.push({
              name: 'npm Version',
              status: 'ok',
              message: `v${npmVersion} (requires >= 10.0.0)`,
            });
          } else {
            results.push({
              name: 'npm Version',
              status: 'warn',
              message: `v${npmVersion} is below recommended >= 10.0.0`,
              fix: 'Upgrade npm: npm install -g npm@latest',
            });
          }
        } catch {
          results.push({
            name: 'npm Version',
            status: 'warn',
            message: 'Could not detect npm version',
            fix: 'Ensure npm is installed and in PATH',
          });
        }
      }

      // 10. Detect MCP config in Claude settings
      {
        const configJsonPath = join(homedir(), '.claude', 'config.json');
        const mcpJsonPath = join(homedir(), '.claude', 'stackmemory-mcp.json');
        let mcpRegistered = false;
        let mcpServerConfigured = false;

        // Check config.json references stackmemory MCP config file
        if (existsSync(configJsonPath)) {
          try {
            const configJson = JSON.parse(readFileSync(configJsonPath, 'utf8'));
            const configFiles =
              (configJson?.mcp?.configFiles as string[]) || [];
            mcpRegistered = configFiles.some((f: string) =>
              f.includes('stackmemory')
            );
          } catch {
            // Cannot parse config.json
          }
        }

        // Check the MCP config file itself has stackmemory server entry
        if (existsSync(mcpJsonPath)) {
          try {
            const mcpConfig = JSON.parse(readFileSync(mcpJsonPath, 'utf8'));
            mcpServerConfigured = !!mcpConfig?.mcpServers?.stackmemory;
          } catch {
            // Cannot parse MCP config
          }
        }

        if (mcpRegistered && mcpServerConfigured) {
          results.push({
            name: 'MCP Registration',
            status: 'ok',
            message:
              'StackMemory MCP registered in Claude config.json and server configured',
          });
        } else if (mcpServerConfigured && !mcpRegistered) {
          results.push({
            name: 'MCP Registration',
            status: 'warn',
            message:
              'MCP server config exists but not referenced in config.json',
            fix: 'Run: stackmemory setup-mcp',
          });
        } else if (mcpRegistered && !mcpServerConfigured) {
          results.push({
            name: 'MCP Registration',
            status: 'warn',
            message: 'config.json references MCP but server config missing',
            fix: 'Run: stackmemory setup-mcp',
          });
        } else {
          results.push({
            name: 'MCP Registration',
            status: 'warn',
            message: 'StackMemory not registered in Claude MCP settings',
            fix: 'Run: stackmemory setup-mcp',
          });
        }
      }

      // 11. Check desire paths (unmet agent needs in last 7d)
      {
        const desireDir = join(homedir(), '.stackmemory', 'desire-paths');
        if (existsSync(desireDir)) {
          try {
            const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
            const files = readdirSync(desireDir).filter(
              (f) => f.startsWith('desire-') && f.endsWith('.jsonl')
            );
            let totalFailures = 0;
            let unknownTools = 0;
            for (const file of files) {
              const lines = readFileSync(join(desireDir, file), 'utf-8')
                .split('\n')
                .filter(Boolean);
              for (const line of lines) {
                try {
                  const entry = JSON.parse(line);
                  if (new Date(entry.ts).getTime() < cutoff) continue;
                  totalFailures++;
                  if (entry.category === 'unknown_tool') unknownTools++;
                } catch {
                  // skip malformed
                }
              }
            }
            if (totalFailures > 0) {
              results.push({
                name: 'Desire Paths',
                status: unknownTools > 0 ? 'warn' : 'ok',
                message: `${totalFailures} tool failures in last 7d (${unknownTools} unknown tools)`,
                fix:
                  unknownTools > 0
                    ? 'Run: stackmemory desires summary'
                    : undefined,
              });
            } else {
              results.push({
                name: 'Desire Paths',
                status: 'ok',
                message: 'No tool failures in last 7d',
              });
            }
          } catch {
            results.push({
              name: 'Desire Paths',
              status: 'ok',
              message: 'Desire path logging active (no data yet)',
            });
          }
        } else {
          results.push({
            name: 'Desire Paths',
            status: 'ok',
            message: 'Desire path logging not yet active',
          });
        }
      }

      // 12. Check daemon health
      {
        try {
          const { readDaemonStatus } =
            await import('../../daemon/daemon-config.js');
          const status = readDaemonStatus();
          if (status.running) {
            const uptime = status.startedAt
              ? Math.round((Date.now() - status.startedAt) / 1000 / 60)
              : 0;
            const svcCount = Object.values(status.services || {}).filter(
              (s: { enabled?: boolean }) => s.enabled
            ).length;
            results.push({
              name: 'Background Daemon',
              status: 'ok',
              message: `Running (PID: ${status.pid}, ${svcCount} services, ${uptime}min uptime)`,
            });
          } else {
            results.push({
              name: 'Background Daemon',
              status: 'warn',
              message:
                'Daemon not running — context auto-save and maintenance disabled',
              fix: 'Run: stackmemory daemon start',
            });
          }
        } catch {
          results.push({
            name: 'Background Daemon',
            status: 'warn',
            message: 'Could not check daemon status',
            fix: 'Run: stackmemory daemon start',
          });
        }
      }

      // 13. Check file permissions
      const homeStackmemory = join(homedir(), '.stackmemory');
      if (existsSync(homeStackmemory)) {
        try {
          const testFile = join(homeStackmemory, '.write-test');
          writeFileSync(testFile, 'test');
          const { unlinkSync } = await import('fs');
          unlinkSync(testFile);
          results.push({
            name: 'File Permissions',
            status: 'ok',
            message: '~/.stackmemory is writable',
          });
        } catch {
          results.push({
            name: 'File Permissions',
            status: 'error',
            message: '~/.stackmemory is not writable',
            fix: 'Run: chmod 700 ~/.stackmemory',
          });
        }
      }

      // Display results
      let hasErrors = false;
      let hasWarnings = false;

      for (const result of results) {
        const icon =
          result.status === 'ok'
            ? chalk.green('[OK]')
            : result.status === 'warn'
              ? chalk.yellow('[WARN]')
              : chalk.red('[ERROR]');

        console.log(`${icon} ${result.name}`);
        console.log(chalk.gray(`    ${result.message}`));

        if (result.fix) {
          console.log(chalk.cyan(`    Fix: ${result.fix}`));

          if (options.fix && result.status !== 'ok') {
            const fixCmds = [
              'stackmemory setup-mcp',
              'stackmemory hooks install',
              'stackmemory daemon start',
            ];
            for (const cmd of fixCmds) {
              if (result.fix.includes(cmd)) {
                console.log(chalk.gray(`    Attempting: ${cmd}...`));
                try {
                  execSync(cmd, {
                    stdio: 'inherit',
                    timeout: 15000,
                  });
                } catch {
                  console.log(chalk.red('    Auto-fix failed'));
                }
                break;
              }
            }
          }
        }

        if (result.status === 'error') hasErrors = true;
        if (result.status === 'warn') hasWarnings = true;
      }

      // Summary
      console.log('');
      if (hasErrors) {
        console.log(
          chalk.red('Some issues need attention. Run suggested fixes above.')
        );
        process.exit(1);
      } else if (hasWarnings) {
        console.log(
          chalk.yellow(
            'StackMemory is working but some optional features are not configured.'
          )
        );
      } else {
        console.log(
          chalk.green('All checks passed! StackMemory is properly configured.')
        );
      }
    });
}

/**
 * Create setup-plugins command
 */
export function createSetupPluginsCommand(): Command {
  const cmd = new Command('setup-plugins');

  cmd
    .description('Install StackMemory plugins for Claude Code')
    .option('--force', 'Overwrite existing plugins')
    .action(async (options) => {
      console.log(
        chalk.cyan('Installing StackMemory plugins for Claude Code...\n')
      );

      const pluginsDir = join(CLAUDE_DIR, 'plugins');

      // Ensure plugins directory exists
      if (!existsSync(pluginsDir)) {
        mkdirSync(pluginsDir, { recursive: true });
        console.log(chalk.gray(`Created: ${pluginsDir}`));
      }

      // Find the plugins source directory
      // Check multiple locations: local dev, global npm, local npm
      const possiblePaths = [
        join(process.cwd(), 'plugins'),
        join(__dirname, '..', '..', '..', 'plugins'),
        join(homedir(), '.stackmemory', 'plugins'),
      ];

      // Try to find via npm root
      try {
        const globalRoot = execSync('npm root -g', {
          encoding: 'utf-8',
        }).trim();
        possiblePaths.push(
          join(globalRoot, '@stackmemoryai', 'stackmemory', 'plugins')
        );
      } catch {
        // npm not available or failed
      }

      let sourcePluginsDir: string | undefined;
      for (const p of possiblePaths) {
        if (existsSync(p) && existsSync(join(p, 'stackmemory'))) {
          sourcePluginsDir = p;
          break;
        }
      }

      if (!sourcePluginsDir) {
        console.log(chalk.red('Could not find StackMemory plugins directory'));
        console.log(chalk.gray('Searched:'));
        possiblePaths.forEach((p) => console.log(chalk.gray(`  - ${p}`)));
        process.exit(1);
      }

      console.log(chalk.gray(`Source: ${sourcePluginsDir}\n`));

      // List of plugins to install
      const plugins = ['stackmemory', 'ralph-wiggum'];
      let installed = 0;

      for (const plugin of plugins) {
        const sourcePath = join(sourcePluginsDir, plugin);
        const targetPath = join(pluginsDir, plugin);

        if (!existsSync(sourcePath)) {
          console.log(chalk.yellow(`  [SKIP] ${plugin} - not found in source`));
          continue;
        }

        if (existsSync(targetPath)) {
          if (options.force) {
            // Remove existing
            try {
              rmSync(targetPath, { recursive: true, force: true });
            } catch {
              console.log(
                chalk.red(`  [ERROR] ${plugin} - could not remove existing`)
              );
              continue;
            }
          } else {
            console.log(
              chalk.gray(`  [EXISTS] ${plugin} - use --force to overwrite`)
            );
            continue;
          }
        }

        // Create symlink
        try {
          execSync(`ln -s "${sourcePath}" "${targetPath}"`, {
            encoding: 'utf-8',
          });
          console.log(chalk.green(`  [OK] ${plugin}`));
          installed++;
        } catch (err) {
          console.log(
            chalk.red(`  [ERROR] ${plugin} - ${(err as Error).message}`)
          );
        }
      }

      console.log('');
      if (installed > 0) {
        console.log(chalk.green(`Installed ${installed} plugin(s)`));
        console.log(chalk.gray('\nAvailable commands in Claude Code:'));
        console.log(
          chalk.white('  /sm-status    ') +
            chalk.gray('Show StackMemory status')
        );
        console.log(
          chalk.white('  /sm-capture   ') +
            chalk.gray('Capture work for handoff')
        );
        console.log(
          chalk.white('  /sm-restore   ') +
            chalk.gray('Restore from last handoff')
        );
        console.log(
          chalk.white('  /sm-decision  ') + chalk.gray('Record a decision')
        );
        console.log(
          chalk.white('  /sm-help      ') + chalk.gray('Show all commands')
        );
        console.log(
          chalk.white('  /ralph-loop   ') +
            chalk.gray('Start Ralph iteration loop')
        );
      } else {
        console.log(chalk.yellow('No plugins installed'));
      }
    });

  return cmd;
}

/**
 * Create setup-remote command for remote MCP server auto-start
 */
export function createSetupRemoteCommand(): Command {
  const cmd = new Command('setup-remote');

  cmd
    .description('Configure remote MCP server to auto-start on boot')
    .option('--port <number>', 'Port for remote server', '3847')
    .option('--project <path>', 'Project root directory')
    .option('--uninstall', 'Remove the auto-start service')
    .option('--status', 'Check service status')
    .action(async (options) => {
      const home = homedir();
      const platform = process.platform;

      // Service configuration
      const serviceName =
        platform === 'darwin'
          ? 'com.stackmemory.remote-mcp'
          : 'stackmemory-remote-mcp';
      const serviceDir =
        platform === 'darwin'
          ? join(home, 'Library', 'LaunchAgents')
          : join(home, '.config', 'systemd', 'user');
      const serviceFile =
        platform === 'darwin'
          ? join(serviceDir, `${serviceName}.plist`)
          : join(serviceDir, `${serviceName}.service`);
      const logDir = join(home, '.stackmemory', 'logs');
      const _pidFile = join(home, '.stackmemory', 'remote-mcp.pid');

      // Handle status check
      if (options.status) {
        console.log(chalk.cyan('\nRemote MCP Server Status\n'));

        if (platform === 'darwin') {
          try {
            const result = execSync(
              `launchctl list | grep ${serviceName} || true`,
              { encoding: 'utf-8' }
            );
            if (result.includes(serviceName)) {
              console.log(chalk.green('[RUNNING]') + ' Service is active');
              try {
                const health = execSync(
                  `curl -s http://localhost:${options.port}/health 2>/dev/null`,
                  { encoding: 'utf-8' }
                );
                const data = JSON.parse(health);
                console.log(chalk.gray(`  Project: ${data.projectId}`));
                console.log(
                  chalk.gray(`  URL: http://localhost:${options.port}/sse`)
                );
              } catch {
                console.log(
                  chalk.yellow('  Server not responding to health check')
                );
              }
            } else {
              console.log(chalk.yellow('[STOPPED]') + ' Service not running');
            }
          } catch {
            console.log(chalk.yellow('[UNKNOWN]') + ' Could not check status');
          }
        } else if (platform === 'linux') {
          try {
            execSync(`systemctl --user is-active ${serviceName}`, {
              stdio: 'pipe',
            });
            console.log(chalk.green('[RUNNING]') + ' Service is active');
          } catch {
            console.log(chalk.yellow('[STOPPED]') + ' Service not running');
          }
        }

        console.log(chalk.gray(`\nService file: ${serviceFile}`));
        console.log(chalk.gray(`Logs: ${logDir}/remote-mcp.log`));
        return;
      }

      // Handle uninstall
      if (options.uninstall) {
        console.log(chalk.cyan('\nUninstalling Remote MCP Server Service\n'));

        if (platform === 'darwin') {
          try {
            execSync(`launchctl unload "${serviceFile}"`, { stdio: 'pipe' });
            console.log(chalk.green('[OK]') + ' Service unloaded');
          } catch {
            console.log(chalk.gray('[SKIP]') + ' Service was not loaded');
          }

          if (existsSync(serviceFile)) {
            const fs = await import('fs/promises');
            await fs.unlink(serviceFile);
            console.log(chalk.green('[OK]') + ' Service file removed');
          }
        } else if (platform === 'linux') {
          try {
            execSync(`systemctl --user stop ${serviceName}`, { stdio: 'pipe' });
            execSync(`systemctl --user disable ${serviceName}`, {
              stdio: 'pipe',
            });
            console.log(chalk.green('[OK]') + ' Service stopped and disabled');
          } catch {
            console.log(chalk.gray('[SKIP]') + ' Service was not running');
          }

          if (existsSync(serviceFile)) {
            const fs = await import('fs/promises');
            await fs.unlink(serviceFile);
            execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
            console.log(chalk.green('[OK]') + ' Service file removed');
          }
        }

        console.log(chalk.green('\nRemote MCP service uninstalled'));
        return;
      }

      // Install service
      console.log(chalk.cyan('\nSetting up Remote MCP Server Auto-Start\n'));

      if (platform !== 'darwin' && platform !== 'linux') {
        console.log(
          chalk.red('Auto-start is only supported on macOS and Linux')
        );
        console.log(chalk.gray('\nManual start: stackmemory mcp-remote'));
        return;
      }

      // Create directories
      if (!existsSync(serviceDir)) {
        mkdirSync(serviceDir, { recursive: true });
      }
      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
      }

      // Find node and stackmemory paths
      let nodePath: string;
      try {
        nodePath = execSync('which node', { encoding: 'utf-8' }).trim();
      } catch {
        nodePath = '/usr/local/bin/node';
      }

      // Find stackmemory CLI path
      let stackmemoryPath: string;
      try {
        stackmemoryPath = execSync('which stackmemory', {
          encoding: 'utf-8',
        }).trim();
      } catch {
        // Try npm global path
        try {
          const npmRoot = execSync('npm root -g', { encoding: 'utf-8' }).trim();
          stackmemoryPath = join(
            npmRoot,
            '@stackmemoryai',
            'stackmemory',
            'dist',
            'cli',
            'index.js'
          );
        } catch {
          stackmemoryPath = 'npx stackmemory';
        }
      }

      const projectPath = options.project || home;
      const port = options.port || '3847';

      if (platform === 'darwin') {
        // Generate macOS launchd plist
        const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${serviceName}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${stackmemoryPath.includes('npx') ? 'npx' : nodePath}</string>
        ${stackmemoryPath.includes('npx') ? '<string>stackmemory</string>' : `<string>${stackmemoryPath}</string>`}
        <string>mcp-remote</string>
        <string>--port</string>
        <string>${port}</string>
        <string>--project</string>
        <string>${projectPath}</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <key>WorkingDirectory</key>
    <string>${projectPath}</string>

    <key>StandardOutPath</key>
    <string>${logDir}/remote-mcp.log</string>

    <key>StandardErrorPath</key>
    <string>${logDir}/remote-mcp.error.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${home}</string>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
        <key>NODE_ENV</key>
        <string>production</string>
    </dict>

    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>`;

        writeFileSync(serviceFile, plist);
        console.log(chalk.green('[OK]') + ' Created launchd service file');

        // Unload if already loaded
        try {
          execSync(`launchctl unload "${serviceFile}" 2>/dev/null`, {
            stdio: 'pipe',
          });
        } catch {
          // Not loaded, ignore
        }

        // Load the service
        try {
          execSync(`launchctl load -w "${serviceFile}"`, { stdio: 'pipe' });
          console.log(chalk.green('[OK]') + ' Service loaded and started');
        } catch (err) {
          console.log(chalk.red('[ERROR]') + ` Failed to load service: ${err}`);
          return;
        }
      } else if (platform === 'linux') {
        // Generate systemd service
        const service = `[Unit]
Description=StackMemory Remote MCP Server
Documentation=https://github.com/stackmemoryai/stackmemory
After=network.target

[Service]
Type=simple
ExecStart=${stackmemoryPath.includes('npx') ? 'npx stackmemory' : `${nodePath} ${stackmemoryPath}`} mcp-remote --port ${port} --project ${projectPath}
Restart=on-failure
RestartSec=10
WorkingDirectory=${projectPath}

Environment=HOME=${home}
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=NODE_ENV=production

StandardOutput=append:${logDir}/remote-mcp.log
StandardError=append:${logDir}/remote-mcp.error.log

[Install]
WantedBy=default.target`;

        writeFileSync(serviceFile, service);
        console.log(chalk.green('[OK]') + ' Created systemd service file');

        try {
          execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
          execSync(`systemctl --user enable ${serviceName}`, { stdio: 'pipe' });
          execSync(`systemctl --user start ${serviceName}`, { stdio: 'pipe' });
          console.log(chalk.green('[OK]') + ' Service enabled and started');
        } catch (err) {
          console.log(
            chalk.red('[ERROR]') + ` Failed to start service: ${err}`
          );
          return;
        }
      }

      // Verify it's running
      console.log(chalk.cyan('\nVerifying server...\n'));
      await new Promise((resolve) => setTimeout(resolve, 2000));

      try {
        const health = execSync(
          `curl -s http://localhost:${port}/health 2>/dev/null`,
          { encoding: 'utf-8' }
        );
        const data = JSON.parse(health);
        console.log(chalk.green('[OK]') + ' Server is running');
        console.log(chalk.gray(`  Project: ${data.projectId}`));
      } catch {
        console.log(
          chalk.yellow('[WARN]') +
            ' Server not responding yet (may still be starting)'
        );
      }

      console.log(
        chalk.green('\nRemote MCP Server configured for auto-start!')
      );
      console.log(chalk.cyan('\nConnection info:'));
      console.log(chalk.white(`  URL: http://localhost:${port}/sse`));
      console.log(chalk.white(`  Health: http://localhost:${port}/health`));
      console.log(chalk.gray(`\nLogs: ${logDir}/remote-mcp.log`));
      console.log(chalk.gray(`Service: ${serviceFile}`));
    });

  return cmd;
}

/**
 * Create setup-commands command for installing command packs
 */
export function createSetupCommandsCommand(): Command {
  const cmd = new Command('setup-commands');

  cmd
    .description('Install StackMemory command packs for Claude Code')
    .argument('[pack]', 'Pack name to install (default: core)', 'core')
    .option('--list', 'List available packs and their commands')
    .option('--force', 'Overwrite existing command files')
    .option('--uninstall', 'Remove installed commands')
    .option('--dry-run', 'Show what would be installed without making changes')
    .action(async (pack: string, options) => {
      const commandsDir = join(CLAUDE_DIR, 'commands');

      // Find packs source directory
      const possiblePaths = [
        join(process.cwd(), 'packs'),
        join(__dirname, '..', '..', '..', 'packs'),
      ];

      // Try npm global path
      try {
        const globalRoot = execSync('npm root -g', {
          encoding: 'utf-8',
        }).trim();
        possiblePaths.push(
          join(globalRoot, '@stackmemoryai', 'stackmemory', 'packs')
        );
      } catch {
        // npm not available
      }

      let packsDir: string | undefined;
      for (const p of possiblePaths) {
        if (existsSync(p)) {
          packsDir = p;
          break;
        }
      }

      if (!packsDir) {
        console.log(chalk.red('Could not find packs directory'));
        process.exit(1);
      }

      // List mode
      if (options.list) {
        console.log(chalk.cyan('\nAvailable command packs:\n'));
        const packs = readdirSync(packsDir).filter((d) =>
          existsSync(join(packsDir!, d, 'manifest.json'))
        );

        for (const p of packs) {
          const manifest = JSON.parse(
            readFileSync(join(packsDir, p, 'manifest.json'), 'utf8')
          );
          console.log(
            chalk.white(`  ${manifest.name}`) +
              chalk.gray(` v${manifest.version} — ${manifest.description}`)
          );

          // Show public commands
          if (manifest.commands?.public) {
            for (const cmd of manifest.commands.public) {
              console.log(
                chalk.green(`    /${cmd.name}`) +
                  chalk.gray(` — ${cmd.description}`)
              );
            }
          }

          // Show internal deps
          if (manifest.commands?.internal) {
            console.log(
              chalk.gray(
                `    + ${manifest.commands.internal.length} internal deps`
              )
            );
          }
          console.log('');
        }
        return;
      }

      // Validate pack exists
      const packDir = join(packsDir, pack);
      const manifestPath = join(packDir, 'manifest.json');

      if (!existsSync(manifestPath)) {
        console.log(chalk.red(`Pack "${pack}" not found`));
        console.log(chalk.gray('Run: stackmemory setup-commands --list'));
        process.exit(1);
      }

      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const allCommands = [
        ...(manifest.commands?.public || []),
        ...(manifest.commands?.internal || []),
      ];

      // Uninstall mode
      if (options.uninstall) {
        console.log(
          chalk.cyan(
            `\nUninstalling pack: ${manifest.name} v${manifest.version}\n`
          )
        );

        let removed = 0;
        for (const cmd of allCommands) {
          const targetPath = join(commandsDir, `${cmd.name}.md`);
          if (existsSync(targetPath)) {
            if (options.dryRun) {
              console.log(chalk.gray(`  Would remove: /${cmd.name}`));
            } else {
              rmSync(targetPath, { force: true });
              console.log(chalk.green(`  [OK]`) + ` Removed /${cmd.name}`);
              removed++;
            }
          }
        }

        console.log(chalk.green(`\nRemoved ${removed} command(s)`));
        return;
      }

      // Install mode
      console.log(
        chalk.cyan(`\nInstalling pack: ${manifest.name} v${manifest.version}\n`)
      );
      console.log(chalk.gray(`${manifest.description}\n`));

      // Ensure commands directory exists
      if (!existsSync(commandsDir)) {
        if (options.dryRun) {
          console.log(chalk.gray(`Would create: ${commandsDir}`));
        } else {
          mkdirSync(commandsDir, { recursive: true });
        }
      }

      let installed = 0;
      let skipped = 0;

      for (const cmd of allCommands) {
        const sourcePath = join(packDir, cmd.file);
        const targetPath = join(commandsDir, `${cmd.name}.md`);
        const isPublic = manifest.commands?.public?.some(
          (c: { name: string }) => c.name === cmd.name
        );

        if (!existsSync(sourcePath)) {
          console.log(
            chalk.red(`  [MISS] /${cmd.name}`) +
              chalk.gray(` — source not found: ${cmd.file}`)
          );
          continue;
        }

        if (existsSync(targetPath) && !options.force) {
          console.log(
            chalk.gray(`  [SKIP] /${cmd.name} — exists (use --force)`)
          );
          skipped++;
          continue;
        }

        if (options.dryRun) {
          const tag = isPublic ? chalk.green('PUBLIC') : chalk.gray('INTERNAL');
          console.log(
            chalk.gray(`  Would install: `) +
              chalk.white(`/${cmd.name}`) +
              ` [${tag}]`
          );
          installed++;
          continue;
        }

        // Remove existing (symlink or file) before creating new symlink
        if (existsSync(targetPath)) {
          rmSync(targetPath, { force: true });
        }

        // Create symlink
        try {
          execSync(`ln -s "${sourcePath}" "${targetPath}"`, {
            encoding: 'utf-8',
          });
          const tag = isPublic ? chalk.green('PUBLIC') : chalk.gray('INTERNAL');
          console.log(
            chalk.green(`  [OK]`) +
              ` /${cmd.name} [${tag}]` +
              chalk.gray(` — ${cmd.description}`)
          );
          installed++;
        } catch (err) {
          console.log(
            chalk.red(`  [ERROR] /${cmd.name}`) +
              chalk.gray(` — ${(err as Error).message}`)
          );
        }
      }

      console.log('');
      if (installed > 0) {
        console.log(chalk.green(`Installed ${installed} command(s)`));
      }
      if (skipped > 0) {
        console.log(chalk.gray(`Skipped ${skipped} (already exist)`));
      }

      if (!options.dryRun && installed > 0) {
        console.log(chalk.cyan('\nAvailable commands in Claude Code:'));
        for (const cmd of manifest.commands?.public || []) {
          console.log(
            chalk.white(`  /${cmd.name}`) + chalk.gray(`  ${cmd.description}`)
          );
        }
      }
    });

  return cmd;
}

/**
 * Register setup commands
 */
export function registerSetupCommands(program: Command): void {
  program.addCommand(createSetupMCPCommand());
  program.addCommand(createDoctorCommand());
  program.addCommand(createSetupPluginsCommand());
  program.addCommand(createSetupRemoteCommand());
  program.addCommand(createSetupCommandsCommand());
}
