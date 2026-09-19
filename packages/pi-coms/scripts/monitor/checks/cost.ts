// scripts/monitor/checks/cost.ts
import { GetCostAndUsageCommand, type GetCostAndUsageCommandOutput } from "@aws-sdk/client-cost-explorer";
import type { Finding } from "../report.ts";
import type { MonitorState } from "../state.ts";
import type { AwsClient } from "./alarms.ts";

// SIO-1680: the fleet default is an absolute $100 gate with the percentage
// filter off (pct 0 disables it). The monitor reads env overrides against these.
export const COST_DEFAULTS = { pct: 0, abs: 100 } as const;

// SIO-1819: Bedrock bills per MODEL, so the SERVICE dimension never returns a
// value called "Bedrock" -- the live names are "Claude Sonnet 4.6 (Amazon
// Bedrock Edition)" and similar. Matching the parenthetical is what separates
// the monitor's own investigation cost from account workload spend.
const BEDROCK_SERVICE = /amazon bedrock/i;

// The cost of one day, split by service. `total` is the sum of the groups when
// the response is grouped, because AWS returns an EMPTY `Total` in that case
// (verified live 2026-09-19): reading Total alone would record 0.00 every day
// and silently flatten the baseline.
function dayCost(r: {
	Total?: { UnblendedCost?: { Amount?: string } };
	Groups?: { Keys?: string[]; Metrics?: { UnblendedCost?: { Amount?: string } } }[];
}): { total: number; byService: Record<string, number> } {
	const byService: Record<string, number> = {};
	let grouped = 0;
	for (const g of r.Groups ?? []) {
		const name = g.Keys?.[0];
		if (!name) continue;
		const usd = Number(g.Metrics?.UnblendedCost?.Amount ?? "0");
		if (!Number.isFinite(usd)) continue;
		byService[name] = (byService[name] ?? 0) + usd;
		grouped += usd;
	}
	// No groups means an ungrouped response (or a day with no spend at all):
	// fall back to Total so an older shape keeps working.
	if (Object.keys(byService).length === 0) {
		const total = Number(r.Total?.UnblendedCost?.Amount ?? "0");
		return { total: Number.isFinite(total) ? total : 0, byService };
	}
	return { total: grouped, byService };
}

export function topService(byService: Record<string, number>): { name: string; usd: number } | null {
	let top: { name: string; usd: number } | null = null;
	for (const [name, usd] of Object.entries(byService)) {
		if (!top || usd > top.usd) top = { name, usd };
	}
	return top;
}

export function bedrockSpend(byService: Record<string, number>): number {
	let sum = 0;
	for (const [name, usd] of Object.entries(byService)) if (BEDROCK_SERVICE.test(name)) sum += usd;
	return sum;
}

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
			// SIO-1819: attribution only. This does not change when the check
			// fires -- it changes what the finding can SAY when it does.
			GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
		}),
	)) as GetCostAndUsageCommandOutput;

	// Only yesterday's split is needed for the finding; the rest of the window
	// feeds the baseline as a plain total. Keyed on the DATE rather than taking
	// the last row: the window's ordering is the API's to choose.
	const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
	let yesterdayByService: Record<string, number> = {};
	for (const r of resp.ResultsByTime ?? []) {
		const date = r.TimePeriod?.Start;
		if (!date) continue;
		const { total, byService } = dayCost(r);
		state.recordCost(date, total);
		if (date === yesterday) yesterdayByService = byService;
	}

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
	// SIO-1819: name the driver. Without this a rise is just a number, and the
	// monitor's own Bedrock investigation cost reads identically to workload
	// spend. `resource` stays "account" deliberately: making it per-service would
	// split one account's spend across several per-resource investigation budget
	// buckets (budget.ts keys on finding.resource), which is a different change.
	const top = topService(yesterdayByService);
	const bedrockUsd = bedrockSpend(yesterdayByService);
	const attribution = top ? `; top service ${top.name} $${top.usd.toFixed(2)}` : "";
	return [
		{
			family: "cost",
			severity: "warn",
			resource: "account",
			// A zero baseline (fresh account) has no meaningful percentage.
			summary: `Spend ${yesterday} was $${latest.usd.toFixed(2)} vs 14d baseline $${baseline.toFixed(2)}${baseline > 0 ? ` (+${((latest.usd / baseline - 1) * 100).toFixed(0)} pct)` : " (no prior spend)"}${attribution}`,
			dedup_key: key,
			evidence: {
				date: yesterday,
				usd: latest.usd,
				baseline,
				...(top ? { topService: top } : {}),
				// Always present when grouped, including 0: "no Bedrock spend" is
				// the answer to the question this field exists for, and an absent
				// key reads as "unknown" instead.
				...(Object.keys(yesterdayByService).length > 0 ? { bedrockUsd, byService: yesterdayByService } : {}),
			},
			at: now.toISOString(),
		},
	];
}
