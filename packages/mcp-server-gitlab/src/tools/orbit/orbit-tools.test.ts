// src/tools/orbit/orbit-tools.test.ts
// SIO-1179: handler-level tests for the Orbit tools -- budget guard, availability
// re-check, blast-radius mrByFile stitching, selectivity rejection, and the
// structured { _error } envelope classification.

import { describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type OrbitRestClient, OrbitUnavailableError } from "../../gitlab-client/orbit.js";
import { type OrbitToolContext, registerOrbitTools } from "./index.js";

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	isError?: boolean;
}
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function stubServer() {
	const handlers = new Map<string, ToolHandler>();
	const server = {
		tool: (name: string, _desc: string, _shape: unknown, handler: ToolHandler) => {
			handlers.set(name, handler);
		},
	} as unknown as McpServer;
	return { server, handlers };
}

// Mirrors the live gitlab.com /orbit/status shape (SIO-1077) so isOrbitIndexed
// flips availability in the boot-unavailable re-check test.
const LIVE_HEALTHY_STATUS = {
	system: {
		status: "healthy",
		version: "0.86.0",
		components: [
			{ name: "gkg-indexer-sdlc", status: "healthy", replicas: { ready: 8, desired: 8 } },
			{ name: "gkg-indexer-code", status: "healthy", replicas: { ready: 10, desired: 10 } },
		],
	},
};

function extractEnvelope(text: string): { kind: string; category: string; statusCode?: number } {
	const start = text.indexOf('{"_error"');
	expect(start).toBeGreaterThan(-1);
	const parsed = JSON.parse(text.slice(start)) as { _error: { kind: string; category: string; statusCode?: number } };
	return parsed._error;
}

function makeCtx(over: Partial<OrbitToolContext>, client?: Partial<OrbitRestClient>): OrbitToolContext {
	return {
		client: client as unknown as OrbitRestClient,
		available: true,
		maxQueriesPerRun: 20,
		defaultGroupPath: "pvhcorp",
		...over,
	};
}

function register(ctx: OrbitToolContext) {
	const { server, handlers } = stubServer();
	const count = registerOrbitTools(server, ctx);
	return { handlers, count };
}

describe("Orbit tools: availability", () => {
	test("no client -> no-index envelope after the steering prose (non-degrading)", async () => {
		const { handlers } = register(makeCtx({ client: undefined, available: false }));
		const result = await handlers.get("gitlab_cross_project_callers")?.({ fqn: "X" });
		expect(result?.isError).toBe(true);
		const text = result?.content[0]?.text ?? "";
		expect(text.startsWith("The GitLab Orbit knowledge graph is not available")).toBe(true);
		const envelope = extractEnvelope(text);
		expect(envelope.kind).toBe("no-index");
		expect(envelope.category).toBe("no-data");
	});

	// SIO-1295: the re-check arms for ANY boot-unavailable state (e.g. a boot during a
	// schema migration or a failed boot probe), not just "indexing" -- a recovered Orbit
	// is picked up on the next tool call without a process restart.
	test("booted unavailable -> one free status re-check flips availability and the query proceeds", async () => {
		let statusCalls = 0;
		let queryCalls = 0;
		const client: Partial<OrbitRestClient> = {
			getStatus: async () => {
				statusCalls += 1;
				return LIVE_HEALTHY_STATUS as Awaited<ReturnType<OrbitRestClient["getStatus"]>>;
			},
			query: async () => {
				queryCalls += 1;
				return { result: { rows: [] } };
			},
		};
		const ctx = makeCtx({ available: false }, client);
		const { handlers } = register(ctx);
		const result = await handlers.get("gitlab_cross_project_callers")?.({ fqn: "X" });
		expect(result?.isError).toBeFalsy();
		expect(statusCalls).toBe(1);
		expect(queryCalls).toBe(1);
		expect(ctx.available).toBe(true);
	});

	// The free schema tool participates in the same recovery contract: if it is the
	// first handler invoked after a recovery, it must flip availability too.
	test("gitlab_graph_schema also re-checks a boot-unavailable context and recovers", async () => {
		let statusCalls = 0;
		let schemaCalls = 0;
		const client: Partial<OrbitRestClient> = {
			getStatus: async () => {
				statusCalls += 1;
				return LIVE_HEALTHY_STATUS as Awaited<ReturnType<OrbitRestClient["getStatus"]>>;
			},
			getSchema: async () => {
				schemaCalls += 1;
				return { nodes: [] };
			},
		};
		const ctx = makeCtx({ available: false }, client);
		const { handlers } = register(ctx);
		const result = await handlers.get("gitlab_graph_schema")?.({});
		expect(result?.isError).toBeFalsy();
		expect(statusCalls).toBe(1);
		expect(schemaCalls).toBe(1);
		expect(ctx.available).toBe(true);
	});

	test("re-check that still reports unavailable soft-fails with no-index and never bills", async () => {
		let statusCalls = 0;
		let queryCalls = 0;
		const client: Partial<OrbitRestClient> = {
			getStatus: async () => {
				statusCalls += 1;
				return { status: "indexing" } as Awaited<ReturnType<OrbitRestClient["getStatus"]>>;
			},
			query: async () => {
				queryCalls += 1;
				return { result: { rows: [] } };
			},
		};
		const ctx = makeCtx({ available: false }, client);
		const { handlers } = register(ctx);
		const result = await handlers.get("gitlab_cross_project_callers")?.({ fqn: "X" });
		expect(result?.isError).toBe(true);
		expect(extractEnvelope(result?.content[0]?.text ?? "").kind).toBe("no-index");
		expect(statusCalls).toBe(1);
		expect(queryCalls).toBe(0);
		expect(ctx.available).toBe(false);
	});
});

