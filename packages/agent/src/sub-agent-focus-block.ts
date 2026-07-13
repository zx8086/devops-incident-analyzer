// packages/agent/src/sub-agent-focus-block.ts
import type { InvestigationFocus, ResolvedIdentifiers } from "@devops-agent/shared";

// SIO-1079: the per-turn, volatile block appended to a sub-agent's system prompt. It
// carries (a) a real current-time anchor and (b) the investigation focus. The clock is a
// parameter (not read from Date here) so the block is deterministic and unit-testable; the
// caller passes new Date().toISOString(). Kept out of the cached base prompt because both
// the time anchor and the focus change every turn.
//
// The current-time line is the fix for the AWS sub-agent choosing CloudWatch query windows
// with no "now" reference: without it the LLM invented Unix epoch seconds unmoored from the
// real clock and anchored aws_logs_start_query outside the log group's retention window.
//
// SIO-1080: adding the current time was not enough -- the LLM OVERRODE it, shifting a 2026
// incident timestamp back to 2025 (its training prior mis-dates "now") and landing outside
// retention. So the year is now asserted as a standalone imperative fact derived from nowIso,
// with an explicit prohibition on adjusting the incident year. (A deterministic guard in the
// AWS start-query tool, correctYearDrift, is the load-bearing backstop when this is ignored.)
export function buildFocusBlock(
	focus: InvestigationFocus | undefined,
	nowIso: string,
	resolved?: ResolvedIdentifiers,
	dataSourceId?: string,
): string {
	const currentYear = nowIso.slice(0, 4);
	const timeAnchor =
		`\n\n---\n\nCurrent time: ${nowIso}. THE CURRENT YEAR IS ${currentYear}. ` +
		"Treat every incident/event timestamp given to you as literal ground truth -- never shift, " +
		"adjust, correct, or reinterpret its YEAR, even if the timestamp appears to be in the future " +
		"relative to your own sense of the date. Your internal sense of the current date may be stale; " +
		`this "Current time" value is authoritative. When a tool needs a time window (e.g. CloudWatch ` +
		"Logs Insights startTime/endTime, which are Unix epoch SECONDS), compute the epoch from the " +
		"incident timestamp EXACTLY as given, anchor to it and to this current time, never guess an " +
		"absolute epoch, and keep the window within the data source's retention.";

	if (!focus) return timeAnchor;

	// SIO-1084: name-resolution is IN scope. "Do not pivot" means do not investigate
	// UNRELATED services -- it must NOT discourage discovering the correct canonical
	// identifier for an anchored service (the incident's loose name is frequently NOT
	// the store's real service.name / log group / scope), which is the grounding step.
	const focusBlock =
		`${timeAnchor}\n\n---\n\nINVESTIGATION FOCUS (continuing across turns):\n` +
		`- Summary: ${focus.summary}\n` +
		`- Anchored services: ${focus.services.join(", ") || "(none)"}\n` +
		`- Anchored time window: ${focus.timeWindow ? `${focus.timeWindow.from} to ${focus.timeWindow.to}` : "(none)"}\n\n` +
		"Stay scoped to this investigation: do not investigate UNRELATED services, clusters, " +
		"or time ranges. Resolving an anchored service's real identifier IS in scope -- you MAY " +
		"enumerate all service.names / log groups / scopes/collections / topics to find the " +
		"canonical name that corresponds to an anchored service, then query that. If the user's " +
		'current message references "kafka" or "the broker" or similar pronouns, resolve them ' +
		"against the anchored services list, not the broadest possible interpretation.";

	const resolvedBlock = buildResolvedBlock(focus, resolved, dataSourceId);
	return resolvedBlock ? `${focusBlock}${resolvedBlock}` : focusBlock;
}

