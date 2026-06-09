/**
 * MCP Tool Definitions for Workflow Capture/Replay
 *
 * Exposes the Stagehand workflow integration as MCP tools
 * that any AI agent can call.
 */

import {
  WorkflowCache,
  type CapturedWorkflow,
  type CachedWorkflowEntry,
  type WorkflowBenchmarkResult,
} from './stagehand-workflows.js';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const WORKFLOW_DIR = join(homedir(), '.stackmemory', 'workflows');
const BENCHMARK_FILE = join(WORKFLOW_DIR, 'benchmarks.jsonl');

// ─── Tool Definitions ─────────────────────────────────────────

export const workflowToolDefinitions = [
  {
    name: 'workflow_list',
    description:
      'List all captured browser workflows with replay stats. ' +
      'Shows workflow name, URL, step count, replay count, success rate, and average duration.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url_filter: {
          type: 'string',
          description: 'Filter workflows by URL host (e.g., "github.com")',
        },
      },
    },
  },
  {
    name: 'workflow_get',
    description:
      'Get details of a specific captured workflow including all steps.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Workflow ID' },
        name: { type: 'string', description: 'Workflow name (fuzzy match)' },
      },
    },
  },
  {
    name: 'workflow_replay',
    description:
      'Replay a cached browser workflow. Supports cached (fast, no AI), AI (self-healing), or hybrid mode. ' +
      'Use variables to parameterize URLs and instructions ({{key}} syntax).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Workflow ID to replay' },
        name: {
          type: 'string',
          description: 'Workflow name (fuzzy match, alternative to id)',
        },
        mode: {
          type: 'string',
          enum: ['cached', 'ai', 'hybrid'],
          description:
            'Replay mode: cached (fast), ai (self-healing), hybrid (cache + fallback)',
        },
        variables: {
          type: 'object',
          description:
            'Variables to substitute in URLs and instructions (key-value pairs)',
          additionalProperties: { type: 'string' },
        },
      },
    },
  },
  {
    name: 'workflow_benchmarks',
    description:
      'Show benchmark results comparing workflow execution approaches ' +
      '(Stagehand AI, cached replay, Playwright code, Puppeteer code).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workflow: {
          type: 'string',
          description: 'Filter by workflow name',
        },
      },
    },
  },
];

// ─── Tool Handlers ────────────────────────────────────────────

export async function handleWorkflowTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  switch (toolName) {
    case 'workflow_list':
      return handleWorkflowList(args.url_filter as string | undefined);
    case 'workflow_get':
      return handleWorkflowGet(
        args.id as string | undefined,
        args.name as string | undefined
      );
    case 'workflow_replay':
      return handleWorkflowReplayInfo(
        args.id as string | undefined,
        args.name as string | undefined,
        args.mode as string | undefined,
        args.variables as Record<string, string> | undefined
      );
    case 'workflow_benchmarks':
      return handleWorkflowBenchmarks(args.workflow as string | undefined);
    default:
      return text(`Unknown tool: ${toolName}`);
  }
}

function handleWorkflowList(
  urlFilter?: string
): ReturnType<typeof handleWorkflowTool> {
  const cache = new WorkflowCache();
  let workflows = cache.list();

  if (urlFilter) {
    const filter = urlFilter.toLowerCase();
    workflows = workflows.filter((w) =>
      w.startUrl.toLowerCase().includes(filter)
    );
  }

  if (workflows.length === 0) {
    return text(
      'No captured workflows found. Use StagehandWorkflowCapture to record browser workflows.'
    );
  }

  const lines = workflows.map((w) => {
    const steps = w.steps.length;
    const replays = w.replayCount;
    const rate = (w.successRate * 100).toFixed(0);
    const avgMs = w.avgDuration.toFixed(0);
    return `- **${w.name}** (${w.id.slice(0, 8)})\n  URL: ${w.startUrl}\n  Steps: ${steps} | Replays: ${replays} | Success: ${rate}% | Avg: ${avgMs}ms`;
  });

  return text(
    `## Captured Workflows (${workflows.length})\n\n${lines.join('\n\n')}`
  );
}