describe("Orbit tools: credit budget guard", () => {
	test("second billed call in the window returns a throttled envelope, no billed query", async () => {
		let queryCalls = 0;
		const client: Partial<OrbitRestClient> = {
			query: async () => {
				queryCalls += 1;
				return { result: { rows: [] } };
			},
		};
		const { handlers } = register(makeCtx({ maxQueriesPerRun: 1 }, client));
		const first = await handlers.get("gitlab_cross_project_callers")?.({ fqn: "X" });
		expect(first?.isError).toBeFalsy();
		const second = await handlers.get("gitlab_cross_project_callers")?.({ fqn: "Y" });
		expect(second?.isError).toBe(true);
		const text = second?.content[0]?.text ?? "";
		expect(text).toContain("budget");
		expect(extractEnvelope(text).kind).toBe("throttled");
		expect(queryCalls).toBe(1);
	});
});

describe("gitlab_blast_radius: mrByFile enrichment stitching", () => {
	test("stitches MR metadata per distinct def file, capped at 3, enrich failure non-fatal", async () => {
		const calls: unknown[] = [];
		const blastRows = {
			result: {
				rows: [
					{ def: { file_path: "a.ts" }, sym: { file_path: "x.ts" } },
					{ def: { file_path: "b.ts" }, sym: { file_path: "y.ts" } },
					{ def: { file_path: "c.ts" }, sym: { file_path: "z.ts" } },
					{ def: { file_path: "d.ts" }, sym: { file_path: "w.ts" } },
				],
			},
		};
		let call = 0;
		const client: Partial<OrbitRestClient> = {
			query: async (dsl: Record<string, unknown>) => {
				calls.push(dsl);
				call += 1;
				if (call === 1) return blastRows;
				// enrich queries: second one fails (non-fatal), others return an MR row
				if (call === 3) throw new OrbitUnavailableError("enrich boom");
				return { result: { rows: [{ mr: { iid: 42, merged_at: "2026-07-20 10:00:00" } }] } };
			},
		};
		const { handlers } = register(makeCtx({}, client));
		const result = await handlers.get("gitlab_blast_radius")?.({ symbol: "logger" });
		expect(result?.isError).toBeFalsy();
		const payload = JSON.parse(result?.content[0]?.text ?? "{}") as {
			queryTag: string;
			mrByFile: Record<string, { iid: number }>;
		};
		expect(payload.queryTag).toBe("orbit_blast_radius");
		// 4 distinct files, MAX_ENRICH_FILES=3 -> only a/b/c attempted; b's enrich failed
		expect(Object.keys(payload.mrByFile).sort()).toEqual(["a.ts", "c.ts"]);
		expect(payload.mrByFile["a.ts"]?.iid).toBe(42);
		// 1 blast + 3 enrich queries
		expect(calls.length).toBe(4);
	});

	test("emitted blast query carries no group file_path filter (SIO-1179 dead-filter regression)", async () => {
		let captured: Record<string, unknown> | undefined;
		const client: Partial<OrbitRestClient> = {
			query: async (dsl: Record<string, unknown>) => {
				captured = captured ?? dsl;
				return { result: { rows: [] } };
			},
		};
		const { handlers } = register(makeCtx({}, client));
		await handlers.get("gitlab_blast_radius")?.({ symbol: "logger" });
		expect(JSON.stringify(captured)).not.toContain("pvhcorp");
		expect(JSON.stringify(captured)).not.toContain("contains");
	});
});

