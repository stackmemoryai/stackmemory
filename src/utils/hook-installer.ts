/**
 * hook-installer.ts — Canonical hook definitions + settings.json merge logic
 *
 * Single source of truth for all Claude Code hooks that StackMemory manages.
 * Used by both:
 *   - claude-sm.ts ensureHooks() (session start)
 *   - scripts/install-claude-hooks-auto.js (postinstall)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface HookEntry {
  /** Script filename, e.g. "session-rescue.sh" */
  scriptName: string;
  /** Claude Code event type: "Stop" | "PreToolUse" | "PostToolUse" */
  eventType: string;
  /** Optional matcher for PreToolUse/PostToolUse, e.g. "Bash" */
  matcher?: string;
  /** Timeout in seconds */
  timeout?: number;
  /** Prefix for the command, e.g. "node" for .js files */
  commandPrefix?: string;
  /** Core session-persistence hook vs optional */
  required: boolean;
}

/** Hooks StackMemory owns and auto-installs */
export const CANONICAL_HOOKS: HookEntry[] = [
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
];

/** Script names that should be removed from settings (dead/deprecated hooks) */
export const DEAD_HOOKS: string[] = ['sms-response-handler.js'];

// ---------------------------------------------------------------------------
// settings.json types (subset relevant to hooks)
// ---------------------------------------------------------------------------

interface HookCommand {
  type: 'command';
  command: string;
  timeout?: number;
}

interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}

interface ClaudeSettings {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/** Build the full command string for a hook entry */
export function buildCommand(entry: HookEntry, hooksDir: string): string {
  const scriptPath = path.join(hooksDir, entry.scriptName);
  if (entry.commandPrefix) {
    return `${entry.commandPrefix} ${scriptPath}`;
  }
  return scriptPath;
}

/** Check if a hook (by scriptName) already exists in settings */
export function hookExists(
  settings: ClaudeSettings,
  entry: HookEntry
): boolean {
  const groups = settings.hooks?.[entry.eventType];
  if (!groups) return false;

  for (const group of groups) {
    for (const hook of group.hooks) {
      if (hook.command.includes(entry.scriptName)) {
        return true;
      }
    }
  }
  return false;
}

/** Detect whether settings contain any dead hooks */
export function hasDeadHooks(settings: ClaudeSettings): boolean {
  if (!settings.hooks) return false;

  for (const groups of Object.values(settings.hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        for (const dead of DEAD_HOOKS) {
          if (hook.command.includes(dead)) return true;
        }
      }
    }
  }
  return false;
}

/** Remove dead/deprecated hook references from settings (mutates in place) */
export function removeDeadHooks(settings: ClaudeSettings): boolean {
  if (!settings.hooks) return false;

  let removed = false;
  for (const eventType of Object.keys(settings.hooks)) {
    const groups = settings.hooks[eventType];
    for (const group of groups) {
      const before = group.hooks.length;
      group.hooks = group.hooks.filter((hook) => {
        for (const dead of DEAD_HOOKS) {
          if (hook.command.includes(dead)) return false;
        }
        return true;
      });
      if (group.hooks.length < before) removed = true;
    }
    // Remove empty groups
    settings.hooks[eventType] = groups.filter((g) => g.hooks.length > 0);
    // Remove empty event types
    if (settings.hooks[eventType].length === 0) {
      delete settings.hooks[eventType];
    }
  }
  return removed;
}

/** Add a single hook entry to settings (mutates in place) */
function addHook(
  settings: ClaudeSettings,
  entry: HookEntry,
  hooksDir: string
): void {
  if (!settings.hooks) settings.hooks = {};

  const eventGroups = settings.hooks[entry.eventType] || [];
  const command = buildCommand(entry, hooksDir);

  const hookCmd: HookCommand = { type: 'command', command };
  if (entry.timeout) hookCmd.timeout = entry.timeout;

  // Find existing group with matching matcher (or no matcher for global hooks)
  const matcherValue = entry.matcher ?? undefined;
  const targetGroup = eventGroups.find((g) => {
    if (matcherValue) return g.matcher === matcherValue;
    return !g.matcher;
  });

  if (targetGroup) {
    targetGroup.hooks.push(hookCmd);
  } else {
    const newGroup: HookGroup = { hooks: [hookCmd] };
    if (matcherValue) newGroup.matcher = matcherValue;
    eventGroups.push(newGroup);
  }

  settings.hooks[entry.eventType] = eventGroups;
}

/**
 * Idempotent merge: ensures all CANONICAL_HOOKS are present, removes dead hooks.
 * Returns deep-cloned settings (does not mutate input).
 */
export function mergeSettings(
  existing: ClaudeSettings,
  hooksDir: string
): ClaudeSettings {
  const merged: ClaudeSettings = JSON.parse(JSON.stringify(existing));

  // Remove dead hooks first
  removeDeadHooks(merged);

  // Add missing canonical hooks
  for (const entry of CANONICAL_HOOKS) {
    if (!hookExists(merged, entry)) {
      addHook(merged, entry, hooksDir);
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// File I/O helpers
// ---------------------------------------------------------------------------

/** Default path to Claude settings.json */
export function getSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

/** Read settings.json, returning empty object on missing/parse error */
export function readSettings(settingsPath?: string): ClaudeSettings {
  const p = settingsPath ?? getSettingsPath();
  try {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  } catch {
    // Parse error → start fresh but preserve non-hooks keys
  }
  return {};
}

/** Atomic write: tmp file + rename */
export function writeSettingsAtomic(
  settings: ClaudeSettings,
  settingsPath?: string
): void {
  const p = settingsPath ?? getSettingsPath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, p);
}
