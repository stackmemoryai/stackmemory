#!/usr/bin/env npx tsx
/**
 * Workflow Benchmark Runner
 *
 * Compares approaches for browser workflow automation:
 *   1. Stagehand AI — natural language, first run (cold)
 *   2. Stagehand Cached — replay from cache (warm)
 *   3. Playwright Code — hand-written selectors
 *
 * Usage:
 *   npx tsx scripts/benchmark-workflows.ts [--workflow <name>] [--runs <n>]
 *
 * Requires:
 *   - @browserbasehq/stagehand installed
 *   - ANTHROPIC_API_KEY or OPENAI_API_KEY set
 *   - Optional: BROWSERBASE_API_KEY for cloud browser
 *
 * The benchmark runs against real websites using safe read-only flows.
 */

import {
  StagehandWorkflowCapture,
  WorkflowCache,
  WorkflowReplayer,
  WorkflowBenchmark,
} from '../src/features/browser/stagehand-workflows.js';
import { CliBrowserAgent } from '../src/features/browser/cli-browser-agent.js';

// ─── Config ───────────────────────────────────────────────────

const RUNS = parseInt(
  process.argv.find((_, i, a) => a[i - 1] === '--runs') || '3'
);
const WORKFLOW_FILTER = process.argv.find(
  (_, i, a) => a[i - 1] === '--workflow'
);

