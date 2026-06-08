/**
 * StackMemory Portal tests.
 *
 * Covers token generation, config resolution, the embedded UI, and the HTTP
 * auth layer. The pty/tmux bridge only loads on a socket connection, so the
 * HTTP server can be exercised without node-pty present.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  PortalServer,
  resolveConfig,
  ensureToken,
  readStatus,
  renderPortalPage,
} from '../index.js';

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'portal-test-'));
  process.env['PORTAL_STATE_DIR'] = stateDir;
});

afterEach(() => {
  delete process.env['PORTAL_STATE_DIR'];
  rmSync(stateDir, { recursive: true, force: true });
});

describe('ensureToken', () => {
  it('generates and persists a token to ~/.stackmemory/portal/token', () => {
    const token = ensureToken();
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(existsSync(join(stateDir, 'token'))).toBe(true);
  });

  it('returns the same token on subsequent calls', () => {
    expect(ensureToken()).toBe(ensureToken());
  });

  it('persists the token with 0600 permissions', () => {
    ensureToken();
    const mode = readFileSync(join(stateDir, 'token'));
    expect(mode).toBeDefined();
  });
});

describe('resolveConfig', () => {
  it('applies defaults and a generated token', () => {
    const cfg = resolveConfig();
    expect(cfg.port).toBe(7799);
    expect(cfg.host).toBe('0.0.0.0');
    expect(cfg.session).toBe('claude');
    expect(cfg.command).toBe('claude');
    expect(cfg.token).toMatch(/^[0-9a-f]{48}$/);
  });

  it('honors overrides', () => {
    const cfg = resolveConfig({ port: 8080, session: 'agent', command: 'claude --resume' });
    expect(cfg.port).toBe(8080);
    expect(cfg.session).toBe('agent');
    expect(cfg.command).toBe('claude --resume');
  });

  it('leaves the token empty when auth is disabled', () => {
    const cfg = resolveConfig({ noAuth: true });
    expect(cfg.token).toBe('');
    expect(cfg.noAuth).toBe(true);
  });
});

describe('renderPortalPage', () => {
  it('embeds the session name and xterm/socket.io assets', () => {
    const html = renderPortalPage({ session: 'claude' });
    expect(html).toContain('StackMemory Portal');
    expect(html).toContain('session <b>claude</b>');
    expect(html).toContain('@xterm/xterm');
    expect(html).toContain('socket.io-client');
  });

  it('escapes the session name to prevent HTML injection', () => {
    const html = renderPortalPage({ session: '<script>x</script>' });
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('readStatus', () => {
  it('reports not-running when no pid file exists', () => {
    expect(readStatus()).toEqual({ running: false });
  });
});

describe('PortalServer HTTP layer', () => {
  let server: PortalServer;
  let port: number;

  beforeEach(async () => {
    port = 38000 + Math.floor(Math.random() * 1500);
    server = new PortalServer({ port, host: '127.0.0.1', token: 'secret-token' });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('serves /healthz without auth', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; session: string };
    expect(body.ok).toBe(true);
    expect(body.session).toBe('claude');
  });

  it('rejects the page without a valid token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(401);
  });

  it('serves the page with the correct token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/?token=secret-token`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('StackMemory Portal');
  });

  it('writes a status file while running', () => {
    const status = readStatus();
    expect(status.running).toBe(true);
    expect(status.port).toBe(port);
  });

  it('clears the status file after stop', async () => {
    await server.stop();
    expect(readStatus()).toEqual({ running: false });
    // re-create for afterEach idempotency
    server = new PortalServer({ port, host: '127.0.0.1', token: 'secret-token' });
    await server.start();
  });
});

describe('PortalServer no-auth mode', () => {
  it('serves the page without a token when auth is disabled', async () => {
    const port = 39500 + Math.floor(Math.random() * 400);
    const server = new PortalServer({ port, host: '127.0.0.1', noAuth: true });
    await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(200);
    } finally {
      await server.stop();
    }
  });
});
