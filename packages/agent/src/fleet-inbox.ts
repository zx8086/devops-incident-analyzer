// packages/agent/src/fleet-inbox.ts
// SIO-1652: pure helpers behind the fetchFleetInbox node. Inbox bodies are
// untrusted input (spoke model output, operator free text): they are classified
// and excerpted for the card, and only structured facts reach the prompt.
import { FINDING_LINE_RE, type MonitorMessageKind, parseMonitorHeader } from "@devops-agent/pi-coms/contracts";
import type {
	FleetInboxCounts,
	FleetInboxDigest,
	FleetInboxEntry,
	FleetInboxEstate,
	FleetInboxFamilyCount,
	FleetInboxFinding,
	FleetInboxKind,
	FleetInboxSeverity,
	PiComsEnvironment,
} from "@devops-agent/shared";
import { MONITOR_INBOX_KINDS, matchesFocus } from "@devops-agent/shared";
import { isMonitorAgentName, MONITOR_NAME_PREFIX, type PiInboxMessage } from "./action-tools/pi-coms-client.ts";
import { readPiComsCapability } from "./action-tools/pi-verifier.ts";
import type { AgentStateType } from "./state.ts";

export const EXCERPT_MAX = 280;
export const MAX_ENTRIES_PER_ESTATE = 20;
// A logs-overflow report can list dozens of signatures; the card and the prompt need the
// shape of a report, not every line of it.
export const MAX_FINDINGS_PER_ENTRY = 12;
export const MAX_FOCUS_FINDINGS_IN_PROMPT = 8;
// The hub caps a mailbox listing at 100; without `since` it returns the newest.
export const MAILBOX_READ_LIMIT = 100;
export const DEFAULT_FLEET_INBOX_TIMEOUT_MS = 5000;
// setTimeout delays above the 32-bit signed max overflow to 1 ms.
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DEFAULT_WINDOW_MS = 24 * 3600_000;
// The analyzer's own hub traffic: verify/investigate senders (SIO-1635) and the
// pi-fleet pane (SIO-1650). Dropped so the digest never echoes the analyzer.
const DEFAULT_EXCLUDED_SENDER_PREFIXES = ["incident-analyzer-", "pi-fleet-"];
const TERMINAL_STATUSES = new Set(["complete", "error", "timeout"]);

// SIO-1655: default ON (kill-switch semantics). Set PI_COMS_INBOX_ENABLED=false
// (or 0) to disable. The node self-skips when no hub is configured, so a
// deployment without pi-coms is unaffected either way.
export function isFleetInboxEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return readPiComsCapability(env, "inbox");
}

export function fleetInboxTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const parsed = Number(env.PI_COMS_INBOX_TIMEOUT_MS);
	if (Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_TIMER_DELAY_MS) return parsed;
	return DEFAULT_FLEET_INBOX_TIMEOUT_MS;
}

export function excludedSenderPrefixes(env: NodeJS.ProcessEnv = process.env): string[] {
	const raw = env.PI_COMS_INBOX_EXCLUDE_SENDERS;
	if (raw === undefined || raw.trim() === "") return [...DEFAULT_EXCLUDED_SENDER_PREFIXES];
	return raw
		.split(",")
		.map((p) => p.trim())
		.filter((p) => p !== "");
}

export function isExcludedSender(message: Pick<PiInboxMessage, "sender_name">, prefixes: string[]): boolean {
	return prefixes.some((p) => message.sender_name.startsWith(p));
}

const ROLE_ARN_RE = /^arn:aws[\w-]*:iam::(\d{12}):/;

// The account behind an estate, from the assumed-role ARN in AWS_ESTATES. The
// monitor's report header names the account, not the estate.
export function accountIdForEstate(estate: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const raw = env.AWS_ESTATES;
	if (!raw) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const entry = (parsed as Record<string, unknown>)[estate];
	if (typeof entry !== "object" || entry === null) return undefined;
	const arn = (entry as { assumedRoleArn?: unknown }).assumedRoleArn;
	if (typeof arn !== "string") return undefined;
	return ROLE_ARN_RE.exec(arn)?.[1];
}

