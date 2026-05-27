#!/usr/bin/env node
/**
 * image-extract MCP server — stdio transport
 *
 * Provides a `describe_image` tool that extracts text from images
 * via ollama (free local) before the expensive model processes them.
 *
 * Usage in ~/.claude/settings.json mcpServers:
 *   "image-extract": {
 *     "command": "node",
 *     "args": ["/Users/jwu/Dev/stackmemory/src/hooks/image-extract-mcp.cjs"]
 *   }
 *
 * Claude will call this tool when prompted to analyze an image,
 * getting structured text back instead of burning Opus vision tokens.
 */

'use strict';

const { spawnSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CACHE_DIR = path.join(process.env.HOME || '/tmp', '.stackmemory', 'image-cache');

function getVisionModel() {
  try {
    const list = execSync('ollama list 2>/dev/null', { encoding: 'utf-8', timeout: 3000 });
    return list.match(/(moondream|llava|minicpm-v|gemma3)[^\s]*/)?.[0] || null;
  } catch {
    return null;
  }
}

function extractImage(filePath, prompt) {
  if (!fs.existsSync(filePath)) return { error: `File not found: ${filePath}` };

  // Cache check
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const stat = fs.statSync(filePath);
  const cacheKey = Buffer.from(`${filePath}:${stat.mtimeMs}:${prompt}`).toString('base64url').slice(0, 60);
  const cacheFile = path.join(CACHE_DIR, `${cacheKey}.txt`);

  if (fs.existsSync(cacheFile)) {
    return { text: fs.readFileSync(cacheFile, 'utf-8'), cached: true };
  }

  const model = getVisionModel();
  if (!model) return { error: 'No vision model. Run: ollama pull moondream' };

  const result = spawnSync('ollama', ['run', model, prompt, '--images', filePath], {
    encoding: 'utf-8',
    timeout: 30000,
  });

  if (result.status !== 0 || !result.stdout.trim()) {
    return { error: `ollama failed: ${result.stderr || 'empty output'}` };
  }

  const text = result.stdout.trim();
  try { fs.writeFileSync(cacheFile, text); } catch {}
  return { text, model };
}

// --- JSON-RPC stdio MCP server ---

let requestId = 0;

function respond(id, result) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(`${msg}\n`);
}

function respondError(id, code, message) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(`${msg}\n`);
}

function handleRequest(req) {
  const { id, method, params } = req;

  if (method === 'initialize') {
    respond(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'image-extract', version: '1.0.0' },
    });
    return;
  }

  if (method === 'notifications/initialized') return;

  if (method === 'tools/list') {
    respond(id, {
      tools: [{
        name: 'describe_image',
        description: 'Extract text description from an image using a fast local vision model (ollama/moondream). Use this to analyze screenshots, UI mockups, charts, or any image — much cheaper than processing the raw image directly. Returns structured text extraction.',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'Absolute path to the image file (.png, .jpg, .webp, etc.)',
            },
            prompt: {
              type: 'string',
              description: 'What to extract — e.g. "extract all text and UI elements" or "what errors are shown?"',
              default: 'Describe this image concisely. Extract all visible text, UI elements, error messages, code, and data.',
            },
          },
          required: ['file_path'],
        },
      }],
    });
    return;
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params;
    if (name !== 'describe_image') {
      respondError(id, -32601, `Unknown tool: ${name}`);
      return;
    }

    const prompt = args.prompt || 'Describe this image concisely. Extract all visible text, UI elements, error messages, code, and data.';
    const result = extractImage(args.file_path, prompt);

    if (result.error) {
      respond(id, {
        content: [{ type: 'text', text: JSON.stringify({ error: result.error }) }],
        isError: true,
      });
    } else {
      respond(id, {
        content: [{ type: 'text', text: result.text }],
      });
    }
    return;
  }

  respondError(id, -32601, `Method not found: ${method}`);
}

// Read JSON-RPC from stdin line by line
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  try {
    handleRequest(JSON.parse(line));
  } catch (err) {
    process.stderr.write(`[image-extract] parse error: ${err.message}\n`);
  }
});
