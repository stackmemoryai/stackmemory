/**
 * Claude Code Lifecycle Hooks for StackMemory
 * Integrates with Claude Code's session lifecycle
 */

import { SessionMonitor } from '../../core/monitoring/session-monitor';
import { FrameManager } from '../../core/frame/frame-manager';
import { DatabaseManager } from '../../core/storage/database-manager';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

export interface ClaudeCodeHookConfig {
  projectRoot: string;
  autoTriggers: {
    onContextHigh: boolean; // Auto-save at 70%
    onContextCritical: boolean; // Force-save at 85%
    onSessionIdle: boolean; // Handoff on 5min idle
    onSessionEnd: boolean; // Handoff on close
    onClearCommand: boolean; // Save before /clear
  };
  claudeHooksPath?: string; // Path to .claude/hooks
}

export class ClaudeCodeLifecycleHooks {
  private monitor?: SessionMonitor;
  private config: ClaudeCodeHookConfig;
  private isActive: boolean = false;
  private hookScripts: Map<string, string> = new Map();

  constructor(config: ClaudeCodeHookConfig) {
    this.config = {
      ...config,
      claudeHooksPath:
        config.claudeHooksPath || path.join(os.homedir(), '.claude', 'hooks'),
    };
  }

  /**
   * Initialize hooks and start monitoring
   */
  async initialize(): Promise<void> {
    if (this.isActive) return;

    // Initialize database and managers
    const dbPath = path.join(
      this.config.projectRoot,
      '.stackmemory',
      'db',
      'stackmemory.db'
    );
    const dbManager = new DatabaseManager(dbPath);
    await dbManager.initialize();

    const frameManager = new FrameManager(dbManager);

    // Create session monitor
    this.monitor = new SessionMonitor(
      frameManager,
      dbManager,
      this.config.projectRoot,
      {
        contextWarningThreshold: 0.6,
        contextCriticalThreshold: 0.7,
        contextAutoSaveThreshold: 0.85,
        idleTimeoutMinutes: 5,
        autoSaveLedger: this.config.autoTriggers.onContextCritical,
        autoGenerateHandoff: this.config.autoTriggers.onSessionIdle,
        sessionEndHandoff: this.config.autoTriggers.onSessionEnd,
      }
    );

    // Register event handlers
    this.registerEventHandlers();

    // Install Claude Code hooks
    await this.installClaudeHooks();

    // Start monitoring
    await this.monitor.start();

    this.isActive = true;
    console.log('✅ Claude Code lifecycle hooks initialized');
  }

  /**
   * Register event handlers for monitor events
   */
  private registerEventHandlers(): void {
    if (!this.monitor) return;

    // Context events
    this.monitor.on('context:warning', (data) => {
      console.log(`⚠️ Context at ${Math.round(data.percentage * 100)}%`);
    });

    this.monitor.on('context:high', async (data) => {
      if (this.config.autoTriggers.onContextHigh) {
        console.log('🟡 High context - preparing auto-save');
        await this.executeHook('on-context-high', data);
      }
    });

    this.monitor.on('context:ledger_saved', (data) => {
      console.log(`✅ Ledger saved (${data.compression}x compression)`);
      console.log('💡 You can now safely use /clear');
    });

    // Handoff events
    this.monitor.on('handoff:generated', (data) => {
      console.log(`📋 Handoff saved (trigger: ${data.trigger})`);
    });
  }

