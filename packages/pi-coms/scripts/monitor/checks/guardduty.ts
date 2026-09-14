// scripts/monitor/checks/guardduty.ts
import {
	GetFindingsCommand,
	type GetFindingsCommandOutput,
	type Finding as GuardDutyFinding,
	ListDetectorsCommand,
	type ListDetectorsCommandOutput,
	ListFindingsCommand,
	type ListFindingsCommandOutput,
} from "@aws-sdk/client-guardduty";
import type { Finding, Severity } from "../report.ts";
import type { MonitorState } from "../state.ts";
import type { AwsClient } from "./alarms.ts";

// SIO-1740: guardduty:ListFindings/GetFindings were granted and unread. A
// detector's findings above the floor become monitor findings; GuardDuty's
// own 0-9 scale maps to the monitor's: 7+ is critical, else warn.
const MIN_SEVERITY = 4;
const CRITICAL_AT = 7;
const FIRST_LOOKBACK_MS = 86_400_000;
const REALERT_MS = 86_400_000;
const PAGE = 50;

export type CheckGuardDutyOpts = { now?: number };

function severityFor(s: number | undefined): Severity {
	return (s ?? 0) >= CRITICAL_AT ? "critical" : "warn";
}

export async function checkGuardDuty(
	client: AwsClient,
	state: MonitorState,
	opts: CheckGuardDutyOpts = {},
): Promise<Finding[]> {
	const now = opts.now ?? Date.now();
	const at = new Date(now).toISOString();
	const findings: Finding[] = [];
	const detectors = (await client.send(new ListDetectorsCommand({}))) as ListDetectorsCommandOutput;
	// No detector is a fact about the account (GuardDuty not enabled here), not
	// a failed check; the watchlist and Config checks still cover it.
	for (const detectorId of detectors.DetectorIds ?? []) {
		const wmKey = `guardduty:${detectorId}`;
		const since = state.getWatermark(wmKey) ?? now - FIRST_LOOKBACK_MS;
		const ids: string[] = [];
		let nextToken: string | undefined;
		do {
			const resp = (await client.send(
				new ListFindingsCommand({
					DetectorId: detectorId,
					FindingCriteria: {
						Criterion: {
							severity: { GreaterThanOrEqual: MIN_SEVERITY },
							updatedAt: { GreaterThanOrEqual: since },
						},
					},
					SortCriteria: { AttributeName: "updatedAt", OrderBy: "ASC" },
					MaxResults: PAGE,
					NextToken: nextToken,
				}),
			)) as ListFindingsCommandOutput;
			ids.push(...(resp.FindingIds ?? []));
			nextToken = resp.NextToken;
		} while (nextToken);

		// Nothing is marked or advanced until every batch is in hand: a later
		// batch that throws must not leave the earlier ones fingerprinted but
		// undelivered (they would then be silent for a day on the retry).
		const collected: Finding[] = [];
		const toMark: string[] = [];
		let newest = since;
		for (let i = 0; i < ids.length; i += PAGE) {
			const resp = (await client.send(
				new GetFindingsCommand({ DetectorId: detectorId, FindingIds: ids.slice(i, i + PAGE) }),
			)) as GetFindingsCommandOutput;
			for (const f of (resp.Findings ?? []) as GuardDutyFinding[]) {
				const updated = f.UpdatedAt ? Date.parse(f.UpdatedAt) : now;
				if (updated > newest) newest = updated;
				const id = f.Id ?? "unknown";
				// Re-alert on the same finding id only after a day; GuardDuty bumps
				// UpdatedAt on every recurrence, which would otherwise page per event.
				const key = `guardduty:${id}:`;
				if (!state.shouldAlert(key, REALERT_MS)) continue;
				toMark.push(key);
				const resourceType = f.Resource?.ResourceType ?? "unknown";
				collected.push({
					family: "guardduty",
					severity: severityFor(f.Severity),
					resource: `${resourceType}/${id}`,
					summary: `GuardDuty ${f.Type ?? "finding"} (severity ${f.Severity ?? "?"}): ${f.Title ?? ""}`,
					dedup_key: key,
					evidence: {
						id,
						type: f.Type ?? null,
						severity: f.Severity ?? null,
						resourceType,
						region: f.Region ?? null,
						count: f.Service?.Count ?? null,
						firstSeen: f.Service?.EventFirstSeen ?? null,
						lastSeen: f.Service?.EventLastSeen ?? null,
						updatedAt: f.UpdatedAt ?? null,
					},
					at,
				});
			}
		}
		for (const key of toMark) state.markAlerted(key, "guardduty");
		findings.push(...collected);
		// The watermark is bounded by this scan's start: a detail read can carry
		// an UpdatedAt from after the listing, and moving past it would skip a
		// finding that appeared in between. Findings updated during the scan are
		// listed again next time and fall to the fingerprint.
		state.setWatermark(wmKey, Math.min(newest, now));
	}
	return findings;
}