export type IncidentWindow = { from: string; to: string };

// Same precedence as the normalizer's follow-up inheritance: the investigation
// focus first, the normalized incident as the legacy fallback, else the last 24 h.
export function incidentWindow(
	state: Pick<AgentStateType, "investigationFocus" | "normalizedIncident">,
	now: Date = new Date(),
): IncidentWindow {
	const focus = state.investigationFocus?.timeWindow;
	if (focus) return { from: focus.from, to: focus.to };
	const normalized = state.normalizedIncident?.timeWindow;
	if (normalized) return { from: normalized.from, to: normalized.to };
	return { from: new Date(now.getTime() - DEFAULT_WINDOW_MS).toISOString(), to: now.toISOString() };
}

// `detail` is the finding's indented continuation lines (evidence, and the spoke's
// "cause:" once it has diagnosed the finding). It exists to be MATCHED against the focus
// services and goes nowhere else: it is the one place a shared log group's finding names
// the service it is about, and it is free text that must never reach a prompt.
export type MonitorFinding = {
	severity: FleetInboxSeverity;
	family: string;
	resource: string;
	summary: string;
	detail: string;
};
export type MonitorReport = {
	kind: MonitorMessageKind;
	accountId: string;
	topSeverity: FleetInboxSeverity;
	// Incident reports only: the count the header states. null for a digest (its
	// counts are a 24 h rollup) and a suppression review (it has none).
	findingCount: number | null;
	findings: MonitorFinding[];
};

// The monitor's own wire format (packages/pi-coms/scripts/monitor/report.ts): a
// header line, then one finding line per finding with indented continuation
// lines. SIO-1814 put the finding line's shape in the monitor's shared contract;
// SIO-1825 put the four HEADER shapes there too, after the analyzer's
// incident-only header regex silently dropped every daily digest and suppression
// review (they parsed as undefined and were filtered out as conversations).
export function parseMonitorReport(text: string): MonitorReport | undefined {
	const lines = text.split("\n");
	const header = parseMonitorHeader(lines[0] ?? "");
	if (!header) return undefined;
	const findings: MonitorFinding[] = [];
	// A digest's notable lines carry the same "(sev/family) resource: summary"
	// shape behind a two-space indent, and are a 24 h rollup of findings already
	// reported. FINDING_LINE_RE is anchored at column 0 so they never match here;
	// skipping the whole loop makes that explicit rather than incidental, and
	// keeps a digest's findings[] empty so nothing double-counts them.
	if (header.kind === "incident-report") {
		for (const line of lines.slice(1)) {
			const m = FINDING_LINE_RE.exec(line);
			if (!m) {
				// Continuation lines are indented under their finding (report.ts).
				const open = findings.at(-1);
				if (open && /^\s+\S/.test(line)) open.detail += `${open.detail ? " " : ""}${line.trim()}`;
				continue;
			}
			findings.push({
				severity: m[1] as FleetInboxSeverity,
				family: m[2] ?? "",
				resource: m[3] ?? "",
				summary: m[4] ?? "",
				detail: "",
			});
		}
	}
	return {
		kind: header.kind,
		accountId: header.accountId,
		topSeverity: header.severity as FleetInboxSeverity,
		findingCount: header.findingCount,
		findings,
	};
}

// The monitor kind as the inbox labels it. Kept as a mapping rather than reusing
// the contract's names directly: `monitor-report` predates SIO-1825 and is
// persisted in checkpointed state, so renaming it would break a resumed thread.
const INBOX_KIND_BY_MONITOR_KIND: Record<MonitorMessageKind, FleetInboxKind> = {
	"incident-report": "monitor-report",
	"daily-digest": "daily-digest",
	"suppression-review": "suppression-review",
};

export type ClassifiedMessage = {
	kind: FleetInboxKind;
	severity: FleetInboxSeverity | null;
	findingCount: number | null;
	alarmNames: string[];
	findings: FleetInboxFinding[];
};

