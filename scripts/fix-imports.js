#!/usr/bin/env node

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, relative, dirname, resolve } from 'path';

const importMappings = {
  // Core monitoring imports
  '../core/logger': '../core/monitoring/logger',
  './logger': '../monitoring/logger',
  '../core/error-handler': '../core/monitoring/error-handler',
  './error-handler': '../monitoring/error-handler',
  '../core/progress-tracker': '../core/monitoring/progress-tracker',

  // Core context imports
  '../core/frame-manager': '../core/context/frame-manager',
  './core/frame-manager': './core/context/frame-manager',

  // Core projects imports
  '../core/project-manager': '../core/projects/project-manager',
  './core/project-manager': './core/projects/project-manager',

  // Core utils imports
  '../core/update-checker': '../core/utils/update-checker',
  './core/update-checker': './core/utils/update-checker',

  // Features imports
  '../pebbles/pebbles-task-store': '../features/tasks/pebbles-task-store',
  './pebbles/pebbles-task-store': './features/tasks/pebbles-task-store',
  '../pebbles/task-aware-context': '../features/tasks/task-aware-context',
  '../analytics/index': '../features/analytics/index',
  './analytics/index': './features/analytics/index',
  '../analytics/core/analytics-service':
    '../../features/analytics/core/analytics-service',
  '../integrations/browser-mcp': '../features/browser/browser-mcp',

  // Linear integration imports
  '../integrations/linear-auth': '../integrations/linear/auth',
  './linear-auth': './auth',
  '../integrations/linear-sync': '../integrations/linear/sync',
  './linear-sync': './sync',
  '../integrations/linear-client': '../integrations/linear/client',
  './linear-client': './client',
  '../../integrations/linear-client': '../../integrations/linear/client',
  '../integrations/linear-config': '../integrations/linear/config',
  './linear-config': './config',
  '../integrations/linear-auto-sync': '../integrations/linear/auto-sync',
  './linear-auto-sync': './auto-sync',

  // MCP imports
  '../mcp/mcp-server': '../integrations/mcp/server',
  './mcp/mcp-server': './integrations/mcp/server',

  // CLI imports
  './project-commands': './commands/projects',
  './analytics-viewer': './utils/viewer',
  '../cli/cli': '../cli/index',

  // Production server imports
  '../monitoring/logger': '../../core/monitoring/logger',
  '../monitoring/metrics': '../../core/monitoring/metrics',
};

function getCorrectRelativePath(fromFile, toFile) {
  const fromDir = dirname(fromFile);
  let relativePath = relative(fromDir, toFile).replace(/\\/g, '/');
  if (!relativePath.startsWith('.')) {
    relativePath = './' + relativePath;
  }
  // Remove .ts extension for imports
  relativePath = relativePath.replace(/\.ts$/, '');
  return relativePath;
}

function fixImportsInFile(filePath) {
  if (!filePath.endsWith('.ts') && !filePath.endsWith('.js')) {
    return false;
  }

  try {
    let content = readFileSync(filePath, 'utf-8');
    let modified = false;

    // Fix each known import mapping
    for (const [oldPath, newPath] of Object.entries(importMappings)) {
      const importRegex = new RegExp(
        `(import.*from\\s+['"])${escapeRegex(oldPath)}(\\.js)?(['"])`,
        'g'
      );
      const requireRegex = new RegExp(
        `(require\\(['"])${escapeRegex(oldPath)}(\\.js)?(['"])`,
        'g'
      );

      const newContent = content
        .replace(importRegex, `$1${newPath}.js$3`)
        .replace(requireRegex, `$1${newPath}.js$3`);

      if (newContent !== content) {
        content = newContent;
        modified = true;
      }
    }

    // Special fixes for specific files
    if (filePath.includes('src/cli/index.ts')) {
      // Add shebang if missing
      if (!content.startsWith('#!/usr/bin/env node')) {
        content = '#!/usr/bin/env node\n' + content;
        modified = true;
      }
    }

    // Fix imports in specific directories
    if (filePath.includes('src/core/context/')) {
      content = content.replace(
        /from ['"]\.\/logger\.js['"]/g,
        `from '../monitoring/logger.js'`
      );
      content = content.replace(
        /from ['"]\.\/error-handler\.js['"]/g,
        `from '../monitoring/error-handler.js'`
      );
      modified = true;
    }

    if (filePath.includes('src/core/projects/')) {
      content = content.replace(
        /from ['"]\.\/logger\.js['"]/g,
        `from '../monitoring/logger.js'`
      );
      modified = true;
    }

    if (filePath.includes('src/core/utils/')) {
      content = content.replace(
        /from ['"]\.\/logger\.js['"]/g,
        `from '../monitoring/logger.js'`
      );
      modified = true;
    }

    if (filePath.includes('src/integrations/linear/')) {
      // Fix relative imports within linear directory
      content = content.replace(
        /from ['"]\.\/linear-auth\.js['"]/g,
        `from './auth.js'`
      );
      content = content.replace(
        /from ['"]\.\/linear-sync\.js['"]/g,
        `from './sync.js'`
      );
      content = content.replace(
        /from ['"]\.\/linear-client\.js['"]/g,
        `from './client.js'`
      );
      content = content.replace(
        /from ['"]\.\/linear-config\.js['"]/g,
        `from './config.js'`
      );
      content = content.replace(
        /from ['"]\.\/linear-auto-sync\.js['"]/g,
        `from './auto-sync.js'`
      );
      modified = true;
    }

    if (modified) {
      writeFileSync(filePath, content);
      console.log(`✅ Fixed: ${relative(process.cwd(), filePath)}`);
      return true;
    }

    return false;
  } catch (error) {
    console.error(`❌ Error fixing ${filePath}:`, error.message);
    return false;
  }
}

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function walkDirectory(dir) {
  const files = [];

  try {
    const items = readdirSync(dir);

    for (const item of items) {
      const fullPath = join(dir, item);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        // Skip node_modules, dist, and .git
        if (
          !item.startsWith('.') &&
          item !== 'node_modules' &&
          item !== 'dist'
        ) {
          files.push(...walkDirectory(fullPath));
        }
      } else if (stat.isFile()) {
        files.push(fullPath);
      }
    }
  } catch (error) {
    console.error(`Error walking directory ${dir}:`, error.message);
  }

  return files;
}

// Main execution
console.log('🔄 Fixing import paths after reorganization...\n');

const srcFiles = walkDirectory(join(process.cwd(), 'src'));
const testFiles = walkDirectory(join(process.cwd(), 'tests'));

let fixedCount = 0;

for (const file of [...srcFiles, ...testFiles]) {
  if (fixImportsInFile(file)) {
    fixedCount++;
  }
}

console.log(`\n✅ Fixed ${fixedCount} files`);
console.log('📦 Run "npm run build" to verify all imports are correct');
