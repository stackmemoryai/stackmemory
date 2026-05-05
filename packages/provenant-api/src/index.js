/**
 * Provenant Sync API — Cloudflare Worker
 *
 * Endpoints:
 *   POST /v1/setup             — Bootstrap workspace + first API key (no auth)
 *   POST /v1/workspaces/:id/keys    — Create API key (auth required)
 *   GET  /v1/workspaces/:id         — Get workspace details (auth required)
 *   POST /v1/workspaces/:id/members — Invite member (auth, owner/admin)
 *   POST /v1/sync/push         — Accept entities from local clients
 *   POST /v1/sync/pull         — Return entities since cursor
 *   GET  /v1/sync/status        — Server-side sync status
 *   GET  /health                — Health check
 */

import { neon } from '@neondatabase/serverless';
import { createHash, randomBytes } from 'node:crypto';
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
      return json({ status: 'ok', version: '0.2.0' }, 200, request);
    }

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request),
      });
    }

    const sql = neon(env.DATABASE_URL);

    try {
      // Setup — no auth required (bootstrap flow)
      if (path === '/v1/setup' && request.method === 'POST') {
        return await handleSetup(request, sql);
      }

      // All other endpoints require auth
      const authResult = await authenticate(
        request,
        env,
        sql,
        corsHeaders(request)
      );
      if (authResult instanceof Response) return authResult;

      const { projectId, workspaceId, email } = authResult;
      const clientId = request.headers.get('X-Client-Id') || 'unknown';

      // Workspace routes (path pattern matching)
      const workspaceKeysMatch = path.match(
        /^\/v1\/workspaces\/([^/]+)\/keys$/
      );
      const workspaceMembersMatch = path.match(
        /^\/v1\/workspaces\/([^/]+)\/members$/
      );
      const workspaceDetailMatch = path.match(/^\/v1\/workspaces\/([^/]+)$/);

      if (workspaceKeysMatch && request.method === 'POST') {
        return await handleCreateKey(
          request,
          sql,
          workspaceKeysMatch[1],
          email
        );
      }
      if (workspaceMembersMatch && request.method === 'POST') {
        return await handleInviteMember(
          request,
          sql,
          workspaceMembersMatch[1],
          email
        );
      }
      if (workspaceDetailMatch && request.method === 'GET') {
        return await handleGetWorkspace(
          request,
          sql,
          workspaceDetailMatch[1],
          email
        );
      }

      // Sync routes
      switch (`${request.method} ${path}`) {
        case 'POST /v1/sync/push':
          return await handlePush(request, sql, projectId, clientId);
        case 'POST /v1/sync/pull':
          return await handlePull(request, sql, projectId, clientId);
        case 'GET /v1/sync/status':
          return await handleStatus(request, sql, projectId, clientId);
        default:
          return json({ error: 'Not found' }, 404, request);
      }
    } catch (err) {
      console.error('API error:', err);
      return json({ error: 'Internal server error' }, 500, request);
    }
  },
};

// =============================================
// Workspace + Key Provisioning
// =============================================

/**
 * POST /v1/setup
 * Bootstrap: create workspace, default project, first API key.
 * No auth required — this is the signup entry point.
 * Returns the raw API key (only time it's visible).
 */