// SIO-1303: the IMPORTS join is blind to Java same-package and cross-service REST
// coupling, so a 0-row edge result does not mean "no blast radius" -- it means the
// join can't see it. The handler falls back to a Definition name-sweep and tags the
// payload distinctly so the extractor and the LLM both know these rows are name
// co-occurrences, not confirmed import edges.
describe("gitlab_blast_radius: definition name-match fallback (SIO-1303)", () => {
	test("0 edge rows -> fallback query fires, payload tagged radiusMode, mrByFile still stitches", async () => {
		const calls: Array<Record<string, unknown>> = [];
		let call = 0;
		const client: Partial<OrbitRestClient> = {
			query: async (dsl: Record<string, unknown>) => {
				calls.push(dsl);
				call += 1;
				if (call === 1) return { result: { rows: [] } }; // primary IMPORTS join: 0 rows
				if (call === 2) {
					// fallback definition name-match: 1 row
					return { result: { rows: [{ def: { fqn: "StyleController#getStyleByStyleCode", file_path: "a.java" } }] } };
				}
				// enrichment MR-for-file query
				return { result: { rows: [{ mr: { iid: 7, merged_at: "2026-07-20 10:00:00" } }] } };
			},
		};
		const { handlers } = register(makeCtx({}, client));
		const result = await handlers.get("gitlab_blast_radius")?.({ symbol: "getStyleByStyleCode" });
		expect(result?.isError).toBeFalsy();
		const payload = JSON.parse(result?.content[0]?.text ?? "{}") as {
			queryTag: string;
			radiusMode?: string;
			mrByFile: Record<string, { iid: number }>;
		};
		expect(payload.queryTag).toBe("orbit_blast_radius");
		expect(payload.radiusMode).toBe("definition-name-match");
		expect(payload.mrByFile["a.java"]?.iid).toBe(7);
		// call 2 must be the fallback DSL: single Definition node, no IMPORTS relationship
		const fallbackDsl = calls[1];
		const nodes = fallbackDsl?.nodes as Array<{ entity: string }> | undefined;
		expect(nodes).toHaveLength(1);
		expect(nodes?.[0]?.entity).toBe("Definition");
		expect(fallbackDsl?.relationships ?? []).toHaveLength(0);
	});

	test("edge query returns rows -> no fallback triggered, radiusMode omitted", async () => {
		let call = 0;
		const client: Partial<OrbitRestClient> = {
			query: async () => {
				call += 1;
				if (call === 1) return { result: { rows: [{ def: { file_path: "logger.js" }, sym: { file_path: "x.js" } }] } };
				return { result: { rows: [] } }; // enrichment
			},
		};
		const { handlers } = register(makeCtx({}, client));
		const result = await handlers.get("gitlab_blast_radius")?.({ symbol: "logger" });
		const payload = JSON.parse(result?.content[0]?.text ?? "{}") as { radiusMode?: string };
		expect(payload.radiusMode).toBeUndefined();
		expect(call).toBe(2); // primary + 1 enrich; no fallback query
	});

	test("0 edge rows + budget exhausted before fallback -> returns empty primary result, no crash", async () => {
		let call = 0;
		const client: Partial<OrbitRestClient> = {
			query: async () => {
				call += 1;
				return { result: { rows: [] } };
			},
		};
		// maxQueriesPerRun: 1 means the primary query consumes the only slot in the window.
		const { handlers } = register(makeCtx({ maxQueriesPerRun: 1 }, client));
		const result = await handlers.get("gitlab_blast_radius")?.({ symbol: "getStyleByStyleCode" });
		expect(result?.isError).toBeFalsy();
		const payload = JSON.parse(result?.content[0]?.text ?? "{}") as { radiusMode?: string };
		expect(payload.radiusMode).toBeUndefined();
		expect(call).toBe(1); // only the primary query ran
	});

	test("fallback query throws -> falls through to the empty primary payload, no error", async () => {
		let call = 0;
		const client: Partial<OrbitRestClient> = {
			query: async () => {
				call += 1;
				if (call === 1) return { result: { rows: [] } };
				throw new OrbitUnavailableError("fallback boom");
			},
		};
		const { handlers } = register(makeCtx({}, client));
		const result = await handlers.get("gitlab_blast_radius")?.({ symbol: "getStyleByStyleCode" });
		expect(result?.isError).toBeFalsy();
		const payload = JSON.parse(result?.content[0]?.text ?? "{}") as { radiusMode?: string; mrByFile: unknown };
		expect(payload.radiusMode).toBeUndefined();
		expect(payload.mrByFile).toEqual({});
	});
});

