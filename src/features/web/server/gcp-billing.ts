/**
 * GCP Billing integration.
 *
 * Pulls actual GCP spend from a BigQuery billing export table. The table is
 * typically named `project.dataset.gcp_billing_export_v1_<BILLING_ACCOUNT_ID>`
 * and is populated automatically when Cloud Billing export to BigQuery is
 * enabled.
 *
 * Required environment variables (one of the two credential styles):
 *   - GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
 *     + GCP_BILLING_PROJECT_ID
     + GCP_BILLING_DATASET
     + GCP_BILLING_TABLE
 *   OR
 *   - GCP_BILLING_BIGQUERY_TABLE=project.dataset.table
 *     + GOOGLE_APPLICATION_CREDENTIALS
 *
 * If credentials/table are not configured, spend functions return undefined
 * and the /evals page falls back to the manual GCP_AI_SPEND_USD env var.
 */

import { existsSync } from 'fs';

export interface GcpDailySpend {
  date: string;
  costUsd: number;
}

export interface GcpSpendResult {
  totalCostUsd: number;
  daily: GcpDailySpend[];
  currency: string;
  table: string;
}

function getTableReference(): string | undefined {
  const fullTable = process.env['GCP_BILLING_BIGQUERY_TABLE'];
  if (fullTable) return fullTable;

  const project = process.env['GCP_BILLING_PROJECT_ID'];
  const dataset = process.env['GCP_BILLING_DATASET'];
  const table = process.env['GCP_BILLING_TABLE'];
  if (project && dataset && table) {
    return `${project}.${dataset}.${table}`;
  }
  return undefined;
}

/**
 * Lazily import @google-cloud/bigquery so the server can still start when the
 * dependency is not installed.
 */
async function getBigQuery() {
  const { BigQuery } = await import('@google-cloud/bigquery');
  return new BigQuery();
}

/**
 * Query GCP billing export for total and daily spend over the last N days.
 * Returns undefined if billing is not configured or the query fails.
 */
export async function getGcpSpend(
  days = 30
): Promise<GcpSpendResult | undefined> {
  const table = getTableReference();
  if (!table) return undefined;

  try {
    const bq = await getBigQuery();

    const [totalRows] = await bq.query({
      query: `
        SELECT
          SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)) AS total_cost,
          currency
        FROM \`${table}\`
        WHERE usage_start_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
        LIMIT 1
      `,
      params: { days },
      location: 'US',
    });

    const [dailyRows] = await bq.query({
      query: `
        SELECT
          DATE(usage_start_time) AS date,
          SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)) AS cost_usd
        FROM \`${table}\`
        WHERE usage_start_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
        GROUP BY date
        ORDER BY date ASC
      `,
      params: { days },
      location: 'US',
    });

    const total = Number(totalRows?.[0]?.total_cost ?? 0);
    const currency = String(totalRows?.[0]?.currency ?? 'USD');

    const daily: GcpDailySpend[] = (dailyRows || [])
      .map((r: any) => ({
        date: String(r.date ?? ''),
        costUsd: Number(r.cost_usd ?? 0),
      }))
      .filter((d: GcpDailySpend) => d.date);

    return {
      totalCostUsd: total,
      daily,
      currency,
      table,
    };
  } catch (error) {
    console.warn('Failed to fetch GCP spend from BigQuery:', error);
    return undefined;
  }
}

/**
 * Synchronous fallback used by the spend summary: returns the manual env var
 * value if live BigQuery is not available.
 */
export function getGcpSpendEnvFallback(): number | undefined {
  const raw = process.env['GCP_AI_SPEND_USD'];
  if (!raw) return undefined;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}
