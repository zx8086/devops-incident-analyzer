// packages/agent/src/fleet-inbox.test.ts
// SIO-1652: pure helpers behind the fetchFleetInbox node. Bodies are untrusted
// input, so the prompt summary is asserted to carry none of them.
import { describe, expect, test } from "bun:test";
import { formatFindingLine } from "@devops-agent/pi-coms/contracts";
import type { PiInboxMessage } from "./action-tools/pi-coms-client.ts";
import {
	accountIdForEstate,
	attributableToEstate,
	buildEstateDigest,
	classifyMessage,
	EXCERPT_MAX,
	excerptOf,
	excludedSenderPrefixes,
	findingNamesFocus,
	fleetInboxTimeoutMs,
	incidentWindow,
	isExcludedSender,
	isFleetInboxEnabled,
	type MonitorFinding,
	parseMonitorReport,
	summarizeFleetInboxForPrompt,
	withinWindow,
} from "./fleet-inbox.ts";

const REPORT = [
	"[critical] aws-111122223333: 3 finding(s)",
	"",
	"- (critical/alarm) checkout-alb-5xx: Alarm checkout-alb-5xx entered ALARM",
	"  cause: SECRET-BODY-MARKER the model thinks the target group is unhealthy",
	"- (warn/logs) /aws/lambda/checkout: 42 ERROR lines in 5m",
	"- (info/alarm) orders-lag: Alarm orders-lag entered INSUFFICIENT_DATA",
].join("\n");

function message(over: Partial<PiInboxMessage> = {}): PiInboxMessage {
	return {
		msg_id: "01J",
		sender_name: "monitor-aws-111122223333",
		target_name: "ops",
		prompt: REPORT,
		status: "queued",
		error: null,
		response: null,
		created_at: "2026-09-06T10:00:00.000Z",
		delivered_at: null,
		completed_at: null,
		...over,
	};
}

describe("gates and config", () => {
	// SIO-1655: capability gates default ON (kill-switch semantics). Only an
	// explicit "false" or "0" disables; anything else, including unset, is on.
	test("the node is on unless PI_COMS_INBOX_ENABLED is false or 0", () => {
		expect(isFleetInboxEnabled({})).toBe(true);
		expect(isFleetInboxEnabled({ PI_COMS_INBOX_ENABLED: "true" })).toBe(true);
		expect(isFleetInboxEnabled({ PI_COMS_INBOX_ENABLED: "1" })).toBe(true);
		expect(isFleetInboxEnabled({ PI_COMS_INBOX_ENABLED: "false" })).toBe(false);
		expect(isFleetInboxEnabled({ PI_COMS_INBOX_ENABLED: "0" })).toBe(false);
	});

	test("the read budget defaults to 5000 ms and ignores invalid values", () => {
		expect(fleetInboxTimeoutMs({})).toBe(5000);
		expect(fleetInboxTimeoutMs({ PI_COMS_INBOX_TIMEOUT_MS: "1500" })).toBe(1500);
		expect(fleetInboxTimeoutMs({ PI_COMS_INBOX_TIMEOUT_MS: "soon" })).toBe(5000);
		expect(fleetInboxTimeoutMs({ PI_COMS_INBOX_TIMEOUT_MS: "0" })).toBe(5000);
	});

	test("self-traffic prefixes default to the analyzer and the pane, overridable", () => {
		expect(excludedSenderPrefixes({})).toEqual(["incident-analyzer-", "pi-fleet-"]);
		expect(excludedSenderPrefixes({ PI_COMS_INBOX_EXCLUDE_SENDERS: " bot-, ops-tool- " })).toEqual([
			"bot-",
			"ops-tool-",
		]);
		expect(isExcludedSender(message({ sender_name: "incident-analyzer-abcd1234" }), excludedSenderPrefixes({}))).toBe(
			true,
		);
		expect(isExcludedSender(message(), excludedSenderPrefixes({}))).toBe(false);
	});

	test("accountIdForEstate reads the assumed role ARN from AWS_ESTATES", () => {
		const env = {
			AWS_ESTATES: JSON.stringify({
				"eu-oit-prd": { assumedRoleArn: "arn:aws:iam::111122223333:role/DevOpsAgentReadOnly", externalId: "x" },
				"eu-b2b-dev": { region: "eu-west-1" },
			}),
		};
		expect(accountIdForEstate("eu-oit-prd", env)).toBe("111122223333");
		expect(accountIdForEstate("eu-b2b-dev", env)).toBeUndefined();
		expect(accountIdForEstate("eu-oit-prd", { AWS_ESTATES: "{oops" })).toBeUndefined();
		expect(accountIdForEstate("eu-oit-prd", {})).toBeUndefined();
	});
});

