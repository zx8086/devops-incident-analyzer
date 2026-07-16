// agent/src/learn/ticket.test.ts

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentStateType } from "../state.ts";
import { capTicketForPrompt, flattenAtlassianText, learnFetchTicket, parseJiraIssuePayload } from "./ticket.ts";

const FIXTURE_JSON = readFileSync(join(import.meta.dir, "__fixtures__", "devops-1355-jira-issue.json"), "utf8");

function stateWith(overrides: Partial<AgentStateType>): AgentStateType {
	return overrides as AgentStateType;
}

afterEach(() => {
	delete process.env.HIL_LEARNING_ENABLED;
	delete process.env.KNOWLEDGE_GRAPH_ENABLED;
});

describe("SIO-1126 parseJiraIssuePayload", () => {
	test("parses the DEVOPS-1355 fixture (plain-string and ADF bodies)", () => {
		const ticket = parseJiraIssuePayload(FIXTURE_JSON, "DEVOPS-1355");
		expect(ticket).not.toBeNull();
		expect(ticket?.key).toBe("DEVOPS-1355");
		expect(ticket?.summary).toBe("Kafka controller election storm");
		expect(ticket?.status).toBe("In Progress");
		expect(ticket?.description).toContain("controller election storm");
		expect(ticket?.comments).toHaveLength(3);
		// The HIL correction is a plain string body.
		expect(ticket?.comments[1]?.author).toBe("Ops Engineer");
		expect(ticket?.comments[1]?.body).toContain("Route53 resolver rule");
		// The last comment is an ADF document; the flattener extracts its text.
		expect(ticket?.comments[2]?.body).toContain("Devs confirmed this was parked");
	});

	test("strips Rovo <custom> mention tags but keeps the inner text", () => {
		const ticket = parseJiraIssuePayload(FIXTURE_JSON, "DEVOPS-1355");
		expect(ticket?.comments[0]?.body).not.toContain("<custom");
		expect(ticket?.comments[0]?.body).toContain("@Ops Engineer");
	});

	test("returns null for non-JSON, non-object, and empty-fields payloads", () => {
		expect(parseJiraIssuePayload("Error: upstream 500", "X-1")).toBeNull();
		expect(parseJiraIssuePayload(JSON.stringify("just a string"), "X-1")).toBeNull();
		expect(parseJiraIssuePayload(JSON.stringify({ key: "X-1", fields: {} }), "X-1")).toBeNull();
	});
});

describe("SIO-1126 flattenAtlassianText", () => {
	test("handles nested ADF content and falls back to JSON for odd shapes", () => {
		const adf = {
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [
						{ type: "text", text: "hello" },
						{ type: "text", text: " world" },
					],
				},
			],
		};
		expect(flattenAtlassianText(adf).trim()).toBe("hello world");
		expect(flattenAtlassianText(null)).toBe("");
		expect(flattenAtlassianText({ weird: true })).toContain("weird");
	});
});

describe("SIO-1126 capTicketForPrompt", () => {
	test("caps each comment body and drops oldest comments when over the total budget", () => {
		const big = "x".repeat(5_000);
		const ticket = {
			key: "T-1",
			summary: "s",
			status: "Open",
			description: "d".repeat(3_000),
			comments: Array.from({ length: 10 }, (_, i) => ({ author: `a${i}`, createdAt: "", body: big })),
		};
		const capped = capTicketForPrompt(ticket, { perBodyChars: 2_000, totalChars: 9_000 });
		// Newest comments survive; oldest are dropped.
		expect(capped.comments.length).toBeLessThan(10);
		expect(capped.comments.at(-1)?.author).toBe("a9");
		for (const c of capped.comments) {
			expect(c.body.length).toBeLessThanOrEqual(2_000 + 20);
		}
		const total = capped.description.length + capped.comments.reduce((n, c) => n + c.body.length, 0);
		expect(total).toBeLessThanOrEqual(9_000 + 20);
	});

	test("leaves a small ticket untouched", () => {
		const ticket = {
			key: "T-1",
			summary: "s",
			status: "Open",
			description: "short",
			comments: [{ author: "a", createdAt: "", body: "b" }],
		};
		expect(capTicketForPrompt(ticket)).toEqual(ticket);
	});
});

describe("SIO-1126 learnFetchTicket gates", () => {
	test("returns {} when the lane is disabled", async () => {
		process.env.HIL_LEARNING_ENABLED = "false";
		const result = await learnFetchTicket(stateWith({ hilLearnTicketKey: "DEVOPS-1355" }));
		expect(result).toEqual({});
	});

	test("returns {} when no ticket key is set", async () => {
		const result = await learnFetchTicket(stateWith({ hilLearnTicketKey: undefined }));
		expect(result).toEqual({});
	});

	test("aborts the lane with a message when the knowledge graph is disabled", async () => {
		delete process.env.KNOWLEDGE_GRAPH_ENABLED;
		const result = await learnFetchTicket(stateWith({ hilLearnTicketKey: "DEVOPS-1355" }));
		expect(result.hilTicket).toBeUndefined();
		expect(result.partialFailures?.[0]?.reason).toBe("knowledge-graph-disabled");
		expect(result.messages).toHaveLength(1);
	});
});
