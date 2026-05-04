/**
 * Auth middleware — API key validation
 * Reads Bearer token, hashes it, looks up in api_keys table.
 */

import { createHash } from 'node:crypto';

/**
 * @param {Request} request
 * @param {{ DATABASE_URL: string }} env
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 * @returns {Promise<{ projectId: string; email: string } | Response>}
 */
export async function authenticate(request, env, sql) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response(
      JSON.stringify({ error: 'Missing Authorization header' }),
      {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  const token = authHeader.slice(7);
  const keyHash = createHash('sha256').update(token).digest('hex');

  const rows = await sql`
    SELECT id, user_email, project_id FROM api_keys
    WHERE key_hash = ${keyHash}
      AND revoked_at IS NULL
  `;

  if (rows.length === 0) {
    return new Response(JSON.stringify({ error: 'Invalid API key' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const key = rows[0];

  // Update last_used_at (fire-and-forget)
  sql`UPDATE api_keys SET last_used_at = NOW() WHERE id = ${key.id}`.catch(
    () => {}
  );

  return { projectId: key.project_id, email: key.user_email };
}