// SIO-1084: render the current datasource's pre-resolved canonical identifiers, if
// the resolveIdentifiers node produced them for THIS focus. Guarded on the stamp so
// a stale prior-turn resolution (against a different service set) is never shown.
function buildResolvedBlock(
	focus: InvestigationFocus,
	resolved: ResolvedIdentifiers | undefined,
	dataSourceId: string | undefined,
): string {
	if (!resolved || !dataSourceId) return "";
	if (!sameServiceSet(resolved.resolvedForServices, focus.services)) return "";

	const lines = renderDatasourceLines(resolved, dataSourceId);
	if (lines.length === 0) return "";

	return (
		"\n\n---\n\nRESOLVED IDENTIFIERS (candidates to verify, probed this turn):\n" +
		`${lines.join("\n")}\n\n` +
		"Use these exact names in tool calls. They are candidates from a fast enumeration probe -- " +
		"if one looks wrong, verify with a listing/schema tool before assuming."
	);
}

function renderDatasourceLines(resolved: ResolvedIdentifiers, dataSourceId: string): string[] {
	const lines: string[] = [];
	switch (dataSourceId) {
		case "elastic":
			if (resolved.elastic?.serviceNames.length) {
				lines.push(`- Elastic service.name candidates: ${resolved.elastic.serviceNames.join(", ")}`);
				// SIO-1090: hand the agent the WORKING broad query shape so it finds the data in
				// one call instead of thrashing. The incident message can live in generic app logs
				// (`message`), APM app logs, OR APM error logs (`error.exception.message`) -- searching
				// only one index/field misses it (validated live: the AFS message is ~100x more
				// present in `message` than in `error.exception.message`). Search all candidate fields
				// across logs-*,logs-apm.* with a wide default window; a chronic error is easily missed
				// by a narrow slice.
				lines.push(
					"  Search across index `logs-*,logs-apm.*` with ONE query: a `terms` filter on the " +
						"candidate service.name(s) + a `multi_match` (`type: phrase`) of the cited error over " +
						"fields [`message`, `error.exception.message`, `body.text`], and an `@timestamp` range " +
						"`gte: now-30d` (wide by default -- do NOT bound to a 1h/24h slice; a chronic error " +
						"recurs for days at low frequency). Report which `_index` and field matched, the exact " +
						"count (`track_total_hits: true`), the latest timestamp, and sample messages. Do NOT " +
						"pin to `logs-apm.error-*` only, and do NOT run per-name permutations -- put all " +
						"candidate names in one `terms` filter.",
				);
			}
			break;
		case "couchbase":
			if (resolved.couchbase && Object.keys(resolved.couchbase.scopes).length > 0) {
				lines.push(
					"- Couchbase scopes -> collections (query with a collection-only FROM and the matching scope_name; do NOT write a bucket.scope.collection path):",
				);
				// SIO-1088: a bare SELECT * needs a PRIMARY index. A collection with only SECONDARY
				// indexes REJECTS SELECT * with "no index available" -- but its data is fully queryable
				// via a WHERE clause LEADING on a secondary index key field. So tag each collection
				// [PRIMARY] (SELECT * ok) vs [SECONDARY ONLY - query WHERE on: <fields>], and list the
				// exact key fields so the agent builds a covered query instead of mis-reading the
				// SELECT * failure as "no data / missing index". Keep EVERY collection listed.
				const indexInfo = resolved.couchbase.indexInfo;
				const indexProbeRan = indexInfo !== undefined;
				// SIO-1088: these are DISTINCT states with DIFFERENT remediation. A [SECONDARY ONLY]
				// collection is queryable via a WHERE that leads on a key field; a [NO USABLE INDEX]
				// collection can't be satisfied by ANY WHERE (no index to plan against) and needs
				// key-based lookup. Conflating them would hand the WHERE guidance to a no-index
				// collection -> the agent tries a WHERE, it fails, and it may re-misread that as absence.
				let anySecondaryOnly = false;
				let anyNoUsableIndex = false;
				for (const [scope, collections] of Object.entries(resolved.couchbase.scopes)) {
					if (!indexProbeRan) {
						lines.push(`    ${scope}: [${collections.join(", ")}]`);
						continue;
					}
					const byCollection = indexInfo[scope] ?? {};
					const tagged = collections.map((c) => {
						const info = byCollection[c];
						if (info?.hasPrimary) return `${c} [PRIMARY index - SELECT * ok]`;
						if (info && info.secondaryKeyFields.length > 0) {
							anySecondaryOnly = true;
							return `${c} [SECONDARY ONLY - query WHERE on: ${info.secondaryKeyFields.join(", ")}]`;
						}
						// Present in the scope map but no online index at all.
						anyNoUsableIndex = true;
						return `${c} [NO USABLE INDEX - use capella_get_document_by_id / USE KEYS]`;
					});
					lines.push(`    ${scope}: [${tagged.join(", ")}]`);
				}
				if (indexProbeRan && anySecondaryOnly) {
					lines.push(
						"    A [SECONDARY ONLY] collection HAS data but no primary index -- a bare SELECT * FAILS with 'no index available' (this is NOT missing data). Query it with a WHERE clause that LEADS on one of the listed key fields, e.g. SELECT <fields> FROM <collection> WHERE <firstKeyField> = <value> [AND ...]. Never conclude a collection is empty or has a schema problem from a SELECT * failure.",
					);
				}
				if (indexProbeRan && anyNoUsableIndex) {
					lines.push(
						"    A [NO USABLE INDEX] collection may still have data -- NO WHERE query can be planned without any index (a WHERE will also fail with 'no index available'). Use capella_get_document_by_id or USE KEYS instead. Never conclude it is empty from a SELECT * or WHERE failure.",
					);
				}
			}
			break;
		case "aws":
			if (resolved.aws?.logGroups.length) {
				lines.push(`- AWS log groups: ${resolved.aws.logGroups.join(", ")}`);
			}
			if (resolved.aws?.ecsServices?.length) {
				lines.push(`- AWS ECS services: ${resolved.aws.ecsServices.join(", ")}`);
			}
			break;
		case "kafka":
			if (resolved.kafka?.topics.length) {
				lines.push(`- Kafka topics: ${resolved.kafka.topics.join(", ")}`);
			}
			if (resolved.kafka?.consumerGroups.length) {
				lines.push(`- Kafka consumer groups: ${resolved.kafka.consumerGroups.join(", ")}`);
			}
			break;
		case "konnect":
			if (resolved.konnect?.controlPlaneId) {
				const name = resolved.konnect.controlPlaneName ? ` (${resolved.konnect.controlPlaneName})` : "";
				lines.push(`- Konnect controlPlaneId: ${resolved.konnect.controlPlaneId}${name}`);
			}
			if (resolved.konnect?.serviceIds?.length) {
				lines.push(`- Konnect service ids: ${resolved.konnect.serviceIds.join(", ")}`);
			}
			break;
		case "gitlab":
			if (resolved.gitlab?.projectId) {
				const path = resolved.gitlab.pathWithNamespace ? ` (${resolved.gitlab.pathWithNamespace})` : "";
				lines.push(`- GitLab numeric project_id: ${resolved.gitlab.projectId}${path}`);
			}
			break;
		case "atlassian":
			if (resolved.atlassian?.jiraProjectKeys.length) {
				lines.push(`- Jira project keys: ${resolved.atlassian.jiraProjectKeys.join(", ")}`);
			}
			if (resolved.atlassian?.confluenceSpaceKeys.length) {
				lines.push(`- Confluence space keys: ${resolved.atlassian.confluenceSpaceKeys.join(", ")}`);
			}
			break;
	}
	return lines;
}

// SIO-1084: case-insensitive SET equality. Compares the deduped lowercased sets in
// both directions -- a plain length + one-directional membership check would treat
// e.g. ["orders","ORDERS"] as equal to ["orders","payments"] (a stale-resolution
// false positive), so we dedupe first and require mutual containment.
function sameServiceSet(a: string[], b: string[]): boolean {
	const setA = new Set(a.map((s) => s.toLowerCase()));
	const setB = new Set(b.map((s) => s.toLowerCase()));
	if (setA.size !== setB.size) return false;
	for (const s of setA) {
		if (!setB.has(s)) return false;
	}
	return true;
}
