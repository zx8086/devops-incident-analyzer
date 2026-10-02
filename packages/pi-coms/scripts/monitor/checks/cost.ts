// scripts/monitor/checks/cost.ts
import { GetCostAndUsageCommand, type GetCostAndUsageCommandOutput } from "@aws-sdk/client-cost-explorer";
import type { Finding } from "../report.ts";
import type { MonitorState } from "../state.ts";
import type { AwsClient } from "./alarms.ts";

// SIO-1680: the fleet default is an absolute $100 gate with the percentage
// filter off (pct 0 disables it). The monitor reads env overrides against these.
export const COST_DEFAULTS = { pct: 0, abs: 100 } as const;

// SIO-1923: Cost Explorer posts a day's charges over the following day, so at
// the 06:15Z daily run "yesterday" is only partly posted (eu-shared-services-prd
// 2026-10-01 read $0.00: Bedrock absent, a daily Data Transfer credit cancelling
// the rest). Judging it alerts on a partial number, and a day is judged only
// once, so a spike posted late was never alerted. Judge the day before instead.
export function settledCostDate(now: Date): string {
	return new Date(now.getTime() - 2 * 86_400_000).toISOString().slice(0, 10);
}

// The digest reports only what a check run actually judged. Re-reading the
// costs table instead would print the day's earlier partial figure as settled
// whenever the check failed or the monitor was paused.
export const COST_JUDGED_SNAPSHOT = "cost-judged";

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
	// 16 days: the judged day (D-2) plus its 14-day baseline, plus D-1 so the
	// partial day is still recorded for the next run.
	const start = new Date(now.getTime() - 16 * 86_400_000).toISOString().slice(0, 10);
	// GetCostAndUsage pages. Measured live on eu-shared-services-prd (15 days,
	// ~30 service groups/day) it returns no NextPageToken today -- confirmed with
	// the raw CLI and --no-paginate -- but an account with more services will
	// page, and BOTH failure modes are silent: a day split across pages records
	// an understated total (flattening the baseline), and a final page that never
	// arrives would make the judged day missing. Accumulate every page, then
	// record once per date.
	const day = settledCostDate(now);
	const totals = new Map<string, number>();
	const byDate = new Map<string, Record<string, number>>();
	let nextPageToken: string | undefined;
	do {
		const resp = (await client.send(
			new GetCostAndUsageCommand({
				TimePeriod: { Start: start, End: end },
				Granularity: "DAILY",
				Metrics: ["UnblendedCost"],
				// SIO-1819: attribution only. This does not change when the check
				// fires -- it changes what the finding can SAY when it does.
				GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
				NextPageToken: nextPageToken,
			}),
		)) as GetCostAndUsageCommandOutput;
		for (const r of resp.ResultsByTime ?? []) {
			const date = r.TimePeriod?.Start;
			if (!date) continue;
			const { total, byService } = dayCost(r);
			totals.set(date, (totals.get(date) ?? 0) + total);
			// Merge rather than replace: the same date can appear on several pages
			// with a different slice of its services on each.
			const merged = byDate.get(date) ?? {};
			for (const [svc, usd] of Object.entries(byService)) merged[svc] = (merged[svc] ?? 0) + usd;
			byDate.set(date, merged);
		}
		nextPageToken = resp.NextPageToken;
	} while (nextPageToken);

	for (const [date, total] of totals) state.recordCost(date, total);
	const dayByService = byDate.get(day) ?? {};

	// Judge only a day this response returned: a stored figure from an earlier
	// run may predate the day's late postings.
	const usd = totals.get(day);
	if (usd === undefined) return [];
	const baseline = state.costBaseline(day, 14);
	state.setSnapshot(COST_JUDGED_SNAPSHOT, {
		date: day,
		usd: String(usd),
		baseline: baseline === null ? "" : String(baseline),
	});
	if (baseline === null) return [];

	// Alert only when over by BOTH thresholds: pct filters noise on small
	// accounts, abs filters noise on near-zero baselines. A pct of 0 or less
	// turns the percentage gate off explicitly, so abs alone decides (SIO-1680).
	const overPct = pct <= 0 || usd > baseline * (1 + pct / 100);
	const overAbs = usd > baseline + abs;
	if (!(overPct && overAbs)) return [];

	const key = `cost:${day}`;
	if (!state.shouldAlert(key)) return [];
	state.markAlerted(key, "cost");
	// SIO-1819: name the driver. Without this a rise is just a number, and the
	// monitor's own Bedrock investigation cost reads identically to workload
	// spend. `resource` stays "account" deliberately: making it per-service would
	// split one account's spend across several per-resource investigation budget
	// buckets (budget.ts keys on finding.resource), which is a different change.
	const top = topService(dayByService);
	const bedrockUsd = bedrockSpend(dayByService);
	const attribution = top ? `; top service ${top.name} $${top.usd.toFixed(2)}` : "";
	return [
		{
			family: "cost",
			severity: "warn",
			resource: "account",
			// A zero baseline (fresh account) has no meaningful percentage.
			summary: `Spend ${day} was $${usd.toFixed(2)} vs 14d baseline $${baseline.toFixed(2)}${baseline > 0 ? ` (+${((usd / baseline - 1) * 100).toFixed(0)} pct)` : " (no prior spend)"}${attribution}`,
			dedup_key: key,
			evidence: {
				date: day,
				usd,
				baseline,
				...(top ? { topService: top } : {}),
				// Always present when grouped, including 0: "no Bedrock spend" is
				// the answer to the question this field exists for, and an absent
				// key reads as "unknown" instead.
				...(Object.keys(dayByService).length > 0 ? { bedrockUsd, byService: dayByService } : {}),
			},
			at: now.toISOString(),
		},
	];
}
