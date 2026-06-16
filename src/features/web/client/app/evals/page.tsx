"use client";

import { useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface ModelSpend {
  modelKey: string;
  displayName: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  listCostUsd: number;
  effectiveCostUsd: number;
}

interface SourceSpend {
  source: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  listCostUsd: number;
  effectiveCostUsd: number;
}

interface DaySpend {
  date: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  listCostUsd: number;
  effectiveCostUsd: number;
}

interface SpendSummary {
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

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

function formatUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

export default function EvalsPage() {
  const [spend, setSpend] = useState<SpendSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/evals")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: SpendSummary) => {
        setSpend(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        Loading AI spend estimate…
      </div>
    );
  }

  if (error || !spend) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-destructive">
        Failed to load spend estimate: {error || "unknown error"}
      </div>
    );
  }

  const bySourceList = Object.values(spend.bySource);
  const byModelList = Object.values(spend.byModel);
  const hasGcp = spend.gcpSpendUsd !== undefined;

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-3xl font-bold">Evals</h1>
        <p className="text-muted-foreground">
          AI spend estimate across conductor traces and retrieval audits
        </p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Effective Cost</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              {spend.formattedEffectiveCost}
            </div>
            <p className="text-xs text-muted-foreground">
              After {(spend.discountMultiplier * 100).toFixed(0)}% discount ramp
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">List Cost</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{spend.formattedListCost}</div>
            <p className="text-xs text-muted-foreground">At posted model prices</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Tokens</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">
              {formatTokens(spend.totalTokens)}
            </div>
            <p className="text-xs text-muted-foreground">
              {formatTokens(spend.totalInputTokens)} in /{" "}
              {formatTokens(spend.totalOutputTokens)} out
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">GCP Spend</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-purple-600">
              {spend.gcpSpendFormatted ?? "—"}
            </div>
            <p className="text-xs text-muted-foreground">
              {spend.gcpSource === "bigquery"
                ? `Live BigQuery ${spend.gcpTable ? `· ${spend.gcpTable}` : ""}`
                : hasGcp
                ? "From GCP_AI_SPEND_USD"
                : "Set GCP billing env vars to include"}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* By Source */}
      <Card>
        <CardHeader>
          <CardTitle>By Source</CardTitle>
          <CardDescription>
            Token usage and cost grouped by subsystem
          </CardDescription>
        </CardHeader>
        <CardContent>
          {bySourceList.length === 0 ? (
            <p className="text-muted-foreground">No usage data found.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2 font-medium">Source</th>
                    <th className="text-right py-2 font-medium">Tokens</th>
                    <th className="text-right py-2 font-medium">List Cost</th>
                    <th className="text-right py-2 font-medium">Effective Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {bySourceList.map((s) => (
                    <tr key={s.source} className="border-b last:border-0">
                      <td className="py-2 capitalize">{s.source}</td>
                      <td className="text-right py-2">
                        {formatTokens(s.totalTokens)}
                      </td>
                      <td className="text-right py-2">{formatUsd(s.listCostUsd)}</td>
                      <td className="text-right py-2">
                        {formatUsd(s.effectiveCostUsd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* By Model */}
      <Card>
        <CardHeader>
          <CardTitle>By Model</CardTitle>
          <CardDescription>
            Cost breakdown per provider/model pair
          </CardDescription>
        </CardHeader>
        <CardContent>
          {byModelList.length === 0 ? (
            <p className="text-muted-foreground">No model usage data found.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2 font-medium">Model</th>
                    <th className="text-right py-2 font-medium">Tokens</th>
                    <th className="text-right py-2 font-medium">List Cost</th>
                    <th className="text-right py-2 font-medium">Effective Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {byModelList.map((m) => (
                    <tr key={m.modelKey} className="border-b last:border-0">
                      <td className="py-2">{m.displayName}</td>
                      <td className="text-right py-2">
                        {formatTokens(m.totalTokens)}
                      </td>
                      <td className="text-right py-2">{formatUsd(m.listCostUsd)}</td>
                      <td className="text-right py-2">
                        {formatUsd(m.effectiveCostUsd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* By Day */}
      <Card>
        <CardHeader>
          <CardTitle>Daily Trend</CardTitle>
          <CardDescription>Spend and tokens per day</CardDescription>
        </CardHeader>
        <CardContent>
          {spend.byDay.length === 0 ? (
            <p className="text-muted-foreground">No daily data found.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2 font-medium">Date</th>
                    <th className="text-right py-2 font-medium">Tokens</th>
                    <th className="text-right py-2 font-medium">List Cost</th>
                    <th className="text-right py-2 font-medium">Effective Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {spend.byDay.map((d) => (
                    <tr key={d.date} className="border-b last:border-0">
                      <td className="py-2">{d.date}</td>
                      <td className="text-right py-2">
                        {formatTokens(d.totalTokens)}
                      </td>
                      <td className="text-right py-2">{formatUsd(d.listCostUsd)}</td>
                      <td className="text-right py-2">
                        {formatUsd(d.effectiveCostUsd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* GCP Daily Spend */}
      {spend.gcpSource === "bigquery" && (
        <Card>
          <CardHeader>
            <CardTitle>GCP Daily Spend</CardTitle>
            <CardDescription>
              Live GCP cost from BigQuery{" "}
              {spend.gcpTable ? `· ${spend.gcpTable}` : ""}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!spend.gcpDaily || spend.gcpDaily.length === 0 ? (
              <p className="text-muted-foreground">No GCP daily data found.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-2 font-medium">Date</th>
                      <th className="text-right py-2 font-medium">GCP Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {spend.gcpDaily.map((d) => (
                      <tr key={d.date} className="border-b last:border-0">
                        <td className="py-2">{d.date}</td>
                        <td className="text-right py-2">{formatUsd(d.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
