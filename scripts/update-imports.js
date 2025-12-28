#!/usr/bin/env node

/**
 * Update import paths after folder reorganization
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, relative, dirname } from 'path';

const importMappings = {
  // Core mappings
  '../core/frame-manager': '../core/context/frame-manager',
  '../core/project-manager': '../core/projects/project-manager',
  '../core/logger': '../core/monitoring/logger',
  '../core/error-handler': '../core/monitoring/error-handler',
  '../core/progress-tracker': '../core/monitoring/progress-tracker',
  '../core/update-checker': '../core/utils/update-checker',

  // Features mappings
  '../pebbles/pebbles-task-store': '../features/tasks/task-store',
  '../pebbles/task-aware-context': '../features/tasks/task-context',
  '../analytics/': '../features/analytics/',
  '../integrations/browser-mcp': '../features/browser/browser-mcp',

  // Integrations mappings
  '../integrations/linear-auth': '../integrations/linear/auth',
  '../integrations/linear-sync': '../integrations/linear/sync',
  '../integrations/linear-client': '../integrations/linear/client',
  '../integrations/linear-config': '../integrations/linear/config',
  '../integrations/linear-auto-sync': '../integrations/linear/auto-sync',
  '../mcp/mcp-server': '../integrations/mcp/server',

  // CLI mappings
  './cli': './index',
  './project-commands': './commands/projects',
  './analytics-viewer': './utils/viewer',
  '../cli/cli': '../cli/index',

  // Server mappings
  '../railway/': '../servers/railway/',
  './railway/': './servers/railway/',
};

function updateImportsInFile(filePath) {
  if (!filePath.endsWith('.ts') && !filePath.endsWith('.js')) {
    return false;
  }

  try {
    let content = readFileSync(filePath, 'utf-8');
    let modified = false;

    // Update import statements
    for (const [oldPath, newPath] of Object.entries(importMappings)) {
      const importRegex = new RegExp(
        `(import.*from\\s+['"]\\.?)${escapeRegex(oldPath)}(['"])`,
        'g'
      );
      const newContent = content.replace(importRegex, `$1${newPath}$2`);

      if (newContent !== content) {
        content = newContent;
        modified = true;
      }
    }

    // Special case: Update shebang for CLI entry point
    if (filePath.endsWith('src/cli/index.ts')) {
      if (!content.startsWith('#!/usr/bin/env node')) {
        content = '#!/usr/bin/env node\n' + content;
        modified = true;
      }
    }

    if (modified) {
      writeFileSync(filePath, content);
      console.log(`✅ Updated: ${relative(process.cwd(), filePath)}`);
      return true;
    }

    return false;
  } catch (error) {
    console.error(`❌ Error updating ${filePath}:`, error.message);
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

function updatePackageJson() {
  try {
    const packagePath = join(process.cwd(), 'package.json');
    const pkg = JSON.parse(readFileSync(packagePath, 'utf-8'));

    // Update bin path
    if (pkg.bin && pkg.bin.stackmemory) {
      pkg.bin.stackmemory = 'dist/src/cli/index.js';
    }

    // Update main entry
    if (pkg.main) {
      pkg.main = pkg.main.replace('dist/src/index.js', 'dist/src/index.js');
    }

    // Update scripts
    if (pkg.scripts) {
      // Update MCP server paths
      if (pkg.scripts['mcp:start']) {
        pkg.scripts['mcp:start'] = pkg.scripts['mcp:start'].replace(
          'dist/src/mcp/mcp-server.js',
          'dist/src/integrations/mcp/server.js'
        );
      }
      if (pkg.scripts['mcp:local']) {
        pkg.scripts['mcp:local'] = pkg.scripts['mcp:local'].replace(
          'dist/src/mcp/mcp-server.js',
          'dist/src/integrations/mcp/server.js'
        );
      }

      // Update lint fix script
      if (pkg.scripts['lint:autofix']) {
        pkg.scripts['lint:autofix'] = pkg.scripts['lint:autofix'].replace(
          'scripts/fix-lint-loop.cjs',
          'scripts/development/fix-lint-loop.cjs'
        );
      }
    }

    writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');
    console.log('✅ Updated package.json');
  } catch (error) {
    console.error('❌ Error updating package.json:', error.message);
  }
}

function updateTsConfig() {
  try {
    const tsconfigPath = join(process.cwd(), 'tsconfig.json');
    const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf-8'));

    // Update exclude paths if needed
    if (tsconfig.exclude) {
      tsconfig.exclude = tsconfig.exclude
        .map((path) => {
          if (path === 'src/runway.bak') return null;
          if (path === 'src/runway') return null;
          return path;
        })
        .filter(Boolean);
    }

    writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2) + '\n');
    console.log('✅ Updated tsconfig.json');
  } catch (error) {
    console.error('❌ Error updating tsconfig.json:', error.message);
  }
}

// Main execution
console.log('🔄 Updating import paths after reorganization...\n');

const srcFiles = walkDirectory(join(process.cwd(), 'src'));
const testFiles = walkDirectory(join(process.cwd(), 'tests'));
const scriptFiles = walkDirectory(join(process.cwd(), 'scripts'));

let updatedCount = 0;

for (const file of [...srcFiles, ...testFiles, ...scriptFiles]) {
  if (updateImportsInFile(file)) {
    updatedCount++;
  }
}

// Update configuration files
updatePackageJson();
updateTsConfig();

console.log(`\n✅ Updated ${updatedCount} files`);
console.log('📦 Run "npm run build" to verify all imports are correct');
