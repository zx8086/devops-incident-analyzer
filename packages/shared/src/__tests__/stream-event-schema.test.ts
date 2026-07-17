// packages/shared/src/__tests__/stream-event-schema.test.ts
// SIO-775: round-trip tests for the new datasource_result event.
import { describe, expect, test } from "bun:test";
import { StreamEventSchema } from "../agent-state.ts";

describe("StreamEventSchema datasource_result", () => {
	test("parses a success result with kafkaFindings", () => {
		const parsed = StreamEventSchema.parse({
			type: "datasource_result",
			dataSourceId: "kafka-agent",
			status: "success",
			duration: 1234,
			kafkaFindings: {
				consumerGroups: [{ id: "pim-sink", state: "STABLE", totalLag: 42 }],
				dlqTopics: [{ name: "orders.dlq", totalMessages: 17, recentDelta: 3 }],
			},
		});
		expect(parsed.type).toBe("datasource_result");
		if (parsed.type !== "datasource_result") throw new Error("narrow");
		expect(parsed.kafkaFindings?.consumerGroups?.[0]?.id).toBe("pim-sink");
		expect(parsed.kafkaFindings?.dlqTopics?.[0]?.recentDelta).toBe(3);
	});

	test("parses an error result with no findings", () => {
		const parsed = StreamEventSchema.parse({
			type: "datasource_result",
			dataSourceId: "kafka-agent",
			status: "error",
			error: "MCP error -32010",
		});
		expect(parsed.type).toBe("datasource_result");
		if (parsed.type !== "datasource_result") throw new Error("narrow");
		expect(parsed.error).toBe("MCP error -32010");
		expect(parsed.kafkaFindings).toBeUndefined();
	});

	test("parses a result with dlqTopics.recentDelta=null (no baseline)", () => {
		const parsed = StreamEventSchema.parse({
			type: "datasource_result",
			dataSourceId: "kafka-agent",
			status: "success",
			kafkaFindings: {
				dlqTopics: [{ name: "orders.dlq", totalMessages: 5, recentDelta: null }],
			},
		});
		if (parsed.type !== "datasource_result") throw new Error("narrow");
		expect(parsed.kafkaFindings?.dlqTopics?.[0]?.recentDelta).toBeNull();
	});

	test("rejects invalid status", () => {
		expect(() =>
			StreamEventSchema.parse({
				type: "datasource_result",
				dataSourceId: "kafka-agent",
				status: "running",
			}),
		).toThrow();
	});
});