// SIO-1815: does this finding name one of the incident's focus services? Same predicate
// every findings card scopes with (matchesFocus, SIO-1030), over everything the monitor
// wrote about the finding. The resource alone is not enough: feed-service logs to
// the shared /ecs/fargate/shop-prd-log-group, and only the summary and the spoke's
// cause line name it. Empty focus = unscoped, which here means NOT a focus match --
// matchesFocus's show-all default would otherwise mark every finding as relevant.
export function findingNamesFocus(finding: MonitorFinding, focusServices: string[]): boolean {
	if (focusServices.length === 0) return false;
	return matchesFocus(`${finding.resource} ${finding.summary} ${finding.detail}`, focusServices);
}

export function classifyMessage(message: PiInboxMessage, focusServices: string[] = []): ClassifiedMessage {
	// SIO-1825 (Greptile, PR #854): a header is UNTRUSTED text. Any operator or spoke
	// message whose first line quotes one would otherwise be counted and severity-rated as
	// monitor traffic -- reproduced: sender "simon" posting a "[critical] ... daily digest"
	// line scored a critical report against the estate. The sender name is the one
	// hub-controlled signal (pi-coms-client.ts), and every monitor message on the live prd
	// hub comes from a `monitor-` peer (verified: 100/100 across six accounts), so requiring
	// the prefix costs no real traffic and closes the spoof.
	const report = isMonitorAgentName(message.sender_name) ? parseMonitorReport(message.prompt) : undefined;
	if (report) {
		return {
			kind: INBOX_KIND_BY_MONITOR_KIND[report.kind],
			severity: report.topSeverity,
			findingCount: report.findingCount,
			alarmNames: [...new Set(report.findings.filter((f) => f.family === "alarm").map((f) => f.resource))],
			findings: report.findings.map((f) => ({
				severity: f.severity,
				family: f.family,
				resource: f.resource,
				focus: findingNamesFocus(f, focusServices),
			})),
		};
	}
	// A terminal row on an estate inbox is a completed exchange with that spoke.
	if (TERMINAL_STATUSES.has(message.status)) {
		return { kind: "conversation", severity: null, findingCount: null, alarmNames: [], findings: [] };
	}
	return { kind: "other", severity: null, findingCount: null, alarmNames: [], findings: [] };
}

export function withinWindow(message: Pick<PiInboxMessage, "created_at">, window: IncidentWindow): boolean {
	const at = Date.parse(message.created_at);
	if (!Number.isFinite(at)) return false;
	return at >= Date.parse(window.from) && at <= Date.parse(window.to);
}

export type EstateIdentity = { estate: string; accountId: string | undefined; agentNames: string[] };

// Whether an `ops` row belongs to this estate: the report header names the
// estate's account, or the sender is the estate's agent or its monitor.
export function attributableToEstate(message: PiInboxMessage, identity: EstateIdentity): boolean {
	const senders = new Set(identity.agentNames.flatMap((n) => [n, `${MONITOR_NAME_PREFIX}${n}`]));
	if (senders.has(message.sender_name)) return true;
	// Same untrusted-header rule as classifyMessage: the account id in a quoted header
	// attributes a message to an estate, so only a monitor peer may be believed on it.
	if (!isMonitorAgentName(message.sender_name)) return false;
	const report = parseMonitorReport(message.prompt);
	return report !== undefined && identity.accountId !== undefined && report.accountId === identity.accountId;
}

export function excerptOf(text: string): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length <= EXCERPT_MAX) return collapsed;
	return `${collapsed.slice(0, EXCERPT_MAX - 3)}...`;
}

export function toEntry(inbox: string, message: PiInboxMessage, focusServices: string[] = []): FleetInboxEntry {
	const classified = classifyMessage(message, focusServices);
	// Focus findings first, so the per-entry cap never cuts the ones the turn is about.
	const findings = [...classified.findings].sort((a, b) => Number(b.focus) - Number(a.focus));
	return {
		msgId: message.msg_id,
		inbox,
		sender: message.sender_name,
		target: message.target_name,
		kind: classified.kind,
		severity: classified.severity,
		findingCount: classified.findingCount,
		alarmNames: classified.alarmNames,
		findings: findings.slice(0, MAX_FINDINGS_PER_ENTRY),
		focus: findings.some((f) => f.focus),
		createdAt: message.created_at,
		completedAt: message.completed_at,
		excerpt: excerptOf(message.prompt),
	};
}

