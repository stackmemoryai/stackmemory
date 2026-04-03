#!/usr/bin/env node
/**
 * StackMemory Board — Agent Viewer Server
 *
 * Express + Socket.io server that:
 * - Lists conductor agent statuses from ~/.stackmemory/conductor/agents/
 * - Spawns interactive Claude Code sessions (stdin open, stream-json output)
 * - Streams agent output to browser via WebSocket
 * - Accepts user input from browser and writes to agent stdin
 * - Persists session state for reconnection
 *
 * Usage: node server.js [--port 3456]
 */

const http = require('http');
const express = require('express');
const { Server: SocketServer } = require('socket.io');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Config ──

const PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--port') || '3456');
const CONDUCTOR_DIR = path.join(os.homedir(), '.stackmemory', 'conductor');
const AGENTS_DIR = path.join(CONDUCTOR_DIR, 'agents');
const SESSIONS_DIR = path.join(os.tmpdir(), 'stackmemory-board-sessions');
const OUTPUT_BUFFER_LIMIT = 50000; // chars to keep per session

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// ── State ──

/** @type {Map<string, {process: import('child_process').ChildProcess, output: string[], clients: Set<any>, startedAt: number, model: string, cwd: string}>} */
const sessions = new Map();

// ── Express + Socket.io ──

const app = express();
const server = http.createServer(app);
const io = new SocketServer(server, { cors: { origin: '*' } });

app.use(express.json());

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// ── REST API ──

// List conductor agent statuses
app.get('/api/agents', (_req, res) => {
  const agents = scanAgentStatuses();
  res.json(agents);
});

// List active interactive sessions
app.get('/api/sessions', (_req, res) => {
  const list = [];
  for (const [id, s] of sessions) {
    list.push({
      id,
      startedAt: s.startedAt,
      model: s.model,
      cwd: s.cwd,
      alive: s.process && !s.process.killed,
      outputLength: s.output.join('').length,
    });
  }
  res.json(list);
});

// Create a new interactive Claude Code session
app.post('/api/sessions', (req, res) => {
  const { prompt, model, cwd } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  const sessionId = `board-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const session = spawnSession(sessionId, {
    prompt,
    model: model || 'sonnet',
    cwd: cwd || process.cwd(),
  });

  res.json({ sessionId, pid: session.process.pid });
});

// Send a message to an existing session's stdin
app.post('/api/sessions/:id/message', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  if (session.process.killed) return res.status(410).json({ error: 'session ended' });

  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  // Write to stdin (stream-json expects JSON input)
  const input = JSON.stringify({ type: 'user_message', content: message }) + '\n';
  session.process.stdin.write(input);

  res.json({ ok: true });
});

// Kill a session
app.delete('/api/sessions/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });

  session.process.kill('SIGTERM');
  res.json({ ok: true });
});

// Get session output history (for reconnection)
app.get('/api/sessions/:id/output', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });

  res.json({ output: session.output });
});

// ── WebSocket ──

io.on('connection', (socket) => {
  console.log(`[board] Client connected: ${socket.id}`);

  // Attach to a session for live streaming
  socket.on('session:attach', (sessionId) => {
    const session = sessions.get(sessionId);
    if (!session) {
      socket.emit('session:error', { error: 'session not found' });
      return;
    }

    session.clients.add(socket);
    socket.join(`session:${sessionId}`);

    // Send buffered output history
    socket.emit('session:history', { sessionId, output: session.output });
    socket.emit('session:status', {
      sessionId,
      alive: !session.process.killed,
      pid: session.process.pid,
    });

    console.log(`[board] Client ${socket.id} attached to session ${sessionId}`);
  });

  // Detach from session
  socket.on('session:detach', (sessionId) => {
    const session = sessions.get(sessionId);
    if (session) {
      session.clients.delete(socket);
      socket.leave(`session:${sessionId}`);
    }
  });

  // Send input to session
  socket.on('session:input', ({ sessionId, message }) => {
    const session = sessions.get(sessionId);
    if (!session || session.process.killed) return;

    const input = JSON.stringify({ type: 'user_message', content: message }) + '\n';
    session.process.stdin.write(input);
  });

  // Send signal to session
  socket.on('session:signal', ({ sessionId, signal }) => {
    const session = sessions.get(sessionId);
    if (!session || session.process.killed) return;
    session.process.kill(signal || 'SIGINT');
  });

  // Create session from socket
  socket.on('session:create', ({ prompt, model, cwd }) => {
    const sessionId = `board-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const session = spawnSession(sessionId, {
      prompt: prompt || '',
      model: model || 'sonnet',
      cwd: cwd || process.cwd(),
    });

    session.clients.add(socket);
    socket.join(`session:${sessionId}`);
    socket.emit('session:created', { sessionId, pid: session.process.pid });
  });

  socket.on('disconnect', () => {
    // Remove from all sessions
    for (const [, session] of sessions) {
      session.clients.delete(socket);
    }
    console.log(`[board] Client disconnected: ${socket.id}`);
  });
});