// SIO-902: synthetics drift events round-trip through the discriminated union.
describe("StreamEventSchema synthetics events", () => {
	const validReport = {
		type: "synthetics_drift_report",
		deployment: "eu-b2b",
		kibanaUrl: "https://x.es.io:443",
		kibanaSpace: "dev",
		hasActionableDrift: true,
		totals: {
			projectsChecked: 10,
			monitorsInSource: 81,
			monitorsInKibana: 254,
			missingInKibana: 0,
			extraInKibana: 132,
			changed: 41,
		},
		drift: [
			{
				project: "eu-oit.prd",
				monitorId: "a",
				monitorName: "OIT API",
				category: "changed",
				fields: [{ field: "name", source: "OIT", live: "Prana" }],
			},
		],
		reconcilePlan: {
			pushToKibana: { command: "c", monitors: [{ project: "eu-oit.prd", monitorId: "a", monitorName: "OIT API" }] },
			addToSource: { action: "x", monitors: [] },
		},
	};

	test("parses a well-formed synthetics_drift_report", () => {
		const parsed = StreamEventSchema.parse(validReport);
		expect(parsed.type).toBe("synthetics_drift_report");
		if (parsed.type !== "synthetics_drift_report") throw new Error("narrow");
		expect(parsed.totals.extraInKibana).toBe(132);
		expect(parsed.drift[0]?.category).toBe("changed");
	});

	test("rejects an unknown monitor category", () => {
		expect(() =>
			StreamEventSchema.parse({
				...validReport,
				drift: [{ project: "p", monitorId: "a", monitorName: "a", category: "deleted_somewhere" }],
			}),
		).toThrow();
	});

	test("rejects a report missing totals", () => {
		const { totals: _omit, ...noTotals } = validReport;
		expect(() => StreamEventSchema.parse(noTotals)).toThrow();
	});

	test("parses synthetics_push_choice and synthetics_push_result", () => {
		expect(
			StreamEventSchema.parse({
				type: "synthetics_push_choice",
				threadId: "t1",
				deployment: "eu-b2b",
				kibanaSpace: "dev",
				pushableCount: 2,
				extraCount: 1,
				projectScope: "eu-oit.prd",
				command: "c",
				pushMonitors: [{ project: "eu-oit.prd", monitorName: "a" }],
				extraMonitors: [{ project: "eu-ss.dev", monitorName: "b" }],
				message: "Approve?",
			}).type,
		).toBe("synthetics_push_choice");
		expect(
			StreamEventSchema.parse({
				type: "synthetics_push_result",
				status: "pushed",
				pushedCount: 2,
				project: "eu-oit.prd",
			}).type,
		).toBe("synthetics_push_result");
	});

	test("rejects a push result with a non-numeric pushedCount", () => {
		expect(() =>
			StreamEventSchema.parse({ type: "synthetics_push_result", status: "pushed", pushedCount: "2" }),
		).toThrow();
	});

	test("projectScope accepts null (fleet-wide)", () => {
		const parsed = StreamEventSchema.parse({
			type: "synthetics_push_choice",
			threadId: "t1",
			deployment: "eu-b2b",
			kibanaSpace: "dev",
			pushableCount: 2,
			extraCount: 0,
			projectScope: null,
			command: "c",
			pushMonitors: [],
			extraMonitors: [],
			message: "Approve?",
		});
		expect(parsed.type).toBe("synthetics_push_choice");
		if (parsed.type !== "synthetics_push_choice") throw new Error("narrow");
		expect(parsed.projectScope).toBeNull();
	});
});

describe("StreamEventSchema fleet_upgrade events (SIO-922)", () => {
	test("parses fleet_upgrade_preview_report", () => {
		const parsed = StreamEventSchema.parse({
			type: "fleet_upgrade_preview_report",
			deployment: "eu-b2b",
			targetVersion: "9.4.2",
			resolvedCount: 232,
			versionAvailable: true,
			rolloutSeconds: 600,
			crosstab: { upgradeable: 4, notUpgradeable: 228, byReason: [{ reason: "wolfi", count: 228 }] },
		});
		expect(parsed.type).toBe("fleet_upgrade_preview_report");
		if (parsed.type !== "fleet_upgrade_preview_report") throw new Error("narrow");
		expect(parsed.crosstab.upgradeable).toBe(4);
	});

	test("parses fleet_upgrade_choice", () => {
		expect(
			StreamEventSchema.parse({
				type: "fleet_upgrade_choice",
				threadId: "t1",
				deployment: "eu-b2b",
				targetVersion: "9.4.2",
				resolvedCount: 232,
				upgradeableCount: 4,
				notUpgradeableCount: 228,
				rolloutSeconds: 600,
				byReason: [{ reason: "wolfi", count: 228 }],
				message: "Approve?",
			}).type,
		).toBe("fleet_upgrade_choice");
	});

	// SIO-935: the optional version partition round-trips on both fleet events, and OMITTING it
	// still parses (the back-compat invariant -- old CI reports carry no versionCrosstab).
	test("versionCrosstab round-trips on preview_report + choice, and is optional", () => {
		const vc = { alreadyOnTarget: 196, outdated: 611, versionUnknown: 0, upgradeableOutdated: 6 };
		const preview = StreamEventSchema.parse({
			type: "fleet_upgrade_preview_report",
			deployment: "us-cld",
			targetVersion: "9.4.2",
			resolvedCount: 807,
			versionAvailable: true,
			rolloutSeconds: 3600,
			crosstab: { upgradeable: 6, notUpgradeable: 801, byReason: [{ reason: "unknown", count: 601 }] },
			versionCrosstab: vc,
		});
		if (preview.type !== "fleet_upgrade_preview_report") throw new Error("narrow");
		expect(preview.versionCrosstab).toEqual(vc);

		const choice = StreamEventSchema.parse({
			type: "fleet_upgrade_choice",
			threadId: "t1",
			deployment: "us-cld",
			targetVersion: "9.4.2",
			resolvedCount: 807,
			upgradeableCount: 6,
			notUpgradeableCount: 801,
			rolloutSeconds: 3600,
			byReason: [{ reason: "unknown", count: 601 }],
			versionCrosstab: vc,
			message: "Approve?",
		});
		if (choice.type !== "fleet_upgrade_choice") throw new Error("narrow");
		expect(choice.versionCrosstab).toEqual(vc);

		// Back-compat: omitting versionCrosstab still parses (and leaves it undefined).
		const noVc = StreamEventSchema.parse({
			type: "fleet_upgrade_preview_report",
			deployment: "us-cld",
			targetVersion: "9.4.2",
			resolvedCount: 807,
			versionAvailable: true,
			rolloutSeconds: 3600,
			crosstab: { upgradeable: 6, notUpgradeable: 801, byReason: [] },
		});
		if (noVc.type !== "fleet_upgrade_preview_report") throw new Error("narrow");
		expect(noVc.versionCrosstab).toBeUndefined();
	});

	test("parses fleet_upgrade_apply_result and rejects a wrong status", () => {
		expect(
			StreamEventSchema.parse({
				type: "fleet_upgrade_apply_result",
				status: "applied",
				acked: 4,
				failedSilent: 0,
			}).type,
		).toBe("fleet_upgrade_apply_result");
		// "pushed" is a synthetics status, not a fleet-apply status
		expect(() => StreamEventSchema.parse({ type: "fleet_upgrade_apply_result", status: "pushed" })).toThrow();
	});
});

