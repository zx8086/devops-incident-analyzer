// scripts/monitor/checks/health.ts
import { DescribeEventsCommand, type DescribeEventsCommandOutput, type Event } from "@aws-sdk/client-health";
import { errorMessage } from "../errors.ts";
import type { Finding, Severity } from "../report.ts";
import type { MonitorState } from "../state.ts";
import type { AwsClient } from "./alarms.ts";

// SIO-1740: AWS-side incidents were only visible once they tripped an alarm.
// health:DescribeEvents has been granted all along and nothing read it.
const REALERT_MS = 86_400_000;
// A scheduled change further out than this is planning, not an incident.
const UPCOMING_WARN_MS = 48 * 3_600_000;
const UNSUPPORTED_KEY = "health:unsupported:";
const UNSUPPORTED_REALERT_MS = 7 * 86_400_000;

export type CheckHealthOpts = { now?: number; regions?: string[] };

function severityFor(e: Event, now: number): Severity {
	const category = e.eventTypeCategory ?? "";
	if (category === "issue" || category === "investigation") return "warn";
	if (category === "scheduledChange") {
		const start = e.startTime ? new Date(e.startTime).getTime() : now;
		return start - now > UPCOMING_WARN_MS ? "info" : "warn";
	}
	return "info";
}

export async function checkHealth(
	client: AwsClient,
	state: MonitorState,
	opts: CheckHealthOpts = {},
): Promise<Finding[]> {
	const now = opts.now ?? Date.now();
	const at = new Date(now).toISOString();
	const findings: Finding[] = [];
	const events: Event[] = [];
	let nextToken: string | undefined;
	try {
		do {
			const resp = (await client.send(
				new DescribeEventsCommand({
					filter: {
						eventStatusCodes: ["open", "upcoming"],
						...(opts.regions ? { regions: opts.regions } : {}),
					},
					nextToken,
				}),
			)) as DescribeEventsCommandOutput;
			events.push(...(resp.events ?? []));
			nextToken = resp.nextToken;
		} while (nextToken);
	} catch (e) {
		// The Health API is gated on a Business or Enterprise support plan; an
		// account without one answers SubscriptionRequiredException on every
		// call. That is a fact about the account, not a broken check: say it
		// once a week instead of degrading the digest every cycle.
		if ((e as { name?: string }).name === "SubscriptionRequiredException") {
			if (state.shouldAlert(UNSUPPORTED_KEY, UNSUPPORTED_REALERT_MS)) {
				state.markAlerted(UNSUPPORTED_KEY, "health");
				findings.push({
					family: "health",
					severity: "info",
					resource: "aws-health",
					summary: "AWS Health API not available in this account (needs a Business or Enterprise support plan)",
					dedup_key: UNSUPPORTED_KEY,
					evidence: { error: errorMessage(e) },
					at,
				});
			}
			return findings;
		}
		throw e;
	}

	// The key carries the severity, so a scheduled change that crosses into
	// the 48h window moves from info to warn at once instead of waiting out
	// the info key's re-alert interval. An event that is no longer open loses
	// its keys and re-alerts if it ever reopens.
	const live = new Set(events.map((e) => `health:${e.arn ?? "unknown"}:`));
	for (const key of state.alertKeys("health:")) {
		if (key === UNSUPPORTED_KEY) continue;
		// The ARN carries colons of its own; the severity is the last segment.
		const prefix = key.slice(0, key.lastIndexOf(":") + 1);
		if (!live.has(prefix)) state.clearAlerts(key);
	}

	for (const e of events) {
		const arn = e.arn ?? "unknown";
		const severity = severityFor(e, now);
		const key = `health:${arn}:${severity}`;
		if (!state.shouldAlert(key, REALERT_MS)) continue;
		state.markAlerted(key, "health");
		const region = e.region ?? "global";
		const service = e.service ?? "unknown";
		findings.push({
			family: "health",
			severity,
			resource: `${service}/${region}`,
			summary: `AWS Health ${e.eventTypeCategory ?? "event"} ${e.eventTypeCode ?? ""} (${e.statusCode ?? "unknown"}) for ${service} in ${region}`,
			dedup_key: key,
			evidence: {
				arn,
				service,
				eventTypeCode: e.eventTypeCode ?? null,
				category: e.eventTypeCategory ?? null,
				status: e.statusCode ?? null,
				scope: e.eventScopeCode ?? null,
				region,
				startTime: e.startTime ? new Date(e.startTime).toISOString() : null,
				endTime: e.endTime ? new Date(e.endTime).toISOString() : null,
				lastUpdatedTime: e.lastUpdatedTime ? new Date(e.lastUpdatedTime).toISOString() : null,
			},
			at,
		});
	}
	return findings;
}
