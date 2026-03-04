import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  CANONICAL_HOOKS,
  DEAD_HOOKS,
  hookExists,
  hasDeadHooks,
  removeDeadHooks,
  mergeSettings,
  buildCommand,
  readSettings,
  writeSettingsAtomic,
} from '../hook-installer.js';

const HOOKS_DIR = path.join(os.homedir(), '.claude', 'hooks');

describe('hook-installer', () => {
  describe('CANONICAL_HOOKS', () => {
    it('defines all 9 hooks', () => {
      expect(CANONICAL_HOOKS).toHaveLength(9);
      const names = CANONICAL_HOOKS.map((h) => h.scriptName);
      expect(names).toContain('session-rescue.sh');
      expect(names).toContain('stop-checkpoint.js');
      expect(names).toContain('chime-on-stop.sh');
      expect(names).toContain('auto-checkpoint.js');
      expect(names).toContain('cord-trace.js');
      expect(names).toContain('theory-capture.js');
      expect(names).toContain('team-subagent-stop.js');
      expect(names).toContain('team-task-complete.js');
      expect(names).toContain('team-teammate-idle.js');
    });

    it('core hooks are required, optional hooks are not', () => {
      const required = CANONICAL_HOOKS.filter((h) => h.required);
      const optional = CANONICAL_HOOKS.filter((h) => !h.required);
      expect(required).toHaveLength(5);
      expect(optional).toHaveLength(4);
      const optionalNames = optional.map((h) => h.scriptName);
      expect(optionalNames).toContain('theory-capture.js');
      expect(optionalNames).toContain('team-subagent-stop.js');
      expect(optionalNames).toContain('team-task-complete.js');
      expect(optionalNames).toContain('team-teammate-idle.js');
    });

    it('js hooks have node commandPrefix', () => {
      const jsHooks = CANONICAL_HOOKS.filter((h) =>
        h.scriptName.endsWith('.js')
      );
      for (const hook of jsHooks) {
        expect(hook.commandPrefix).toBe('node');
      }
    });
  });

  describe('DEAD_HOOKS', () => {
    it('includes sms-response-handler.js', () => {
      expect(DEAD_HOOKS).toContain('sms-response-handler.js');
    });
  });

  describe('buildCommand', () => {
    it('builds plain path for shell scripts', () => {
      const entry = CANONICAL_HOOKS.find(
        (h) => h.scriptName === 'session-rescue.sh'
      )!;
      expect(buildCommand(entry, HOOKS_DIR)).toBe(
        path.join(HOOKS_DIR, 'session-rescue.sh')
      );
    });

    it('prepends node for js hooks', () => {
      const entry = CANONICAL_HOOKS.find(
        (h) => h.scriptName === 'auto-checkpoint.js'
      )!;
      expect(buildCommand(entry, HOOKS_DIR)).toBe(
        `node ${path.join(HOOKS_DIR, 'auto-checkpoint.js')}`
      );
    });
  });

  describe('hookExists', () => {
    it('returns false for empty settings', () => {
      const entry = CANONICAL_HOOKS[0];
      expect(hookExists({}, entry)).toBe(false);
    });

    it('returns true when hook is present', () => {
      const entry = CANONICAL_HOOKS.find(
        (h) => h.scriptName === 'session-rescue.sh'
      )!;
      const settings = {
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command' as const,
                  command: '/Users/test/.claude/hooks/session-rescue.sh',
                  timeout: 12,
                },
              ],
            },
          ],
        },
      };
      expect(hookExists(settings, entry)).toBe(true);
    });

    it('returns false when different hooks are present', () => {
      const entry = CANONICAL_HOOKS.find(
        (h) => h.scriptName === 'session-rescue.sh'
      )!;
      const settings = {
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command' as const,
                  command: '/some/other/hook.sh',
                },
              ],
            },
          ],
        },
      };
      expect(hookExists(settings, entry)).toBe(false);
    });
  });

  describe('hasDeadHooks', () => {
    it('returns false for clean settings', () => {
      expect(hasDeadHooks({})).toBe(false);
    });

    it('detects sms-response-handler.js', () => {
      const settings = {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                {
                  type: 'command' as const,
                  command:
                    'node /Users/test/.claude/hooks/sms-response-handler.js',
                },
              ],
            },
          ],
        },
      };
      expect(hasDeadHooks(settings)).toBe(true);
    });
  });

  describe('removeDeadHooks', () => {
    it('removes sms-response-handler and cleans empty groups', () => {
      const settings = {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                {
                  type: 'command' as const,
                  command: 'node /path/to/block-dangerous-git.py',
                },
                {
                  type: 'command' as const,
                  command:
                    'node /Users/test/.claude/hooks/sms-response-handler.js',
                },
              ],
            },
          ],
        },
      };

      const removed = removeDeadHooks(settings);
      expect(removed).toBe(true);
      // sms handler removed, block-dangerous-git remains
      expect(settings.hooks!['PreToolUse']).toHaveLength(1);
      expect(settings.hooks!['PreToolUse'][0].hooks).toHaveLength(1);
      expect(settings.hooks!['PreToolUse'][0].hooks[0].command).toContain(
        'block-dangerous-git.py'
      );
    });

    it('removes entire event type when all hooks are dead', () => {
      const settings = {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                {
                  type: 'command' as const,
                  command:
                    'node /Users/test/.claude/hooks/sms-response-handler.js',
                },
              ],
            },
          ],
          Stop: [
            {
              hooks: [
                {
                  type: 'command' as const,
                  command: '/path/to/some-valid-hook.sh',
                },
              ],
            },
          ],
        },
      };

      removeDeadHooks(settings);
      expect(settings.hooks!['PreToolUse']).toBeUndefined();
      expect(settings.hooks!['Stop']).toHaveLength(1);
    });

    it('returns false when no dead hooks found', () => {
      const settings = {
        hooks: {
          Stop: [
            {
              hooks: [
                { type: 'command' as const, command: '/path/to/valid.sh' },
              ],
            },
          ],
        },
      };
      expect(removeDeadHooks(settings)).toBe(false);
    });
  });

  describe('mergeSettings', () => {
    it('adds all canonical hooks to empty settings', () => {
      const result = mergeSettings({}, HOOKS_DIR);
      expect(result.hooks).toBeDefined();
      expect(result.hooks!['Stop']).toBeDefined();
      expect(result.hooks!['PostToolUse']).toBeDefined();

      // All 4 hooks present
      for (const entry of CANONICAL_HOOKS) {
        expect(hookExists(result, entry)).toBe(true);
      }
    });

    it('preserves existing non-hook settings', () => {
      const existing = {
        includeCoAuthoredBy: false,
        someOtherSetting: 'value',
      };
      const result = mergeSettings(existing, HOOKS_DIR);
      expect(result['includeCoAuthoredBy']).toBe(false);
      expect(result['someOtherSetting']).toBe('value');
    });

    it('preserves existing non-canonical hooks', () => {
      const existing = {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                {
                  type: 'command' as const,
                  command: '/path/to/custom-hook.sh',
                },
              ],
            },
          ],
        },
      };
      const result = mergeSettings(existing, HOOKS_DIR);
      // Custom hook preserved
      const preToolGroups = result.hooks!['PreToolUse'];
      expect(preToolGroups).toBeDefined();
      const bashGroup = preToolGroups.find(
        (g: { matcher?: string }) => g.matcher === 'Bash'
      );
      expect(bashGroup).toBeDefined();
      expect(
        bashGroup!.hooks.some(
          (h: { command: string }) => h.command === '/path/to/custom-hook.sh'
        )
      ).toBe(true);
    });

    it('is idempotent — running twice produces same result', () => {
      const first = mergeSettings({}, HOOKS_DIR);
      const second = mergeSettings(first, HOOKS_DIR);
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    });

    it('removes dead hooks during merge', () => {
      const existing = {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                {
                  type: 'command' as const,
                  command:
                    'node /Users/test/.claude/hooks/sms-response-handler.js',
                },
              ],
            },
          ],
        },
      };
      const result = mergeSettings(existing, HOOKS_DIR);
      expect(hasDeadHooks(result)).toBe(false);
    });

    it('does not mutate the input settings', () => {
      const existing = {
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command' as const,
                  command: '/path/to/existing-stop.sh',
                },
              ],
            },
          ],
        },
      };
      const before = JSON.stringify(existing);
      mergeSettings(existing, HOOKS_DIR);
      expect(JSON.stringify(existing)).toBe(before);
    });

    it('groups Stop hooks together in one matcher-less group', () => {
      const result = mergeSettings({}, HOOKS_DIR);
      const stopGroups = result.hooks!['Stop'];
      // All Stop hooks should be in a single matcher-less group
      const matcherlessGroups = stopGroups.filter(
        (g: { matcher?: string }) => !g.matcher
      );
      expect(matcherlessGroups).toHaveLength(1);
      // 3 Stop hooks: session-rescue, stop-checkpoint, chime-on-stop
      expect(matcherlessGroups[0].hooks).toHaveLength(3);
    });
  });

  describe('readSettings / writeSettingsAtomic', () => {
    let tmpDir: string;
    let settingsPath: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-installer-test-'));
      settingsPath = path.join(tmpDir, 'settings.json');
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns empty object for missing file', () => {
      expect(readSettings(settingsPath)).toEqual({});
    });

    it('round-trips settings through write and read', () => {
      const settings = {
        includeCoAuthoredBy: false,
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command' as const,
                  command: '/path/to/hook.sh',
                  timeout: 5,
                },
              ],
            },
          ],
        },
      };

      writeSettingsAtomic(settings, settingsPath);
      const loaded = readSettings(settingsPath);
      expect(loaded).toEqual(settings);
    });

    it('creates parent directories if needed', () => {
      const nestedPath = path.join(tmpDir, 'sub', 'dir', 'settings.json');
      writeSettingsAtomic({ test: true }, nestedPath);
      expect(fs.existsSync(nestedPath)).toBe(true);
    });

    it('handles corrupted JSON gracefully', () => {
      fs.writeFileSync(settingsPath, '{ broken json !!!');
      expect(readSettings(settingsPath)).toEqual({});
    });
  });
});
