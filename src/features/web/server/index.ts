/**
 * StackMemory Web Dashboard Server
 * Express + Socket.io server for real-time dashboard
 */

import express from 'express';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import cors from 'cors';
import { LinearTaskReader } from '../../tui/services/linear-task-reader.js';
import { SessionManager } from '../../../core/session/session-manager.js';
import { FrameManager } from '../../../core/context/index.js';
import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { join } from 'path';
import { getSpendSummary } from './spend-calculator.js';
// Type-safe environment variable access
function _getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (value === undefined) {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`Environment variable ${key} is required`);
  }
  return value;
}

function _getOptionalEnv(key: string): string | undefined {
  return process.env[key];
}

const app = express();
const httpServer = createServer(app);
const io = new SocketServer(httpServer, {
  cors: {
    origin: process.env['CLIENT_URL'] || 'http://localhost:3000',
    methods: ['GET', 'POST'],
  },
});

// Middleware
app.use(cors());
app.use(express.json());

// Data services
let taskReader: LinearTaskReader;
let sessionManager: SessionManager;
let frameManager: FrameManager | null = null;
let db: Database.Database | null = null;

// Initialize services
function initializeServices() {
  console.log('🚀 Initializing StackMemory Web Server...');

  // Initialize task reader
  taskReader = new LinearTaskReader(process.cwd());
  console.log(
    `📋 TaskReader initialized with ${taskReader.getTasks().length} tasks`
  );

  // Initialize session manager
  sessionManager = new SessionManager({ enableMonitoring: true });
  console.log('📊 SessionManager initialized');

  // Initialize database and frame manager
  const dbPath = join(process.cwd(), '.stackmemory', 'context.db');
  if (existsSync(dbPath)) {
    try {
      db = new Database(dbPath);
      frameManager = new FrameManager(db, 'web');
      console.log('💾 Database and FrameManager initialized');
    } catch (error: unknown) {
      console.error('❌ Failed to initialize database:', error);
    }
  }
}

// REST API Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/tasks', (req, res) => {
  try {
    const tasks = taskReader.getTasks();
    res.json({ tasks, total: tasks.length });
  } catch {
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

app.get('/api/tasks/active', (req, res) => {
  try {
    const tasks = taskReader.getActiveTasks();
    res.json({ tasks, total: tasks.length });
  } catch {
    res.status(500).json({ error: 'Failed to fetch active tasks' });
  }
});

app.get('/api/tasks/by-state/:state', (req, res) => {
  try {
    const tasks = taskReader.getTasksByState(req.params.state);
    res.json({ tasks, total: tasks.length });
  } catch {
    res.status(500).json({ error: 'Failed to fetch tasks by state' });
  }
});

app.get('/api/sessions', (req, res) => {
  try {
    const sessions = sessionManager?.getActiveSessions
      ? sessionManager.getActiveSessions()
      : [];
    res.json({ sessions, total: sessions.length });
  } catch {
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

app.get('/api/frames', (req, res) => {
  try {
    if (!frameManager) {
      res.json({ frames: [], total: 0 });
      return;
    }
    const frames = frameManager.getAllFrames();
    res.json({ frames, total: frames.length });
  } catch {
    res.status(500).json({ error: 'Failed to fetch frames' });
  }
});

app.get('/api/analytics', (req, res) => {
  try {
    const tasks = taskReader.getTasks();
    const sessions = sessionManager?.getActiveSessions
      ? sessionManager.getActiveSessions()
      : [];
    const frames = frameManager?.getAllFrames() || [];

    // Calculate analytics
    const analytics = {
      summary: {
        totalTasks: tasks.length,
        activeTasks: tasks.filter((t: any) => t.state === 'In Progress').length,
        completedTasks: tasks.filter((t: any) => t.state === 'Done').length,
        totalSessions: sessions.length,
        totalFrames: frames.length,
      },
      tasksByState: tasks.reduce(
        (acc, task) => {
          acc[task.state] = (acc[task.state] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>
      ),
      tasksByPriority: tasks.reduce(
        (acc, task) => {
          const priority = task.priority || 4;
          acc[priority] = (acc[priority] || 0) + 1;
          return acc;
        },
        {} as Record<number, number>
      ),
      recentActivity: {
        tasksUpdatedToday: tasks.filter((t: any) => {
          const updated = new Date(t.updatedAt);
          const today = new Date();
          return updated.toDateString() === today.toDateString();
        }).length,
        sessionsToday: sessions.filter((s: any) => {
          const started = new Date(s.startTime);
          const today = new Date();
          return started.toDateString() === today.toDateString();
        }).length,
      },
    };

    res.json(analytics);
  } catch {
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

app.get('/api/evals', async (req, res) => {
  try {
    const spend = await getSpendSummary();
    res.json(spend);
  } catch (error: unknown) {
    console.error('Error fetching evals spend:', error);
    res.status(500).json({ error: 'Failed to fetch AI spend estimate' });
  }
});

// WebSocket handling
io.on('connection', (socket) => {
  console.log('👤 Client connected:', socket.id);

  // Send initial data
  socket.emit('initial-data', {
    tasks: taskReader.getTasks(),
    sessions: sessionManager?.getActiveSessions
      ? sessionManager.getActiveSessions()
      : [],
    frames: frameManager?.getAllFrames() || [],
  });

  // Handle client requests
  socket.on('refresh-tasks', () => {
    socket.emit('tasks:update', taskReader.getTasks());
  });

  socket.on('refresh-sessions', () => {
    const sessions = sessionManager?.getActiveSessions
      ? sessionManager.getActiveSessions()
      : [];
    socket.emit('sessions:update', sessions);
  });

  socket.on('refresh-frames', () => {
    socket.emit('frames:update', frameManager?.getAllFrames() || []);
  });

  socket.on('disconnect', () => {
    console.log('👋 Client disconnected:', socket.id);
  });
});

// Periodic updates (every 5 seconds)
setInterval(() => {
  try {
    io.emit('tasks:update', taskReader.getTasks());
    // SessionManager might not have getActiveSessions yet
    const sessions = sessionManager?.getActiveSessions
      ? sessionManager.getActiveSessions()
      : [];
    io.emit('sessions:update', sessions);
    io.emit('frames:update', frameManager?.getAllFrames() || []);
  } catch (error: unknown) {
    console.error('Error in periodic update:', error);
  }
}, 5000);

// Start server
const PORT = process.env['WS_PORT'] || 8080;

initializeServices();

httpServer.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║   StackMemory Web Dashboard Server              ║
║   Running on http://localhost:${PORT}            ║
║   WebSocket: ws://localhost:${PORT}              ║
╚══════════════════════════════════════════════════╝
  `);
});
