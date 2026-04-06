#!/usr/bin/env node

/**
 * Doc Ingest Hook
 *
 * Fires on PostToolUse when WebFetch is used. If the fetched URL looks like
 * documentation (docs.*, /api/, /reference/, /guide/), auto-ingests it into
 * the project wiki via stackmemory wiki ingest.
 *
 * Lightweight: only runs if .stackmemory/config.yaml has obsidian.vaultPath.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Doc URL patterns
const DOC_PATTERNS = [
  /^https?:\/\/docs\./i,
  /^https?:\/\/[^/]+\/docs\//i,
  /^https?:\/\/[^/]+\/api\//i,
  /^https?:\/\/[^/]+\/reference\//i,
  /^https?:\/\/[^/]+\/guide/i,
  /^https?:\/\/[^/]+\/tutorial/i,
  /^https?:\/\/developer\./i,
];

// Rate limit: max 1 ingest per URL per session
const seen = new Set();

function main() {
  try {
    // Only fire on WebFetch tool
    const toolName = process.env.TOOL_NAME || '';
    if (toolName !== 'WebFetch') return;

    // Check wiki is configured
    const configPath = path.join(process.cwd(), '.stackmemory', 'config.yaml');
    if (!fs.existsSync(configPath)) return;
    const config = fs.readFileSync(configPath, 'utf-8');
    if (!config.includes('vaultPath:')) return;

    // Extract URL from tool input
    const input = process.env.TOOL_INPUT || '';
    let url;
    try {
      const parsed = JSON.parse(input);
      url = parsed.url;
    } catch {
      // Try regex fallback
      const match = input.match(/https?:\/\/[^\s"']+/);
      url = match ? match[0] : null;
    }

    if (!url) return;

    // Check if URL matches doc patterns
    const isDoc = DOC_PATTERNS.some((p) => p.test(url));
    if (!isDoc) return;

    // Dedupe per session
    const host = new URL(url).hostname;
    if (seen.has(host)) return;
    seen.add(host);

    // Run ingest (fire-and-forget, max 1 page for auto-ingest)
    execSync(`stackmemory wiki ingest "${url}" -n 5`, {
      timeout: 15000,
      stdio: 'ignore',
    });
  } catch {
    // Silent fail
  }
}

main();