describe("StreamEventSchema hil_learning_applied (SIO-1146)", () => {
	const validReport = {
		ticketKey: "DEVOPS-1375",
		incidentId: "jira:DEVOPS-1375",
		incidentCreated: true,
		rootCauseWritten: true,
		curated: true,
		factsWritten: 3,
		bindingsConfirmed: 1,
		bindingsInvalidated: 0,
		heuristicsProposed: 0,
		skipped: [{ id: "fact-2", reason: "rejected" }],
		items: [
			{ id: "rc-1", kind: "root-cause", label: "nlb-stale-target-capella-side", status: "applied" },
			{ id: "fact-2", kind: "memory-fact", label: "Cluster mn1... endpoint service", status: "rejected" },
			{
				id: "bind-1",
				kind: "binding",
				label: "confirm svc -> aws vpc-endpoint",
				status: "skipped",
				reason: "already recorded",
			},
		],
	};

	test("parses a well-formed report", () => {
		const parsed = StreamEventSchema.parse({ type: "hil_learning_applied", report: validReport });
		expect(parsed.type).toBe("hil_learning_applied");
		if (parsed.type !== "hil_learning_applied") throw new Error("narrow");
		expect(parsed.report.items).toHaveLength(3);
		expect(parsed.report.items[1]?.status).toBe("rejected");
		expect(parsed.report.items[2]?.reason).toBe("already recorded");
	});

	test("rejects an unknown item status", () => {
		expect(() =>
			StreamEventSchema.parse({
				type: "hil_learning_applied",
				report: { ...validReport, items: [{ id: "rc-1", kind: "root-cause", label: "x", status: "pending" }] },
			}),
		).toThrow();
	});

	test("rejects a report missing ticketKey", () => {
		const { ticketKey: _omit, ...noTicket } = validReport;
		expect(() => StreamEventSchema.parse({ type: "hil_learning_applied", report: noTicket })).toThrow();
	});

	// CodeRabbit PR #412: skipped items must carry the write-time reason.
	test("rejects a skipped item without a reason; applied without reason is fine", () => {
		expect(() =>
			StreamEventSchema.parse({
				type: "hil_learning_applied",
				report: { ...validReport, items: [{ id: "fact-1", kind: "memory-fact", label: "x", status: "skipped" }] },
			}),
		).toThrow();
		const ok = StreamEventSchema.parse({
			type: "hil_learning_applied",
			report: { ...validReport, items: [{ id: "rc-1", kind: "root-cause", label: "x", status: "applied" }] },
		});
		expect(ok.type).toBe("hil_learning_applied");
	});
});