function emptyCounts(): FleetInboxCounts {
	return { total: 0, focus: 0, critical: 0, warn: 0, incidentReports: 0, dailyDigests: 0, suppressionReviews: 0 };
}

export function buildEstateDigest(input: {
	estate: string;
	environment: PiComsEnvironment;
	inboxes: string[];
	messages: { inbox: string; message: PiInboxMessage }[];
	error: string | null;
	focusServices?: string[];
}): FleetInboxEstate {
	const focusServices = input.focusServices ?? [];
	// The monitor's own messages only. An estate inbox is mostly the monitor's requests to
	// its spoke ("You are the read-only devops agent for AWS account ... diagnose each one"):
	// one per report, carrying the prompt and none of the findings, so they doubled the
	// card and pushed real reports out of the entry cap without adding a fact.
	// SIO-1825: all THREE monitor kinds, not just incident reports. The daily digest is the
	// monitor's report of record and its dead-man signal -- it ships for every account every
	// day, and dropping it left the card reading "0 monitor report(s)" on a live account.
	const monitorKinds = new Set<FleetInboxKind>(MONITOR_INBOX_KINDS);
	const all = input.messages
		.map(({ inbox, message }) => toEntry(inbox, message, focusServices))
		.filter((entry) => monitorKinds.has(entry.kind))
		// SIO-1815: reports naming a focus service first, newest first within each group.
		// An estate inbox holds a day of reports for every service in the account; ordering
		// by time alone let an unrelated account's-worth push the relevant ones past the cap.
		// SIO-1825: then incident reports ahead of digests at equal focus. A digest is a 24 h
		// rollup that ships daily whatever happens; an incident report is a fresh finding, so
		// when the entry cap bites it is the incident reports that must survive it.
		.sort(
			(a, b) =>
				Number(b.focus) - Number(a.focus) ||
				Number(b.kind === "monitor-report") - Number(a.kind === "monitor-report") ||
				b.createdAt.localeCompare(a.createdAt) ||
				b.msgId.localeCompare(a.msgId),
		);
	const counts = emptyCounts();
	const alarmNames = new Set<string>();
	const families = new Map<string, FleetInboxFamilyCount>();
	let latestAt: string | null = null;
	for (const entry of all) {
		counts.total += 1;
		if (entry.kind === "monitor-report") counts.incidentReports += 1;
		else if (entry.kind === "daily-digest") counts.dailyDigests += 1;
		else if (entry.kind === "suppression-review") counts.suppressionReviews += 1;
		if (entry.focus) counts.focus += 1;
		if (entry.severity === "critical") counts.critical += 1;
		if (entry.severity === "warn") counts.warn += 1;
		for (const name of entry.alarmNames) alarmNames.add(name);
		for (const f of entry.findings) {
			const row = families.get(f.family) ?? { family: f.family, count: 0, focus: 0 };
			row.count += 1;
			if (f.focus) row.focus += 1;
			families.set(f.family, row);
		}
		if (latestAt === null || entry.createdAt > latestAt) latestAt = entry.createdAt;
	}
	return {
		estate: input.estate,
		environment: input.environment,
		inboxes: input.inboxes,
		entries: all.slice(0, MAX_ENTRIES_PER_ESTATE),
		counts,
		families: [...families.values()].sort(
			(a, b) => b.focus - a.focus || b.count - a.count || a.family.localeCompare(b.family),
		),
		alarmNames: [...alarmNames].sort(),
		// No longer all[0]: the list is focus-first, so the newest report may not lead it.
		latestAt,
		error: input.error,
	};
}

const PROMPT_RESOURCE_MAX = 120;

