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

// SIO-1134: a curated linkage (Incident.ticketKey) resolves by exact lookup.
describe("SIO-1134 curated ticket-link lookup", () => {
	test("returns a single ticket-link candidate without embedding", async () => {
		let embedCalled = false;
		_setEmbedderForTesting(async () => {
			embedCalled = true;
			return [0.1];
		});
		const store: GraphStore = {
			init: async () => undefined,
			close: async () => undefined,
			run: async <T>(cypher: string): Promise<T[]> => {
				if (cypher.includes("i.ticketKey = $ticketKey")) {
					return [{ id: "inc-curated", summary: "the canonical investigation", severity: "high" }] as T[];
				}
				return [] as T[];
			},
		};
		_setGraphStoreForTesting(store);

		const result = await learnMatchIncident(stateWith({ hilTicket: ticket() }));
		expect(result.hilMatchCandidates).toHaveLength(1);
		expect(result.hilMatchCandidates?.[0]).toMatchObject({ id: "inc-curated", via: "ticket-link", distance: 0 });
		expect(embedCalled).toBe(false);
	});
});

const REQ_ID = "1f5b2c8a-0d3e-4a9b-8c7d-2e6f4a1b9c0d";

function ticketWithRequestId(location: "description" | "comment"): TicketResolution {
	const footer = `\n\n**Request-Id:** ${REQ_ID}`;
	return {
		key: "DEVOPS-9001",
		summary: "pasted report ticket",
		status: "Done",
		description: location === "description" ? `Executive Summary\nThe report body.${footer}` : "The report body.",
		comments:
			location === "comment"
				? [{ author: "human", createdAt: "2026-07-17T00:00:00.000Z", body: `Pasting the report:${footer}` }]
				: [],
	};
}

const REQ_ID_2 = "2a6c3d9b-1e4f-5b0a-9d8c-3f7e5b2c0a1d";

describe("SIO-1133 extractRequestIds", () => {
	test("pulls UUIDs after the Request-Id label, case-insensitive, tolerant of markers", async () => {
		const { extractRequestIds } = await import("./match.ts");
		expect(extractRequestIds(`**Request-Id:** ${REQ_ID}`)).toEqual([REQ_ID]);
		expect(extractRequestIds(`request-id: ${REQ_ID.toUpperCase()}`)).toEqual([REQ_ID]);
		expect(extractRequestIds(`noise\nRequest-Id:   ${REQ_ID}\nmore`)).toEqual([REQ_ID]);
	});
	test("returns ALL ids in text order, deduped", async () => {
		const { extractRequestIds } = await import("./match.ts");
		// CodeRabbit PR #405: a stale footer must not hide a later valid id.
		expect(extractRequestIds(`Request-Id: ${REQ_ID}\n...\nRequest-Id: ${REQ_ID_2}`)).toEqual([REQ_ID, REQ_ID_2]);
		// Same id twice -> one entry.
		expect(extractRequestIds(`Request-Id: ${REQ_ID}\nRequest-Id: ${REQ_ID}`)).toEqual([REQ_ID]);
	});
	test("returns [] when absent or malformed", async () => {
		const { extractRequestIds } = await import("./match.ts");
		expect(extractRequestIds("no id here")).toEqual([]);
		expect(extractRequestIds("Request-Id: not-a-uuid")).toEqual([]);
		expect(extractRequestIds("Request-Id: 1f5b2c8a-0d3e-4a9b-8c7d")).toEqual([]); // truncated
	});
});