describe("gitlab_orbit_query_graph: selectivity + error classification", () => {
	test("unselective query rejected with bad-query envelope BEFORE any billed call", async () => {
		let queryCalls = 0;
		const client: Partial<OrbitRestClient> = {
			query: async () => {
				queryCalls += 1;
				return { result: { rows: [] } };
			},
		};
		const { handlers } = register(makeCtx({}, client));
		const result = await handlers.get("gitlab_orbit_query_graph")?.({
			query: { query_type: "traversal", nodes: [{ id: "p", entity: "Project", columns: ["name"] }], limit: 5 },
		});
		expect(result?.isError).toBe(true);
		expect(extractEnvelope(result?.content[0]?.text ?? "").kind).toBe("bad-query");
		expect(queryCalls).toBe(0);
	});

	test("compile_error from Orbit classifies as bad-query (wins over the HTTP status)", async () => {
		const client: Partial<OrbitRestClient> = {
			query: async () => {
				throw new OrbitUnavailableError("Orbit query failed (400): compile_error schema violation", 400);
			},
		};
		const { handlers } = register(makeCtx({}, client));
		const result = await handlers.get("gitlab_cross_project_callers")?.({ fqn: "X" });
		expect(result?.isError).toBe(true);
		const text = result?.content[0]?.text ?? "";
		const envelope = extractEnvelope(text);
		expect(envelope.kind).toBe("bad-query");
		expect(envelope.statusCode).toBe(400);
		// SIO-1294: a compile error means Orbit is UP and rejected the query shape --
		// the prose must steer fix-the-DSL, never the unavailability fallback.
		expect(text).not.toContain("not available");
		expect(text).toContain("Fix the query DSL");
		expect(text).toContain("gitlab_graph_schema");
	});

	test("upstream 503 classifies as server-error and keeps the unavailability fallback prose", async () => {
		const client: Partial<OrbitRestClient> = {
			query: async () => {
				throw new OrbitUnavailableError("Orbit query failed (503)", 503);
			},
		};
		const { handlers } = register(makeCtx({}, client));
		const result = await handlers.get("gitlab_cross_project_callers")?.({ fqn: "X" });
		expect(result?.isError).toBe(true);
		const text = result?.content[0]?.text ?? "";
		expect(extractEnvelope(text).kind).toBe("server-error");
		// SIO-1294: only bad-query branches away from the fallback steering.
		expect(text).toContain("not available");
	});
});

describe("registerOrbitTools surface", () => {
	test("registers exactly 7 tools and blast_radius exposes no group_path param", () => {
		const shapes = new Map<string, Record<string, unknown>>();
		const server = {
			tool: (name: string, _desc: string, shape: Record<string, unknown>) => {
				shapes.set(name, shape);
			},
		} as unknown as McpServer;
		const count = registerOrbitTools(server, makeCtx({}));
		expect(count).toBe(7);
		expect(shapes.size).toBe(7);
		expect(Object.keys(shapes.get("gitlab_blast_radius") ?? {}).sort()).toEqual(["limit", "symbol"]);
	});
});