// "(warn/logs) /ecs/fargate/shop-prd-log-group x5", most frequent first. The key is
// severity + family + resource: all three are the monitor's structured fields.
// Returns the lines AND how many distinct focus findings there were, so a cap is stated
// rather than silent (Greptile, PR #846): totals cover every report, details do not.
function focusFindingLines(estate: FleetInboxEstate): { lines: string[]; distinct: number } {
	const tally = new Map<string, number>();
	for (const entry of estate.entries) {
		for (const f of entry.findings) {
			if (!f.focus) continue;
			const key = `(${f.severity}/${f.family}) ${f.resource.slice(0, PROMPT_RESOURCE_MAX)}`;
			tally.set(key, (tally.get(key) ?? 0) + 1);
		}
	}
	const lines = [...tally.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, MAX_FOCUS_FINDINGS_IN_PROMPT)
		.map(([key, n]) => `${key} x${n}`);
	return { lines, distinct: tally.size };
}

// Prompt summary: counts, severities, categories, resource and alarm names, timestamps.
// It never reads `excerpt`, `sender`, a finding's summary or any body, so untrusted text
// cannot reach the LLM.
export function summarizeFleetInboxForPrompt(digest: FleetInboxDigest): string {
	if (digest.estates.length === 0) return "";
	const lines = [`Fleet inbox (pi-coms hubs, window ${digest.windowFrom} to ${digest.windowTo}):`];
	const scoped = digest.focusServices.length > 0;
	if (scoped) lines.push(`Scoped to the focus services: ${digest.focusServices.join(", ")}`);
	for (const estate of digest.estates) {
		if (estate.error && estate.counts.total === 0) {
			lines.push(`- ${estate.estate} (${estate.environment}): read failed (${estate.error})`);
			continue;
		}
		const c = estate.counts;
		const focusPart = scoped ? `, ${c.focus} naming a focus service` : "";
		// SIO-1825: name the kinds. "3 monitor message(s)" covering one incident report and
		// two daily digests is not three findings: a digest is a 24 h rollup that ships every
		// day whatever happens, and reading it as an incident overstates the account's state.
		const kindParts = [
			c.incidentReports > 0 ? `${c.incidentReports} incident report(s)` : "",
			c.dailyDigests > 0 ? `${c.dailyDigests} daily digest(s)` : "",
			c.suppressionReviews > 0 ? `${c.suppressionReviews} suppression review(s)` : "",
		].filter((p) => p !== "");
		const breakdown = kindParts.length > 0 ? ` (${kindParts.join(", ")})` : "";
		let line = `- ${estate.estate} (${estate.environment}): ${c.total} monitor message(s)${breakdown}${focusPart}; critical=${c.critical} warn=${c.warn}`;
		if (estate.latestAt) line += `; latest ${estate.latestAt}`;
		lines.push(line);
		if (estate.families.length > 0) {
			const parts = estate.families.map((f) =>
				scoped && f.focus > 0 ? `${f.family}=${f.count} (focus ${f.focus})` : `${f.family}=${f.count}`,
			);
			lines.push(`  finding categories: ${parts.join(", ")}`);
		}
		const focus = focusFindingLines(estate);
		if (focus.lines.length > 0) {
			const capped =
				focus.distinct > focus.lines.length ? ` (top ${focus.lines.length} of ${focus.distinct} distinct)` : "";
			lines.push(`  focus findings${capped}: ${focus.lines.join("; ")}`);
		} else if (scoped && c.total > 0) lines.push("  focus findings: none of these messages names a focus service");
		// The counts above cover every report in the window; the per-report details are
		// capped. Say so, or "5 naming a focus service" reads as "and here are all five".
		if (estate.entries.length < c.total) {
			lines.push(
				`  detail is from ${estate.entries.length} of ${c.total} messages (focus first, then incident reports, then newest); counts and categories cover all ${c.total}`,
			);
		}
		if (estate.alarmNames.length > 0) lines.push(`  alarms: ${estate.alarmNames.join(", ")}`);
		if (estate.error) lines.push(`  partial: ${estate.error}`);
	}
	return lines.join("\n");
}
