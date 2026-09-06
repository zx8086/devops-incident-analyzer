// apps/web/src/lib/components/FleetInboxCard.test.ts
// SIO-1652: SSR shape checks for the fleet inbox card.
import { describe, expect, test } from "bun:test";
import type { FleetInboxDigest } from "@devops-agent/shared";
import { render } from "svelte/server";
import FleetInboxCard from "./FleetInboxCard.svelte";

const digest: FleetInboxDigest = {
	windowFrom: "2026-09-06T00:00:00.000Z",
	windowTo: "2026-09-06T12:00:00.000Z",
	generatedAt: "2026-09-06T12:00:01.000Z",
	estates: [
		{
			estate: "eu-oit-prd",
			environment: "prd",
			inboxes: ["eu-oit-prd", "ops"],
			entries: [
				{
					msgId: "01R",
					inbox: "ops",
					sender: "monitor-aws-111122223333",
					target: "ops",
					kind: "monitor-report",
					severity: "critical",
					findingCount: 3,
					alarmNames: ["checkout-alb-5xx"],
					createdAt: "2026-09-06T10:00:00.000Z",
					completedAt: null,
					excerpt: "[critical] aws-111122223333: 3 finding(s) - (critical/alarm) checkout-alb-5xx: Alarm entered ALARM",
				},
			],
			counts: { total: 1, monitorReports: 1, conversations: 0, other: 0, critical: 1, warn: 0 },
			alarmNames: ["checkout-alb-5xx"],
			latestAt: "2026-09-06T10:00:00.000Z",
			error: null,
		},
		{
			estate: "eu-b2b-dev",
			environment: "dev",
			inboxes: ["eu-b2b-dev", "ops"],
			entries: [],
			counts: { total: 0, monitorReports: 0, conversations: 0, other: 0, critical: 0, warn: 0 },
			alarmNames: [],
			latestAt: null,
			error: "mailbox ops timed out after 5000 ms",
		},
	],
};

describe("FleetInboxCard", () => {
	test("renders estates with environment, counts, alarms, entries and the read error", () => {
		const { body } = render(FleetInboxCard, { props: { digest } });
		expect(body).toContain("Fleet inbox");
		expect(body).toContain("eu-oit-prd");
		expect(body).toContain("prd");
		expect(body).toContain("1 message(s): 1 monitor report(s), 0 conversation(s); critical 1, warn 0");
		expect(body).toContain("checkout-alb-5xx");
		expect(body).toContain("monitor report");
		expect(body).toContain("monitor-aws-111122223333 to ops");
		expect(body).toContain("3 finding(s)");
		expect(body).toContain("Alarm entered ALARM");
		expect(body).toContain("mailbox ops timed out after 5000 ms");
	});

	test("an estate with no rows and no error says so", () => {
		const quiet: FleetInboxDigest = {
			...digest,
			estates: [{ ...(digest.estates[1] as FleetInboxDigest["estates"][number]), error: null }],
		};
		const { body } = render(FleetInboxCard, { props: { digest: quiet } });
		expect(body).toContain("No messages in the window.");
	});
});
