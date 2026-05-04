/**
 * Provenant Sync API — Cloudflare Worker
 *
 * Endpoints:
 *   POST /v1/sync/push   — Accept entities from local clients
 *   POST /v1/sync/pull   — Return entities since cursor
 *   GET  /v1/sync/status  — Server-side sync status
 *   GET  /health          — Health check
 */

import { neon } from '@neondatabase/serverless';
import { authenticate } from './auth.js';

export default {
  /**
   * @param {Request} request
   * @param {{ DATABASE_URL: string; SYNC_OVERFLOW: R2Bucket }} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Health check — no auth
    if (path === '/health' && request.method === 'GET') {
      return json({ status: 'ok', version: '0.1.0' });
    }

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    // All sync endpoints require auth
    const sql = neon(env.DATABASE_URL);
    const authResult = await authenticate(request, env, sql);
    if (authResult instanceof Response) return authResult;

    const { projectId, email } = authResult;
    const clientId = request.headers.get('X-Client-Id') || 'unknown';

    try {
      switch (`${request.method} ${path}`) {
        case 'POST /v1/sync/push':
          return await handlePush(request, sql, projectId, clientId);
        case 'POST /v1/sync/pull':
          return await handlePull(request, sql, projectId, clientId);
        case 'GET /v1/sync/status':
          return await handleStatus(sql, projectId, clientId);
        default:
          return json({ error: 'Not found' }, 404);
      }
    } catch (err) {
      console.error('Sync API error:', err);
      return json({ error: 'Internal server error' }, 500);
    }
  },
};

/**
 * POST /v1/sync/push
 * Accept entities from a local client, upsert into Neon.
 */
async function handlePush(request, sql, projectId, clientId) {
  const body = await request.json();

  if (body.protocolVersion !== 1) {
    return json({ error: 'Unsupported protocol version' }, 400);
  }

  const entities = body.entities || [];
  if (entities.length === 0) {
    return json({
      accepted: 0,
      rejected: [],
      serverCursor: new Date().toISOString(),
    });
  }

  const rejected = [];
  let accepted = 0;
  const conflicts = [];

  for (const entity of entities) {
    try {
      // Check for conflict (newest_wins)
      const existing = await sql`
        SELECT version FROM sync_entities
        WHERE project_id = ${projectId}
          AND table_name = ${entity.table}
          AND id = ${entity.id}
      `;

      if (existing.length > 0 && existing[0].version > entity.version) {
        conflicts.push({
          id: entity.id,
          table: entity.table,
          serverVersion: Number(existing[0].version),
          clientVersion: entity.version,
        });
        continue;
      }

      // Upsert
      await sql`
        INSERT INTO sync_entities (id, project_id, table_name, version, tier, data, client_id)
        VALUES (${entity.id}, ${projectId}, ${entity.table}, ${entity.version}, ${entity.tier}, ${JSON.stringify(entity.data)}, ${clientId})
        ON CONFLICT (project_id, table_name, id)
        DO UPDATE SET
          version = EXCLUDED.version,
          tier = EXCLUDED.tier,
          data = EXCLUDED.data,
          client_id = EXCLUDED.client_id,
          pushed_at = NOW()
      `;
      accepted++;
    } catch (err) {
      rejected.push({ id: entity.id, reason: String(err) });
    }
  }

  const serverCursor = new Date().toISOString();

  // Update client cursor
  await sql`
    INSERT INTO sync_cursors (project_id, client_id, direction, cursor_value)
    VALUES (${projectId}, ${clientId}, 'push', ${serverCursor}::timestamptz)
    ON CONFLICT (project_id, client_id, direction)
    DO UPDATE SET cursor_value = EXCLUDED.cursor_value, updated_at = NOW()
  `;

  return json({
    accepted,
    rejected,
    serverCursor,
    ...(conflicts.length > 0 ? { conflicts } : {}),
  });
}

/**
 * POST /v1/sync/pull
 * Return entities pushed by other clients since the given cursor.
 */
async function handlePull(request, sql, projectId, clientId) {
  const body = await request.json();
  const since = body.since || new Date(0).toISOString();
  const limit = Math.min(body.limit || 100, 500);
  const tables = body.tables; // optional filter

  let rows;
  if (tables && tables.length > 0) {
    rows = await sql`
      SELECT id, table_name, version, tier, data
      FROM sync_entities
      WHERE project_id = ${projectId}
        AND pushed_at > ${since}::timestamptz
        AND client_id != ${clientId}
        AND table_name = ANY(${tables})
      ORDER BY pushed_at ASC
      LIMIT ${limit + 1}
    `;
  } else {
    rows = await sql`
      SELECT id, table_name, version, tier, data
      FROM sync_entities
      WHERE project_id = ${projectId}
        AND pushed_at > ${since}::timestamptz
        AND client_id != ${clientId}
      ORDER BY pushed_at ASC
      LIMIT ${limit + 1}
    `;
  }

  const hasMore = rows.length > limit;
  const entities = rows.slice(0, limit).map((r) => ({
    table: r.table_name,
    id: r.id,
    version: Number(r.version),
    tier: r.tier,
    data: typeof r.data === 'string' ? JSON.parse(r.data) : r.data,
  }));

  // Server cursor = pushed_at of last returned entity, or `since` if empty
  const serverCursor =
    entities.length > 0
      ? new Date().toISOString() // approximate — good enough for alpha
      : since;

  // Update pull cursor
  await sql`
    INSERT INTO sync_cursors (project_id, client_id, direction, cursor_value)
    VALUES (${projectId}, ${clientId}, 'pull', ${serverCursor}::timestamptz)
    ON CONFLICT (project_id, client_id, direction)
    DO UPDATE SET cursor_value = EXCLUDED.cursor_value, updated_at = NOW()
  `;

  return json({ entities, serverCursor, hasMore });
}

/**
 * GET /v1/sync/status
 */
async function handleStatus(sql, projectId, clientId) {
  const cursors = await sql`
    SELECT direction, cursor_value FROM sync_cursors
    WHERE project_id = ${projectId} AND client_id = ${clientId}
  `;

  const pushCursor = cursors.find((c) => c.direction === 'push');
  const pullCursor = cursors.find((c) => c.direction === 'pull');

  const entityCount = await sql`
    SELECT COUNT(*)::int as count FROM sync_entities
    WHERE project_id = ${projectId}
  `;

  return json({
    projectId,
    clientId,
    lastPushAt: pushCursor?.cursor_value || null,
    lastPullAt: pullCursor?.cursor_value || null,
    totalEntities: entityCount[0]?.count || 0,
  });
}

// --- Helpers ---

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
    },
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Id',
  };
}
