// shared/src/__tests__/ticket-types.test.ts
import { describe, expect, test } from "bun:test";
import {
	CreatedTicketSchema,
	CreateTicketRequestSchema,
	TicketProviderIdSchema,
	TicketProviderInfoSchema,
} from "../ticket-types.ts";

describe("TicketProviderIdSchema", () => {
	test("accepts jira", () => {
		expect(TicketProviderIdSchema.parse("jira")).toBe("jira");
	});

	test("rejects unknown providers", () => {
		expect(TicketProviderIdSchema.safeParse("linear").success).toBe(false);
	});
});

describe("CreateTicketRequestSchema", () => {
	const valid = {
		projectKey: "DEVOPS",
		issueTypeName: "Task",
		summary: "Kafka consumer lag on orders-events",
		description: "Full incident report markdown",
		assigneeId: "70121:86ec4ccf-9601-42a5-ab81-d15240b5de71",
		epicKey: "DEVOPS-1354",
	};

	test("accepts a full request", () => {
		expect(CreateTicketRequestSchema.parse(valid)).toEqual(valid);
	});

	test("accepts null assigneeId (unassigned)", () => {
		expect(CreateTicketRequestSchema.parse({ ...valid, assigneeId: null }).assigneeId).toBeNull();
	});

	test("rejects missing assigneeId (must be explicit null)", () => {
		const { assigneeId: _assigneeId, ...rest } = valid;
		expect(CreateTicketRequestSchema.safeParse(rest).success).toBe(false);
	});

	test("accepts null epicKey (no epic) and rejects missing epicKey", () => {
		expect(CreateTicketRequestSchema.parse({ ...valid, epicKey: null }).epicKey).toBeNull();
		const { epicKey: _epicKey, ...rest } = valid;
		expect(CreateTicketRequestSchema.safeParse(rest).success).toBe(false);
	});

	test("rejects empty summary and over-long summary", () => {
		expect(CreateTicketRequestSchema.safeParse({ ...valid, summary: "" }).success).toBe(false);
		expect(CreateTicketRequestSchema.safeParse({ ...valid, summary: "x".repeat(256) }).success).toBe(false);
	});

	test("rejects description over 32k", () => {
		expect(CreateTicketRequestSchema.safeParse({ ...valid, description: "x".repeat(32_001) }).success).toBe(false);
	});
});

describe("CreatedTicketSchema", () => {
	test("url is optional", () => {
		expect(CreatedTicketSchema.parse({ key: "DEVOPS-1382" })).toEqual({ key: "DEVOPS-1382" });
	});
});

describe("TicketProviderInfoSchema", () => {
	test("id must be a known provider", () => {
		expect(TicketProviderInfoSchema.safeParse({ id: "jira", label: "Jira" }).success).toBe(true);
		expect(TicketProviderInfoSchema.safeParse({ id: "github", label: "GitHub" }).success).toBe(false);
	});
});