describe("incidentWindow", () => {
	const now = new Date("2026-09-06T12:00:00.000Z");
	test("prefers the investigation focus, then the normalized incident, then 24 h", () => {
		expect(
			incidentWindow(
				{
					investigationFocus: {
						services: [],
						datasources: [],
						timeWindow: { from: "2026-09-06T08:00:00.000Z", to: "2026-09-06T09:00:00.000Z" },
						summary: "",
						establishedAtTurn: 1,
					},
					normalizedIncident: { timeWindow: { from: "2026-09-05T00:00:00.000Z", to: "2026-09-05T01:00:00.000Z" } },
				},
				now,
			),
		).toEqual({ from: "2026-09-06T08:00:00.000Z", to: "2026-09-06T09:00:00.000Z" });
		expect(
			incidentWindow(
				{
					investigationFocus: undefined,
					normalizedIncident: { timeWindow: { from: "2026-09-05T00:00:00.000Z", to: "2026-09-05T01:00:00.000Z" } },
				},
				now,
			),
		).toEqual({ from: "2026-09-05T00:00:00.000Z", to: "2026-09-05T01:00:00.000Z" });
		expect(incidentWindow({ investigationFocus: undefined, normalizedIncident: {} }, now)).toEqual({
			from: "2026-09-05T12:00:00.000Z",
			to: "2026-09-06T12:00:00.000Z",
		});
	});
});

describe("parseMonitorReport and classifyMessage", () => {
	test("parses the monitor's report header and finding lines", () => {
		const report = parseMonitorReport(REPORT);
		expect(report).toEqual({
			accountId: "111122223333",
			topSeverity: "critical",
			findingCount: 3,
			findings: [
				{
					severity: "critical",
					family: "alarm",
					resource: "checkout-alb-5xx",
					summary: "Alarm checkout-alb-5xx entered ALARM",
					detail: "cause: SECRET-BODY-MARKER the model thinks the target group is unhealthy",
				},
				{
					severity: "warn",
					family: "logs",
					resource: "/aws/lambda/checkout",
					summary: "42 ERROR lines in 5m",
					detail: "",
				},
				{
					severity: "info",
					family: "alarm",
					resource: "orders-lag",
					summary: "Alarm orders-lag entered INSUFFICIENT_DATA",
					detail: "",
				},
			],
		});
		expect(parseMonitorReport("please check the ALB")).toBeUndefined();
	});

	// SIO-1814: the fixture above is hand-written, which is how the parser drifted
	// from the producer unnoticed. This one is written by the monitor's own line
	// emitter; packages/pi-coms/tests/report.test.ts proves formatIncidentReport
	// emits through it for every family.
	test("reads hyphenated families written by the monitor's own emitter", () => {
		const findings: MonitorFinding[] = [
			{ severity: "critical", family: "db-events", resource: "orders-db", summary: "RDS failover: started" },
			{ severity: "warn", family: "spoke-health", resource: "aws-eu-oit-prd", summary: "3 model failures" },
			{ severity: "info", family: "alarm", resource: "orders-lag", summary: "entered INSUFFICIENT_DATA" },
		].map((f) => ({ ...f, severity: f.severity as MonitorFinding["severity"], detail: "evidence: {}" }));
		const text = [
			"[critical] aws-111122223333: 3 finding(s)",
			"",
			...findings.flatMap((f) => [formatFindingLine(f), "  evidence: {}"]),
		].join("\n");
		const report = parseMonitorReport(text);
		expect(report?.findings).toEqual(findings);
		expect(report?.findings.length).toBe(report?.findingCount);
	});

	// The digest's notable lines share the "(sev/family)" shape behind a two-space
	// indent, but they are a 24 h rollup of findings already reported one by one.
	test("an indented notable line is not a finding", () => {
		const text = [
			"[warn] aws-111122223333: 1 finding(s)",
			"",
			formatFindingLine({ severity: "warn", family: "logs", resource: "/aws/lambda/x", summary: "errors" }),
			`  ${formatFindingLine({ severity: "warn", family: "db-events", resource: "orders-db", summary: "failover" })}`,
		].join("\n");
		expect(parseMonitorReport(text)?.findings.map((f) => f.family)).toEqual(["logs"]);
	});

	test("classifies reports, completed conversations and the rest", () => {
		expect(classifyMessage(message())).toEqual({
			kind: "monitor-report",
			severity: "critical",
			findingCount: 3,
			alarmNames: ["checkout-alb-5xx", "orders-lag"],
			// Structured fields only: no summary, no detail.
			findings: [
				{ severity: "critical", family: "alarm", resource: "checkout-alb-5xx", focus: false },
				{ severity: "warn", family: "logs", resource: "/aws/lambda/checkout", focus: false },
				{ severity: "info", family: "alarm", resource: "orders-lag", focus: false },
			],
		});
		expect(
			classifyMessage(message({ prompt: "is the ALB healthy?", status: "complete", response: { verdict: "ok" } })),
		).toEqual({ kind: "conversation", severity: null, findingCount: null, alarmNames: [], findings: [] });
		expect(classifyMessage(message({ prompt: "hello", status: "queued" }))).toEqual({
			kind: "other",
			severity: null,
			findingCount: null,
			alarmNames: [],
			findings: [],
		});
	});
});

