#!/usr/bin/env node
/**
 * Automatically configure Claude Desktop to use StackMemory MCP
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

function setupClaudeIntegration() {
  console.log('🔧 Setting up Claude Desktop integration...\n');

  // Find Claude Desktop config path
  const configPaths = [
    path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json'
    ), // macOS
    path.join(os.homedir(), '.config', 'claude', 'claude_desktop_config.json'), // Linux
    path.join(
      os.homedir(),
      'AppData',
      'Roaming',
      'Claude',
      'claude_desktop_config.json'
    ), // Windows
  ];

  let configPath = null;
  for (const p of configPaths) {
    if (fs.existsSync(p) || fs.existsSync(path.dirname(p))) {
      configPath = p;
      break;
    }
  }

  if (!configPath) {
    console.log('❌ Claude Desktop config directory not found');
    console.log('📝 Manual setup required - add this to your Claude config:');
    printManualConfig();
    return;
  }

  // Current project path
  const projectRoot = process.cwd();
  const mcpServerPath = path.join(
    projectRoot,
    'dist',
    'src',
    'mcp',
    'mcp-server.js'
  );

  // Read existing config or create new
  let config = { mcpServers: {} };
  if (fs.existsSync(configPath)) {
    try {
      const existing = fs.readFileSync(configPath, 'utf8');
      config = JSON.parse(existing);
      if (!config.mcpServers) config.mcpServers = {};
    } catch (error) {
      console.log('⚠️  Could not parse existing config, creating new one');
    }
  }

  // Add/update StackMemory MCP server
  config.mcpServers.stackmemory = {
    command: 'node',
    args: [mcpServerPath],
    env: {
      PROJECT_ROOT: projectRoot,
      STACKMEMORY_AUTO_CHECK: 'true',
    },
  };

  // Ensure directory exists
  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  // Write config
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log('✅ Claude Desktop config updated successfully!');
    console.log(`📁 Config location: ${configPath}\n`);

    console.log(
      '🔄 Please restart Claude Desktop to activate StackMemory integration\n'
    );
    console.log('🎯 StackMemory will now automatically:');
    console.log('   • Save context every 15 minutes');
    console.log('   • Load previous context on startup');
    console.log('   • Track tasks and decisions');
    console.log('   • Enable seamless context persistence\n');
  } catch (error) {
    console.log('❌ Failed to write config file:', error.message);
    console.log('📝 Manual setup required:');
    printManualConfig();
  }
}

function printManualConfig() {
  const projectRoot = process.cwd();
  const mcpServerPath = path.join(
    projectRoot,
    'dist',
    'src',
    'mcp',
    'mcp-server.js'
  );

  console.log(
    '\n' +
      JSON.stringify(
        {
          mcpServers: {
            stackmemory: {
              command: 'node',
              args: [mcpServerPath],
              env: {
                PROJECT_ROOT: projectRoot,
                STACKMEMORY_AUTO_CHECK: 'true',
              },
            },
          },
        },
        null,
        2
      ) +
      '\n'
  );
}

setupClaudeIntegration();
