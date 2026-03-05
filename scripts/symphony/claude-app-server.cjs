#!/usr/bin/env node
/**
 * Claude Code App-Server Adapter for Symphony
 *
 * Speaks the Codex app-server JSON-RPC 2.0 stdio protocol
 * but runs Claude Code underneath.
 *
 * Primary mode: `claude -p --output-format stream-json` (full tool use)
 * Fallback mode: `claude --print` (single-turn, no tools)
 *
 * Symphony spawns this process and sends:
 *   initialize → thread/start → turn/start → (stream events) → turn/completed
 *
 * Usage in WORKFLOW.md:
 *   codex:
 *     command: node /path/to/claude-app-server.cjs
 */

const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const readline = require('readline');

// State
let threadId = null;
let workspace = null;
let sessionId = null;

// Read JSON-RPC messages from stdin (one per line)
const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  handleMessage(msg);
});

rl.on('close', () => {
  process.exit(0);
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function log(msg) {
  process.stderr.write(`[claude-adapter] ${msg}\n`);
}

function handleMessage(msg) {
  const { method, id, params } = msg;

  switch (method) {
    case 'initialize':
      send({
        id,
        result: {
          serverInfo: {
            name: 'claude-app-server-adapter',
            version: '0.2.0',
          },
          capabilities: {},
        },
      });
      break;

    case 'initialized':
      break;

    case 'thread/start':
      threadId = randomUUID();
      workspace = params?.cwd || process.cwd();
      send({
        id,
        result: { thread: { id: threadId } },
      });
      break;

    case 'turn/start':
      handleTurn(id, params);
      break;

    default:
      if (id !== undefined) {
        send({ id, result: {} });
      }
      break;
  }
}

async function handleTurn(turnRequestId, params) {
  const turnId = randomUUID();
  sessionId = `${threadId}-${turnId}`;
  const prompt = extractPrompt(params);
  const cwd = params?.cwd || workspace;

  send({
    id: turnRequestId,
    result: { turn: { id: turnId } },
  });

  try {
    // Primary: stream-json mode with full tool use
    log(`Starting agentic turn (stream-json) in ${cwd}`);
    const result = await runClaudeStreaming(prompt, cwd, turnId);

    send({
      method: 'turn/completed',
      params: {
        turnId,
        threadId,
        result: {
          type: 'completed',
          output: [{ type: 'text', text: result }],
        },
      },
    });
  } catch (err) {
    log(`Agentic mode failed: ${err.message}`);
    log('Falling back to single-turn --print mode');

    try {
      const fallbackResult = await runClaudePrint(prompt, cwd);

      send({
        method: 'turn/completed',
        params: {
          turnId,
          threadId,
          result: {
            type: 'completed',
            output: [{ type: 'text', text: fallbackResult }],
          },
        },
      });
    } catch (fallbackErr) {
      log(`Fallback also failed: ${fallbackErr.message}`);

      send({
        method: 'turn/failed',
        params: {
          turnId,
          threadId,
          error: {
            message: `Primary: ${err.message} | Fallback: ${fallbackErr.message}`,
          },
        },
      });
    }
  }
}

function extractPrompt(params) {
  if (!params?.input) return '';
  return params.input
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

/**
 * Primary mode: `claude -p --output-format stream-json`
 *
 * Runs Claude Code with full tool use (Bash, Edit, Read, etc.).
 * Streams JSON events, we parse them and forward relevant ones
 * to Symphony as notifications, then collect the final result.
 */
function runClaudeStreaming(prompt, cwd, turnId) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
      prompt,
    ];

    const claude = spawn('claude', args, {
      cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let lastAssistantText = '';
    let toolUseCount = 0;
    let lineBuffer = '';

    claude.stdout.on('data', (chunk) => {
      lineBuffer += chunk.toString();

      // Process complete lines
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop(); // keep incomplete last line

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          processStreamEvent(event, turnId);

          // Track outputs
          if (event.type === 'assistant' && event.message) {
            const textBlocks = (event.message.content || [])
              .filter((b) => b.type === 'text')
              .map((b) => b.text);
            if (textBlocks.length > 0) {
              lastAssistantText = textBlocks.join('\n');
            }

            const toolBlocks = (event.message.content || [])
              .filter((b) => b.type === 'tool_use');
            toolUseCount += toolBlocks.length;
          }

          // Also capture result message
          if (event.type === 'result' && event.result) {
            lastAssistantText = event.result;
          }
        } catch {
          // non-JSON line from claude, ignore
        }
      }
    });

    let stderr = '';
    claude.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    claude.on('close', (code) => {
      // Process any remaining buffer
      if (lineBuffer.trim()) {
        try {
          const event = JSON.parse(lineBuffer);
          if (event.type === 'result' && event.result) {
            lastAssistantText = event.result;
          }
        } catch {
          // ignore
        }
      }

      log(`Claude stream exited code=${code} tools_used=${toolUseCount}`);

      if (code === 0 && lastAssistantText) {
        resolve(lastAssistantText);
      } else if (code === 0) {
        resolve('(Claude completed but produced no text output)');
      } else {
        reject(new Error(`Claude stream exited code ${code}: ${stderr.slice(0, 500)}`));
      }
    });

    claude.on('error', (err) => {
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}

/**
 * Forward stream events to Symphony as notifications.
 * Symphony expects these as method notifications (no id).
 */
function processStreamEvent(event, turnId) {
  if (!event.type) return;

  switch (event.type) {
    case 'assistant': {
      // Forward tool_use blocks as command executions
      const content = event.message?.content || [];
      for (const block of content) {
        if (block.type === 'tool_use') {
          send({
            method: 'item/commandExecution/started',
            params: {
              turnId,
              threadId,
              tool: block.name,
              arguments: block.input,
            },
          });
          log(`Tool: ${block.name}`);
        }
      }
      break;
    }

    case 'result': {
      // Final result — handled by caller
      break;
    }

    default:
      // system, user, etc. — skip
      break;
  }
}

/**
 * Fallback: `claude --print <prompt>`
 * Simple single-turn, no tool use.
 */
function runClaudePrint(prompt, cwd) {
  return new Promise((resolve, reject) => {
    const claude = spawn('claude', ['--print', prompt], {
      cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    claude.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    claude.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    claude.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim() || '(no output)');
      } else {
        reject(new Error(`Claude print exited code ${code}: ${stderr.slice(0, 500)}`));
      }
    });

    claude.on('error', (err) => {
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}