describe("SIO-1133 request-id scan lane", () => {
	function scanStore(incidentExists: boolean): GraphStore {
		return {
			init: async () => undefined,
			close: async () => undefined,
			run: async <T>(cypher: string): Promise<T[]> => {
				// curated ticketKey lookup runs first and must miss so the scan is reached.
				if (cypher.includes("i.ticketKey = $ticketKey")) return [] as T[];
				// incidentById node query.
				if (cypher.includes("MATCH (i:Incident {id: $id}) RETURN i.id AS id")) {
					return incidentExists
						? ([{ id: REQ_ID, summary: "the report incident", severity: "high" }] as T[])
						: ([] as T[]);
				}
				return [] as T[];
			},
		};
	}

	test("resolves a request-id candidate without embedding (description footer)", async () => {
		let embedCalled = false;
		_setEmbedderForTesting(async () => {
			embedCalled = true;
			return [0.1];
		});
		_setGraphStoreForTesting(scanStore(true));

		const result = await learnMatchIncident(stateWith({ hilTicket: ticketWithRequestId("description") }));
		expect(result.hilMatchCandidates).toHaveLength(1);
		expect(result.hilMatchCandidates?.[0]).toMatchObject({ id: REQ_ID, via: "request-id", distance: 0 });
		expect(result.hilTicketEmbedding).toEqual([]);
		expect(embedCalled).toBe(false);
	});

	test("scans comments too", async () => {
		_setEmbedderForTesting(async () => [0.1]);
		_setGraphStoreForTesting(scanStore(true));
		const result = await learnMatchIncident(stateWith({ hilTicket: ticketWithRequestId("comment") }));
		expect(result.hilMatchCandidates?.[0]).toMatchObject({ id: REQ_ID, via: "request-id" });
	});

	test("a request-id NOT in the KG falls through to pin/vector", async () => {
		_setEmbedderForTesting(async () => [0.1, 0.2]);
		// incidentById returns [] (not in KG); the vector fallback then runs.
		const store: GraphStore = {
			init: async () => undefined,
			close: async () => undefined,
			run: async <T>(cypher: string): Promise<T[]> => {
				if (cypher.includes("i.ticketKey = $ticketKey")) return [] as T[];
				if (cypher.includes("MATCH (i:Incident {id: $id}) RETURN i.id AS id")) return [] as T[];
				if (cypher.includes("QUERY_VECTOR_INDEX")) {
					return [{ id: "inc-vec", summary: "vector hit", severity: "low", distance: 0.3 }] as T[];
				}
				return [] as T[];
			},
		};
		_setGraphStoreForTesting(store);

		const result = await learnMatchIncident(stateWith({ hilTicket: ticketWithRequestId("description") }));
		// No request-id candidate; the vector fallback supplied the candidate instead.
		expect(result.hilMatchCandidates?.some((c) => c.via === "request-id")).toBe(false);
		expect(result.hilMatchCandidates?.[0]).toMatchObject({ id: "inc-vec", via: "vector" });
	});

	test("no Request-Id in the ticket text -> no request-id candidate", async () => {
		_setEmbedderForTesting(async () => [0.1]);
		_setGraphStoreForTesting(scanStore(true));
		const result = await learnMatchIncident(stateWith({ hilTicket: ticket() }));
		expect(result.hilMatchCandidates?.some((c) => c.via === "request-id")).toBe(false);
	});

	// CodeRabbit PR #405: a STALE footer id (first) must not hide a VALID id (second). The
	// scan queries each id in order until one resolves in the KG.
	test("a stale first Request-Id falls through to a valid second one", async () => {
		_setEmbedderForTesting(async () => [0.1]);
		const ticketTwoIds: TicketResolution = {
			key: "DEVOPS-9002",
			summary: "pasted report with two ids",
			status: "Done",
			// First id is stale (not in KG); the second resolves.
			description: `Old paste:\n**Request-Id:** ${REQ_ID}\n\nCorrected paste:\n**Request-Id:** ${REQ_ID_2}`,
			comments: [],
		};
		const store: GraphStore = {
			init: async () => undefined,
			close: async () => undefined,
			run: async <T>(cypher: string, params?: Record<string, unknown>): Promise<T[]> => {
				if (cypher.includes("i.ticketKey = $ticketKey")) return [] as T[];
				if (cypher.includes("MATCH (i:Incident {id: $id}) RETURN i.id AS id")) {
					// Only the SECOND id exists in the KG.
					return params?.id === REQ_ID_2
						? ([{ id: REQ_ID_2, summary: "the valid incident", severity: "high" }] as T[])
						: ([] as T[]);
				}
				return [] as T[];
			},
		};
		_setGraphStoreForTesting(store);

		const result = await learnMatchIncident(stateWith({ hilTicket: ticketTwoIds }));
		expect(result.hilMatchCandidates).toHaveLength(1);
		expect(result.hilMatchCandidates?.[0]).toMatchObject({ id: REQ_ID_2, via: "request-id" });
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

	test("PR #397 review: terminates at a next heading that came from ADF flattening", () => {
		// flattenAtlassianText renders ADF heading nodes as markdown headings, so a
		// fully-ADF report still terminates section capture correctly.
		const adfFlattened = [
			"## Executive Summary",
			"The service is failing its bootstrap handshake.",
			"## Findings",
			"| table | of | findings |",
		].join("\n");
		const out = extractExecutiveSummary(adfFlattened);
		expect(out).toBe("The service is failing its bootstrap handshake.");
	});

	test("PR #397 review: the 2000-char cap never splits a surrogate pair", () => {
		// Fill so the cap lands exactly on the middle of an emoji pair.
		const body = `${"x".repeat(1_999)}\u{1F600}rest`;
		const out = extractExecutiveSummary(`## Executive Summary\n${body}`);
		expect(out).not.toBeNull();
		const last = (out ?? "").charCodeAt((out ?? "").length - 1);
		// No lone high surrogate at the boundary.
		expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
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