async function handleSetup(request, sql) {
  const body = await request.json();
  const { email, workspaceName } = body;

  if (!email || !workspaceName) {
    return json(
      { error: 'email and workspaceName are required' },
      400,
      request
    );
  }

  // Idempotent: if workspace already exists for this email, return existing
  const existing = await sql`
    SELECT w.id as workspace_id, p.id as project_id
    FROM workspaces w
    JOIN projects p ON p.workspace_id = w.id
    WHERE w.owner_email = ${email}
    LIMIT 1
  `;

  if (existing.length > 0) {
    return json(
      {
        error:
          'Workspace already exists for this email. Use your existing API key.',
        workspaceId: existing[0].workspace_id,
        projectId: existing[0].project_id,
      },
      409,
      request
    );
  }

  // Generate slug from workspace name
  const slug = workspaceName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  // Check slug uniqueness
  const slugCheck = await sql`
    SELECT id FROM workspaces WHERE slug = ${slug}
  `;
  if (slugCheck.length > 0) {
    return json(
      { error: `Workspace slug "${slug}" is taken. Choose another name.` },
      409,
      request
    );
  }

  // Create workspace
  const wsRows = await sql`
    INSERT INTO workspaces (name, slug, owner_email)
    VALUES (${workspaceName}, ${slug}, ${email})
    RETURNING id
  `;
  const workspaceId = wsRows[0].id;

  // Add owner as member
  await sql`
    INSERT INTO workspace_members (workspace_id, email, role)
    VALUES (${workspaceId}, ${email}, 'owner')
  `;

  // Create default project
  const projRows = await sql`
    INSERT INTO projects (workspace_id, name)
    VALUES (${workspaceId}, 'Default')
    RETURNING id
  `;
  const projectId = projRows[0].id;

  // Generate API key: smk_<32 random hex>
  const rawKey = `smk_${randomBytes(32).toString('hex')}`;
  const keyHash = createHash('sha256').update(rawKey).digest('hex');

  await sql`
    INSERT INTO api_keys (key_hash, user_email, project_id, workspace_id, name)
    VALUES (${keyHash}, ${email}, ${projectId}, ${workspaceId}, 'default')
  `;

  return json(
    {
      workspaceId,
      projectId,
      apiKey: rawKey,
      message: 'Save this API key — it will not be shown again.',
    },
    201,
    request
  );
}

/**
 * POST /v1/workspaces/:id/keys
 * Create a new API key for the workspace.
 */
async function handleCreateKey(request, sql, workspaceId, callerEmail) {
  // Verify membership
  const member = await sql`
    SELECT role FROM workspace_members
    WHERE workspace_id = ${workspaceId} AND email = ${callerEmail}
  `;
  if (member.length === 0) {
    return json({ error: 'Not a member of this workspace' }, 403, request);
  }

  const body = await request.json();
  const keyName = body.name || 'unnamed';
  const projectId = body.projectId;

  if (!projectId) {
    return json({ error: 'projectId is required' }, 400, request);
  }

  // Verify project belongs to workspace
  const proj = await sql`
    SELECT id FROM projects
    WHERE id = ${projectId} AND workspace_id = ${workspaceId}
  `;
  if (proj.length === 0) {
    return json({ error: 'Project not found in this workspace' }, 404, request);
  }

  const rawKey = `smk_${randomBytes(32).toString('hex')}`;
  const keyHash = createHash('sha256').update(rawKey).digest('hex');

  await sql`
    INSERT INTO api_keys (key_hash, user_email, project_id, workspace_id, name)
    VALUES (${keyHash}, ${callerEmail}, ${projectId}, ${workspaceId}, ${keyName})
  `;

  return json(
    {
      apiKey: rawKey,
      projectId,
      name: keyName,
      message: 'Save this API key — it will not be shown again.',
    },
    201,
    request
  );
}

/**
 * GET /v1/workspaces/:id
 * Get workspace details + members + projects.
 */
async function handleGetWorkspace(request, sql, workspaceId, callerEmail) {
  // Verify membership
  const member = await sql`
    SELECT role FROM workspace_members
    WHERE workspace_id = ${workspaceId} AND email = ${callerEmail}
  `;
  if (member.length === 0) {
    return json({ error: 'Not a member of this workspace' }, 403, request);
  }

  const ws = await sql`
    SELECT id, name, slug, owner_email, plan, seat_limit, created_at
    FROM workspaces WHERE id = ${workspaceId}
  `;
  if (ws.length === 0) {
    return json({ error: 'Workspace not found' }, 404, request);
  }

  const members = await sql`
    SELECT email, role, joined_at FROM workspace_members
    WHERE workspace_id = ${workspaceId}
    ORDER BY joined_at ASC
  `;

  const projects = await sql`
    SELECT id, name, created_at FROM projects
    WHERE workspace_id = ${workspaceId}
    ORDER BY created_at ASC
  `;

  const keys = await sql`
    SELECT id, name, project_id, created_at, last_used_at FROM api_keys
    WHERE workspace_id = ${workspaceId} AND revoked_at IS NULL
    ORDER BY created_at ASC
  `;

  return json(
    {
      ...ws[0],
      members,
      projects,
      keys,
    },
    200,
    request
  );
}