function handleWorkflowGet(
  id?: string,
  name?: string
): ReturnType<typeof handleWorkflowTool> {
  const cache = new WorkflowCache();
  let entry: CachedWorkflowEntry | undefined;

  if (id) {
    entry = cache.get(id);
  } else if (name) {
    entry = cache.findByName(name);
  }

  if (!entry) {
    return text('Workflow not found.');
  }

  const stepLines = entry.steps.map(
    (s, i) =>
      `  ${i + 1}. [${s.type}] ${s.instruction}${s.url ? ` (${s.url})` : ''}`
  );

  return text(
    `## ${entry.name}\n\n` +
      `ID: ${entry.id}\n` +
      `Start URL: ${entry.startUrl}\n` +
      `Captured: ${entry.capturedAt}\n` +
      `Replays: ${entry.replayCount} | Success: ${(entry.successRate * 100).toFixed(0)}%\n\n` +
      `### Steps\n${stepLines.join('\n')}`
  );
}

function handleWorkflowReplayInfo(
  id?: string,
  name?: string,
  mode?: string,
  variables?: Record<string, string>
): ReturnType<typeof handleWorkflowTool> {
  // Note: actual replay requires a Stagehand instance running.
  // This tool returns the replay plan + instructions.
  const cache = new WorkflowCache();
  let entry: CachedWorkflowEntry | undefined;

  if (id) {
    entry = cache.get(id);
  } else if (name) {
    entry = cache.findByName(name);
  }

  if (!entry) {
    return text(
      'Workflow not found. Use workflow_list to see available workflows.'
    );
  }

  const replayMode = mode || 'hybrid';
  const varList = variables
    ? Object.entries(variables)
        .map(([k, v]) => `  ${k} = "${v}"`)
        .join('\n')
    : '  (none)';

  return text(
    `## Replay Plan: ${entry.name}\n\n` +
      `Mode: ${replayMode}\n` +
      `Variables:\n${varList}\n\n` +
      `### Steps to Execute\n` +
      entry.steps
        .map((s, i) => `  ${i + 1}. [${s.type}] ${s.instruction}`)
        .join('\n') +
      `\n\nTo execute, create a StagehandWorkflowCapture instance and call:\n` +
      '```ts\n' +
      `const replayer = new WorkflowReplayer(stagehand);\n` +
      `await replayer.replay("${entry.id}", "${replayMode}"${variables ? ', variables' : ''});\n` +
      '```'
  );
}

function handleWorkflowBenchmarks(
  workflow?: string
): ReturnType<typeof handleWorkflowTool> {
  if (!existsSync(BENCHMARK_FILE)) {
    return text(
      'No benchmark data. Run WorkflowBenchmark to generate comparisons.'
    );
  }

  const lines = readFileSync(BENCHMARK_FILE, 'utf-8').trim().split('\n');
  let results: WorkflowBenchmarkResult[] = [];

  for (const line of lines) {
    try {
      results.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }

  if (workflow) {
    const filter = workflow.toLowerCase();
    results = results.filter((r) => r.workflow.toLowerCase().includes(filter));
  }

  if (results.length === 0) {
    return text('No benchmark results found.');
  }

  // Group by workflow
  const grouped = new Map<string, WorkflowBenchmarkResult[]>();
  for (const r of results) {
    const list = grouped.get(r.workflow) || [];
    list.push(r);
    grouped.set(r.workflow, list);
  }

  const sections: string[] = [];
  for (const [name, runs] of grouped) {
    const header = `### ${name}\n`;
    const table = [
      '| Approach | Duration | Tokens | Success | Self-Healed |',
      '|----------|----------|--------|---------|-------------|',
      ...runs.map(
        (r) =>
          `| ${r.approach} | ${r.duration}ms | ${r.tokens} | ${r.success ? 'Y' : 'N'} | ${r.selfHealed ? 'Y' : 'N'} |`
      ),
    ].join('\n');
    sections.push(header + table);
  }

  return text(`## Workflow Benchmarks\n\n${sections.join('\n\n')}`);
}

function text(t: string) {
  return Promise.resolve({ content: [{ type: 'text' as const, text: t }] });
}
