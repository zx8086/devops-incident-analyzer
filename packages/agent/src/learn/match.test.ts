// agent/src/learn/match.test.ts

import { afterEach, describe, expect, test } from "bun:test";
import { _setGraphStoreForTesting, type GraphStore } from "@devops-agent/knowledge-graph";
import { _setEmbedderForTesting } from "../graph-knowledge.ts";
import type { AgentStateType } from "../state.ts";
import { buildMatchEmbedText, extractExecutiveSummary, learnMatchIncident } from "./match.ts";
import type { TicketResolution } from "./ticket.ts";

function ticket(): TicketResolution {
	return {
		key: "DEVOPS-1355",
		summary: "MSK Kafka controller election storm",
		status: "In Progress",
		description: "Confluent bootstrap disconnects, broker id -1",
		comments: [],
	};
}

function stateWith(overrides: Partial<AgentStateType>): AgentStateType {
	return overrides as AgentStateType;
}

afterEach(() => {
	_setEmbedderForTesting(null);
	_setGraphStoreForTesting(null);
});

describe("SIO-1126 buildMatchEmbedText", () => {
	test("joins summary + description and respects the embedding char cap", () => {
		const text = buildMatchEmbedText("summary", "x".repeat(40_000));
		expect(text.startsWith("summary\n")).toBe(true);
		// truncateForEmbedding head-truncates at embeddingMaxChars (default 24000).
		expect(text.length).toBeLessThanOrEqual(24_000);
	});
});

describe("SIO-1126 learnMatchIncident", () => {
	test("pins ticket-mention hits first and appends vector hits, deduped", async () => {
		_setEmbedderForTesting(async () => [0.1, 0.2, 0.3]);
		const store: GraphStore = {
			init: async () => undefined,
			close: async () => undefined,
			run: async <T>(cypher: string): Promise<T[]> => {
				if (cypher.includes("CONTAINS")) {
					return [{ id: "inc-pin", summary: "investigation mentioning DEVOPS-1355", severity: "high" }] as T[];
				}
				if (cypher.includes("QUERY_VECTOR_INDEX")) {
					return [
						{ id: "inc-pin", summary: "duplicate of the pin", severity: "high", distance: 0.01 },
						{ id: "inc-2", summary: "similar confluent incident", severity: "medium", distance: 0.2 },
					] as T[];
				}
				return [] as T[];
			},
		};
		_setGraphStoreForTesting(store);

		const result = await learnMatchIncident(stateWith({ hilTicket: ticket() }));
		const candidates = result.hilMatchCandidates ?? [];
		expect(candidates.map((c) => c.id)).toEqual(["inc-pin", "inc-2"]);
		expect(candidates[0]?.via).toBe("ticket-mention");
		expect(candidates[1]?.via).toBe("vector");
		expect(result.hilTicketEmbedding).toEqual([0.1, 0.2, 0.3]);
	});

	test("a total matching outage aborts the lane instead of offering create-new", async () => {
		// Outage != zero matches: minting a duplicate incident on a store/embedder
		// failure is worse than asking the user to retry (CodeRabbit, PR #392).
		_setEmbedderForTesting(async () => {
			throw new Error("bedrock down");
		});
		const store: GraphStore = {
			init: async () => undefined,
			close: async () => undefined,
			run: async () => {
				throw new Error("store down");
			},
		};
		_setGraphStoreForTesting(store);

		const result = await learnMatchIncident(stateWith({ hilTicket: ticket() }));
		expect(result.hilTicket).toBeUndefined();
		expect(result.messages).toHaveLength(1);
		expect(result.partialFailures?.[0]?.reason).toBe("match-unavailable");
	});

	test("a genuine zero-match result still reaches the gate (create-new allowed)", async () => {
		_setEmbedderForTesting(async () => [0.1, 0.2, 0.3]);
		const store: GraphStore = {
			init: async () => undefined,
			close: async () => undefined,
			run: async () => [],
		};
		_setGraphStoreForTesting(store);

		const result = await learnMatchIncident(stateWith({ hilTicket: ticket() }));
		expect(result.hilMatchCandidates).toEqual([]);
		// The lane is NOT aborted: hilTicket is untouched (key absent from the update).
		expect("hilTicket" in result).toBe(false);
	});

	test("returns {} without a fetched ticket", async () => {
		expect(await learnMatchIncident(stateWith({}))).toEqual({});
	});
});

// SIO-1132: the embedding input prefers the ticket's Executive Summary -- the
// stored Incident vectors are short user-query embeddings, so summary-vs-summary
// is the aligned pair; whole-report embeddings drown in shared boilerplate.
describe("SIO-1132 extractExecutiveSummary", () => {
	const REPORT = [
		"# Incident Report -- consumer-service Couchbase Connectivity Failures",
		"",
		"**Generated:** 2026-06-02T10:31:29.730Z",
		"",
		"## Executive Summary",
		"",
		"consumer-service is throwing BaseEndpoint exceptions exclusively for this",
		"service while all other services remain healthy. The primary root cause",
		"hypothesis is a security group missing from the private endpoint allowlist.",
		"",
		"## Current State Assessment",
		"",
		"| Time | Datasource | Finding |",
	].join("\n");

	test("captures the section under a ## heading, stopping at the next heading", () => {
		const out = extractExecutiveSummary(REPORT);
		expect(out).toContain("BaseEndpoint exceptions exclusively");
		expect(out).toContain("private endpoint allowlist");
		expect(out).not.toContain("Current State Assessment");
		expect(out).not.toContain("| Time |");
	});

	test("matches a BARE heading line (post-ADF flattening strips # markers)", () => {
		const flattened = [
			"Some header text",
			"Executive Summary",
			"The cluster itself is healthy.",
			"---",
			"Findings",
		].join("\n");
		expect(extractExecutiveSummary(flattened)).toBe("The cluster itself is healthy.");
	});

	test("matches a **bold** heading variant", () => {
		const text = ["**Executive Summary**", "Bold-heading style summary body.", "**Findings**", "table..."].join("\n");
		expect(extractExecutiveSummary(text)).toBe("Bold-heading style summary body.");
	});

	test("caps the captured section length", () => {
		const long = `## Executive Summary\n${"x".repeat(10_000)}`;
		const out = extractExecutiveSummary(long);
		expect(out).not.toBeNull();
		expect((out ?? "").length).toBeLessThanOrEqual(2_000);
	});

	test("returns null when no section exists or it is empty", () => {
		expect(extractExecutiveSummary("just a plain ticket body without sections")).toBeNull();
		expect(extractExecutiveSummary("## Executive Summary\n## Next Section\nbody")).toBeNull();
	});

	test("buildMatchEmbedText embeds summary + exec summary when present, full text otherwise", () => {
		const withSection = buildMatchEmbedText("Ticket title", REPORT);
		expect(withSection).toContain("Ticket title");
		expect(withSection).toContain("BaseEndpoint exceptions exclusively");
		expect(withSection).not.toContain("| Time |");

		const withoutSection = buildMatchEmbedText("Ticket title", "plain body text");
		expect(withoutSection).toBe("Ticket title\nplain body text");
	});
});