describe("filters", () => {
	const window = { from: "2026-09-06T09:00:00.000Z", to: "2026-09-06T11:00:00.000Z" };
	test("withinWindow is inclusive and rejects unparseable timestamps", () => {
		expect(withinWindow(message(), window)).toBe(true);
		expect(withinWindow(message({ created_at: "2026-09-06T11:00:00.000Z" }), window)).toBe(true);
		expect(withinWindow(message({ created_at: "2026-09-06T11:00:00.001Z" }), window)).toBe(false);
		expect(withinWindow(message({ created_at: "yesterday" }), window)).toBe(false);
	});

	test("attributableToEstate matches the report account or the estate's agent names", () => {
		const identity = { estate: "eu-oit-prd", accountId: "111122223333", agentNames: ["eu-oit-prd"] };
		expect(attributableToEstate(message(), identity)).toBe(true);
		expect(attributableToEstate(message({ prompt: "free text", sender_name: "eu-oit-prd" }), identity)).toBe(true);
		expect(attributableToEstate(message({ prompt: "free text", sender_name: "monitor-eu-oit-prd" }), identity)).toBe(
			true,
		);
		expect(attributableToEstate(message({ prompt: "free text", sender_name: "someone-else" }), identity)).toBe(false);
		expect(attributableToEstate(message({ prompt: REPORT.replace("111122223333", "444455556666") }), identity)).toBe(
			false,
		);
	});

	test("excerptOf collapses whitespace and caps the length", () => {
		expect(excerptOf("  a\n\n b  ")).toBe("a b");
		const long = "x".repeat(EXCERPT_MAX + 50);
		expect(excerptOf(long).length).toBe(EXCERPT_MAX);
		expect(excerptOf(long).endsWith("...")).toBe(true);
	});
});

