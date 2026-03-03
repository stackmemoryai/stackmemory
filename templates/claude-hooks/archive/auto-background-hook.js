#!/usr/bin/env node
/**
 * Claude Code pre-tool-use hook for auto-backgrounding commands
 *
 * Install: Add to ~/.claude/settings.json hooks.pre_tool_use
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_PATH = path.join(
  os.homedir(),
  '.stackmemory',
  'auto-background.json'
);

const DEFAULT_CONFIG = {
  enabled: true,
  timeoutMs: 5000,
  alwaysBackground: [
    'npm install',
    'npm ci',
    'yarn install',
    'pnpm install',
    'bun install',
    'npm run build',
    'yarn build',
    'pnpm build',
    'cargo build',
    'go build',
    'make',
    'npm test',
    'npm run test',
    'yarn test',
    'pytest',
    'jest',
    'vitest',
    'cargo test',
    'docker build',
    'docker-compose up',
    'docker compose up',
    'git clone',
    'git fetch --all',
    'npx tsc',
    'tsc --noEmit',
    'eslint .',
    'npm run lint',
  ],
  neverBackground: [
    'vim',
    'nvim',
    'nano',
    'less',
    'more',
    'top',
    'htop',
    'echo',
    'cat',
    'ls',
    'pwd',
    'cd',
    'which',
    'git status',
    'git diff',
    'git log',
  ],
  verbose: false,
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return {
        ...DEFAULT_CONFIG,
        ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')),
      };
    }
  } catch {}
  return DEFAULT_CONFIG;
}

function shouldAutoBackground(command, config) {
  if (!config.enabled) return false;

  const cmd = command.trim().toLowerCase();

  // Never background these
  for (const pattern of config.neverBackground) {
    if (cmd.startsWith(pattern.toLowerCase())) return false;
  }

  // Always background these
  for (const pattern of config.alwaysBackground) {
    if (cmd.startsWith(pattern.toLowerCase())) return true;
  }

  return false;
}

// Read hook input from stdin
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  try {
    const hookData = JSON.parse(input);
    const { tool_name, tool_input } = hookData;

    // Only process Bash tool
    if (tool_name !== 'Bash') {
      // Allow other tools through unchanged
      console.log(JSON.stringify({ permissionDecision: 'allow' }));
      return;
    }

    const command = tool_input?.command;
    if (!command) {
      console.log(JSON.stringify({ permissionDecision: 'allow' }));
      return;
    }

    // Already backgrounded
    if (tool_input.run_in_background === true) {
      console.log(JSON.stringify({ permissionDecision: 'allow' }));
      return;
    }

    const config = loadConfig();

    if (shouldAutoBackground(command, config)) {
      if (config.verbose) {
        console.error(
          `[auto-bg] Backgrounding: ${command.substring(0, 60)}...`
        );
      }

      // Modify the tool input to add run_in_background using correct schema
      console.log(
        JSON.stringify({
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: {
            ...tool_input,
            run_in_background: true,
          },
        })
      );
    } else {
      console.log(JSON.stringify({ permissionDecision: 'allow' }));
    }
  } catch (err) {
    // On error, allow the command through unchanged
    console.error('[auto-bg] Error:', err.message);
    console.log(JSON.stringify({ permissionDecision: 'allow' }));
  }
});
