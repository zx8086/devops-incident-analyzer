// scripts/monitor/checks/cost.ts
import { GetCostAndUsageCommand, type GetCostAndUsageCommandOutput } from "@aws-sdk/client-cost-explorer";
import type { Finding } from "../report.ts";
import type { MonitorState } from "../state.ts";
import type { AwsClient } from "./alarms.ts";

// SIO-1680: the fleet default is an absolute $100 gate with the percentage
// filter off (pct 0 disables it). The monitor reads env overrides against these.
export const COST_DEFAULTS = { pct: 0, abs: 100 } as const;

export async function checkCost(
	client: AwsClient,
	state: MonitorState,
	opts: { now?: Date; pct?: number; abs?: number } = {},
): Promise<Finding[]> {
	const now = opts.now ?? new Date();
	const pct = opts.pct ?? COST_DEFAULTS.pct;
	const abs = opts.abs ?? COST_DEFAULTS.abs;

	const end = now.toISOString().slice(0, 10); // exclusive
	const start = new Date(now.getTime() - 15 * 86_400_000).toISOString().slice(0, 10);
	const resp = (await client.send(
		new GetCostAndUsageCommand({
			TimePeriod: { Start: start, End: end },
			Granularity: "DAILY",
			Metrics: ["UnblendedCost"],
		}),
	)) as GetCostAndUsageCommandOutput;

	for (const r of resp.ResultsByTime ?? []) {
		const date = r.TimePeriod?.Start;
		const amount = Number(r.Total?.UnblendedCost?.Amount ?? "0");
		if (date) state.recordCost(date, amount);
	}

	const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
	const latest = state.latestCost();
	if (!latest || latest.date !== yesterday) return [];
	const baseline = state.costBaseline(yesterday, 14);
	if (baseline === null) return [];

	// Alert only when over by BOTH thresholds: pct filters noise on small
	// accounts, abs filters noise on near-zero baselines. A pct of 0 or less
	// turns the percentage gate off explicitly, so abs alone decides (SIO-1680).
	const overPct = pct <= 0 || latest.usd > baseline * (1 + pct / 100);
	const overAbs = latest.usd > baseline + abs;
	if (!(overPct && overAbs)) return [];

	const key = `cost:${yesterday}`;
	if (!state.shouldAlert(key)) return [];
	state.markAlerted(key, "cost");
	return [
		{
			family: "cost",
			severity: "warn",
			resource: "account",
			// A zero baseline (fresh account) has no meaningful percentage.
			summary: `Spend ${yesterday} was $${latest.usd.toFixed(2)} vs 14d baseline $${baseline.toFixed(2)}${baseline > 0 ? ` (+${((latest.usd / baseline - 1) * 100).toFixed(0)} pct)` : " (no prior spend)"}`,
			dedup_key: key,
			evidence: { date: yesterday, usd: latest.usd, baseline },
			at: now.toISOString(),
		},
	];
}
