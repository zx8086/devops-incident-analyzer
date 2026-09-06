// packages/agent/src/fleet-inbox.test.ts
// SIO-1652: pure helpers behind the fetchFleetInbox node. Bodies are untrusted
// input, so the prompt summary is asserted to carry none of them.
import { describe, expect, test } from "bun:test";
import type { PiInboxMessage } from "./action-tools/pi-coms-client.ts";
import {
	accountIdForEstate,
	attributableToEstate,
	buildEstateDigest,
	classifyMessage,
	EXCERPT_MAX,
	excerptOf,
	excludedSenderPrefixes,
	fleetInboxTimeoutMs,
	incidentWindow,
	isExcludedSender,
	isFleetInboxEnabled,
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
	test("the node is off unless PI_COMS_INBOX_ENABLED is true or 1", () => {
		expect(isFleetInboxEnabled({})).toBe(false);
		expect(isFleetInboxEnabled({ PI_COMS_INBOX_ENABLED: "false" })).toBe(false);
		expect(isFleetInboxEnabled({ PI_COMS_INBOX_ENABLED: "true" })).toBe(true);
		expect(isFleetInboxEnabled({ PI_COMS_INBOX_ENABLED: "1" })).toBe(true);
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
				},
				{ severity: "warn", family: "logs", resource: "/aws/lambda/checkout", summary: "42 ERROR lines in 5m" },
				{
					severity: "info",
					family: "alarm",
					resource: "orders-lag",
					summary: "Alarm orders-lag entered INSUFFICIENT_DATA",
				},
			],
		});
		expect(parseMonitorReport("please check the ALB")).toBeUndefined();
	});

	test("classifies reports, completed conversations and the rest", () => {
		expect(classifyMessage(message())).toEqual({
			kind: "monitor-report",
			severity: "critical",
			findingCount: 3,
			alarmNames: ["checkout-alb-5xx", "orders-lag"],
		});
		expect(
			classifyMessage(message({ prompt: "is the ALB healthy?", status: "complete", response: { verdict: "ok" } })),
		).toEqual({ kind: "conversation", severity: null, findingCount: null, alarmNames: [] });
		expect(classifyMessage(message({ prompt: "hello", status: "queued" }))).toEqual({
			kind: "other",
			severity: null,
			findingCount: null,
			alarmNames: [],
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

	test("orders entries newest first with counts, alarm names and the latest timestamp", () => {
		expect(estate.entries.map((e) => e.msgId)).toEqual(["01K", "01J", "01H"]);
		expect(estate.counts).toEqual({ total: 3, monitorReports: 1, conversations: 1, other: 1, critical: 1, warn: 0 });
		expect(estate.alarmNames).toEqual(["checkout-alb-5xx", "orders-lag"]);
		expect(estate.latestAt).toBe("2026-09-06T10:30:00.000Z");
		expect(estate.entries[0]?.excerpt).toContain("why is checkout slow?");
	});

	test("the prompt summary carries structured facts only, never a body", () => {
		const summary = summarizeFleetInboxForPrompt({
			windowFrom: "2026-09-06T09:00:00.000Z",
			windowTo: "2026-09-06T11:00:00.000Z",
			generatedAt: "2026-09-06T11:00:01.000Z",
			estates: [
				estate,
				{
					...estate,
					estate: "eu-b2b-dev",
					environment: "dev",
					entries: [],
					counts: { total: 0, monitorReports: 0, conversations: 0, other: 0, critical: 0, warn: 0 },
					alarmNames: [],
					latestAt: null,
					error: "hub timed out",
				},
			],
		});
		expect(summary).toContain("eu-oit-prd (prd): 3 message(s)");
		expect(summary).toContain("1 monitor report(s), 1 conversation(s), 1 other");
		expect(summary).toContain("critical=1 warn=0");
		expect(summary).toContain("alarms: checkout-alb-5xx, orders-lag");
		expect(summary).toContain("latest 2026-09-06T10:30:00.000Z");
		expect(summary).toContain("eu-b2b-dev (dev): read failed (hub timed out)");
		expect(summary).not.toContain("SECRET-BODY-MARKER");
		expect(summary).not.toContain("why is checkout slow");
		expect(summary).not.toContain("kim");
	});

	test("an empty digest renders nothing", () => {
		expect(summarizeFleetInboxForPrompt({ windowFrom: "a", windowTo: "b", generatedAt: "c", estates: [] })).toBe("");
	});
});
