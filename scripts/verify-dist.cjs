#!/usr/bin/env node
// Verifies expected dist artifacts and bin launchers point to correct paths.
// Exits non-zero with actionable messages on mismatch.

const { readFileSync, existsSync } = require('fs');
const { join } = require('path');

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exitCode = 1;
}

function checkFile(path) {
  if (!existsSync(path)) {
    fail(`Missing built file: ${path}`);
    return false;
  }
  return true;
}

function fileContains(path, substr) {
  try {
    const c = readFileSync(path, 'utf8');
    if (!c.includes(substr)) {
      fail(`Expected reference not found in ${path}: ${substr}`);
      return false;
    }
    return true;
  } catch (e) {
    fail(`Unable to read ${path}: ${e.message}`);
    return false;
  }
}

function main() {
  const dist = 'dist/src';

  // 1) Core CLI and MCP server artifacts
  const requiredFiles = [
    join(dist, 'integrations/mcp/server.js'),
    join(dist, 'cli/index.js'),
    join(dist, 'cli/codex-sm.js'),
    join(dist, 'cli/codex-sm-danger.js'),
    join(dist, 'cli/claude-sm.js'),
    join(dist, 'cli/claude-sm-danger.js'),
    join(dist, 'cli/hermes-sm.js'),
    join(dist, 'cli/opencode-sm.js'),
    join(dist, 'cli/gemini-sm.js'),
  ];
  requiredFiles.forEach(checkFile);

  // 2) Bin launchers reference dist/src/* (ESM dynamic import)
  fileContains('bin/codex-sm', "../dist/src/cli/codex-sm.js");
  fileContains('bin/codex-smd', "../dist/src/cli/codex-sm-danger.js");
  fileContains('bin/claude-sm', "../dist/src/cli/claude-sm.js");
  fileContains('bin/claude-smd', "../dist/src/cli/claude-sm-danger.js");
  fileContains('bin/hermes-sm', "../dist/src/cli/hermes-sm.js");
  fileContains('bin/hermes-smd', "../dist/src/cli/hermes-sm.js");
  fileContains('bin/opencode-sm', "../dist/src/cli/opencode-sm.js");
  fileContains('bin/gemini-sm', "../dist/src/cli/gemini-sm.js");

  // 3) package.json scripts point to correct paths
  try {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const scripts = pkg.scripts || {};
    const expectations = [
      ['start', 'dist/src/integrations/mcp/server.js'],
      ['start:full', 'dist/src/integrations/mcp/server.js'],
      ['mcp:start', 'dist/src/integrations/mcp/server.js'],
    ];
    for (const [key, needle] of expectations) {
      const val = scripts[key] || '';
      if (!val.includes(needle)) {
        fail(`scripts.${key} should reference ${needle}, found: ${val}`);
      }
    }
  } catch (e) {
    fail(`Failed to validate package.json scripts: ${e.message}`);
  }

  if (process.exitCode) {
    console.error('\nOne or more checks failed. Run: npm run build');
    console.error('Then re-run: npm run verify:dist');
  } else {
    console.log('verify-dist: OK');
  }
}

main();

