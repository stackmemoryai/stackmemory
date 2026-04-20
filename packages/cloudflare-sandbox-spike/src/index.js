import { getSandbox } from '@cloudflare/sandbox';

export { Sandbox } from '@cloudflare/sandbox';

function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers,
  });
}

function errorResponse(status, error, details) {
  return json(
    {
      ok: false,
      error,
      details: details || null,
    },
    { status }
  );
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function parseRoute(request) {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  return { url, parts };
}

function normalizeSandboxId(value) {
  const id = String(value || '')
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9][a-z0-9-_]{1,63}$/.test(id)) {
    throw new Error(
      'sandbox id must be 2-64 chars of lowercase letters, numbers, dashes, or underscores'
    );
  }
  return id;
}

function normalizeMountPrefix(projectId, prefix) {
  if (prefix && typeof prefix === 'string') {
    let value = prefix.trim();
    if (!value.startsWith('/')) value = `/${value}`;
    if (!value.endsWith('/')) value = `${value}/`;
    return value;
  }
  return `/projects/${projectId}/`;
}

function requireEnv(env, keys) {
  const missing = keys.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`missing env vars: ${missing.join(', ')}`);
  }
}

async function mountProjectBucket(sandbox, env, projectId, options = {}) {
  const mountPath = options.mountPath || '/persist';
  const prefix = normalizeMountPrefix(projectId, options.prefix);

  if (options.localBucket) {
    await sandbox.mountBucket('PROJECT_DATA', mountPath, {
      localBucket: true,
      prefix,
    });
    return { mountPath, prefix, mode: 'localBucket' };
  }

  requireEnv(env, [
    'R2_ENDPOINT',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'PROJECT_DATA_BUCKET_NAME',
  ]);

  await sandbox.mountBucket(env.PROJECT_DATA_BUCKET_NAME, mountPath, {
    endpoint: env.R2_ENDPOINT,
    provider: 'r2',
    prefix,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  });

  return { mountPath, prefix, mode: 'remoteR2' };
}

async function handleBootstrap(env, sandboxId, request) {
  const body = await readJson(request);
  const sandbox = getSandbox(env.Sandbox, sandboxId);
  const result = {
    ok: true,
    sandboxId,
    steps: [],
  };

  if (body.mountProjectData) {
    const mount = await mountProjectBucket(sandbox, env, sandboxId, {
      localBucket: Boolean(body.localBucket),
      mountPath: body.mountPath,
      prefix: body.prefix,
    });
    result.steps.push({ type: 'mountBucket', ...mount });
  }

  if (body.repoUrl) {
    const checkoutOptions = {
      targetDir: body.targetDir || '/workspace/repo',
    };
    if (body.branch) checkoutOptions.branch = body.branch;
    if (body.depth) checkoutOptions.depth = body.depth;
    await sandbox.gitCheckout(body.repoUrl, checkoutOptions);
    result.steps.push({
      type: 'gitCheckout',
      repoUrl: body.repoUrl,
      targetDir: checkoutOptions.targetDir,
      branch: checkoutOptions.branch || 'default',
      depth: checkoutOptions.depth || null,
    });
  }

  await sandbox.writeFile(
    '/workspace/.stackmemory-cloudflare-spike.json',
    JSON.stringify(
      {
        sandboxId,
        bootstrappedAt: new Date().toISOString(),
        mounted: Boolean(body.mountProjectData),
        repoUrl: body.repoUrl || null,
      },
      null,
      2
    )
  );
  result.steps.push({
    type: 'writeFile',
    path: '/workspace/.stackmemory-cloudflare-spike.json',
  });

  return json(result);
}

async function handleExec(env, sandboxId, request) {
  const body = await readJson(request);
  if (!body.command) {
    return errorResponse(400, 'missing_command');
  }
  const sandbox = getSandbox(env.Sandbox, sandboxId);
  const execOptions = {};
  if (body.cwd) execOptions.cwd = body.cwd;
  if (Array.isArray(body.args)) execOptions.args = body.args;
  if (body.timeoutMs) execOptions.timeout = body.timeoutMs;
  if (body.sessionId) execOptions.sessionId = body.sessionId;

  const result = await sandbox.exec(body.command, execOptions);
  return json({
    ok: true,
    sandboxId,
    sessionId: body.sessionId || null,
    result: {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      success: result.success,
    },
  });
}

async function handleFileRead(env, sandboxId, url) {
  const targetPath = url.searchParams.get('path');
  if (!targetPath) {
    return errorResponse(400, 'missing_path');
  }
  const sandbox = getSandbox(env.Sandbox, sandboxId);
  const file = await sandbox.readFile(targetPath);
  return json({
    ok: true,
    sandboxId,
    path: targetPath,
    file,
  });
}

