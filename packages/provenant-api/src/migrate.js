/**
 * Provenant API — Neon Postgres Schema Migration
 * Run: node src/migrate.js
 * Requires DATABASE_URL in .dev.vars or environment
 */

import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'fs';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  (() => {
    try {
      const vars = readFileSync('.dev.vars', 'utf8');
      const match = vars.match(/DATABASE_URL=(.+)/);
      return match?.[1]?.trim();
    } catch {
      return undefined;
    }
  })();

if (!DATABASE_URL) {
  console.error('DATABASE_URL not set. Copy .dev.vars.example to .dev.vars');
  process.exit(1);
}

const sql = neon(DATABASE_URL);

const MIGRATIONS = [
  {
    version: 1,
    name: 'initial_schema',
    up: [
      `CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        key_hash TEXT NOT NULL UNIQUE,
        user_email TEXT NOT NULL,
        project_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ
      )`,
      `CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)`,
      `CREATE TABLE IF NOT EXISTS sync_entities (
        id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        table_name TEXT NOT NULL,
        version BIGINT NOT NULL,
        tier TEXT NOT NULL DEFAULT 'young',
        data JSONB NOT NULL,
        client_id TEXT NOT NULL,
        pushed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (project_id, table_name, id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_sync_entities_pushed
        ON sync_entities(project_id, pushed_at)`,
      `CREATE INDEX IF NOT EXISTS idx_sync_entities_table
        ON sync_entities(project_id, table_name, pushed_at)`,
      `CREATE TABLE IF NOT EXISTS sync_cursors (
        project_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        cursor_value TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (project_id, client_id, direction)
      )`,
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    ],
  },
  {
    version: 2,
    name: 'workspaces_and_members',
    up: [
      // Workspaces — a team/org that owns projects
      `CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        owner_email TEXT NOT NULL,
        plan TEXT NOT NULL DEFAULT 'free',
        seat_limit INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_slug ON workspaces(slug)`,

      // Workspace members
      `CREATE TABLE IF NOT EXISTS workspace_members (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        invited_by TEXT,
        joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, email)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_workspace_members_email ON workspace_members(email)`,

      // Projects belong to a workspace
      `CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id)`,

      // Link api_keys to workspace
      `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS workspace_id TEXT`,
      `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS name TEXT DEFAULT 'default'`,

      // Link sync_entities to workspace
      `ALTER TABLE sync_entities ADD COLUMN IF NOT EXISTS workspace_id TEXT`,
    ],
  },
];

async function migrate() {
  console.log('Running migrations...');

  // Ensure migrations table exists
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  const applied =
    await sql`SELECT version FROM schema_migrations ORDER BY version`;
  const appliedVersions = new Set(applied.map((r) => r.version));

  for (const migration of MIGRATIONS) {
    if (appliedVersions.has(migration.version)) {
      console.log(
        `  v${migration.version} (${migration.name}) — already applied`
      );
      continue;
    }

    console.log(`  v${migration.version} (${migration.name}) — applying...`);
    for (const statement of migration.up) {
      await sql.query(statement);
    }
    await sql`INSERT INTO schema_migrations (version, name) VALUES (${migration.version}, ${migration.name})`;
    console.log(`  v${migration.version} — done`);
  }

  console.log('Migrations complete.');
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