  /**
   * Install hooks into Claude Code configuration
   */
  private async installClaudeHooks(): Promise<void> {
    // Create hooks directory if it doesn't exist
    await fs.mkdir(this.config.claudeHooksPath!, { recursive: true });

    // Install context monitor hook
    await this.installHook(
      'on-message-submit',
      `
#!/bin/bash
# StackMemory Context Monitor Hook
# Monitors token usage and triggers auto-save when needed

# Get estimated token count from Claude (if available)
TOKEN_COUNT=\${CLAUDE_TOKEN_COUNT:-0}
MAX_TOKENS=\${CLAUDE_MAX_TOKENS:-100000}

if [ "\$TOKEN_COUNT" -gt 0 ]; then
  USAGE=\$((TOKEN_COUNT * 100 / MAX_TOKENS))
  
  if [ "\$USAGE" -gt 85 ]; then
    echo "🔴 Critical: Context at \${USAGE}% - Auto-saving..."
    stackmemory clear --save > /dev/null 2>&1
    echo "✅ Ledger saved. Consider using /clear"
  elif [ "\$USAGE" -gt 70 ]; then
    echo "⚠️ Warning: Context at \${USAGE}%"
    echo "💡 Run: stackmemory clear --save"
  fi
fi

# Update activity timestamp
stackmemory monitor --activity 2>/dev/null || true
`
    );

    // Install session end hook
    await this.installHook(
      'on-session-end',
      `
#!/bin/bash
# StackMemory Session End Hook
# Generates handoff document when session ends

echo "📦 Saving session state..."

# Generate handoff
stackmemory handoff --generate > /dev/null 2>&1 && echo "✅ Handoff saved"

# Save ledger if context is significant
CONTEXT_STATUS=$(stackmemory clear --check 2>/dev/null | grep -o '[0-9]\\+%' | head -1 | tr -d '%')
if [ "\${CONTEXT_STATUS:-0}" -gt 30 ]; then
  stackmemory clear --save > /dev/null 2>&1 && echo "✅ Continuity ledger saved"
fi

echo "👋 Session state preserved for next time"
`
    );

    // Install clear command interceptor
    await this.installHook(
      'on-command-clear',
      `
#!/bin/bash
# StackMemory Clear Interceptor
# Saves state before /clear command

echo "🔄 Preparing for /clear..."

# Save continuity ledger
stackmemory clear --save > /dev/null 2>&1
echo "✅ Continuity ledger saved"

# Generate quick handoff
stackmemory handoff --generate > /dev/null 2>&1
echo "✅ Handoff document saved"

echo "✅ Ready for /clear - context will be restored automatically"
echo "💡 After /clear, run: stackmemory clear --restore"
`
    );

    // Install idle detector
    await this.installHook(
      'on-idle-5min',
      `
#!/bin/bash
# StackMemory Idle Detector
# Generates handoff after 5 minutes of inactivity

echo "⏸️ Session idle - generating handoff..."
stackmemory handoff --generate > /dev/null 2>&1
echo "✅ Handoff saved. Ready to resume anytime."
`
    );
  }

  /**
   * Install a specific hook script
   */
  private async installHook(name: string, script: string): Promise<void> {
    const hookPath = path.join(this.config.claudeHooksPath!, name);

    // Store script content
    this.hookScripts.set(name, script);

    // Write hook file
    await fs.writeFile(hookPath, script.trim(), { mode: 0o755 });

    // Make executable
    await fs.chmod(hookPath, 0o755);
  }

  /**
   * Execute a hook with context
   */
  private async executeHook(hookName: string, context: any): Promise<void> {
    const hookPath = path.join(this.config.claudeHooksPath!, hookName);

    try {
      // Check if hook exists
      await fs.access(hookPath);

      // Execute hook with environment variables
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      const env = {
        ...process.env,
        STACKMEMORY_CONTEXT: JSON.stringify(context),
        STACKMEMORY_PROJECT: this.config.projectRoot,
      };

      const { stdout, stderr } = await execAsync(hookPath, { env });

      if (stdout) console.log(stdout);
      if (stderr) console.error(stderr);
    } catch (error) {
      // Hook doesn't exist or failed
      console.debug(`Hook ${hookName} not found or failed:`, error);
    }
  }

  /**
   * Stop monitoring and cleanup
   */
  async stop(): Promise<void> {
    if (this.monitor) {
      await this.monitor.stop();
    }
    this.isActive = false;
    console.log('🛑 Claude Code lifecycle hooks stopped');
  }

  /**
   * Get current status
   */
  getStatus(): any {
    return {
      isActive: this.isActive,
      monitorStatus: this.monitor?.getStatus(),
      config: this.config,
      installedHooks: Array.from(this.hookScripts.keys()),
    };
  }
}

/**
 * Global singleton instance
 */
let globalInstance: ClaudeCodeLifecycleHooks | undefined;

/**
 * Initialize global hooks
 */
export async function initializeClaudeHooks(
  projectRoot?: string
): Promise<ClaudeCodeLifecycleHooks> {
  if (!projectRoot) {
    projectRoot = process.cwd();
  }

  if (!globalInstance) {
    globalInstance = new ClaudeCodeLifecycleHooks({
      projectRoot,
      autoTriggers: {
        onContextHigh: true,
        onContextCritical: true,
        onSessionIdle: true,
        onSessionEnd: true,
        onClearCommand: true,
      },
    });

    await globalInstance.initialize();
  }

  return globalInstance;
}

/**
 * Get global instance
 */
export function getClaudeHooks(): ClaudeCodeLifecycleHooks | undefined {
  return globalInstance;
}

/**
 * Stop global hooks
 */
export async function stopClaudeHooks(): Promise<void> {
  if (globalInstance) {
    await globalInstance.stop();
    globalInstance = undefined;
  }
}