describe("buildEstateDigest and summarizeFleetInboxForPrompt", () => {
	const estate = buildEstateDigest({
		estate: "eu-oit-prd",
		environment: "prd",
		inboxes: ["eu-oit-prd", "ops"],
		messages: [
			{ inbox: "ops", message: message() },
			{
				inbox: "eu-oit-prd",
				message: message({
					msg_id: "01K",
					sender_name: "kim",
					target_name: "eu-oit-prd",
					prompt: "why is checkout slow? SECRET-BODY-MARKER",
					status: "complete",
					response: "because of the ALB SECRET-BODY-MARKER",
					created_at: "2026-09-06T10:30:00.000Z",
					completed_at: "2026-09-06T10:31:00.000Z",
				}),
			},
			{
				inbox: "eu-oit-prd",
				message: message({ msg_id: "01H", prompt: "noise", created_at: "2026-09-06T09:00:00.000Z" }),
			},
		],
		error: null,
	});

	// The estate inbox is mostly the monitor asking its spoke to diagnose a report: a
	// prompt, no findings. Those rows and operator chatter doubled the card in the live
	// run of 2026-09-18, so only the reports themselves survive.
	test("keeps monitor reports only: conversations and other rows are dropped, not counted", () => {
		expect(estate.entries.map((e) => [e.msgId, e.kind])).toEqual([["01J", "monitor-report"]]);
		expect(estate.counts).toEqual({ total: 1, focus: 0, critical: 1, warn: 0 });
		expect(estate.alarmNames).toEqual(["checkout-alb-5xx", "orders-lag"]);
		expect(estate.latestAt).toBe(estate.entries[0]?.createdAt ?? "");
		expect(JSON.stringify(estate)).not.toContain("why is checkout slow");
	});

	test("the prompt summary carries structured facts only, never a body", () => {
		const summary = summarizeFleetInboxForPrompt({
			windowFrom: "2026-09-06T09:00:00.000Z",
			windowTo: "2026-09-06T11:00:00.000Z",
			generatedAt: "2026-09-06T11:00:01.000Z",
			focusServices: [],
			estates: [
				estate,
				{
					...estate,
					estate: "eu-b2b-dev",
					environment: "dev",
					entries: [],
					counts: { total: 0, focus: 0, critical: 0, warn: 0 },
					families: [],
					alarmNames: [],
					latestAt: null,
					error: "hub timed out",
				},
			],
		});
		expect(summary).toContain("eu-oit-prd (prd): 1 monitor report(s); critical=1 warn=0");
		expect(summary).toContain("critical=1 warn=0");
		expect(summary).toContain("alarms: checkout-alb-5xx, orders-lag");
		expect(summary).toContain(`latest ${estate.latestAt}`);
		expect(summary).toContain("eu-b2b-dev (dev): read failed (hub timed out)");
		expect(summary).not.toContain("SECRET-BODY-MARKER");
		expect(summary).not.toContain("why is checkout slow");
		expect(summary).not.toContain("kim");
	});

	test("an empty digest renders nothing", () => {
		expect(
			summarizeFleetInboxForPrompt({
				windowFrom: "a",
				windowTo: "b",
				generatedAt: "c",
				focusServices: [],
				estates: [],
			}),
		).toBe("");
	});
});

