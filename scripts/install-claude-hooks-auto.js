#!/usr/bin/env node

/**
 * Auto-install Claude hooks during npm install
 * This runs as a postinstall script to set up tracing hooks and daemon
 *
 * INTERACTIVE: Asks for user consent before modifying ~/.claude
 *
 * Writes to ~/.claude/settings.json (the current Claude Code config format).
 * Uses CANONICAL_HOOKS from hook-installer when dist is available, otherwise
 * falls back to an inline definition.
 */

import {
  existsSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';

import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const claudeHooksDir = join(homedir(), '.claude', 'hooks');
const claudeSettingsFile = join(homedir(), '.claude', 'settings.json');
const templatesDir = join(__dirname, '..', 'templates', 'claude-hooks');
const stackmemoryBinDir = join(homedir(), '.stackmemory', 'bin');
const distDir = join(__dirname, '..', 'dist');

// ---------------------------------------------------------------------------
// Try to import from compiled hook-installer; fall back to inline definitions
// ---------------------------------------------------------------------------

/** @type {Array<{scriptName: string, eventType: string, matcher?: string, timeout?: number, commandPrefix?: string, required: boolean}>} */
let CANONICAL_HOOKS;
let mergeSettingsFn;
let readSettingsFn;
let writeSettingsAtomicFn;

try {
  const mod = await import('../dist/src/utils/hook-installer.js');
  CANONICAL_HOOKS = mod.CANONICAL_HOOKS;
  mergeSettingsFn = mod.mergeSettings;
  readSettingsFn = mod.readSettings;
  writeSettingsAtomicFn = mod.writeSettingsAtomic;
} catch {
  // dist not built yet — use inline fallback
  CANONICAL_HOOKS = [
    {
      scriptName: 'session-rescue.sh',
      eventType: 'Stop',
      timeout: 12,
      required: true,
    },
    {
      scriptName: 'stop-checkpoint.js',
      eventType: 'Stop',
      timeout: 5,
      commandPrefix: 'node',
      required: true,
    },
    {
      scriptName: 'chime-on-stop.sh',
      eventType: 'Stop',
      timeout: 2,
      required: true,
    },
    {
      scriptName: 'auto-checkpoint.js',
      eventType: 'PostToolUse',
      timeout: 2,
      commandPrefix: 'node',
      required: true,
    },
    {
      scriptName: 'cord-trace.js',
      eventType: 'PostToolUse',
      matcher: 'mcp__.*__cord_(spawn|fork|complete|ask|tree)',
      timeout: 2,
      commandPrefix: 'node',
      required: true,
    },
    {
      scriptName: 'team-subagent-stop.js',
      eventType: 'SubagentStop',
      timeout: 5,
      commandPrefix: 'node',
      required: false,
    },
    {
      scriptName: 'team-task-complete.js',
      eventType: 'TaskCompleted',
      timeout: 5,
      commandPrefix: 'node',
      required: false,
    },
    {
      scriptName: 'team-teammate-idle.js',
      eventType: 'TeammateIdle',
      timeout: 3,
      commandPrefix: 'node',
      required: false,
    },
    {
      scriptName: 'desire-path-trace.js',
      eventType: 'PostToolUse',
      timeout: 2,
      commandPrefix: 'node',
      required: false,
    },
  ];

  const DEAD_HOOKS = ['sms-response-handler.js'];

  readSettingsFn = (p) => {
    try {
      if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      /* parse error */
    }
    return {};
  };

  writeSettingsAtomicFn = (settings, p) => {
    const dir = dirname(p);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = p + '.tmp';
    writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
    renameSync(tmp, p);
  };

  mergeSettingsFn = (existing, hooksDir) => {
    const merged = JSON.parse(JSON.stringify(existing));
    if (!merged.hooks) merged.hooks = {};

    // Remove dead hooks
    for (const eventType of Object.keys(merged.hooks)) {
      const groups = merged.hooks[eventType];
      for (const group of groups) {
        group.hooks = group.hooks.filter((h) => {
          for (const dead of DEAD_HOOKS) {
            if (h.command.includes(dead)) return false;
          }
          return true;
        });
      }
      merged.hooks[eventType] = groups.filter((g) => g.hooks.length > 0);
      if (merged.hooks[eventType].length === 0) delete merged.hooks[eventType];
    }

    // Add missing canonical hooks
    for (const entry of CANONICAL_HOOKS) {
      const exists = (merged.hooks[entry.eventType] || []).some((group) =>
        group.hooks.some((h) => h.command.includes(entry.scriptName))
      );
      if (exists) continue;

      const scriptPath = join(hooksDir, entry.scriptName);
      const command = entry.commandPrefix
        ? `${entry.commandPrefix} ${scriptPath}`
        : scriptPath;
      const hookCmd = { type: 'command', command };
      if (entry.timeout) hookCmd.timeout = entry.timeout;

      const eventGroups = merged.hooks[entry.eventType] || [];
      const matcherValue = entry.matcher;
      let targetGroup = eventGroups.find((g) =>
        matcherValue ? g.matcher === matcherValue : !g.matcher
      );

      if (targetGroup) {
        targetGroup.hooks.push(hookCmd);
      } else {
        const newGroup = { hooks: [hookCmd] };
        if (matcherValue) newGroup.matcher = matcherValue;
        eventGroups.push(newGroup);
      }
      merged.hooks[entry.eventType] = eventGroups;
    }

    return merged;
  };
}

// ---------------------------------------------------------------------------
// Legacy hook files (still installed for backward-compat tooling hooks)
// ---------------------------------------------------------------------------

const LEGACY_HOOK_FILES = [
  'tool-use-trace.js',
  'on-startup.js',
  'on-clear.js',
  'on-task-complete.js',
  'skill-eval.sh',
  'skill-eval.cjs',
];
const LEGACY_DATA_FILES = ['skill-rules.json'];

/**
 * Ask user for confirmation before installing hooks
 * Returns true if user consents, false otherwise
 */
async function askForConsent() {
  // Auto-install if STACKMEMORY_AUTO_HOOKS=true (no prompt needed)
  if (process.env.STACKMEMORY_AUTO_HOOKS === 'true') {
    console.log(
      'STACKMEMORY_AUTO_HOOKS=true — installing hooks automatically.'
    );
    return true;
  }

  // Skip prompt if not interactive (CI/CD, piped input)
  if (!process.stdin.isTTY || process.env.CI === 'true') {
    console.log(
      'StackMemory installed. Run "stackmemory setup-mcp" to configure Claude Code integration.'
    );
    return false;
  }

  console.log('\nStackMemory Post-Install\n');
  console.log(
    'StackMemory can integrate with Claude Code by installing hooks that:'
  );
  console.log('  - Track tool usage for better context');
  console.log('  - Enable session persistence across restarts');
  console.log('  - Auto-checkpoint and session rescue');
  console.log('  - Recommend relevant skills based on your prompts');
  console.log('\nThis will modify files in ~/.claude/\n');

  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question('Install Claude Code hooks? [y/N] ', (answer) => {
      rl.close();
      const normalized = answer.toLowerCase().trim();
      resolve(normalized === 'y' || normalized === 'yes');
    });

    // Timeout after 30 seconds - default to no
    setTimeout(() => {
      console.log('\n(Timed out, skipping hook installation)');
      rl.close();
      resolve(false);
    }, 30000);
  });
}