// Load .env for API keys if available
try {
  const { readFileSync } = await import('fs');
  const envFile = readFileSync('.env', 'utf-8');
  for (const line of envFile.split('\n')) {
    const match = line.match(/^([A-Z_]+)=(.+)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
} catch {
  /* no .env file */
}

// Stagehand defaults to OpenAI — prefer Anthropic if available
if (process.env.ANTHROPIC_API_KEY) {
  delete process.env.OPENAI_API_KEY; // Remove stale key
}

// Mode: 'api' uses direct LLM API, 'cli' uses claude -p subprocess
const MODE = process.argv.includes('--cli') ? 'cli' : 'api';

// ─── Test Workflows ───────────────────────────────────────────

interface WorkflowDefinition {
  name: string;
  startUrl: string;
  steps: Array<{
    type: 'navigate' | 'act' | 'extract';
    instruction: string;
    schema?: any;
  }>;
  playwrightFn?: (page: any) => Promise<void>;
}

const WORKFLOWS: WorkflowDefinition[] = [
  {
    name: 'GitHub Repo Stars',
    startUrl: 'https://github.com/browserbase/stagehand',
    steps: [
      {
        type: 'extract',
        instruction:
          'extract the star count and description of this repository',
      },
    ],
    playwrightFn: async (page: any) => {
      await page.goto('https://github.com/browserbase/stagehand');
      await page.waitForLoadState('domcontentloaded');
      // Use robust selectors — GitHub changes these frequently
      const stars = await page
        .locator('[id*="star"]')
        .first()
        .textContent()
        .catch(() => 'N/A');
      const desc = await page
        .locator('p.f4')
        .first()
        .textContent()
        .catch(() =>
          page
            .locator('[class*="about"] p, .BorderGrid-cell p')
            .first()
            .textContent()
            .catch(() => 'N/A')
        );
      return { stars, desc };
    },
  },
  {
    name: 'HN Top Stories',
    startUrl: 'https://news.ycombinator.com',
    steps: [
      {
        type: 'extract',
        instruction: 'extract the titles and URLs of the top 5 stories',
      },
    ],
    playwrightFn: async (page: any) => {
      await page.goto('https://news.ycombinator.com');
      const items = await page.$$eval('.titleline > a', (els: any[]) =>
        els
          .slice(0, 5)
          .map((el: any) => ({ title: el.textContent, url: el.href }))
      );
      return items;
    },
  },
  {
    name: 'NPM Package Info',
    startUrl: 'https://www.npmjs.com/package/@browserbasehq/stagehand',
    steps: [
      {
        type: 'extract',
        instruction:
          'extract the package version, weekly downloads, and description',
      },
    ],
    playwrightFn: async (page: any) => {
      await page.goto('https://www.npmjs.com/package/@browserbasehq/stagehand');
      await page.waitForLoadState('domcontentloaded');
      // NPM uses client-side rendering — extract from page title or JSON-LD
      const version = await page.evaluate(() => {
        // Try JSON-LD first (most reliable)
        const ld = document.querySelector('script[type="application/ld+json"]');
        if (ld) {
          try {
            return JSON.parse(ld.textContent || '').version || 'unknown';
          } catch {}
        }
        // Fallback: parse from title "stagehand - npm" or page content
        const title = document.title;
        const match = title.match(/(\d+\.\d+\.\d+)/);
        if (match) return match[1];
        // Last resort: find version-like string in body text
        const body = document.body.innerText;
        const verMatch = body.match(/Version\s*[\n:]*\s*(\d+\.\d+\.\d+)/i);
        return verMatch ? verMatch[1] : 'unknown';
      });
      return { version };
    },
  },
];

// ─── Runner ───────────────────────────────────────────────────

async function main() {
  console.log('Workflow Benchmark Runner');
  console.log('========================\n');

  // Check for Stagehand
  let Stagehand: any;
  try {
    const mod = await import('@browserbasehq/stagehand');
    Stagehand = mod.Stagehand;
  } catch {
    console.error('ERROR: @browserbasehq/stagehand not installed.');
    console.error('Run: npm install @browserbasehq/stagehand');
    console.error(
      '\nRunning in dry-run mode (Playwright-only benchmarks)...\n'
    );
  }

  // Check for Playwright
  let chromium: any;
  try {
    const pw = await import('playwright');
    chromium = pw.chromium;
  } catch {
    console.error('ERROR: playwright not installed.');
    console.error('Run: npm install playwright');
    process.exit(1);
  }

  const benchmark = new WorkflowBenchmark();
  const workflows = WORKFLOW_FILTER
    ? WORKFLOWS.filter((w) =>
        w.name.toLowerCase().includes(WORKFLOW_FILTER.toLowerCase())
      )
    : WORKFLOWS;

  if (workflows.length === 0) {
    console.error(`No workflows matching "${WORKFLOW_FILTER}"`);
    process.exit(1);
  }

  console.log(`Running ${workflows.length} workflows × ${RUNS} runs each\n`);

  for (const wf of workflows) {
    console.log(`\n### ${wf.name}`);
    console.log(`    URL: ${wf.startUrl}\n`);

    // ── Playwright Code Benchmark ──
    if (wf.playwrightFn) {
      for (let i = 0; i < RUNS; i++) {
        const browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();

        try {
          await benchmark.benchmarkPlaywright(
            wf.name,
            () => wf.playwrightFn!(page),
            wf.steps.length
          );
          console.log(`  [playwright-code] run ${i + 1}/${RUNS}: OK`);
        } catch (e: any) {
          console.log(
            `  [playwright-code] run ${i + 1}/${RUNS}: FAIL - ${e.message}`
          );
        }

        await browser.close();
      }
    }

    // ── CLI Agent Benchmark (claude -p / codex, subscription-based) ──
    if (MODE === 'cli' || process.argv.includes('--all')) {
      const cliProvider = process.argv.includes('--codex')
        ? ('codex' as const)
        : ('claude' as const);
      // First run: cold (CLI call + cache write)
      for (let i = 0; i < RUNS; i++) {
        const agent = new CliBrowserAgent({
          provider: cliProvider,
          headless: true,
        });
        const start = Date.now();
        try {
          await agent.init();
          await agent.goto(wf.startUrl);

          for (const step of wf.steps) {
            if (step.type === 'extract') {
              const r = await agent.extract(step.instruction);
              console.log(
                `    extracted (cache=${r.fromCache}, ${r.cliTokens} tokens, ${r.duration}ms)`
              );
            } else if (step.type === 'act') {
              await agent.act(step.instruction);
            }
          }

          const result = {
            workflow: wf.name,
            approach: `cli-${cliProvider}${i > 0 ? '-cached' : ''}` as any,
            duration: Date.now() - start,
            tokens: 0,
            success: true,
            selfHealed: false,
            steps: wf.steps.length,
          };
          benchmark.getResults().push(result);
          console.log(
            `  [cli-${cliProvider}]      run ${i + 1}/${RUNS}: OK (${result.duration}ms)`
          );
        } catch (e: any) {
          const result = {
            workflow: wf.name,
            approach: `cli-${cliProvider}` as any,
            duration: Date.now() - start,
            tokens: 0,
            success: false,
            selfHealed: false,
            steps: wf.steps.length,
            error: e.message,
          };
          benchmark.getResults().push(result);
          console.log(
            `  [cli-${cliProvider}]      run ${i + 1}/${RUNS}: FAIL - ${e.message.slice(0, 100)}`
          );
        }
        await agent.close();
      }
    }

    // ── Stagehand AI Benchmark (direct API — needs API key) ──
    if (Stagehand && MODE === 'api') {
      for (let i = 0; i < RUNS; i++) {
        let stagehand: any;
        try {
          const modelConfig = process.env.ANTHROPIC_API_KEY
            ? {
                modelName: 'anthropic/claude-sonnet-4-20250514',
                apiKey: process.env.ANTHROPIC_API_KEY,
              }
            : process.env.OPENAI_API_KEY
              ? {
                  modelName: 'openai/gpt-4o-mini',
                  apiKey: process.env.OPENAI_API_KEY,
                }
              : { modelName: 'openai/gpt-4o-mini' };
          stagehand = new Stagehand({
            env: 'LOCAL',
            cacheDir: `${process.env.HOME}/.stackmemory/workflows/stagehand-cache`,
            model: modelConfig,
          });
          await stagehand.init();

          const page = stagehand.context.pages()[0];
          await page.goto(wf.startUrl);

          await benchmark.benchmarkStagehandAI(wf.name, stagehand, wf.steps);
          console.log(`  [stagehand-ai]    run ${i + 1}/${RUNS}: OK`);
        } catch (e: any) {
          console.log(
            `  [stagehand-ai]    run ${i + 1}/${RUNS}: FAIL - ${e.message}`
          );
        }

        if (stagehand) {
          try {
            await stagehand.close();
          } catch {
            /* ignore */
          }
        }
      }

      // ── Stagehand Cached Benchmark ──
      // Only works if previous AI runs populated the cache
      const cache = new WorkflowCache();
      const cached = cache.findByName(wf.name);
      if (cached) {
        for (let i = 0; i < RUNS; i++) {
          let stagehand: any;
          try {
            stagehand = new Stagehand({
              env: 'LOCAL',
              enableCaching: true,
              headless: true,
              modelName: process.env.ANTHROPIC_API_KEY
                ? 'claude-sonnet-4-20250514'
                : undefined,
              modelClientOptions: process.env.ANTHROPIC_API_KEY
                ? {
                    apiKey: process.env.ANTHROPIC_API_KEY,
                  }
                : undefined,
            });
            await stagehand.init();

            const replayer = new WorkflowReplayer(stagehand, cache);
            await benchmark.benchmarkStagehandCached(
              wf.name,
              replayer,
              cached.id
            );
            console.log(`  [stagehand-cache] run ${i + 1}/${RUNS}: OK`);
          } catch (e: any) {
            console.log(
              `  [stagehand-cache] run ${i + 1}/${RUNS}: FAIL - ${e.message}`
            );
          }

          if (stagehand) {
            try {
              await stagehand.close();
            } catch {
              /* ignore */
            }
          }
        }
      }
    }
  }

  // ── Results ──
  console.log('\n\n## Results\n');
  console.log(benchmark.formatTable());

  // Save
  benchmark.save();
  console.log(`\nResults saved to ~/.stackmemory/workflows/benchmarks.jsonl`);

  // ── Summary ──
  const results = benchmark.getResults();
  const byApproach = new Map<
    string,
    { totalDur: number; totalTokens: number; count: number; successes: number }
  >();

  for (const r of results) {
    const stats = byApproach.get(r.approach) || {
      totalDur: 0,
      totalTokens: 0,
      count: 0,
      successes: 0,
    };
    stats.totalDur += r.duration;
    stats.totalTokens += r.tokens;
    stats.count++;
    if (r.success) stats.successes++;
    byApproach.set(r.approach, stats);
  }

  console.log('\n## Summary\n');
  console.log('| Approach | Avg Duration | Avg Tokens | Success Rate |');
  console.log('|----------|-------------|------------|-------------|');
  for (const [approach, stats] of byApproach) {
    const avgDur = (stats.totalDur / stats.count).toFixed(0);
    const avgTokens = (stats.totalTokens / stats.count).toFixed(0);
    const rate = ((stats.successes / stats.count) * 100).toFixed(0);
    console.log(`| ${approach} | ${avgDur}ms | ${avgTokens} | ${rate}% |`);
  }
}

main().catch(console.error);