// SIO-1815. Shapes taken from the 2026-09-18 live run: the service logs to a
// log group it SHARES with the rest of the cluster, so the resource never names it; only
// the finding's summary and the spoke's "cause:" line do.
describe("SIO-1815: the digest is scoped to the focus services", () => {
	const FOCUS = ["feed-service", "Vendor Data Hub"];
	const FEED_REPORT = [
		"[warn] aws-111122223333: 2 finding(s)",
		"",
		"- (warn/logs) /ecs/fargate/shop-prd-log-group: 2 error-pattern event(s): Caused by: jakarta.ws.rs.InternalServerErrorException",
		"  cause: feed-service's nightly stock sync job SECRET-CAUSE-MARKER",
		"- (warn/alarm) shop-prd-db-cpu-high: entered ALARM",
	].join("\n");
	const ORDERS_REPORT = [
		"[warn] aws-111122223333: 1 finding(s)",
		"",
		"- (warn/logs) /ecs/fargate/checkout-prd-log-group: 63 error-pattern event(s): deadlock detected",
		"  cause: A storm of PostgreSQL deadlocks on the order table in checkout-service",
	].join("\n");
	const LAMBDA_REPORT = [
		"[warn] aws-111122223333: 12 finding(s)",
		"",
		"- (warn/health) LAMBDA/eu-central-1: AWS Health scheduledChange AWS_LAMBDA_PLANNED_LIFECYCLE_EVENT",
	].join("\n");

	function digestFor(focusServices: string[]) {
		return buildEstateDigest({
			estate: "eu-oit-prd",
			environment: "prd",
			inboxes: ["eu-oit-prd", "ops"],
			focusServices,
			error: null,
			messages: [
				// Newest first is orders, then lambda; the feed-service report is the OLDEST.
				{
					inbox: "ops",
					message: message({ msg_id: "03", prompt: ORDERS_REPORT, created_at: "2026-09-06T11:00:00.000Z" }),
				},
				{
					inbox: "ops",
					message: message({ msg_id: "02", prompt: LAMBDA_REPORT, created_at: "2026-09-06T10:30:00.000Z" }),
				},
				{
					inbox: "ops",
					message: message({ msg_id: "01", prompt: FEED_REPORT, created_at: "2026-09-06T10:00:00.000Z" }),
				},
			],
		});
	}

	test("a finding is matched on what the monitor wrote about it, not on its resource alone", () => {
		const [logs, alarm] = parseMonitorReport(FEED_REPORT)?.findings ?? [];
		if (!logs || !alarm) throw new Error("fixture did not parse");
		expect(logs.resource).not.toContain("feed-service");
		expect(findingNamesFocus(logs, FOCUS)).toBe(true);
		expect(findingNamesFocus(alarm, FOCUS)).toBe(false);
		// matchesFocus treats an empty focus as show-all; here unscoped must mean no match.
		expect(findingNamesFocus(logs, [])).toBe(false);
	});

	test("reports naming a focus service lead, ahead of newer reports about other services", () => {
		const estate = digestFor(FOCUS);
		expect(estate.entries.map((e) => [e.msgId, e.focus])).toEqual([
			["01", true],
			["03", false],
			["02", false],
		]);
		expect(estate.counts).toEqual({ total: 3, focus: 1, critical: 0, warn: 3 });
		// Focus-first ordering must not turn latestAt into "the focus report's time".
		expect(estate.latestAt).toBe("2026-09-06T11:00:00.000Z");
	});

	test("counts findings per monitor category, with the focus share of each", () => {
		expect(digestFor(FOCUS).families).toEqual([
			{ family: "logs", count: 2, focus: 1 },
			{ family: "alarm", count: 1, focus: 0 },
			{ family: "health", count: 1, focus: 0 },
		]);
	});

	test("unscoped (no focus services) keeps plain newest-first and marks nothing", () => {
		const estate = digestFor([]);
		expect(estate.entries.map((e) => e.msgId)).toEqual(["03", "02", "01"]);
		expect(estate.counts.focus).toBe(0);
		expect(estate.entries.every((e) => !e.focus)).toBe(true);
	});

	test("the prompt names the focus findings by category and resource, and still never a body", () => {
		const summary = summarizeFleetInboxForPrompt({
			windowFrom: "2026-09-06T09:00:00.000Z",
			windowTo: "2026-09-06T12:00:00.000Z",
			generatedAt: "2026-09-06T12:00:01.000Z",
			focusServices: FOCUS,
			estates: [digestFor(FOCUS)],
		});
		expect(summary).toContain("Scoped to the focus services: feed-service, Vendor Data Hub");
		expect(summary).toContain("3 monitor report(s), 1 naming a focus service");
		expect(summary).toContain("finding categories: logs=2 (focus 1), alarm=1, health=1");
		expect(summary).toContain("focus findings: (warn/logs) /ecs/fargate/shop-prd-log-group x1");
		// The other service's log group is in the inbox but is not a focus finding.
		expect(summary).not.toContain("checkout-prd-log-group");
		expect(summary).not.toContain("SECRET-CAUSE-MARKER");
		expect(summary).not.toContain("deadlock");
		expect(summary).not.toContain("InternalServerErrorException");
	});

	test("a scoped digest with no match says so instead of implying relevance", () => {
		const summary = summarizeFleetInboxForPrompt({
			windowFrom: "a",
			windowTo: "b",
			generatedAt: "c",
			focusServices: ["payments-gateway"],
			estates: [digestFor(["payments-gateway"])],
		});
		expect(summary).toContain("0 naming a focus service");
		expect(summary).toContain("none of these reports names a focus service");
	});

	test("the digest never carries a finding's free text", () => {
		const json = JSON.stringify(digestFor(FOCUS).entries.map((e) => e.findings));
		expect(json).not.toContain("SECRET-CAUSE-MARKER");
		expect(json).not.toContain("deadlock");
	});
});