// ── Session Management ──

function spawnSession(sessionId, opts) {
  const args = [
    '--output-format', 'stream-json',
    '--model', opts.model,
    '--input-format', 'stream-json',
  ];

  // If prompt provided, use -p for initial prompt
  if (opts.prompt) {
    args.unshift('-p', opts.prompt);
  }

  console.log(`[board] Spawning session ${sessionId}: claude ${args.slice(0, 6).join(' ')}...`);

  const child = spawn('claude', args, {
    cwd: opts.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0' },
  });

  const session = {
    process: child,
    output: [],
    clients: new Set(),
    startedAt: Date.now(),
    model: opts.model,
    cwd: opts.cwd,
  };

  sessions.set(sessionId, session);

  // Stream stdout (stream-json events)
  let stdoutBuf = '';
  child.stdout.on('data', (data) => {
    stdoutBuf += data.toString();

    // Parse line-delimited JSON
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop(); // keep incomplete line

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        session.output.push(line);
        trimOutputBuffer(session);

        // Broadcast to attached clients
        io.to(`session:${sessionId}`).emit('session:event', { sessionId, event });
      } catch {
        // Non-JSON output, send as raw
        session.output.push(line);
        io.to(`session:${sessionId}`).emit('session:raw', { sessionId, data: line });
      }
    }
  });

  // Stream stderr
  child.stderr.on('data', (data) => {
    const text = data.toString();
    io.to(`session:${sessionId}`).emit('session:stderr', { sessionId, data: text });
  });

  // Handle exit
  child.on('close', (code) => {
    console.log(`[board] Session ${sessionId} exited with code ${code}`);
    io.to(`session:${sessionId}`).emit('session:exit', { sessionId, code });

    // Persist output to disk for later review
    const outputFile = path.join(SESSIONS_DIR, `${sessionId}.jsonl`);
    fs.writeFileSync(outputFile, session.output.join('\n'));
  });

  child.on('error', (err) => {
    console.error(`[board] Session ${sessionId} error: ${err.message}`);
    io.to(`session:${sessionId}`).emit('session:error', { sessionId, error: err.message });
  });

  return session;
}

function trimOutputBuffer(session) {
  const total = session.output.join('').length;
  if (total > OUTPUT_BUFFER_LIMIT) {
    // Drop oldest entries
    while (session.output.length > 10 && session.output.join('').length > OUTPUT_BUFFER_LIMIT * 0.8) {
      session.output.shift();
    }
  }
}

// ── Conductor Agent Scanner ──

function scanAgentStatuses() {
  if (!fs.existsSync(AGENTS_DIR)) return [];

  const entries = fs.readdirSync(AGENTS_DIR, { withFileTypes: true });
  const statuses = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const statusPath = path.join(AGENTS_DIR, entry.name, 'status.json');
    if (!fs.existsSync(statusPath)) continue;

    try {
      const data = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
      const alive = isProcessAlive(data.pid);
      const elapsed = Date.now() - new Date(data.lastUpdate).getTime();

      statuses.push({
        ...data,
        dir: entry.name,
        alive,
        stale: alive && elapsed > 5 * 60 * 1000,
        elapsed,
      });
    } catch {
      // skip corrupt
    }
  }

  return statuses.sort((a, b) =>
    new Date(b.lastUpdate).getTime() - new Date(a.lastUpdate).getTime()
  );
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// ── Start ──

server.listen(PORT, () => {
  console.log(`\n  StackMemory Board`);
  console.log(`  http://localhost:${PORT}\n`);
});
