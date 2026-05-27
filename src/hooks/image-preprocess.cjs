#!/usr/bin/env node
/**
 * image-preprocess.cjs — PreToolUse hook for Claude Code + Codex
 *
 * Intercepts Read tool calls on image files (.png, .jpg, .jpeg, .gif, .webp).
 * Extracts text description via cheap vision model (ollama → haiku → mini).
 * Injects extraction as a system message so the expensive model gets text, not pixels.
 *
 * Install in ~/.claude/settings.json:
 *   "PreToolUse": [{
 *     "matcher": "Read",
 *     "hooks": [{
 *       "type": "command",
 *       "command": "node /Users/jwu/Dev/stackmemory/src/hooks/image-preprocess.cjs",
 *       "timeout": 15
 *     }]
 *   }]
 *
 * Opt out: STACKMEMORY_IMAGE_PREPROCESS=0
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

if (process.env.STACKMEMORY_IMAGE_PREPROCESS === '0') process.exit(0);

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff']);
const CACHE_DIR = path.join(process.env.HOME || '/tmp', '.stackmemory', 'image-cache');

function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf-8');
  } catch {
    return;
  }

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }

  const toolName = input.tool_name || input.toolName;
  if (toolName !== 'Read') return;

  const toolInput = input.tool_input || input.input || {};
  const filePath = toolInput.file_path || toolInput.filePath;
  if (!filePath) return;

  const ext = path.extname(filePath).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) return;

  // Check if file exists
  if (!fs.existsSync(filePath)) return;

  // Check cache — hash by path + mtime
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const stat = fs.statSync(filePath);
  const cacheKey = Buffer.from(`${filePath}:${stat.mtimeMs}`).toString('base64url');
  const cacheFile = path.join(CACHE_DIR, `${cacheKey}.txt`);

  if (fs.existsSync(cacheFile)) {
    const cached = fs.readFileSync(cacheFile, 'utf-8');
    process.stdout.write(JSON.stringify({
      systemMessage: `[image-preprocess] Cached extraction for ${path.basename(filePath)}:\n${cached}`
    }) + '\n');
    return;
  }

  // Extract via cheapest available model
  const description = extractViaOllama(filePath)
    || extractViaHaiku(filePath)
    || extractViaMini(filePath);

  if (!description) return; // Let the Read tool handle it normally

  // Cache the result
  try {
    fs.writeFileSync(cacheFile, description);
  } catch {}

  process.stdout.write(JSON.stringify({
    systemMessage: `[image-preprocess] Auto-extracted from ${path.basename(filePath)} (text injected, raw image skipped):\n${description}`
  }) + '\n');
}

function extractViaOllama(filePath) {
  try {
    // Check if a vision model exists
    const list = execSync('ollama list 2>/dev/null', { encoding: 'utf-8', timeout: 3000 });
    const visionModel = list.match(/(moondream|llava|minicpm-v|gemma3)[^\s]*/)?.[0];
    if (!visionModel) return null;

    const result = spawnSync('ollama', ['run', visionModel,
      'Describe this image concisely. Extract all visible text, UI elements, error messages, code, and data.',
      '--images', filePath
    ], { encoding: 'utf-8', timeout: 15000 });

    if (result.status === 0 && result.stdout.trim()) {
      return `<!-- via ollama/${visionModel} -->\n${result.stdout.trim()}`;
    }
  } catch {}
  return null;
}

function extractViaHaiku(filePath) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  try {
    const b64 = fs.readFileSync(filePath).toString('base64');
    const ext = path.extname(filePath).toLowerCase();
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
      : ext === '.webp' ? 'image/webp'
      : ext === '.gif' ? 'image/gif'
      : 'image/png';

    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } },
          { type: 'text', text: 'Describe this image concisely. Extract all visible text, UI elements, error messages, code, and data. Be thorough but brief.' }
        ]
      }]
    });

    const result = spawnSync('curl', [
      '-s', 'https://api.anthropic.com/v1/messages',
      '-H', `x-api-key: ${apiKey}`,
      '-H', 'anthropic-version: 2023-06-01',
      '-H', 'content-type: application/json',
      '-d', body
    ], { encoding: 'utf-8', timeout: 10000 });

    if (result.status === 0) {
      const resp = JSON.parse(result.stdout);
      const text = resp.content?.find(c => c.type === 'text')?.text;
      if (text) return `<!-- via claude-haiku-4.5 -->\n${text}`;
    }
  } catch {}
  return null;
}

function extractViaMini(filePath) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  try {
    const b64 = fs.readFileSync(filePath).toString('base64');
    const ext = path.extname(filePath).toLowerCase();
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';

    const body = JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
          { type: 'text', text: 'Describe this image concisely. Extract all visible text, UI elements, error messages, code, and data.' }
        ]
      }]
    });

    const result = spawnSync('curl', [
      '-s', 'https://api.openai.com/v1/chat/completions',
      '-H', `Authorization: Bearer ${apiKey}`,
      '-H', 'Content-Type: application/json',
      '-d', body
    ], { encoding: 'utf-8', timeout: 10000 });

    if (result.status === 0) {
      const resp = JSON.parse(result.stdout);
      const text = resp.choices?.[0]?.message?.content;
      if (text) return `<!-- via gpt-4o-mini -->\n${text}`;
    }
  } catch {}
  return null;
}

try {
  main();
} catch {
  // Non-fatal
}
