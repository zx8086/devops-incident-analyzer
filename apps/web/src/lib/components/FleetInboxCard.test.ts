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
	focusServices: [],
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
					findings: [{ severity: "critical", family: "alarm", resource: "checkout-alb-5xx", focus: false }],
					focus: false,
					createdAt: "2026-09-06T10:00:00.000Z",
					completedAt: null,
					excerpt: "[critical] aws-111122223333: 3 finding(s) - (critical/alarm) checkout-alb-5xx: Alarm entered ALARM",
				},
			],
			counts: { total: 1, focus: 0, critical: 1, warn: 0 },
			families: [{ family: "alarm", count: 1, focus: 0 }],
			alarmNames: ["checkout-alb-5xx"],
			latestAt: "2026-09-06T10:00:00.000Z",
			error: null,
		},
		{
			estate: "eu-b2b-dev",
			environment: "dev",
			inboxes: ["eu-b2b-dev", "ops"],
			entries: [],
			counts: { total: 0, focus: 0, critical: 0, warn: 0 },
			families: [],
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
		expect(body).toContain("1 monitor report(s); critical 1, warn 0");
		expect(body).toContain("checkout-alb-5xx");
		expect(body).toContain("monitor report");
		expect(body).toContain("monitor-aws-111122223333 to ops");
		expect(body).toContain("3 finding(s)");
		expect(body).toContain("Alarm entered ALARM");
		expect(body).toContain("mailbox ops timed out after 5000 ms");
	});

	// SIO-1815: scoped to the focus services, the matching report is the card and the rest of
	// the account's inbox folds away. Unscoped (the test above) nothing is folded.
	test("a scoped digest leads with the focus report and folds the others away", () => {
		const base = digest.estates[0] as FleetInboxDigest["estates"][number];
		const report = base.entries[0] as (typeof base.entries)[number];
		const scopedDigest: FleetInboxDigest = {
			...digest,
			focusServices: ["feed-service"],
			estates: [
				{
					...base,
					counts: { total: 2, focus: 1, critical: 1, warn: 1 },
					families: [{ family: "logs", count: 2, focus: 1 }],
					entries: [
						{
							...report,
							msgId: "FOCUS",
							focus: true,
							excerpt: "FOCUS-EXCERPT",
							findings: [
								{ severity: "warn", family: "logs", resource: "/ecs/fargate/shop-prd-log-group", focus: true },
							],
						},
						{ ...report, msgId: "OTHER", excerpt: "OTHER-EXCERPT" },
					],
				},
			],
		};
		const { body } = render(FleetInboxCard, { props: { digest: scopedDigest } });
		expect(body).toContain("Scoped to:");
		expect(body).toContain("2 monitor report(s), 1 naming a focus service");
		expect(body).toContain("logs 2 (1 focus)");
		expect(body).toContain("logs: /ecs/fargate/shop-prd-log-group");
		expect(body).toContain("1 report(s) about other services in this account");
		// The focus report is outside the fold, the other one inside it.
		expect(body.indexOf("FOCUS-EXCERPT")).toBeLessThan(body.indexOf("<details"));
		expect(body.indexOf("OTHER-EXCERPT")).toBeGreaterThan(body.indexOf("<details"));
	});

	// Greptile, PR #846: counts cover every report while details are capped; the card says so.
	test("a capped digest says how much of it is shown", () => {
		const base = digest.estates[0] as FleetInboxDigest["estates"][number];
		const report = base.entries[0] as (typeof base.entries)[number];
		const capped: FleetInboxDigest = {
			...digest,
			estates: [{ ...base, counts: { ...base.counts, total: 25 }, entries: [{ ...report, findingCount: 15 }] }],
		};
		const { body } = render(FleetInboxCard, { props: { digest: capped } });
		expect(body).toContain("Showing 1 of 25 reports");
		expect(body).toContain("+14 more");
	});

	test("an uncapped digest shows neither note", () => {
		const base = digest.estates[0] as FleetInboxDigest["estates"][number];
		const report = base.entries[0] as (typeof base.entries)[number];
		const exact: FleetInboxDigest = { ...digest, estates: [{ ...base, entries: [{ ...report, findingCount: 1 }] }] };
		const { body } = render(FleetInboxCard, { props: { digest: exact } });
		expect(body).not.toContain("Showing 1 of");
		expect(body).not.toContain("more</span>");
	});

	test("unscoped, nothing is folded away", () => {
		const { body } = render(FleetInboxCard, { props: { digest } });
		expect(body).not.toContain("<details");
		expect(body).not.toContain("Scoped to:");
	});

	test("an estate with no rows and no error says so", () => {
		const quiet: FleetInboxDigest = {
			...digest,
			estates: [{ ...(digest.estates[1] as FleetInboxDigest["estates"][number]), error: null }],
		};
		const { body } = render(FleetInboxCard, { props: { digest: quiet } });
		expect(body).toContain("No monitor reports in the window.");
	});
});
