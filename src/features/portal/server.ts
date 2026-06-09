/**
 * StackMemory Portal — server.
 *
 * Express + Socket.io front end that bridges a browser terminal to a
 * persistent tmux session running Claude Code. Each connected client gets
 * its own pty running `tmux new-session -A -s <session> <command>`:
 *   - `-A` attaches to the session if it exists, otherwise creates it, so
 *     the agent keeps running 24/7 even when no browser is open.
 *   - Disconnecting a browser detaches its pty but leaves tmux alive.
 */

import express from 'express';
import { createServer, type Server as HttpServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { execFileSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { renderPortalPage } from './ui.js';
import {
  type PortalConfig,
  type PortalStatus,
  DEFAULT_PORTAL_CONFIG,
} from './types.js';

const HOME = process.env['HOME'] || '/tmp';

// Minimal node-pty surface, mirroring src/features/sweep/pty-wrapper.ts so we
// avoid a hard compile-time dependency on the native module.
interface PtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  kill(): void;
}

export function getPortalDir(): string {
  const dir =
    process.env['PORTAL_STATE_DIR'] || join(HOME, '.stackmemory', 'portal');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function tokenPath(): string {
  return join(getPortalDir(), 'token');
}

function pidPath(): string {
  return join(getPortalDir(), 'portal.json');
}

/** Load the persisted token, generating + saving one on first use. */
export function ensureToken(): string {
  const p = tokenPath();
  if (existsSync(p)) {
    const t = readFileSync(p, 'utf-8').trim();
    if (t) return t;
  }
  const token = randomBytes(24).toString('hex');
  writeFileSync(p, token + '\n', { mode: 0o600 });
  return token;
}

function tmuxAvailable(): boolean {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function resolveConfig(
  overrides: Partial<PortalConfig> = {}
): PortalConfig {
  const token = overrides.token ?? (overrides.noAuth ? '' : ensureToken());
  return {
    ...DEFAULT_PORTAL_CONFIG,
    cwd: process.cwd(),
    token,
    ...overrides,
  };
}

export class PortalServer {
  private config: PortalConfig;
  private httpServer: HttpServer | null = null;
  private io: SocketServer | null = null;
  private ptys = new Set<PtyProcess>();

  constructor(config: Partial<PortalConfig> = {}) {
    this.config = resolveConfig(config);
  }

  getConfig(): PortalConfig {
    return this.config;
  }

  private authOk(token: unknown): boolean {
    if (this.config.noAuth) return true;
    return typeof token === 'string' && token === this.config.token;
  }

  async start(): Promise<PortalStatus> {
    if (!tmuxAvailable()) {
      throw new Error(
        'tmux is not installed. Install it first (e.g. `apt install tmux` / `brew install tmux`).'
      );
    }

    const app = express();
    const page = renderPortalPage({ session: this.config.session });

    // Token-gate the page itself when auth is enabled.
    app.get('/', (req, res) => {
      if (!this.config.noAuth && !this.authOk(req.query['token'])) {
        res
          .status(401)
          .type('text/plain')
          .send('Unauthorized: missing or invalid ?token');
        return;
      }
      res.type('html').send(page);
    });
    app.get('/healthz', (_req, res) => {
      res.json({ ok: true, session: this.config.session });
    });

    const httpServer = createServer(app);
    const io = new SocketServer(httpServer, { cors: { origin: true } });

    io.use((socket, next) => {
      const token =
        (socket.handshake.auth as { token?: string })?.token ??
        (socket.handshake.query['token'] as string | undefined);
      if (this.authOk(token)) return next();
      next(new Error('Invalid access token'));
    });

    io.on('connection', (socket) => {
      void this.attachSession(socket);
    });

    this.httpServer = httpServer;
    this.io = io;

    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(this.config.port, this.config.host, () => resolve());
    });

    const status: PortalStatus = {
      running: true,
      pid: process.pid,
      port: this.config.port,
      host: this.config.host,
      session: this.config.session,
      startedAt: Date.now(),
    };
    writeFileSync(pidPath(), JSON.stringify(status, null, 2));
    return status;
  }

  private async attachSession(socket: {
    emit: (event: string, ...args: unknown[]) => void;
    on: (event: string, cb: (...args: unknown[]) => void) => void;
  }): Promise<void> {
    let pty: typeof import('node-pty');
    try {
      pty = await import('node-pty');
    } catch {
      socket.emit(
        'portal:error',
        'node-pty is not installed on the server. Run: npm install node-pty'
      );
      return;
    }

    // `tmux new-session -A` attaches if the session exists, else creates it.
    const proc = pty.spawn(
      'tmux',
      ['new-session', '-A', '-s', this.config.session, this.config.command],
      {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: this.config.cwd,
        env: { ...process.env, TERM: 'xterm-256color' },
      }
    ) as unknown as PtyProcess;

    this.ptys.add(proc);

    proc.onData((data) => socket.emit('output', data));
    proc.onExit(() => {
      this.ptys.delete(proc);
      socket.emit(
        'output',
        '\r\n\x1b[33m[portal] session detached]\x1b[0m\r\n'
      );
    });

    socket.on('input', (data: unknown) => {
      if (typeof data === 'string') proc.write(data);
    });
    socket.on('resize', (size: unknown) => {
      const s = size as { cols?: number; rows?: number };
      if (s && Number.isFinite(s.cols) && Number.isFinite(s.rows)) {
        try {
          proc.resize(
            Math.max(2, s.cols as number),
            Math.max(2, s.rows as number)
          );
        } catch {
          /* resize can race with exit; ignore */
        }
      }
    });
    socket.on('disconnect', () => {
      this.ptys.delete(proc);
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    });
  }

  async stop(): Promise<void> {
    for (const p of this.ptys) {
      try {
        p.kill();
      } catch {
        /* ignore */
      }
    }
    this.ptys.clear();
    if (this.io) {
      this.io.close();
      this.io = null;
    }
    await new Promise<void>((resolve) => {
      if (!this.httpServer) return resolve();
      this.httpServer.close(() => resolve());
    });
    this.httpServer = null;
    clearPidFile();
  }
}

export function readStatus(): PortalStatus {
  const p = pidPath();
  if (!existsSync(p)) return { running: false };
  try {
    const status = JSON.parse(readFileSync(p, 'utf-8')) as PortalStatus;
    if (status.pid && !isProcessAlive(status.pid)) {
      clearPidFile();
      return { running: false };
    }
    return status;
  } catch {
    return { running: false };
  }
}

export function stopRunning(): boolean {
  const status = readStatus();
  if (!status.running || !status.pid) return false;
  try {
    process.kill(status.pid, 'SIGTERM');
  } catch {
    /* already dead */
  }
  clearPidFile();
  return true;
}

function clearPidFile(): void {
  try {
    if (existsSync(pidPath())) unlinkSync(pidPath());
  } catch {
    /* ignore */
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
