/**
 * AI Spend Calculator
 *
 * Aggregates token usage from:
 *  - Conductor traces (~/.stackmemory/conductor/traces.db)
 *  - Retrieval audit (project .stackmemory/context.db)
 *
 * and turns it into cost estimates using the shared provider-pricing table.
 */

import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  calculateCost,
  effectiveSpendMultiplier,
  formatCost,
} from '../../../core/models/provider-pricing.js';
import { getGcpSpend, getGcpSpendEnvFallback } from './gcp-billing.js';

export interface SpendSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  listCostUsd: number;
  effectiveCostUsd: number;
  discountMultiplier: number;
  formattedListCost: string;
  formattedEffectiveCost: string;
  bySource: Record<string, SourceSpend>;
  byModel: Record<string, ModelSpend>;
  byDay: DaySpend[];
  gcpSpendUsd?: number;
  gcpSpendFormatted?: string;
  gcpSource?: 'bigquery' | 'env';
  gcpTable?: string;
  gcpDaily?: { date: string; costUsd: number }[];
}

export interface SourceSpend {
  source: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  listCostUsd: number;
  effectiveCostUsd: number;
}

export interface ModelSpend {
  modelKey: string;
  displayName: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  listCostUsd: number;
  effectiveCostUsd: number;
}

export interface DaySpend {
  date: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  listCostUsd: number;
  effectiveCostUsd: number;
}

interface UsageRow {
  source: string;
  modelKey: string;
  inputTokens: number;
  outputTokens: number;
  timestamp: number;
}

const DEFAULT_CONDUCTOR_MODEL = 'anthropic/claude-sonnet-4-20250514';
const DEFAULT_RETRIEVAL_MODEL = 'anthropic/claude-haiku-4-5-20251001';

/**
 * Map a model identifier (as it appears in logs/config) to a pricing-table key.
 */
function resolvePricingKey(
  model?: string,
  fallback = DEFAULT_CONDUCTOR_MODEL
): string {
  if (!model) return fallback;

  const normalized = model.toLowerCase().trim();

  // Anthropic
  if (normalized.includes('claude-opus-4')) return 'anthropic/claude-opus-4-7';
  if (normalized.includes('claude-sonnet-4-5'))
    return 'anthropic/claude-sonnet-4-5-20250929';
  if (normalized.includes('claude-sonnet-4'))
    return 'anthropic/claude-sonnet-4-20250514';
  if (normalized.includes('claude-haiku'))
    return 'anthropic/claude-haiku-4-5-20251001';
  if (normalized.includes('claude-3-5-haiku'))
    return 'anthropic/claude-haiku-4-5-20251001';

  // OpenAI
  if (normalized.includes('gpt-4o')) return 'openai/gpt-4o';

  // OpenRouter
  if (normalized.includes('meta-llama/llama-4-scout'))
    return 'openrouter/meta-llama/llama-4-scout';

  // Cerebras
  if (normalized.includes('llama-4-scout-17b'))
    return 'cerebras/llama-4-scout-17b-16e-instruct';

  // DeepInfra
  if (normalized.includes('glm-4')) return 'deepinfra/THUDM/glm-4-9b-chat';

  return fallback;
}

/**
 * Try to extract a model name from a conductor trace event JSON blob.
 */
function extractModelFromEventJson(eventJson?: string): string | undefined {
  if (!eventJson) return undefined;
  try {
    const event = JSON.parse(eventJson) as Record<string, unknown>;
    const model =
      event.model ??
      (event as any).message?.model ??
      (event as any).body?.model ??
      (event as any).params?.model;
    return typeof model === 'string' ? model : undefined;
  } catch {
    return undefined;
  }
}

function getConductorTracesDbPath(): string {
  return join(homedir(), '.stackmemory', 'conductor', 'traces.db');
}

function getProjectContextDbPath(): string {
  return join(process.cwd(), '.stackmemory', 'context.db');
}

/**
 * Read conductor traces and flatten into usage rows.
 */
function readConductorUsage(): UsageRow[] {
  const dbPath = getConductorTracesDbPath();
  if (!existsSync(dbPath)) return [];

  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare(
        `
        SELECT
          input_tokens as inputTokens,
          output_tokens as outputTokens,
          timestamp,
          event_json as eventJson
        FROM conductor_traces
        WHERE input_tokens > 0 OR output_tokens > 0
        ORDER BY timestamp DESC
        `
      )
      .all() as Array<{
      inputTokens: number;
      outputTokens: number;
      timestamp: number;
      eventJson: string;
    }>;

    return rows.map((r) => ({
      source: 'conductor',
      modelKey: resolvePricingKey(
        extractModelFromEventJson(r.eventJson),
        DEFAULT_CONDUCTOR_MODEL
      ),
      inputTokens: r.inputTokens || 0,
      outputTokens: r.outputTokens || 0,
      timestamp: r.timestamp,
    }));
  } catch (error) {
    console.warn('Failed to read conductor traces for spend estimate:', error);
    return [];
  } finally {
    db?.close();
  }
}

