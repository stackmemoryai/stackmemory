#!/usr/bin/env tsx
/**
 * Initialize StackMemory in the current project
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
} from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import chalk from 'chalk';

// Parse CLI args for --with-diffmem flag
const enableDiffMem = process.argv.includes('--with-diffmem');
// Type-safe environment variable access
function _getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (value === undefined) {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`Environment variable ${key} is required`);
  }
  return value;
}

function _getOptionalEnv(key: string): string | undefined {
  return process.env[key];
}

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
const gitignoreEntry =
  '\n# StackMemory\n.stackmemory/*.db\n.stackmemory/*.db-*\n';

if (existsSync(gitignorePath)) {
  const gitignore = readFileSync(gitignorePath, 'utf-8');
  if (!gitignore.includes('.stackmemory')) {
    appendFileSync(gitignorePath, gitignoreEntry);
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
    userId: process.env['USER'] || 'default',
    teamId: 'local',
    initialized: new Date().toISOString(),
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
    timestamp: Date.now(),
  };
  writeFileSync(jsonlPath, JSON.stringify(initialFrame) + '\n');
  console.log(chalk.green('✓') + ' Created frames.jsonl');
}

// 5. Create MCP config for Claude Code
const isMacOS = process.platform === 'darwin';
const mcpConfigPath = isMacOS
  ? join(
      process.env['HOME'] || '~',
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json'
    )
  : join(
      process.env['HOME'] || '~',
      '.config',
      'claude',
      'claude_desktop_config.json'
    );
console.log(chalk.blue('\n📝 MCP Configuration for Claude Code:\n'));

const mcpConfig = {
  mcpServers: {
    stackmemory: {
      command: 'node',
      args: [join(projectRoot, 'dist', 'integrations', 'mcp', 'server.js')],
      env: {
        PROJECT_ROOT: projectRoot,
      },
    },
  },
};

console.log(chalk.gray('Add this to your Claude Code MCP configuration:'));
console.log(chalk.gray('(' + mcpConfigPath + ')\n'));
console.log(chalk.cyan(JSON.stringify(mcpConfig, null, 2)));

// 6. Build the project
console.log(chalk.blue('\n📦 Building TypeScript files...\n'));
try {
  execSync('npm run build', { stdio: 'inherit', cwd: projectRoot });
  console.log(chalk.green('✓') + ' Build completed');
} catch {
  console.log(chalk.yellow('⚠') + ' Build failed - run npm run build manually');
}

// 7. Optional: Initialize DiffMem for long-term user memory
if (enableDiffMem) {
  console.log(chalk.blue('\n🧠 Setting up DiffMem integration...\n'));

  const diffmemDir = join(stackDir, 'diffmem');
  const diffmemStorageDir = join(diffmemDir, 'storage');
  const diffmemWorktreesDir = join(diffmemDir, 'worktrees');

  // Create DiffMem directories
  mkdirSync(diffmemStorageDir, { recursive: true });
  mkdirSync(diffmemWorktreesDir, { recursive: true });

  // Initialize git repo for storage
  if (!existsSync(join(diffmemStorageDir, '.git'))) {
    try {
      execSync('git init', { cwd: diffmemStorageDir, stdio: 'pipe' });
      execSync('git commit --allow-empty -m "Initialize DiffMem storage"', {
        cwd: diffmemStorageDir,
        stdio: 'pipe',
      });
      console.log(chalk.green('✓') + ' Initialized DiffMem storage repository');
    } catch {
      console.log(
        chalk.yellow('⚠') + ' Failed to initialize git repo for DiffMem'
      );
    }
  }

  // Create DiffMem config
  const diffmemConfigPath = join(diffmemDir, 'config.json');
  const diffmemConfig = {
    enabled: true,
    endpoint: 'http://localhost:8000',
    userId: process.env['USER'] || 'default',
    storagePath: diffmemStorageDir,
    worktreePath: diffmemWorktreesDir,
  };
  writeFileSync(diffmemConfigPath, JSON.stringify(diffmemConfig, null, 2));
  console.log(chalk.green('✓') + ' Created DiffMem configuration');

  // Add DiffMem env vars to .env file
  const envPath = join(projectRoot, '.env');
  const diffmemEnvVars = `
# DiffMem Configuration (Long-term User Memory)
DIFFMEM_ENABLED=true
DIFFMEM_ENDPOINT=http://localhost:8000
DIFFMEM_USER_ID=${process.env['USER'] || 'default'}
DIFFMEM_STORAGE_PATH=${diffmemStorageDir}
DIFFMEM_WORKTREE_PATH=${diffmemWorktreesDir}
`;

  if (existsSync(envPath)) {
    const envContent = readFileSync(envPath, 'utf-8');
    if (!envContent.includes('DIFFMEM_')) {
      appendFileSync(envPath, diffmemEnvVars);
      console.log(chalk.green('✓') + ' Added DiffMem configuration to .env');
    }
  } else {
    writeFileSync(envPath, diffmemEnvVars.trim() + '\n');
    console.log(chalk.green('✓') + ' Created .env with DiffMem configuration');
  }

  console.log(chalk.green('✓') + ' DiffMem integration configured');
  console.log(
    chalk.gray(
      '  Note: DiffMem server must be running for user memory features'
    )
  );
}

console.log(chalk.green.bold('\n✅ StackMemory initialized successfully!\n'));
console.log(chalk.gray('Next steps:'));
console.log(chalk.gray('1. Add the MCP configuration above to Claude Code'));
console.log(chalk.gray('2. Restart Claude Code'));
console.log(chalk.gray('3. Start using context tracking!'));
if (enableDiffMem) {
  console.log(chalk.gray('4. Start DiffMem server: npm run diffmem:start'));
}
console.log(chalk.gray('\nUseful commands:'));
console.log(
  chalk.cyan('  npm run mcp:dev') + ' - Start MCP server in dev mode'
);
console.log(chalk.cyan('  npm run status') + ' - Check StackMemory status');
console.log(chalk.cyan('  npm run analyze') + ' - Analyze context usage');
if (enableDiffMem) {
  console.log(
    chalk.cyan('  npm run diffmem:start') + ' - Start DiffMem server'
  );
}
console.log();
