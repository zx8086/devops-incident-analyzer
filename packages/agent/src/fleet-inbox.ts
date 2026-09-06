// packages/agent/src/fleet-inbox.ts
// SIO-1652: pure helpers behind the fetchFleetInbox node. Inbox bodies are
// untrusted input (spoke model output, operator free text): they are classified
// and excerpted for the card, and only structured facts reach the prompt.
import type {
	FleetInboxCounts,
	FleetInboxDigest,
	FleetInboxEntry,
	FleetInboxEstate,
	FleetInboxKind,
	FleetInboxSeverity,
	PiComsEnvironment,
} from "@devops-agent/shared";
import type { PiInboxMessage } from "./action-tools/pi-coms-client.ts";
import type { AgentStateType } from "./state.ts";

export const EXCERPT_MAX = 280;
export const MAX_ENTRIES_PER_ESTATE = 20;
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

// Default OFF, same form as KNOWLEDGE_GRAPH_ENABLED: only "true" or "1" enables.
export function isFleetInboxEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.PI_COMS_INBOX_ENABLED;
	return v === "true" || v === "1";
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

export type MonitorFinding = { severity: FleetInboxSeverity; family: string; resource: string; summary: string };
export type MonitorReport = {
	accountId: string;
	topSeverity: FleetInboxSeverity;
	findingCount: number;
	findings: MonitorFinding[];
};

// The monitor's own wire format (packages/pi-coms/scripts/monitor/report.ts,
// formatIncidentReport): a header line, then one "- (sev/family) resource: summary"
// line per finding with indented continuation lines.
const REPORT_HEADER_RE = /^\[(info|warn|critical)\] aws-(\d+): (\d+) finding\(s\)/;
const REPORT_FINDING_RE = /^- \((info|warn|critical)\/([a-z]+)\) (.+?): (.+)$/;

export function parseMonitorReport(text: string): MonitorReport | undefined {
	const lines = text.split("\n");
	const header = REPORT_HEADER_RE.exec(lines[0] ?? "");
	if (!header) return undefined;
	const findings: MonitorFinding[] = [];
	for (const line of lines.slice(1)) {
		const m = REPORT_FINDING_RE.exec(line);
		if (!m) continue;
		findings.push({
			severity: m[1] as FleetInboxSeverity,
			family: m[2] ?? "",
			resource: m[3] ?? "",
			summary: m[4] ?? "",
		});
	}
	return {
		accountId: header[2] ?? "",
		topSeverity: header[1] as FleetInboxSeverity,
		findingCount: Number(header[3]),
		findings,
	};
}

export type ClassifiedMessage = {
	kind: FleetInboxKind;
	severity: FleetInboxSeverity | null;
	findingCount: number | null;
	alarmNames: string[];
};

export function classifyMessage(message: PiInboxMessage): ClassifiedMessage {
	const report = parseMonitorReport(message.prompt);
	if (report) {
		return {
			kind: "monitor-report",
			severity: report.topSeverity,
			findingCount: report.findingCount,
			alarmNames: [...new Set(report.findings.filter((f) => f.family === "alarm").map((f) => f.resource))],
		};
	}
	// A terminal row on an estate inbox is a completed exchange with that spoke.
	if (TERMINAL_STATUSES.has(message.status)) {
		return { kind: "conversation", severity: null, findingCount: null, alarmNames: [] };
	}
	return { kind: "other", severity: null, findingCount: null, alarmNames: [] };
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
	const senders = new Set(identity.agentNames.flatMap((n) => [n, `monitor-${n}`]));
	if (senders.has(message.sender_name)) return true;
	const report = parseMonitorReport(message.prompt);
	return report !== undefined && identity.accountId !== undefined && report.accountId === identity.accountId;
}

export function excerptOf(text: string): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length <= EXCERPT_MAX) return collapsed;
	return `${collapsed.slice(0, EXCERPT_MAX - 3)}...`;
}

export function toEntry(inbox: string, message: PiInboxMessage): FleetInboxEntry {
	const classified = classifyMessage(message);
	return {
		msgId: message.msg_id,
		inbox,
		sender: message.sender_name,
		target: message.target_name,
		kind: classified.kind,
		severity: classified.severity,
		findingCount: classified.findingCount,
		alarmNames: classified.alarmNames,
		createdAt: message.created_at,
		completedAt: message.completed_at,
		excerpt: excerptOf(message.prompt),
	};
}

function emptyCounts(): FleetInboxCounts {
	return { total: 0, monitorReports: 0, conversations: 0, other: 0, critical: 0, warn: 0 };
}

export function buildEstateDigest(input: {
	estate: string;
	environment: PiComsEnvironment;
	inboxes: string[];
	messages: { inbox: string; message: PiInboxMessage }[];
	error: string | null;
}): FleetInboxEstate {
	const all = input.messages
		.map(({ inbox, message }) => toEntry(inbox, message))
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.msgId.localeCompare(a.msgId));
	const counts = emptyCounts();
	const alarmNames = new Set<string>();
	for (const entry of all) {
		counts.total += 1;
		if (entry.kind === "monitor-report") counts.monitorReports += 1;
		else if (entry.kind === "conversation") counts.conversations += 1;
		else counts.other += 1;
		if (entry.severity === "critical") counts.critical += 1;
		if (entry.severity === "warn") counts.warn += 1;
		for (const name of entry.alarmNames) alarmNames.add(name);
	}
	return {
		estate: input.estate,
		environment: input.environment,
		inboxes: input.inboxes,
		entries: all.slice(0, MAX_ENTRIES_PER_ESTATE),
		counts,
		alarmNames: [...alarmNames].sort(),
		latestAt: all[0]?.createdAt ?? null,
		error: input.error,
	};
}

// Prompt summary: counts, severities, alarm names and timestamps only. It never
// reads `excerpt`, `sender` or any body, so untrusted text cannot reach the LLM.
export function summarizeFleetInboxForPrompt(digest: FleetInboxDigest): string {
	if (digest.estates.length === 0) return "";
	const lines = [`Fleet inbox (pi-coms hubs, window ${digest.windowFrom} to ${digest.windowTo}):`];
	for (const estate of digest.estates) {
		if (estate.error && estate.counts.total === 0) {
			lines.push(`- ${estate.estate} (${estate.environment}): read failed (${estate.error})`);
			continue;
		}
		const c = estate.counts;
		let line = `- ${estate.estate} (${estate.environment}): ${c.total} message(s): ${c.monitorReports} monitor report(s), ${c.conversations} conversation(s), ${c.other} other; critical=${c.critical} warn=${c.warn}`;
		if (estate.latestAt) line += `; latest ${estate.latestAt}`;
		lines.push(line);
		if (estate.alarmNames.length > 0) lines.push(`  alarms: ${estate.alarmNames.join(", ")}`);
		if (estate.error) lines.push(`  partial: ${estate.error}`);
	}
	return lines.join("\n");
}