/**
 * POST /v1/workspaces/:id/members
 * Invite a member to the workspace. Requires owner or admin role.
 */
async function handleInviteMember(request, sql, workspaceId, callerEmail) {
  // Verify caller is owner or admin
  const caller = await sql`
    SELECT role FROM workspace_members
    WHERE workspace_id = ${workspaceId} AND email = ${callerEmail}
  `;
  if (caller.length === 0 || !['owner', 'admin'].includes(caller[0].role)) {
    return json(
      { error: 'Only owners and admins can invite members' },
      403,
      request
    );
  }

  const body = await request.json();
  const { email, role } = body;

  if (!email) {
    return json({ error: 'email is required' }, 400, request);
  }

  const memberRole = role || 'member';
  if (!['member', 'admin'].includes(memberRole)) {
    return json({ error: 'role must be "member" or "admin"' }, 400, request);
  }

  // Check seat limit
  const ws = await sql`
    SELECT seat_limit FROM workspaces WHERE id = ${workspaceId}
  `;
  const currentMembers = await sql`
    SELECT COUNT(*)::int as count FROM workspace_members
    WHERE workspace_id = ${workspaceId}
  `;
  if (currentMembers[0].count >= ws[0].seat_limit) {
    return json(
      { error: `Seat limit reached (${ws[0].seat_limit}). Upgrade your plan.` },
      403,
      request
    );
  }

  // Idempotent insert
  await sql`
    INSERT INTO workspace_members (workspace_id, email, role, invited_by)
    VALUES (${workspaceId}, ${email}, ${memberRole}, ${callerEmail})
    ON CONFLICT (workspace_id, email) DO UPDATE SET role = ${memberRole}
  `;

  return json({ email, role: memberRole, workspaceId }, 201, request);
}

// =============================================
// Sync
// =============================================

/**
 * POST /v1/sync/push
 * Accept entities from a local client, upsert into Neon.
 */
async function handlePush(request, sql, projectId, clientId) {
  const body = await request.json();

  if (body.protocolVersion !== 1) {
    return json({ error: 'Unsupported protocol version' }, 400, request);
  }

  const entities = body.entities || [];
  if (entities.length === 0) {
    return json(
      {
        accepted: 0,
        rejected: [],
        serverCursor: new Date().toISOString(),
      },
      200,
      request
    );
  }

  if (entities.length > 500) {
    return json({ error: 'Batch too large (max 500)' }, 400, request);
  }

  const uniqueEntities = dedupeEntities(entities);

  // Batch conflict check — single query instead of N+1
  const incomingIds = uniqueEntities.map((e) => e.id);
  const incomingTables = uniqueEntities.map((e) => e.table);
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

  for (const entity of uniqueEntities) {
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

  return json(
    {
      accepted,
      rejected,
      serverCursor,
      ...(conflicts.length > 0 ? { conflicts } : {}),
    },
    200,
    request
  );
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

  return json({ entities, serverCursor, hasMore }, 200, request);
}

/**
 * GET /v1/sync/status
 */
async function handleStatus(request, sql, projectId, clientId) {
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

  return json(
    {
      projectId,
      clientId,
      lastPushAt: pushCursor?.cursor_value || null,
      lastPullAt: pullCursor?.cursor_value || null,
      totalEntities: entityCount[0]?.count || 0,
    },
    200,
    request
  );
}

// --- Helpers ---

function dedupeEntities(entities) {
  const byKey = new Map();
  for (const entity of entities) {
    const key = `${entity.table}:${entity.id}`;
    const existing = byKey.get(key);
    if (!existing || Number(entity.version) >= Number(existing.version)) {
      byKey.set(key, entity);
    }
  }
  return [...byKey.values()];
}

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
