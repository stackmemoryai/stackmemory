#!/usr/bin/env node

/**
 * Desire Path Trace Hook (PostToolUse)
 *
 * Detects failed tool calls and logs them to ~/.stackmemory/desire-paths/
 * as JSONL for later analysis. Tracks what agents *want* but can't get:
 * unknown tools, invalid params, handler errors.
 *
 * Must complete in <50ms -- pure file I/O only.
 */

const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME || '/tmp';
const DESIRE_DIR = path.join(HOME, '.stackmemory', 'desire-paths');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function categorize(errorText) {
  if (!errorText) return 'handler_error';
  if (/unknown tool/i.test(errorText)) return 'unknown_tool';
  if (
    /invalid param|missing.*param|required.*param|unexpected.*param/i.test(
      errorText
    )
  )
    return 'invalid_params';
  return 'handler_error';
}

function isFailure(input) {
  // Check is_error flag
  if (input.tool_response && input.tool_response.is_error === true) return true;

  // Check for error text in response
  const response =
    typeof input.tool_response === 'string'
      ? input.tool_response
      : JSON.stringify(input.tool_response || '');

  if (/Unknown tool:/i.test(response)) return true;
  if (/^Error:/m.test(response)) return true;
  if (/McpError|MCP error/i.test(response)) return true;

  return false;
}

function extractError(input) {
  const response = input.tool_response;
  if (!response) return 'unknown error';

  if (typeof response === 'string') return response.slice(0, 500);
  if (response.error) return String(response.error).slice(0, 500);
  if (response.content && Array.isArray(response.content)) {
    const textBlock = response.content.find((b) => b.type === 'text');
    if (textBlock) return String(textBlock.text).slice(0, 500);
  }

  return JSON.stringify(response).slice(0, 500);
}

function truncateInput(toolInput) {
  if (!toolInput) return {};
  const result = {};
  for (const [key, value] of Object.entries(toolInput)) {
    if (typeof value === 'string' && value.length > 200) {
      result[key] = value.slice(0, 200) + '...[truncated]';
    } else {
      result[key] = value;
    }
  }
  return result;
}

async function readInput() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return JSON.parse(input);
}

async function main() {
  try {
    const input = await readInput();

    if (!isFailure(input)) return;

    const errorText = extractError(input);
    const date = new Date().toISOString().slice(0, 10);
    const entry = {
      ts: new Date().toISOString(),
      sid:
        input.session_id ||
        process.env.CLAUDE_INSTANCE_ID ||
        String(process.ppid),
      tool: input.tool_name || 'unknown',
      input: truncateInput(input.tool_input),
      error: errorText,
      category: categorize(errorText),
      cwd: input.cwd || process.cwd(),
    };

    ensureDir(DESIRE_DIR);
    const filePath = path.join(DESIRE_DIR, `desire-${date}.jsonl`);
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
  } catch {
    // Silent fail -- never block the agent
  }
}

main();
