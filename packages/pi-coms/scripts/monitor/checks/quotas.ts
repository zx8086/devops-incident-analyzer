// scripts/monitor/checks/quotas.ts
import {
	DescribeTrustedAdvisorCheckSummariesCommand,
	type DescribeTrustedAdvisorCheckSummariesCommandOutput,
	DescribeTrustedAdvisorChecksCommand,
	type DescribeTrustedAdvisorChecksCommandOutput,
} from "@aws-sdk/client-support";
import type { Finding, Severity } from "../report.ts";
import type { MonitorState } from "../state.ts";
import type { AwsClient } from "./alarms.ts";

// SIO-1750. This replaces the Service Quotas design entirely.
//
// The original plan walked servicequotas:ListServiceQuotas per service and
// correlated each limit against AWS/Usage metrics to derive a utilisation
// percentage -- a per-quota walk, a metric query per quota, and a threshold we
// would have had to invent. Trusted Advisor already does all of it: ONE
// DescribeTrustedAdvisorCheckSummaries call answers all 52 service-limit
// checks, and each carries AWS's own ok / warning / error verdict. Verified in
// production: 52 checks, one call, all ok.
//
// The API is us-east-1 only and needs a Business or Enterprise support plan.
// An account without one answers SubscriptionRequiredException, which is a
// fact about the support contract, not a broken check -- reported once a week
// as info, exactly as checks/health.ts treats the same exception.
const CATEGORY = "service_limits";
const SUBSCRIPTION_INFO_MS = 604_800_000;
const REALERT_MS = 86_400_000;
// The summaries API takes the check ids in one request; this caps the batch so
// a future expansion of the catalogue cannot build an oversized call.
const BATCH = 100;

export type CheckQuotasOpts = { now?: number };

export function severityForAdvisorStatus(status: string): Severity | null {
	// AWS's own words: "error" is a limit reached, "warning" is approaching one.
	if (status === "error") return "critical";
	if (status === "warning") return "warn";
	return null;
}

function isSubscriptionRequired(e: unknown): boolean {
	const name = (e as { name?: string })?.name ?? "";
	const message = (e as { message?: string })?.message ?? "";
	return name === "SubscriptionRequiredException" || message.includes("SubscriptionRequiredException");
}

export async function checkQuotas(
	client: AwsClient,
	state: MonitorState,
	opts: CheckQuotasOpts = {},
): Promise<Finding[]> {
	const now = opts.now ?? Date.now();
	const at = new Date(now).toISOString();
	const findings: Finding[] = [];

	let checks: { id?: string; name?: string }[];
	try {
		const resp = (await client.send(
			new DescribeTrustedAdvisorChecksCommand({ language: "en" }),
		)) as DescribeTrustedAdvisorChecksCommandOutput;
		checks = (resp.checks ?? []).filter((c) => c.category === CATEGORY);
	} catch (e) {
		if (!isSubscriptionRequired(e)) throw e;
		const key = "quotas:subscription";
		if (!state.shouldAlert(key, SUBSCRIPTION_INFO_MS)) return [];
		state.markAlerted(key, "quotas");
		return [
			{
				family: "quotas",
				severity: "info",
				resource: "trusted-advisor",
				summary: "Service-limit checks not inspected: Trusted Advisor needs a Business or Enterprise support plan",
				dedup_key: key,
				evidence: { reason: "SubscriptionRequiredException", category: CATEGORY },
				at,
			},
		];
	}

	const byId = new Map(checks.map((c) => [c.id ?? "", c.name ?? c.id ?? "unknown"]));
	const ids = checks.map((c) => c.id).filter((x): x is string => Boolean(x));
	const stillFailing = new Set<string>();

	for (let i = 0; i < ids.length; i += BATCH) {
		const resp = (await client.send(
			new DescribeTrustedAdvisorCheckSummariesCommand({ checkIds: ids.slice(i, i + BATCH) }),
		)) as DescribeTrustedAdvisorCheckSummariesCommandOutput;
		for (const s of resp.summaries ?? []) {
			const status = s.status ?? "not_available";
			const severity = severityForAdvisorStatus(status);
			if (severity === null) continue;
			const name = byId.get(s.checkId ?? "") ?? s.checkId ?? "unknown";
			const key = `quotas:${s.checkId}:${status}`;
			stillFailing.add(key);
			if (!state.shouldAlert(key, REALERT_MS)) continue;
			state.markAlerted(key, "quotas");
			findings.push({
				family: "quotas",
				severity,
				resource: name,
				summary: `Service limit ${status === "error" ? "reached" : "approaching"}: ${name} (${
					s.resourcesSummary?.resourcesFlagged ?? 0
				} resource(s) flagged)`,
				dedup_key: key,
				evidence: {
					checkId: s.checkId ?? null,
					checkName: name,
					status,
					flagged: s.resourcesSummary?.resourcesFlagged ?? null,
					processed: s.resourcesSummary?.resourcesProcessed ?? null,
					// Trusted Advisor stamps when it last evaluated, which matters:
					// a stale summary is not the same as a healthy one.
					evaluatedAt: s.timestamp ?? null,
				},
				at,
			});
		}
	}

	// A limit that is no longer flagged re-arms, so the next time it is hit the
	// alert is immediate rather than a day late.
	for (const key of state.alertKeys("quotas:")) {
		if (key === "quotas:subscription") continue;
		if (!stillFailing.has(key)) state.clearAlerts(key);
	}
	return findings;
}
