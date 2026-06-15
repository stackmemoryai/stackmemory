import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { Database } from '../schema/database.js';

interface ServerConfig {
  port: number;
  dbPath: string;
  apiKey?: string; // if set, required for mutation endpoints and webhooks
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

function getAuthHeader(req: IncomingMessage): string | undefined {
  const auth = req.headers['authorization'] ?? '';
  if (typeof auth !== 'string') return undefined;
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  return auth.trim() || undefined;
}

function requireAuth(
  req: IncomingMessage,
  res: ServerResponse,
  apiKey: string | undefined
): boolean {
  if (!apiKey) return true; // auth disabled
  const provided = getAuthHeader(req);
  if (!provided || provided !== apiKey) {
    json(res, 401, { error: 'Unauthorized' });
    return false;
  }
  return true;
}

export function startServer(config: ServerConfig): Server {
  const db = new Database(config.dbPath);
  const authEnabled = !!config.apiKey;

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
        if (!requireAuth(req, res, config.apiKey)) return;

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

      // POST /api/webhook/decision
      // External systems (e.g. a coding harness) can push decisions in real time.
      if (method === 'POST' && path === '/api/webhook/decision') {
        if (!requireAuth(req, res, config.apiKey)) return;

        const body = (await parseJson(req)) as {
          content?: string;
          actor?: string;
          source?: string;
          source_id?: string;
          confidence?: number;
          metadata?: Record<string, unknown>;
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
          confidence: body.confidence ?? 0.75,
        });

        // Optionally link to an external source for provenance.
        if (body.source && body.source_id) {
          const source = db.insertSource({
            system: body.source,
            external_id: body.source_id,
            raw_payload: JSON.stringify(body.metadata ?? {}),
            hash: body.source_id,
          });
          db.linkNodeToSource(
            node.id,
            source.id,
            body.source,
            body.source_id
          );
        }

        json(res, 201, {
          ...node,
          embedding: undefined,
          sourceLinked: !!(body.source && body.source_id),
        });
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
    console.log(`  Auth: ${authEnabled ? 'enabled (PROVENANT_API_KEY set)' : 'disabled'}`);
    console.log(`  Endpoints:`);
    console.log(`    GET  /api/status`);
    console.log(`    GET  /api/nodes?keywords=...&limit=...&actor=...`);
    console.log(`    GET  /api/nodes/:id`);
    console.log(`    POST /api/decisions          ${authEnabled ? '(auth required)' : ''}`);
    console.log(`    POST /api/webhook/decision   ${authEnabled ? '(auth required)' : ''}`);
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

  return server;
}
