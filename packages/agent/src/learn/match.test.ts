// agent/src/learn/match.test.ts

import { afterEach, describe, expect, test } from "bun:test";
import { _setGraphStoreForTesting, type GraphStore } from "@devops-agent/knowledge-graph";
import { _setEmbedderForTesting } from "../graph-knowledge.ts";
import type { AgentStateType } from "../state.ts";
import { buildMatchEmbedText, learnMatchIncident } from "./match.ts";
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
