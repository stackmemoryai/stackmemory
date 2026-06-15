import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../api/server.js';
import type { Server } from 'node:http';

function request(
  port: number,
  path: string,
  opts: { method?: string; body?: unknown; token?: string } = {}
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const method = opts.method ?? 'GET';
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    if (opts.token) {
      headers['Authorization'] = `Bearer ${opts.token}`;
    }

    const req = require('node:http').request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers,
      },
      (res: any) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: text });
          }
        });
      }
    );

    req.on('error', reject);
    if (opts.body) {
      req.write(JSON.stringify(opts.body));
    }
    req.end();
  });
}

describe('REST API', () => {
  let tmpDir: string;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'provenant-api-test-'));
    port = 10_000 + Math.floor(Math.random() * 10_000);
    server = startServer({
      port,
      dbPath: join(tmpDir, 'api.db'),
      apiKey: 'test-api-key',
    });
    await new Promise<void>((resolve) => server.on('listening', resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /api/status returns status without auth', async () => {
    const res = await request(port, '/api/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ nodeCount: 0 });
  });

  it('POST /api/decisions rejects without auth', async () => {
    const res = await request(port, '/api/decisions', {
      method: 'POST',
      body: { content: 'Use PostgreSQL' },
    });
    expect(res.status).toBe(401);
  });

  it('POST /api/decisions creates a node with valid auth', async () => {
    const res = await request(port, '/api/decisions', {
      method: 'POST',
      body: { content: 'Use PostgreSQL', actor: 'qa' },
      token: 'test-api-key',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ content: 'Use PostgreSQL', actor: 'qa' });
  });

  it('POST /api/webhook/decision stores decision with source provenance', async () => {
    const res = await request(port, '/api/webhook/decision', {
      method: 'POST',
      body: {
        content: 'SOP-101 satisfied: frame stack consistent',
        actor: 'harness',
        source: 'harness-pi',
        source_id: 'run-123',
        confidence: 0.9,
      },
      token: 'test-api-key',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      content: 'SOP-101 satisfied: frame stack consistent',
      sourceLinked: true,
    });

    // Node should be searchable
    const search = await request(
      port,
      '/api/nodes?keywords=SOP-101,frame'
    );
    expect(search.status).toBe(200);
    expect(Array.isArray(search.body)).toBe(true);
    expect((search.body as any[]).length).toBe(1);
  });
});
