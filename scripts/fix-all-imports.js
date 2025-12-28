#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs';
import { relative } from 'path';

const fileFixes = [
  // CLI files
  {
    file: 'src/cli/commands/projects.ts',
    fixes: [
      {
        old: '../core/projects/project-manager',
        new: '../../core/projects/project-manager',
      },
    ],
  },
  {
    file: 'src/cli/index.ts',
    fixes: [
      {
        old: '../integrations/linear-auth',
        new: '../integrations/linear/auth',
      },
      {
        old: '../integrations/linear-sync',
        new: '../integrations/linear/sync',
      },
      {
        old: '../integrations/linear-auto-sync',
        new: '../integrations/linear/auto-sync',
      },
      { old: './analytics-viewer', new: './utils/viewer' },
      { old: '../analytics/index', new: '../features/analytics/index' },
      { old: '../mcp/mcp-server', new: '../integrations/mcp/server' },
    ],
  },

  // Core files
  {
    file: 'src/core/context/frame-manager.ts',
    fixes: [
      { old: '../../core/monitoring/logger', new: '../monitoring/logger' },
    ],
  },
  {
    file: 'src/core/projects/project-manager.ts',
    fixes: [
      { old: '../../core/monitoring/logger', new: '../monitoring/logger' },
    ],
  },
  {
    file: 'src/core/utils/update-checker.ts',
    fixes: [
      { old: '../../core/monitoring/logger', new: '../monitoring/logger' },
    ],
  },
  {
    file: 'src/core/monitoring/error-handler.ts',
    fixes: [{ old: '../../core/monitoring/logger', new: './logger' }],
  },
  {
    file: 'src/core/logger.test.ts',
    fixes: [
      { old: '../../core/monitoring/logger', new: './monitoring/logger' },
    ],
  },

  // Features files
  {
    file: 'src/features/tasks/pebbles-task-store.ts',
    fixes: [
      { old: '../core/monitoring/logger', new: '../../core/monitoring/logger' },
    ],
  },
  {
    file: 'src/features/tasks/task-aware-context.ts',
    fixes: [
      {
        old: '../core/context/frame-manager',
        new: '../../core/context/frame-manager',
      },
      { old: '../core/monitoring/logger', new: '../../core/monitoring/logger' },
    ],
  },
  {
    file: 'src/features/browser/browser-mcp.ts',
    fixes: [
      { old: '../core/monitoring/logger', new: '../../core/monitoring/logger' },
    ],
  },
  {
    file: 'src/features/analytics/core/analytics-service.ts',
    fixes: [
      {
        old: '../../integrations/linear/client',
        new: '../../../integrations/linear/client',
      },
    ],
  },

  // Integrations files
  {
    file: 'src/integrations/linear/auth.ts',
    fixes: [
      { old: '../core/monitoring/logger', new: '../../core/monitoring/logger' },
    ],
  },
  {
    file: 'src/integrations/linear/auto-sync.ts',
    fixes: [
      { old: '../core/monitoring/logger', new: '../../core/monitoring/logger' },
      {
        old: '../features/tasks/pebbles-task-store',
        new: '../../features/tasks/pebbles-task-store',
      },
    ],
  },
  {
    file: 'src/integrations/linear/client.ts',
    fixes: [
      { old: '../core/monitoring/logger', new: '../../core/monitoring/logger' },
    ],
  },
  {
    file: 'src/integrations/linear/config.ts',
    fixes: [
      { old: '../core/monitoring/logger', new: '../../core/monitoring/logger' },
    ],
  },
  {
    file: 'src/integrations/linear/sync.ts',
    fixes: [
      { old: '../core/monitoring/logger', new: '../../core/monitoring/logger' },
      {
        old: '../pebbles/pebbles-task-store',
        new: '../../features/tasks/pebbles-task-store',
      },
    ],
  },
  {
    file: 'src/integrations/mcp/server.ts',
    fixes: [
      {
        old: '../core/context/frame-manager',
        new: '../../core/context/frame-manager',
      },
      {
        old: '../pebbles/pebbles-task-store',
        new: '../../features/tasks/pebbles-task-store',
      },
      { old: '../core/monitoring/logger', new: '../../core/monitoring/logger' },
      {
        old: '../features/browser/browser-mcp',
        new: '../../features/browser/browser-mcp',
      },
    ],
  },

  // Servers files
  {
    file: 'src/servers/production/auth-middleware.ts',
    fixes: [
      {
        old: '../../core/monitoring/metrics',
        new: '../../core/monitoring/metrics',
      },
    ],
  },
  {
    file: 'src/servers/railway/index.ts',
    fixes: [
      {
        old: '../features/browser/browser-mcp',
        new: '../../features/browser/browser-mcp',
      },
    ],
  },
];

console.log('🔄 Fixing all import paths...\n');

let totalFixed = 0;

for (const { file, fixes } of fileFixes) {
  try {
    let content = readFileSync(file, 'utf-8');
    let modified = false;

    for (const { old: oldPath, new: newPath } of fixes) {
      const importRegex = new RegExp(
        `(import.*from\\s+['"])${oldPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.js)?(['"])`,
        'g'
      );
      const newContent = content.replace(importRegex, `$1${newPath}.js$3`);

      if (newContent !== content) {
        content = newContent;
        modified = true;
      }
    }

    if (modified) {
      writeFileSync(file, content);
      console.log(`✅ Fixed: ${relative(process.cwd(), file)}`);
      totalFixed++;
    }
  } catch (error) {
    console.error(`❌ Error fixing ${file}:`, error.message);
  }
}

console.log(`\n✅ Fixed ${totalFixed} files`);
console.log('📦 Run "npm run build" to verify all imports are correct');
