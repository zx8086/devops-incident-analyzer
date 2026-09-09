// scripts/monitor/budget.ts
import type { Finding } from "./report.ts";

// Every investigation prompt is a full model turn on the account's Pi agent.
// A noisy source (one application log group emitting new error signatures
// every cycle) can otherwise buy an unbounded number of turns a day; the
// budget bounds the cost per account regardless of what the checks find
// (SIO-1673). Counts are ATTEMPTS, so a failing agent cannot keep the cap
// from filling.

export type InvestigationRecord = { resources: string[]; dedup_keys: string[]; count: number; target: string };

export type InvestigationUsage = { used: number; attemptsFor: (resource: string) => number };

export function investigationUsage(rows: { payload: string }[]): InvestigationUsage {
	const perResource = new Map<string, number>();
	let used = 0;
	for (const r of rows) {
		let rec: unknown;
		try {
			rec = JSON.parse(r.payload);
		} catch {
			continue;
		}
		used++;
		const resources = (rec as { resources?: unknown }).resources;
		if (!Array.isArray(resources)) continue;
		for (const res of new Set(resources.filter((x): x is string => typeof x === "string"))) {
			perResource.set(res, (perResource.get(res) ?? 0) + 1);
		}
	}
	return { used, attemptsFor: (resource) => perResource.get(resource) ?? 0 };
}

export type BudgetLimits = { perDay: number; perResourcePerDay: number };

export type InvestigationPlan = {
	send: Finding[];
	skipped: { finding: Finding; reason: string }[];
};

export function planInvestigation(
	findings: Finding[],
	usage: InvestigationUsage,
	limits: BudgetLimits,
): InvestigationPlan {
	if (findings.length === 0) return { send: [], skipped: [] };
	if (usage.used >= limits.perDay) {
		const reason = `daily investigation budget exhausted (${usage.used}/${limits.perDay} prompts in 24h)`;
		return { send: [], skipped: findings.map((finding) => ({ finding, reason })) };
	}
	const send: Finding[] = [];
	const skipped: { finding: Finding; reason: string }[] = [];
	for (const finding of findings) {
		const attempts = usage.attemptsFor(finding.resource);
		if (attempts >= limits.perResourcePerDay) {
			skipped.push({
				finding,
				reason: `resource over daily investigation cap (${attempts}/${limits.perResourcePerDay} in 24h)`,
			});
		} else {
			send.push(finding);
		}
	}
	return { send, skipped };
}
