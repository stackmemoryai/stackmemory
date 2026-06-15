import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { startServer } from '../../api/server.js';

interface ServeOpts {
  port: string;
  db: string;
}

export function serve(opts: ServeOpts): void {
  mkdirSync(dirname(opts.db), { recursive: true });
  const port = parseInt(opts.port, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${opts.port}`);
    process.exit(1);
  }
  startServer({ port, dbPath: opts.db, apiKey: process.env['PROVENANT_API_KEY'] });
}