async function handleFileWrite(env, sandboxId, request) {
  const { url } = parseRoute(request);
  const targetPath = url.searchParams.get('path');
  if (!targetPath) {
    return errorResponse(400, 'missing_path');
  }
  const sandbox = getSandbox(env.Sandbox, sandboxId);
  const content = await request.text();
  await sandbox.writeFile(targetPath, content);
  return json({
    ok: true,
    sandboxId,
    path: targetPath,
    bytes: Buffer.byteLength(content, 'utf8'),
  });
}

async function handleBackup(env, sandboxId, request) {
  const body = await readJson(request);
  const sandbox = getSandbox(env.Sandbox, sandboxId);
  const backup = await sandbox.createBackup({
    dir: body.dir || '/workspace',
    name: body.name,
    ttl: body.ttl,
    useGitignore: Boolean(body.useGitignore),
  });
  return json({
    ok: true,
    sandboxId,
    backup,
  });
}

async function handleRestore(env, sandboxId, request) {
  const body = await readJson(request);
  if (!body.backup) {
    return errorResponse(400, 'missing_backup');
  }
  const sandbox = getSandbox(env.Sandbox, sandboxId);
  await sandbox.restoreBackup(body.backup);
  return json({
    ok: true,
    sandboxId,
    restored: true,
  });
}

async function handleDestroy(env, sandboxId) {
  const sandbox = getSandbox(env.Sandbox, sandboxId);
  await sandbox.destroy();
  return json({
    ok: true,
    sandboxId,
    destroyed: true,
  });
}

async function handleMount(env, sandboxId, request) {
  const body = await readJson(request);
  const sandbox = getSandbox(env.Sandbox, sandboxId);
  const mount = await mountProjectBucket(sandbox, env, sandboxId, {
    localBucket: Boolean(body.localBucket),
    mountPath: body.mountPath,
    prefix: body.prefix,
  });
  return json({
    ok: true,
    sandboxId,
    mount,
  });
}

async function handleLs(env, sandboxId, url) {
  const targetPath = url.searchParams.get('path') || '/workspace';
  const sandbox = getSandbox(env.Sandbox, sandboxId);
  const result = await sandbox.exec('ls', {
    args: ['-la', targetPath],
  });
  return json({
    ok: true,
    sandboxId,
    path: targetPath,
    result,
  });
}

export default {
  async fetch(request, env) {
    try {
      const { url, parts } = parseRoute(request);

      if (request.method === 'GET' && url.pathname === '/health') {
        return json({
          ok: true,
          service: 'stackmemory-cloudflare-sandbox-spike',
          bindings: {
            sandbox: Boolean(env.Sandbox),
            projectData: Boolean(env.PROJECT_DATA),
            backupBucket: Boolean(env.BACKUP_BUCKET),
          },
        });
      }

      if (parts[0] !== 'v1' || parts[1] !== 'sandboxes' || !parts[2]) {
        return errorResponse(404, 'not_found');
      }

      const sandboxId = normalizeSandboxId(parts[2]);
      const route = parts[3] || '';

      if (
        route === 'terminal' &&
        request.headers.get('upgrade')?.toLowerCase() === 'websocket'
      ) {
        const sandbox = getSandbox(env.Sandbox, sandboxId);
        const sessionId = url.searchParams.get('session');
        if (sessionId) {
          const session = await sandbox.getSession(sessionId);
          return session.terminal(request);
        }
        return sandbox.terminal(request);
      }

      if (request.method === 'POST' && route === 'bootstrap') {
        return handleBootstrap(env, sandboxId, request);
      }

      if (request.method === 'POST' && route === 'exec') {
        return handleExec(env, sandboxId, request);
      }

      if (request.method === 'POST' && route === 'mount') {
        return handleMount(env, sandboxId, request);
      }

      if (request.method === 'GET' && route === 'ls') {
        return handleLs(env, sandboxId, url);
      }

      if (request.method === 'GET' && route === 'files') {
        return handleFileRead(env, sandboxId, url);
      }

      if (request.method === 'PUT' && route === 'files') {
        return handleFileWrite(env, sandboxId, request);
      }

      if (request.method === 'POST' && route === 'backup') {
        return handleBackup(env, sandboxId, request);
      }

      if (request.method === 'POST' && route === 'restore') {
        return handleRestore(env, sandboxId, request);
      }

      if (request.method === 'POST' && route === 'destroy') {
        return handleDestroy(env, sandboxId);
      }

      return errorResponse(404, 'not_found');
    } catch (error) {
      return errorResponse(
        500,
        'sandbox_spike_error',
        error instanceof Error ? error.message : String(error)
      );
    }
  },
};
