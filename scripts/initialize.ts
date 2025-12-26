#!/usr/bin/env tsx
/**
 * Initialize StackMemory in the current project
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import chalk from 'chalk';

const projectRoot = process.cwd();

console.log(chalk.blue.bold('\n🚀 Initializing StackMemory...\n'));

// 1. Create .stackmemory directory
const stackDir = join(projectRoot, '.stackmemory');
if (!existsSync(stackDir)) {
  mkdirSync(stackDir, { recursive: true });
  console.log(chalk.green('✓') + ' Created .stackmemory directory');
} else {
  console.log(chalk.yellow('⚠') + ' .stackmemory directory already exists');
}

// 2. Add to .gitignore
const gitignorePath = join(projectRoot, '.gitignore');
const gitignoreEntry = '\n# StackMemory\n.stackmemory/*.db\n.stackmemory/*.db-*\n';

if (existsSync(gitignorePath)) {
  const gitignore = require('fs').readFileSync(gitignorePath, 'utf-8');
  if (!gitignore.includes('.stackmemory')) {
    require('fs').appendFileSync(gitignorePath, gitignoreEntry);
    console.log(chalk.green('✓') + ' Added .stackmemory to .gitignore');
  }
} else {
  writeFileSync(gitignorePath, gitignoreEntry);
  console.log(chalk.green('✓') + ' Created .gitignore with .stackmemory');
}

// 3. Create config file
const configPath = join(stackDir, 'config.json');
if (!existsSync(configPath)) {
  const config = {
    projectId: projectRoot.split('/').pop(),
    userId: process.env.USER || 'default',
    teamId: 'local',
    initialized: new Date().toISOString()
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(chalk.green('✓') + ' Created config file');
}

// 4. Create initial JSONL file
const jsonlPath = join(stackDir, 'frames.jsonl');
if (!existsSync(jsonlPath)) {
  const initialFrame = {
    id: 'init_' + Date.now(),
    type: 'system',
    content: 'StackMemory initialized',
    timestamp: Date.now()
  };
  writeFileSync(jsonlPath, JSON.stringify(initialFrame) + '\n');
  console.log(chalk.green('✓') + ' Created frames.jsonl');
}

// 5. Create MCP config for Claude Code
const mcpConfigPath = join(process.env.HOME || '~', '.config', 'claude', 'mcp.json');
console.log(chalk.blue('\n📝 MCP Configuration for Claude Code:\n'));

const mcpConfig = {
  "mcpServers": {
    "stackmemory": {
      "command": "node",
      "args": [join(projectRoot, "dist", "mcp-server.js")],
      "env": {
        "PROJECT_ROOT": projectRoot
      }
    }
  }
};

console.log(chalk.gray('Add this to your Claude Code MCP configuration:'));
console.log(chalk.gray('(' + mcpConfigPath + ')\n'));
console.log(chalk.cyan(JSON.stringify(mcpConfig, null, 2)));

// 6. Build the project
console.log(chalk.blue('\n📦 Building TypeScript files...\n'));
try {
  execSync('npm run build', { stdio: 'inherit', cwd: projectRoot });
  console.log(chalk.green('✓') + ' Build completed');
} catch (e) {
  console.log(chalk.yellow('⚠') + ' Build failed - run npm run build manually');
}

console.log(chalk.green.bold('\n✅ StackMemory initialized successfully!\n'));
console.log(chalk.gray('Next steps:'));
console.log(chalk.gray('1. Add the MCP configuration above to Claude Code'));
console.log(chalk.gray('2. Restart Claude Code'));
console.log(chalk.gray('3. Start using context tracking!'));
console.log(chalk.gray('\nUseful commands:'));
console.log(chalk.cyan('  npm run mcp:dev') + ' - Start MCP server in dev mode');
console.log(chalk.cyan('  npm run status') + ' - Check StackMemory status');
console.log(chalk.cyan('  npm run analyze') + ' - Analyze context usage\n');