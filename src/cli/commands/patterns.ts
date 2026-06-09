/**
 * Patterns CLI Commands
 *
 * stackmemory patterns list|learn|stats|prune|export|import
 */

import { Command } from 'commander';
import Database from 'better-sqlite3';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { PatternStore } from '../../core/patterns/pattern-store.js';
import type {
  PatternDomain,
  PatternScope,
  CreatePatternInput,
} from '../../core/patterns/types.js';

function getDb(): Database.Database {
  const dbPath = join(homedir(), '.stackmemory', 'stackmemory.db');
  return new Database(dbPath);
}

function getStore(): PatternStore {
  return new PatternStore(getDb());
}

export function createPatternsCommand(): Command {
  const patterns = new Command('patterns').description(
    'Manage learned behavioral patterns'
  );

  // ── list ──────────────────────────────────────────

  patterns
    .command('list')
    .description('List learned patterns')
    .option('-d, --domain <domain>', 'Filter by domain')
    .option('-s, --status <status>', 'Filter by status', 'active')
    .option('--min-confidence <n>', 'Minimum confidence', '0')
    .option('--json', 'Output JSON')
    .action((opts) => {
      const store = getStore();
      const list = store.list({
        domain: opts.domain as PatternDomain | undefined,
        status: opts.status,
        minConfidence: parseFloat(opts.minConfidence),
      });

      if (opts.json) {
        process.stdout.write(JSON.stringify(list, null, 2) + '\n');
        return;
      }

      if (list.length === 0) {
        process.stdout.write('No patterns found.\n');
        return;
      }

      for (const p of list) {
        const bar = confidenceBar(p.confidence);
        const scope = p.scope === 'global' ? '[global]' : '[project]';
        process.stdout.write(
          `${bar} ${p.confidence.toFixed(2)}  ${scope}  ${p.id}\n` +
            `   trigger: ${p.trigger}\n` +
            `   action:  ${p.action}\n` +
            `   domain:  ${p.domain}  obs: ${p.observationCount}  status: ${p.status}\n\n`
        );
      }
    });

  // ── learn ─────────────────────────────────────────

  patterns
    .command('learn')
    .description('Manually record a pattern')
    .requiredOption('-t, --trigger <text>', 'When this happens')
    .requiredOption('-a, --action <text>', 'Do this')
    .option('-d, --domain <domain>', 'Pattern domain', 'general')
    .option('--scope <scope>', 'project or global', 'project')
    .option('--id <id>', 'Pattern ID (auto-generated if omitted)')
    .action((opts) => {
      const store = getStore();
      const id =
        opts.id ?? slugify(`${opts.domain}-${opts.trigger.slice(0, 40)}`);

      const input: CreatePatternInput = {
        id,
        domain: opts.domain as PatternDomain,
        trigger: opts.trigger,
        action: opts.action,
        scope: opts.scope as PatternScope,
        source: 'manual',
        confidence: 0.5,
      };

      const pattern = store.create(input);
      process.stdout.write(
        `Pattern created: ${pattern.id} (confidence: ${pattern.confidence})\n`
      );
    });

  // ── stats ─────────────────────────────────────────

  patterns
    .command('stats')
    .description('Show pattern statistics')
    .option('--json', 'Output JSON')
    .action((opts) => {
      const store = getStore();
      const s = store.stats();

      if (opts.json) {
        process.stdout.write(JSON.stringify(s, null, 2) + '\n');
        return;
      }

      const lines = [
        `Total patterns: ${s.total}`,
        `Avg confidence: ${s.avgConfidence.toFixed(2)}`,
        '',
        'By domain:',
        ...Object.entries(s.byDomain).map(([d, n]) => `  ${d}: ${n}`),
        '',
        'By status:',
        ...Object.entries(s.byStatus).map(([d, n]) => `  ${d}: ${n}`),
      ];

      if (s.topPatterns.length > 0) {
        lines.push('', 'Top patterns:');
        for (const p of s.topPatterns) {
          lines.push(
            `  ${confidenceBar(p.confidence)} ${p.confidence.toFixed(2)}  ${p.id}`
          );
        }
      }

      process.stdout.write(lines.join('\n') + '\n');
    });

  // ── prune ─────────────────────────────────────────

  patterns
    .command('prune')
    .description('Remove old pending patterns')
    .option('--days <n>', 'Max age in days', '30')
    .action((opts) => {
      const store = getStore();
      const removed = store.prune(parseInt(opts.days, 10));
      process.stdout.write(
        `Pruned ${removed} pending patterns older than ${opts.days} days.\n`
      );
    });

  // ── export ────────────────────────────────────────

  patterns
    .command('export')
    .description('Export patterns to JSON file')
    .option('-o, --output <path>', 'Output file', 'patterns-export.json')
    .option('--min-confidence <n>', 'Minimum confidence', '0.3')
    .action((opts) => {
      const store = getStore();
      const list = store.list({
        status: 'active',
        minConfidence: parseFloat(opts.minConfidence),
      });

      writeFileSync(opts.output, JSON.stringify(list, null, 2), 'utf-8');
      process.stdout.write(
        `Exported ${list.length} patterns to ${opts.output}\n`
      );
    });

  // ── import ────────────────────────────────────────

  patterns
    .command('import')
    .description('Import patterns from JSON file')
    .argument('<file>', 'JSON file to import')
    .option('--scope <scope>', 'Override scope', 'project')
    .action((file, opts) => {
      if (!existsSync(file)) {
        process.stderr.write(`File not found: ${file}\n`);
        process.exit(1);
      }

      const store = getStore();
      const data = JSON.parse(readFileSync(file, 'utf-8'));
      const patterns = Array.isArray(data) ? data : [data];
      let imported = 0;

      for (const p of patterns) {
        if (!p.id || !p.trigger || !p.action) continue;
        const existing = store.get(p.id);
        if (existing) {
          store.reinforce(p.id, 'imported');
        } else {
          store.create({
            id: p.id,
            domain: p.domain ?? 'general',
            trigger: p.trigger,
            action: p.action,
            evidence: p.evidence ?? ['imported'],
            scope: (opts.scope as PatternScope) ?? p.scope ?? 'project',
            source: 'imported',
            confidence: p.confidence ?? 0.5,
          });
        }
        imported++;
      }

      process.stdout.write(`Imported ${imported} patterns.\n`);
    });

  // ── promote ───────────────────────────────────────

  patterns
    .command('promote')
    .description('Promote a project-scoped pattern to global')
    .argument('[id]', 'Pattern ID to promote (omit for auto-candidates)')
    .option('--dry-run', 'Show candidates without promoting')
    .action((id, opts) => {
      const store = getStore();

      if (id) {
        const pattern = store.get(id);
        if (!pattern) {
          process.stderr.write(`Pattern not found: ${id}\n`);
          process.exit(1);
        }
        if (pattern.scope === 'global') {
          process.stdout.write(`Already global: ${id}\n`);
          return;
        }
        if (!opts.dryRun) {
          store.promote(id);
          process.stdout.write(`Promoted to global: ${id}\n`);
        } else {
          process.stdout.write(
            `Would promote: ${id} (confidence: ${pattern.confidence.toFixed(2)})\n`
          );
        }
        return;
      }

      // Auto-detect candidates (seen in 2+ projects with high confidence)
      const candidates = store.promotionCandidates(0.7);
      if (candidates.length === 0) {
        process.stdout.write(
          'No promotion candidates found (need 0.7+ confidence in 2+ projects).\n'
        );
        return;
      }

      for (const c of candidates) {
        const action = opts.dryRun ? 'candidate' : 'promoted';
        if (!opts.dryRun) store.promote(c.id);
        process.stdout.write(
          `${action}: ${c.id} (${c.confidence.toFixed(2)}, project: ${c.projectId})\n`
        );
      }

      if (opts.dryRun) {
        process.stdout.write(
          `\n${candidates.length} candidates. Run without --dry-run to promote.\n`
        );
      }
    });

  // ── projects ──────────────────────────────────────

  patterns
    .command('projects')
    .description('List projects with pattern counts')
    .option('--json', 'Output JSON')
    .action((opts) => {
      const store = getStore();
      const projs = store.projects();

      if (opts.json) {
        process.stdout.write(JSON.stringify(projs, null, 2) + '\n');
        return;
      }

      if (projs.length === 0) {
        process.stdout.write('No project-scoped patterns found.\n');
        return;
      }

      for (const p of projs) {
        process.stdout.write(
          `${p.projectId}  ${p.count} patterns  avg confidence: ${p.avgConfidence.toFixed(2)}\n`
        );
      }
    });

  // ── evolve ────────────────────────────────────────

  patterns
    .command('evolve')
    .description('Analyze pattern clusters and suggest evolved structures')
    .option('--min-cluster <n>', 'Minimum cluster size', '2')
    .option('--json', 'Output JSON')
    .action((opts) => {
      const store = getStore();
      const clusters = store.findClusters(parseInt(opts.minCluster, 10));

      if (opts.json) {
        process.stdout.write(JSON.stringify(clusters, null, 2) + '\n');
        return;
      }

      if (clusters.length === 0) {
        process.stdout.write(
          'No pattern clusters found. Need 2+ active patterns in a domain.\n'
        );
        return;
      }

      for (const cluster of clusters) {
        const avgConf =
          cluster.patterns.reduce((s, p) => s + p.confidence, 0) /
          cluster.patterns.length;
        const label =
          avgConf >= 0.8
            ? 'SKILL candidate'
            : avgConf >= 0.6
              ? 'command candidate'
              : 'cluster';

        process.stdout.write(
          `\n[${cluster.domain}] ${cluster.patterns.length} patterns — ${label} (avg: ${avgConf.toFixed(2)})\n`
        );
        for (const p of cluster.patterns) {
          process.stdout.write(
            `  ${confidenceBar(p.confidence)} ${p.id}: ${p.trigger}\n`
          );
        }
      }
    });

  return patterns;
}

function confidenceBar(confidence: number): string {
  const filled = Math.round(confidence * 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