/**
 * Read retrieval audit and flatten into usage rows.
 * Retrieval audit stores a single tokens_used field; treat as output tokens
 * (analysis generation) with a small fixed input budget for the prompt.
 */
function readRetrievalUsage(): UsageRow[] {
  const dbPath = getProjectContextDbPath();
  if (!existsSync(dbPath)) return [];

  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare(
        `
        SELECT
          tokens_used as tokensUsed,
          timestamp
        FROM retrieval_audit
        WHERE tokens_used > 0
        ORDER BY timestamp DESC
        `
      )
      .all() as Array<{ tokensUsed: number; timestamp: number }>;

    return rows.map((r) => ({
      source: 'retrieval',
      modelKey: DEFAULT_RETRIEVAL_MODEL,
      // Estimate: 80% output, 20% input for the analysis call
      inputTokens: Math.round((r.tokensUsed || 0) * 0.2),
      outputTokens: Math.round((r.tokensUsed || 0) * 0.8),
      timestamp: r.timestamp,
    }));
  } catch (error) {
    console.warn('Failed to read retrieval audit for spend estimate:', error);
    return [];
  } finally {
    db?.close();
  }
}

function dateKey(timestamp: number): string {
  const d = new Date(timestamp);
  return d.toISOString().slice(0, 10);
}

/**
 * Aggregate usage rows into a spend summary.
 */
export function calculateSpendSummary(rows: UsageRow[]): SpendSummary {
  const now = new Date();
  const multiplier = effectiveSpendMultiplier(now);

  const bySource: Record<string, SourceSpend> = {};
  const byModel: Record<string, ModelSpend> = {};
  const byDayMap: Record<string, DaySpend> = {};

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalListCost = 0;
  let totalEffectiveCost = 0;

  for (const row of rows) {
    const cost = calculateCost(
      row.modelKey.split('/')[0],
      row.modelKey.split('/').slice(1).join('/'),
      row.inputTokens,
      row.outputTokens
    );
    const listCost = cost?.totalCost ?? 0;
    const effective = listCost * multiplier;

    totalInputTokens += row.inputTokens;
    totalOutputTokens += row.outputTokens;
    totalListCost += listCost;
    totalEffectiveCost += effective;

    // bySource
    const src = bySource[row.source] ?? {
      source: row.source,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      listCostUsd: 0,
      effectiveCostUsd: 0,
    };
    src.inputTokens += row.inputTokens;
    src.outputTokens += row.outputTokens;
    src.totalTokens += row.inputTokens + row.outputTokens;
    src.listCostUsd += listCost;
    src.effectiveCostUsd += effective;
    bySource[row.source] = src;

    // byModel
    const model = byModel[row.modelKey] ?? {
      modelKey: row.modelKey,
      displayName: row.modelKey.split('/').slice(1).join('/'),
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      listCostUsd: 0,
      effectiveCostUsd: 0,
    };
    model.inputTokens += row.inputTokens;
    model.outputTokens += row.outputTokens;
    model.totalTokens += row.inputTokens + row.outputTokens;
    model.listCostUsd += listCost;
    model.effectiveCostUsd += effective;
    byModel[row.modelKey] = model;

    // byDay
    const day = dateKey(row.timestamp);
    const dayEntry = byDayMap[day] ?? {
      date: day,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      listCostUsd: 0,
      effectiveCostUsd: 0,
    };
    dayEntry.inputTokens += row.inputTokens;
    dayEntry.outputTokens += row.outputTokens;
    dayEntry.totalTokens += row.inputTokens + row.outputTokens;
    dayEntry.listCostUsd += listCost;
    dayEntry.effectiveCostUsd += effective;
    byDayMap[day] = dayEntry;
  }

  return {
    totalInputTokens,
    totalOutputTokens,
    totalTokens: totalInputTokens + totalOutputTokens,
    listCostUsd: totalListCost,
    effectiveCostUsd: totalEffectiveCost,
    discountMultiplier: multiplier,
    formattedListCost: formatCost(totalListCost),
    formattedEffectiveCost: formatCost(totalEffectiveCost),
    bySource,
    byModel,
    byDay: Object.values(byDayMap).sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/**
 * Main entry point: read all available usage sources and return a spend summary.
 */
export async function getSpendSummary(): Promise<SpendSummary> {
  const rows = [...readConductorUsage(), ...readRetrievalUsage()];
  const summary = calculateSpendSummary(rows);

  // Prefer live BigQuery billing data; fall back to manual env var.
  const gcp = await getGcpSpend();
  if (gcp) {
    summary.gcpSpendUsd = gcp.totalCostUsd;
    summary.gcpSpendFormatted = formatCost(gcp.totalCostUsd);
    summary.gcpSource = 'bigquery';
    summary.gcpTable = gcp.table;
    summary.gcpDaily = gcp.daily;
  } else {
    const envSpend = getGcpSpendEnvFallback();
    if (envSpend !== undefined) {
      summary.gcpSpendUsd = envSpend;
      summary.gcpSpendFormatted = formatCost(envSpend);
      summary.gcpSource = 'env';
    }
  }

  return summary;
}
