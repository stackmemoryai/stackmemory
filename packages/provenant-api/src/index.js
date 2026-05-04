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
        headers: corsHeaders(request),
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

  if (entities.length > 500) {
    return json({ error: 'Batch too large (max 500)' }, 400);
  }

  // Batch conflict check — single query instead of N+1
  const incomingIds = entities.map((e) => e.id);
  const incomingTables = entities.map((e) => e.table);
  const existingRows = await sql`
    SELECT id, table_name, version FROM sync_entities
    WHERE project_id = ${projectId}
      AND (id, table_name) IN (
        SELECT UNNEST(${incomingIds}::text[]), UNNEST(${incomingTables}::text[])
      )
  `;

  const existingMap = new Map();
  for (const row of existingRows) {
    existingMap.set(`${row.table_name}:${row.id}`, Number(row.version));
  }

  // Separate conflicts from upsertable entities
  const conflicts = [];
  const toUpsert = [];

  for (const entity of entities) {
    const key = `${entity.table}:${entity.id}`;
    const serverVersion = existingMap.get(key);
    if (serverVersion !== undefined && serverVersion > entity.version) {
      conflicts.push({
        id: entity.id,
        table: entity.table,
        serverVersion,
        clientVersion: entity.version,
      });
    } else {
      toUpsert.push(entity);
    }
  }

  // Batch upsert — single query
  const rejected = [];
  let accepted = 0;

  if (toUpsert.length > 0) {
    try {
      const ids = toUpsert.map((e) => e.id);
      const tableNames = toUpsert.map((e) => e.table);
      const versions = toUpsert.map((e) => e.version);
      const tiers = toUpsert.map((e) => e.tier);
      const dataArr = toUpsert.map((e) => JSON.stringify(e.data));
      const clientIds = toUpsert.map(() => clientId);
      const projectIds = toUpsert.map(() => projectId);

      await sql`
        INSERT INTO sync_entities (id, project_id, table_name, version, tier, data, client_id)
        SELECT * FROM UNNEST(
          ${ids}::text[],
          ${projectIds}::text[],
          ${tableNames}::text[],
          ${versions}::bigint[],
          ${tiers}::text[],
          ${dataArr}::jsonb[],
          ${clientIds}::text[]
        )
        ON CONFLICT (project_id, table_name, id)
        DO UPDATE SET
          version = EXCLUDED.version,
          tier = EXCLUDED.tier,
          data = EXCLUDED.data,
          client_id = EXCLUDED.client_id,
          pushed_at = NOW()
      `;
      accepted = toUpsert.length;
    } catch (err) {
      // If batch fails, report all as rejected
      for (const entity of toUpsert) {
        rejected.push({ id: entity.id, reason: String(err) });
      }
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
      SELECT id, table_name, version, tier, data, pushed_at
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
      SELECT id, table_name, version, tier, data, pushed_at
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

  // Server cursor = pushed_at of last returned row (not approximate)
  const lastRow =
    rows.length > 0 ? rows[Math.min(rows.length, limit) - 1] : null;
  const serverCursor = lastRow?.pushed_at
    ? new Date(lastRow.pushed_at).toISOString()
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

function json(data, status = 200, request = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(request),
    },
  });
}

const ALLOWED_ORIGINS = [
  'https://app.stackmemory.ai',
  'https://stackmemory.ai',
  'http://localhost:3456',
];

function corsHeaders(request) {
  const origin = request?.headers?.get('Origin');
  return {
    'Access-Control-Allow-Origin':
      origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Id',
  };
}
