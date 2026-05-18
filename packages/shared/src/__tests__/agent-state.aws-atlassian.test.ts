// packages/shared/src/__tests__/agent-state.aws-atlassian.test.ts
// SIO-785 Phase 2: AwsFindings + AtlassianFindings schema round-trip tests.
import { describe, expect, test } from "bun:test";
import {
	AtlassianFindingsSchema,
	AtlassianLinkedIssueSchema,
	AwsCloudWatchAlarmSchema,
	AwsFindingsSchema,
	StreamEventSchema,
} from "../agent-state.ts";

describe("AwsCloudWatchAlarmSchema", () => {
	test("parses a valid alarm shape", () => {
		const parsed = AwsCloudWatchAlarmSchema.safeParse({
			name: "msk-cpu",
			state: "ALARM",
			reason: "Threshold crossed",
			metricName: "CPUUtilization",
			namespace: "AWS/Kafka",
			stateUpdatedAt: "2026-05-18T11:00:00Z",
		});
		expect(parsed.success).toBe(true);
	});

	test("rejects missing required fields", () => {
		const parsed = AwsCloudWatchAlarmSchema.safeParse({ name: "only-name" });
		expect(parsed.success).toBe(false);
	});

	test("accepts alarm with only required fields", () => {
		const parsed = AwsCloudWatchAlarmSchema.safeParse({ name: "x", state: "OK" });
		expect(parsed.success).toBe(true);
	});
});

describe("AwsFindingsSchema", () => {
	test("accepts empty findings", () => {
		expect(AwsFindingsSchema.safeParse({}).success).toBe(true);
	});

	test("accepts findings with alarms array", () => {
		const parsed = AwsFindingsSchema.safeParse({
			alarms: [{ name: "a", state: "OK" }],
		});
		expect(parsed.success).toBe(true);
	});
});

describe("AtlassianLinkedIssueSchema", () => {
	test("parses a full issue", () => {
		const parsed = AtlassianLinkedIssueSchema.safeParse({
			key: "INC-101",
			summary: "Notifications outage",
			status: "Resolved",
			severity: "P1",
			createdAt: "2026-05-10T09:00:00Z",
			resolvedAt: "2026-05-10T11:00:00Z",
			mttrMinutes: 120,
			url: "https://tommy.atlassian.net/browse/INC-101",
		});
		expect(parsed.success).toBe(true);
	});

	test("accepts nullable severity + resolvedAt + mttrMinutes", () => {
		const parsed = AtlassianLinkedIssueSchema.safeParse({
			key: "INC-9",
			summary: "Open issue",
			status: "Open",
			severity: null,
			resolvedAt: null,
			mttrMinutes: null,
		});
		expect(parsed.success).toBe(true);
	});

	test("rejects missing required key", () => {
		const parsed = AtlassianLinkedIssueSchema.safeParse({ summary: "x", status: "Open" });
		expect(parsed.success).toBe(false);
	});
});

describe("AtlassianFindingsSchema", () => {
	test("accepts empty findings", () => {
		expect(AtlassianFindingsSchema.safeParse({}).success).toBe(true);
	});

	test("accepts findings with linkedIssues", () => {
		const parsed = AtlassianFindingsSchema.safeParse({
			linkedIssues: [{ key: "A-1", summary: "x", status: "Open" }],
		});
		expect(parsed.success).toBe(true);
	});
});

describe("StreamEventSchema datasource_result with new findings", () => {
	test("parses a success result with awsFindings", () => {
		const parsed = StreamEventSchema.parse({
			type: "datasource_result",
			dataSourceId: "aws",
			status: "success",
			awsFindings: {
				alarms: [{ name: "msk-cpu", state: "ALARM", namespace: "AWS/Kafka" }],
			},
		});
		if (parsed.type !== "datasource_result") throw new Error("narrow");
		expect(parsed.awsFindings?.alarms?.[0]?.name).toBe("msk-cpu");
	});

	test("parses a success result with atlassianFindings", () => {
		const parsed = StreamEventSchema.parse({
			type: "datasource_result",
			dataSourceId: "atlassian",
			status: "success",
			atlassianFindings: {
				linkedIssues: [{ key: "INC-1", summary: "x", status: "Open" }],
			},
		});
		if (parsed.type !== "datasource_result") throw new Error("narrow");
		expect(parsed.atlassianFindings?.linkedIssues?.[0]?.key).toBe("INC-1");
	});
});