async function installClaudeHooks() {
  try {
    // Create Claude hooks directory if it doesn't exist
    if (!existsSync(claudeHooksDir)) {
      mkdirSync(claudeHooksDir, { recursive: true });
      console.log('Created ~/.claude/hooks directory');
    }

    let installed = 0;

    // --- Install canonical session-persistence hooks ---
    for (const entry of CANONICAL_HOOKS) {
      const srcPath = join(templatesDir, entry.scriptName);
      const destPath = join(claudeHooksDir, entry.scriptName);

      if (existsSync(srcPath)) {
        // Backup existing hook if it exists
        if (existsSync(destPath)) {
          const backupPath = `${destPath}.backup-${Date.now()}`;
          copyFileSync(destPath, backupPath);
          console.log(`  Backed up: ${entry.scriptName}`);
        }

        copyFileSync(srcPath, destPath);
        try {
          chmodSync(destPath, 0o755);
        } catch {
          // Silent fail on chmod
        }
        installed++;
        console.log(`  Installed: ${entry.scriptName}`);
      }
    }

    // --- Install legacy tooling hooks ---
    for (const hookFile of [...LEGACY_HOOK_FILES, ...LEGACY_DATA_FILES]) {
      const srcPath = join(templatesDir, hookFile);
      const destPath = join(claudeHooksDir, hookFile);

      if (existsSync(srcPath)) {
        if (existsSync(destPath)) {
          const backupPath = `${destPath}.backup-${Date.now()}`;
          copyFileSync(destPath, backupPath);
          console.log(`  Backed up: ${hookFile}`);
        }

        copyFileSync(srcPath, destPath);

        if (!LEGACY_DATA_FILES.includes(hookFile)) {
          try {
            chmodSync(destPath, 0o755);
          } catch {
            // Silent fail on chmod
          }
        }

        installed++;
        console.log(`  Installed: ${hookFile}`);
      }
    }

    // --- Update settings.json (not the deprecated hooks.json) ---
    const currentSettings = readSettingsFn(claudeSettingsFile);
    const merged = mergeSettingsFn(currentSettings, claudeHooksDir);
    writeSettingsAtomicFn(merged, claudeSettingsFile);

    if (installed > 0) {
      console.log(`\n[OK] Installed ${installed} Claude hooks`);
      console.log(`     Config: ~/.claude/settings.json`);
      console.log(`     Traces: ~/.stackmemory/traces/`);
      console.log('     To disable: set DEBUG_TRACE=false in .env');
    }

    // Install session daemon binary
    await installSessionDaemon();

    return true;
  } catch (error) {
    console.error('Hook installation failed:', error.message);
    console.error('(Non-critical - StackMemory works without hooks)');
    return false;
  }
}

/**
 * Install the session daemon binary to ~/.stackmemory/bin/
 */
async function installSessionDaemon() {
  try {
    // Create bin directory if needed
    if (!existsSync(stackmemoryBinDir)) {
      mkdirSync(stackmemoryBinDir, { recursive: true });
      console.log('Created StackMemory bin directory');
    }

    // Look for the daemon in dist
    const daemonSrc = join(distDir, 'daemon', 'session-daemon.js');
    const daemonDest = join(stackmemoryBinDir, 'session-daemon.js');

    if (existsSync(daemonSrc)) {
      copyFileSync(daemonSrc, daemonDest);

      try {
        chmodSync(daemonDest, 0o755);
      } catch {
        // Silent fail on chmod
      }

      console.log('Installed session daemon binary');
    } else {
      console.log('Session daemon not found in dist (build first)');
    }
  } catch (error) {
    console.error('Failed to install session daemon:', error.message);
    // Non-critical error
  }
}

// Only run if called directly (not imported)
if (import.meta.url === `file://${process.argv[1]}`) {
  const consent = await askForConsent();
  if (consent) {
    await installClaudeHooks();
    console.log(
      '\nNext: Run "stackmemory setup-mcp" to complete Claude Code integration.'
    );
  } else {
    console.log(
      'Skipped hook installation. Run "stackmemory hooks install" later if needed.'
    );
  }
}

export { installClaudeHooks };
