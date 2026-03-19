import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { Database } from '../schema/database.js';

interface ServerConfig {
  port: number;
  dbPath: string;
}

function parseJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function parseQuery(url: string): URLSearchParams {
  const idx = url.indexOf('?');
  return new URLSearchParams(idx >= 0 ? url.slice(idx + 1) : '');
}

function parsePath(url: string): string {
  const idx = url.indexOf('?');
  return idx >= 0 ? url.slice(0, idx) : url;
}

export function startServer(config: ServerConfig): void {
  const db = new Database(config.dbPath);

  const server = createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const path = parsePath(req.url ?? '/');
    const query = parseQuery(req.url ?? '/');

    try {
      // GET /api/status
      if (method === 'GET' && path === '/api/status') {
        json(res, 200, db.getStatus());
        return;
      }

      // GET /api/nodes/:id
      const nodeMatch = path.match(/^\/api\/nodes\/([^/]+)$/);
      if (method === 'GET' && nodeMatch) {
        const id = nodeMatch[1]!;
        const node = db.getNode(id);
        if (!node) {
          json(res, 404, { error: 'Node not found' });
          return;
        }
        const edgesFrom = db.getEdgesFrom(id);
        const edgesTo = db.getEdgesTo(id);
        const sources = db.getSourcesForNode(id);
        json(res, 200, {
          ...node,
          embedding: undefined,
          edges: { from: edgesFrom, to: edgesTo },
          sources,
        });
        return;
      }

      // GET /api/nodes?keywords=...&limit=...&actor=...
      if (method === 'GET' && path === '/api/nodes') {
        const keywordsRaw = query.get('keywords') ?? '';
        const keywords = keywordsRaw
          ? keywordsRaw.split(',').map((k) => k.trim())
          : [];
        const limit = parseInt(query.get('limit') ?? '20', 10);
        const actor = query.get('actor') ?? undefined;
        const nodes = db.searchNodesByKeywords(keywords, limit, actor);
        json(
          res,
          200,
          nodes.map((n) => ({ ...n, embedding: undefined }))
        );
        return;
      }

      // POST /api/decisions
      if (method === 'POST' && path === '/api/decisions') {
        const body = (await parseJson(req)) as {
          content?: string;
          actor?: string;
          reasoning?: string;
        };
        if (!body.content) {
          json(res, 400, { error: 'content is required' });
          return;
        }
        const node = db.insertNode({
          type: 'decision',
          content: body.content,
          embedding: null,
          actor: body.actor ?? null,
          confidence: 0.75,
        });
        json(res, 201, { ...node, embedding: undefined });
        return;
      }

      // GET /api/contradictions
      if (method === 'GET' && path === '/api/contradictions') {
        const contradictions = db.getPendingContradictions();
        json(res, 200, contradictions);
        return;
      }

      json(res, 404, { error: 'Not found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      json(res, 500, { error: message });
    }
  });

  server.listen(config.port, () => {
    console.log(`Provenant API server listening on port ${config.port}`);
    console.log(`  Database: ${config.dbPath}`);
    console.log(`  Endpoints:`);
    console.log(`    GET  /api/status`);
    console.log(`    GET  /api/nodes?keywords=...&limit=...&actor=...`);
    console.log(`    GET  /api/nodes/:id`);
    console.log(`    POST /api/decisions`);
    console.log(`    GET  /api/contradictions`);
  });

  process.on('SIGINT', () => {
    db.close();
    server.close();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    db.close();
    server.close();
    process.exit(0);
  });
}
