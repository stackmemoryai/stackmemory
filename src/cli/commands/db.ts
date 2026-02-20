import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { homedir } from 'os';
import { join } from 'path';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from 'fs';
import { Pool } from 'pg';

interface ConfigShape {
  version?: string;
  setupCompleted?: string;
  features?: any;
  paths?: any;
  database?: { mode?: 'local' | 'hosted'; url?: string };
}

function loadConfig(): { cfgDir: string; cfgPath: string; cfg: ConfigShape } {
  const cfgDir = join(homedir(), '.stackmemory');
  if (!existsSync(cfgDir)) mkdirSync(cfgDir, { recursive: true });
  const cfgPath = join(cfgDir, 'config.json');
  let cfg: ConfigShape = {};
  try {
    if (existsSync(cfgPath)) cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
  } catch {}
  return { cfgDir, cfgPath, cfg };
}

async function testPostgres(url: string): Promise<boolean> {
  try {
    const pool = new Pool({ connectionString: url });
    const r = await pool.query('SELECT 1');
    await pool.end();
    return !!r;
  } catch {
    return false;
  }
}

export function registerLogoutCommand(program: Command): void {
  program
    .command('logout')
    .description('Log out from hosted database (switch back to local)')
    .action(async () => {
      const { cfgDir, cfgPath, cfg } = loadConfig();
      cfg.database = { mode: 'local' };
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      const envPath = join(cfgDir, 'railway.env');
      try {
        if (existsSync(envPath)) unlinkSync(envPath);
      } catch {}
      console.log(
        chalk.green(
          '✓ Switched to local storage and cleared hosted credentials.'
        )
      );
      console.log(
        chalk.gray('Start the server without DATABASE_URL to use local SQLite.')
      );
    });
}

export function registerDbCommands(program: Command): void {
  const db = program.command('db').description('Database operations');

  db.command('switch')
    .description('Switch between local and hosted database')
    .option('--mode <local|hosted>', 'Target mode (local or hosted)')
    .action(async (opts) => {
      const { cfgDir, cfgPath, cfg } = loadConfig();
      let mode: 'local' | 'hosted' = opts.mode;
      if (!mode || (mode !== 'local' && mode !== 'hosted')) {
        const ans = await inquirer.prompt([
          {
            type: 'list',
            name: 'mode',
            message: 'Select database mode:',
            choices: [
              { name: 'Local (SQLite, free)', value: 'local' },
              { name: 'Hosted (Postgres, paid)', value: 'hosted' },
            ],
            default: cfg.database?.mode || 'local',
          },
        ]);
        mode = ans.mode;
      }

      if (mode === 'local') {
        cfg.database = { mode: 'local' };
        writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
        const envPath = join(cfgDir, 'railway.env');
        try {
          if (existsSync(envPath)) unlinkSync(envPath);
        } catch {}
        console.log(chalk.green('✓ Switched to local storage.'));
        return;
      }

      // Hosted flow
      const { openSignup } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'openSignup',
          message: 'Open hosted signup/login page?',
          default: false,
        },
      ]);
      if (openSignup) {
        try {
          const mod = await import('open');
          await mod.default('https://stackmemory.ai/hosted');
        } catch {}
      }
      const { url } = await inquirer.prompt([
        {
          type: 'password',
          name: 'url',
          message: 'Paste your hosted DATABASE_URL (postgres://...)',
          validate: (input: string) =>
            input.startsWith('postgres://') || input.startsWith('postgresql://')
              ? true
              : 'Must start with postgres:// or postgresql://',
        },
      ]);
      process.stdout.write('Testing connection... ');
      const ok = await testPostgres(url);
      if (!ok) {
        console.log(chalk.red('failed'));
        console.log(
          chalk.red('✗ Could not connect to Postgres with provided URL.')
        );
        return;
      }
      console.log(chalk.green('ok'));

      cfg.database = { mode: 'hosted', url };
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      const envFile = join(cfgDir, 'railway.env');
      writeFileSync(envFile, `# StackMemory hosted DB\nDATABASE_URL=${url}\n`);
      console.log(chalk.green('✓ Switched to hosted database.'));
      console.log(
        chalk.gray('Tip: export DATABASE_URL before starting the server.')
      );
    });

  db.command('status')
    .description('Show current database mode and connection status')
    .action(async () => {
      const { cfgDir, cfg } = loadConfig();
      const mode = cfg.database?.mode || 'local';
      console.log(`Mode: ${mode}`);

      if (mode === 'hosted') {
        const url = process.env.DATABASE_URL || cfg.database?.url || '';
        if (!url) {
          console.log(
            chalk.yellow(
              'DATABASE_URL not set and not found in config. Run "stackmemory login".'
            )
          );
          return;
        }
        const masked = maskDsn(url);
        process.stdout.write(`Hosted DSN: ${masked}  → testing... `);
        const ok = await testPostgres(url);
        console.log(ok ? chalk.green('ok') : chalk.red('failed'));
      } else {
        const sqlitePath = join(cfgDir, 'railway.db');
        const exists = existsSync(sqlitePath);
        console.log(
          `Local SQLite path: ${sqlitePath} (${exists ? 'exists' : 'will be created at first run'})`
        );
      }
    });
}

function maskDsn(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    if (u.username) u.username = '***';
    return u.toString();
  } catch {
    return url.replace(/:\\?[^@]*@/, ':***@');
  }
}
