#!/usr/bin/env node

/**
 * Cord Trace Hook (PostToolUse)
 *
 * Fires on every cord_* MCP tool call, logging metrics to a JSONL trace file
 * and accumulating session metrics in a per-session state file.
 *
 * Trace dir: ~/.stackmemory/cord-traces/
 *   cord-trace-{date}.jsonl      — append-only trace log
 *   cord-state-{session_id}.json — running session metrics
 *
 * Must complete in <50ms — pure file I/O only.
 */

const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME || '/tmp';
const TRACE_DIR = path.join(HOME, '.stackmemory', 'cord-traces');
const CORD_TOOLS = new Set([
  'cord_spawn',
  'cord_fork',
  'cord_complete',
  'cord_ask',
  'cord_tree',
]);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function safeWriteFile(filePath, content) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

/**
 * Extract the cord tool name from the full MCP tool name.
 * e.g. "mcp__stackmemory-refactored__cord_spawn" -> "cord_spawn"
 */
function extractCordTool(toolName) {
  if (!toolName) return null;
  for (const t of CORD_TOOLS) {
    if (toolName.endsWith(t)) return t;
  }
  return null;
}

function loadState(sessionId) {
  const stateFile = path.join(TRACE_DIR, `cord-state-${sessionId}.json`);
  try {
    if (fs.existsSync(stateFile)) {
      return JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    }
  } catch {
    // Corrupted state, start fresh
  }
  return {
    session_id: sessionId,
    started: new Date().toISOString(),
    tool_counts: {},
    task_ids: [],
    context_modes: {},
    unblocked_total: 0,
    max_depth: 0,
    completion_rate: 0,
    ask_count: 0,
    completed_count: 0,
    spawn_fork_count: 0,
  };
}

function saveState(sessionId, state) {
  const stateFile = path.join(TRACE_DIR, `cord-state-${sessionId}.json`);
  safeWriteFile(stateFile, JSON.stringify(state, null, 2));
}

function appendTrace(entry) {
  const date = new Date().toISOString().slice(0, 10);
  const traceFile = path.join(TRACE_DIR, `cord-trace-${date}.jsonl`);
  fs.appendFileSync(traceFile, JSON.stringify(entry) + '\n');
}

/**
 * Safely extract metadata from tool_response.
 * MCP tool responses come as { content: [{ type, text }], metadata: {...} }.
 * The hook receives tool_response which may be the raw MCP result or a string.
 */
function extractMetadata(toolResponse) {
  if (!toolResponse) return {};
  if (typeof toolResponse === 'string') {
    try {
      const parsed = JSON.parse(toolResponse);
      return parsed.metadata || parsed;
    } catch {
      return {};
    }
  }
  if (toolResponse.metadata) return toolResponse.metadata;
  return toolResponse;
}

function updateState(state, cordTool, toolInput, toolResponse) {
  // Increment tool count
  state.tool_counts[cordTool] = (state.tool_counts[cordTool] || 0) + 1;

  const meta = extractMetadata(toolResponse);

  switch (cordTool) {
    case 'cord_spawn':
    case 'cord_fork': {
      state.spawn_fork_count++;

      // Track context mode
      const mode = meta.context_mode || cordTool.replace('cord_', '');
      state.context_modes[mode] = (state.context_modes[mode] || 0) + 1;

      // Track task ID
      if (meta.task_id && !state.task_ids.includes(meta.task_id)) {
        state.task_ids.push(meta.task_id);
      }

      // Track max depth
      const depth = meta.depth ?? 0;
      if (depth > state.max_depth) {
        state.max_depth = depth;
      }
      break;
    }

    case 'cord_complete': {
      state.completed_count++;

      // Count unblocked tasks
      const unblocked = meta.unblocked;
      if (Array.isArray(unblocked)) {
        state.unblocked_total += unblocked.length;
      }

      // Update completion rate
      if (state.spawn_fork_count > 0) {
        state.completion_rate = +(
          state.completed_count / state.spawn_fork_count
        ).toFixed(3);
      }
      break;
    }

    case 'cord_ask': {
      state.ask_count++;

      // Track task ID
      if (meta.task_id && !state.task_ids.includes(meta.task_id)) {
        state.task_ids.push(meta.task_id);
      }

      // Track context mode
      state.context_modes['ask'] = (state.context_modes['ask'] || 0) + 1;
      break;
    }

    case 'cord_tree':
      // Read-only — no state change
      break;
  }
}

function buildMetricsSummary(state) {
  return {
    task_count: state.task_ids.length,
    active: state.spawn_fork_count - state.completed_count,
    completed: state.completed_count,
    asks: state.ask_count,
  };
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
    const { tool_name, tool_input, tool_response, session_id } = input;

    const cordTool = extractCordTool(tool_name);
    if (!cordTool) return; // Not a cord tool, shouldn't happen given matcher

    const sid =
      session_id || process.env.CLAUDE_INSTANCE_ID || String(process.ppid);

    ensureDir(TRACE_DIR);

    // Load and update state
    const state = loadState(sid);
    updateState(state, cordTool, tool_input, tool_response);

    // Build trace entry
    const entry = {
      ts: new Date().toISOString(),
      session_id: sid,
      cwd: input.cwd || process.cwd(),
      tool: cordTool,
      input: tool_input || {},
      response: extractMetadata(tool_response),
      metrics: buildMetricsSummary(state),
    };

    // Append trace + save state
    appendTrace(entry);
    saveState(sid, state);
  } catch {
    // Silent fail — never block the agent
  }
}

main();
