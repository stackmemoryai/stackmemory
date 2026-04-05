/**
 * Wiki CLI command.
 *
 * Manages the Karpathy-style LLM knowledge base that compiles
 * accumulated context into a persistent, interlinked wiki.
 *
 * Usage:
 *   stackmemory wiki create      # Generate wiki from all existing context
 *   stackmemory wiki update      # Incremental update from new context
 *   stackmemory wiki lint        # Health check the wiki
 *   stackmemory wiki search <q>  # Search wiki articles
 *   stackmemory wiki status      # Show wiki stats
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  WikiCompiler,
  type DigestRow,
  type EntityStateRow,
  type AnchorRow,
  type SessionDigest,
} from '../../core/wiki/wiki-compiler.js';
import {
  generateChronologicalDigest,
  type DigestPeriod,
} from '../../core/digest/chronological-digest.js';

/** Resolve wiki directory from Obsidian config or fallback */
function resolveWikiDir(): string | null {
  const configPath = join(process.cwd(), '.stackmemory', 'config.yaml');
  if (!existsSync(configPath)) return null;

  const content = readFileSync(configPath, 'utf-8');
  const vaultMatch = content.match(
    /obsidian:\s*\n\s+vaultPath:\s*["']?([^\n"']+)/
  );
  if (!vaultMatch) return null;

  const vaultPath = (vaultMatch[1] ?? '').trim();
  const subdirMatch = content.match(
    /obsidian:\s*\n(?:\s+\w+:.*\n)*\s+subdir:\s*["']?([^\n"']+)/
  );
  const subdir = subdirMatch?.[1]?.trim() || 'stackmemory';

  return join(vaultPath, subdir, 'wiki');
}

function getCompiler(wikiDirOverride?: string): WikiCompiler {
  const wikiDir = wikiDirOverride || resolveWikiDir();
  if (!wikiDir) {
    console.error(
      chalk.red(
        'Wiki not configured. Set obsidian.vaultPath in .stackmemory/config.yaml'
      )
    );
    console.error(chalk.gray('  Or pass --wiki-dir <path>'));
    process.exit(1);
  }
  return new WikiCompiler({ wikiDir });
}

async function openDb() {
  const dbPath = join(process.cwd(), '.stackmemory', 'context.db');
  if (!existsSync(dbPath)) {
    console.error(
      chalk.red('StackMemory not initialized. Run "stackmemory init" first.')
    );
    process.exit(1);
  }
  const { default: Database } = await import('better-sqlite3');
  return new Database(dbPath);
}

/** Query context from the database for wiki compilation */
function queryContext(
  db: import('better-sqlite3').Database,
  opts: { sinceEpoch?: number; limit?: number }
): {
  digests: DigestRow[];
  entities: EntityStateRow[];
  anchors: AnchorRow[];
} {
  const since = opts.sinceEpoch ?? 0;
  const limit = opts.limit ?? 10000;

  // Frames with digests
  const digests = db
    .prepare(
      `SELECT frame_id, name as frame_name, type as frame_type,
              digest_text, created_at, closed_at
       FROM frames
       WHERE state = 'closed' AND digest_text IS NOT NULL
         AND created_at >= ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(since, limit) as DigestRow[];

  // Entity states
  const entities = db
    .prepare(
      `SELECT entity_name, relation, value, context,
              source_frame_id, valid_from, superseded_at
       FROM entity_states
       WHERE valid_from >= ?
       ORDER BY valid_from DESC
       LIMIT ?`
    )
    .all(since, limit) as EntityStateRow[];

  // Anchors with frame names
  const anchors = db
    .prepare(
      `SELECT a.anchor_id, a.frame_id, f.name as frame_name,
              a.type, a.text, a.priority, a.created_at
       FROM anchors a
       JOIN frames f ON f.frame_id = a.frame_id
       WHERE a.created_at >= ?
       ORDER BY a.created_at DESC
       LIMIT ?`
    )
    .all(since, limit) as AnchorRow[];

  return { digests, entities, anchors };
}

export function createWikiCommand(): Command {
  const cmd = new Command('wiki').description(
    'LLM knowledge base — compile context into a persistent wiki'
  );

  // ── create ──
  cmd
    .command('create')
    .description('Generate wiki from all existing context')
    .option('--wiki-dir <path>', 'Override wiki directory')
    .option(
      '--period <period>',
      'Include session digest (today|yesterday|week)',
      'week'
    )
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const compiler = getCompiler(options.wikiDir);
      await compiler.initialize();
      const db = await openDb();

      // Query ALL context (no time filter)
      const ctx = queryContext(db, {});

      // Generate session digest
      let sessionDigest: SessionDigest | undefined;
      try {
        const projectId =
          (
            db
              .prepare(
                `SELECT project_id FROM frames ORDER BY created_at DESC LIMIT 1`
              )
              .get() as { project_id: string } | undefined
          )?.project_id || 'default';

        const content = generateChronologicalDigest(
          db,
          options.period as DigestPeriod,
          projectId
        );
        sessionDigest = {
          period: options.period,
          content,
          generatedAt: Date.now(),
        };
      } catch {
        // Session digest is optional
      }

      db.close();

      const result = await compiler.create({
        ...ctx,
        sessionDigest,
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(chalk.green('\nWiki created.'));
      console.log(chalk.gray(`  Digests compiled:  ${ctx.digests.length}`));
      console.log(chalk.gray(`  Entity states:     ${ctx.entities.length}`));
      console.log(chalk.gray(`  Anchors processed: ${ctx.anchors.length}`));
      console.log(chalk.gray(`  Articles created:  ${result.created.length}`));
      console.log(chalk.gray(`  Total articles:    ${result.totalArticles}`));
    });

  // ── update ──
  cmd
    .command('update')
    .description('Incrementally update wiki with new context')
    .option('--wiki-dir <path>', 'Override wiki directory')
    .option(
      '--since <date>',
      'Update from this date (ISO format, default: last compile)'
    )
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const compiler = getCompiler(options.wikiDir);
      await compiler.initialize();
      const db = await openDb();

      // Determine time window
      let sinceEpoch: number;
      if (options.since) {
        sinceEpoch = Math.floor(new Date(options.since).getTime() / 1000);
      } else {
        const lastCompile = compiler.getLastCompileTime();
        sinceEpoch = lastCompile ?? 0;
      }

      if (sinceEpoch === 0) {
        console.log(
          chalk.yellow(
            'No previous compile found. Running full create instead.'
          )
        );
        db.close();
        // Delegate to create
        cmd.commands
          .find((c) => c.name() === 'create')
          ?.parseAsync(['create', '--wiki-dir', compiler['config'].wikiDir], {
            from: 'user',
          });
        return;
      }

      const ctx = queryContext(db, { sinceEpoch });
      db.close();

      if (
        ctx.digests.length === 0 &&
        ctx.entities.length === 0 &&
        ctx.anchors.length === 0
      ) {
        console.log(chalk.yellow('No new context since last compile.'));
        return;
      }

      const result = await compiler.update(ctx);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(chalk.green('\nWiki updated.'));
      console.log(chalk.gray(`  New digests:       ${ctx.digests.length}`));
      console.log(chalk.gray(`  New entity states: ${ctx.entities.length}`));
      console.log(chalk.gray(`  New anchors:       ${ctx.anchors.length}`));
      console.log(chalk.gray(`  Articles created:  ${result.created.length}`));
      console.log(chalk.gray(`  Articles updated:  ${result.updated.length}`));
      console.log(chalk.gray(`  Total articles:    ${result.totalArticles}`));
    });

  // ── lint ──
  cmd
    .command('lint')
    .description('Health check the wiki for issues')
    .option('--wiki-dir <path>', 'Override wiki directory')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const compiler = getCompiler(options.wikiDir);
      await compiler.initialize();

      const result = await compiler.lint();

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(chalk.cyan('\nWiki Lint Report'));
      console.log(chalk.gray(`  Total articles: ${result.totalArticles}`));

      if (result.orphans.length > 0) {
        console.log(
          chalk.yellow(
            `\n  Orphan pages (no inbound links): ${result.orphans.length}`
          )
        );
        result.orphans
          .slice(0, 10)
          .forEach((o) => console.log(chalk.gray(`    - ${o}`)));
        if (result.orphans.length > 10) {
          console.log(
            chalk.gray(`    ...and ${result.orphans.length - 10} more`)
          );
        }
      }

      if (result.brokenLinks.length > 0) {
        console.log(
          chalk.red(`\n  Broken links: ${result.brokenLinks.length}`)
        );
        result.brokenLinks
          .slice(0, 10)
          .forEach((l) =>
            console.log(chalk.gray(`    - ${l.source} -> ${l.target}`))
          );
      }

      if (result.stale.length > 0) {
        console.log(
          chalk.yellow(`\n  Stale articles (>30 days): ${result.stale.length}`)
        );
        result.stale
          .slice(0, 10)
          .forEach((s) => console.log(chalk.gray(`    - ${s}`)));
      }

      if (
        result.orphans.length === 0 &&
        result.brokenLinks.length === 0 &&
        result.stale.length === 0
      ) {
        console.log(chalk.green('\n  No issues found.'));
      }
    });

  // ── search ──
  cmd
    .command('search <query>')
    .description('Search wiki articles by keyword')
    .option('--wiki-dir <path>', 'Override wiki directory')
    .option('-n, --limit <n>', 'Max results', '20')
    .option('--json', 'Output as JSON')
    .action(async (query: string, options) => {
      const compiler = getCompiler(options.wikiDir);
      await compiler.initialize();

      const results = compiler.search(query).slice(0, parseInt(options.limit));

      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }

      if (results.length === 0) {
        console.log(chalk.yellow(`No results for "${query}".`));
        return;
      }

      console.log(
        chalk.cyan(`\nSearch: "${query}" — ${results.length} results\n`)
      );
      for (const r of results) {
        console.log(`  ${chalk.white(r.title)}`);
        console.log(chalk.gray(`    ${r.path} (${r.matches} matches)`));
      }
    });

  // ── status ──
  cmd
    .command('status')
    .description('Show wiki statistics')
    .option('--wiki-dir <path>', 'Override wiki directory')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const compiler = getCompiler(options.wikiDir);
      await compiler.initialize();

      const status = compiler.getStatus();

      if (options.json) {
        console.log(JSON.stringify(status, null, 2));
        return;
      }

      console.log(chalk.cyan('\nWiki Status'));
      console.log(chalk.gray(`  Total articles: ${status.totalArticles}`));
      for (const [cat, count] of Object.entries(status.byCategory)) {
        console.log(chalk.gray(`    ${cat}: ${count}`));
      }
      if (status.lastCompile) {
        console.log(chalk.gray(`  Last compile: ${status.lastCompile}`));
      } else {
        console.log(chalk.gray(`  Last compile: never`));
      }
    });

  return cmd;
}
