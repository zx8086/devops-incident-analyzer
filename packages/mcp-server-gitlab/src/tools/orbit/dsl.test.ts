// src/tools/orbit/dsl.test.ts

import { describe, expect, test } from "bun:test";
import {
	buildBlastRadiusQuery,
	buildCrossProjectCallersQuery,
	buildMrForFileQuery,
	buildPipelineFailuresQuery,
	buildRecentDeploysQuery,
	buildRecentVulnerabilitiesQuery,
	hasSelectiveAnchor,
	ORBIT_QUERY_TAGS,
} from "./dsl.js";

// Every DSL object has to carry a selective node (filters/node_ids/id_range) or
// Orbit rejects it. This walks the node list and asserts at least one selector.
function hasSelectiveNode(dsl: Record<string, unknown>): boolean {
	const nodes = (dsl.nodes as Array<Record<string, unknown>> | undefined) ?? [];
	const single = dsl.node as Record<string, unknown> | undefined;
	const all = single ? [single, ...nodes] : nodes;
	return all.some((n) => n.filters !== undefined || n.node_ids !== undefined || n.id_range !== undefined);
}

describe("Orbit DSL builders", () => {
	test("blast radius: tagged, selective, anchored on the symbol", () => {
		const { queryTag, dsl } = buildBlastRadiusQuery({ symbol: "authenticate", groupPath: "pvhcorp" });
		expect(queryTag).toBe(ORBIT_QUERY_TAGS.blastRadius);
		expect(hasSelectiveNode(dsl)).toBe(true);
		expect(JSON.stringify(dsl)).toContain("authenticate");
		expect(dsl.query_type).toBe("traversal");
	});

	test("blast radius: rejects an empty symbol (no unbounded scan)", () => {
		expect(() => buildBlastRadiusQuery({ symbol: "   " })).toThrow(/selectivity/i);
	});

	test("cross-project callers: exact fqn eq filter", () => {
		const { queryTag, dsl } = buildCrossProjectCallersQuery({ fqn: "Gitlab::Auth::authenticate" });
		expect(queryTag).toBe(ORBIT_QUERY_TAGS.crossProjectCallers);
		expect(hasSelectiveNode(dsl)).toBe(true);
		expect(JSON.stringify(dsl)).toContain("Gitlab::Auth::authenticate");
	});

	test("recent deploys: group-prefixed, time-bounded, merged only", () => {
		const { queryTag, dsl } = buildRecentDeploysQuery({ groupPath: "pvhcorp", since: "2026-06-01T00:00:00Z" });
		expect(queryTag).toBe(ORBIT_QUERY_TAGS.recentDeploys);
		expect(hasSelectiveNode(dsl)).toBe(true);
		const s = JSON.stringify(dsl);
		expect(s).toContain("pvhcorp/");
		expect(s).toContain("2026-06-01T00:00:00Z");
		expect(s).toContain("merged");
		expect(dsl.order_by).toBe("-mr.merged_at");
	});

	test("pipeline failures: MUST filter source=merge_request_event", () => {
		const { queryTag, dsl } = buildPipelineFailuresQuery({ groupPath: "pvhcorp", since: "2026-06-01T00:00:00Z" });
		expect(queryTag).toBe(ORBIT_QUERY_TAGS.pipelineFailures);
		expect(hasSelectiveNode(dsl)).toBe(true);
		expect(JSON.stringify(dsl)).toContain("merge_request_event");
		expect(dsl.query_type).toBe("aggregation");
	});

	test("no builder uses HAS_LATEST_DIFF (history must use HAS_DIFF)", () => {
		const queries = [
			buildBlastRadiusQuery({ symbol: "x" }),
			buildCrossProjectCallersQuery({ fqn: "a::b" }),
			buildRecentDeploysQuery({ groupPath: "g", since: "2026-01-01" }),
			buildPipelineFailuresQuery({ groupPath: "g", since: "2026-01-01" }),
			buildRecentVulnerabilitiesQuery({ groupPath: "g" }),
		];
		for (const { dsl } of queries) {
			expect(JSON.stringify(dsl)).not.toContain("HAS_LATEST_DIFF");
		}
	});

	test("limits are clamped to <= 1000", () => {
		const { dsl } = buildRecentDeploysQuery({ groupPath: "g", since: "2026-01-01", limit: 999999 });
		expect(dsl.limit).toBe(1000);
	});

	test("vulns: critical/high, group-prefixed", () => {
		const { queryTag, dsl } = buildRecentVulnerabilitiesQuery({ groupPath: "pvhcorp" });
		expect(queryTag).toBe(ORBIT_QUERY_TAGS.recentVulnerabilities);
		expect(hasSelectiveNode(dsl)).toBe(true);
		const s = JSON.stringify(dsl);
		expect(s).toContain("critical");
		expect(s).toContain("high");
		expect(dsl.order_by).toBe("-v.severity");
	});

	test("MR-for-file enrichment: selective on old_path, merged, tagged as blast_radius", () => {
		const { queryTag, dsl } = buildMrForFileQuery({ sourceFile: "pvhcorp/auth-lib/verify.rb" });
		// Reuses blastRadius tag so the extractor merges MR metadata into the finding.
		expect(queryTag).toBe(ORBIT_QUERY_TAGS.blastRadius);
		expect(hasSelectiveNode(dsl)).toBe(true);
		const s = JSON.stringify(dsl);
		expect(s).toContain("old_path");
		expect(s).toContain("pvhcorp/auth-lib/verify.rb");
		expect(s).toContain("merged");
		expect(s).not.toContain("HAS_LATEST_DIFF");
		expect(dsl.order_by).toBe("-mr.merged_at");
	});

	// SIO-1123: Orbit rejects order_by as an object -- it MUST be a string matching
	// ^(-)?node.property$ (confirmed against Orbit's own schema-validation error
	// while live-testing gitlab_recent_deploys / gitlab_recent_vulnerabilities).
	test("every order_by is a '-node.property'/'node.property' string, never an object", () => {
		const ORDER_BY_RE = /^-?[a-zA-Z_][a-zA-Z0-9_]{0,63}\.[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
		const queries = [
			buildRecentDeploysQuery({ groupPath: "g", since: "2026-01-01" }),
			buildRecentVulnerabilitiesQuery({ groupPath: "g" }),
			buildMrForFileQuery({ sourceFile: "g/f.rb" }),
		];
		for (const { dsl } of queries) {
			if (dsl.order_by === undefined) continue;
			expect(typeof dsl.order_by).toBe("string");
			expect(dsl.order_by as string).toMatch(ORDER_BY_RE);
		}
	});
});

describe("hasSelectiveAnchor", () => {
	test("true when a node carries filters", () => {
		expect(
			hasSelectiveAnchor({ query_type: "traversal", node: { entity: "Project", filters: { full_path: "x" } } }),
		).toBe(true);
	});
	test("true when a node carries non-empty node_ids", () => {
		expect(hasSelectiveAnchor({ nodes: [{ entity: "MergeRequest", node_ids: [1] }] })).toBe(true);
	});
	test("true when a node carries a full id_range (start + end)", () => {
		expect(hasSelectiveAnchor({ node: { entity: "Project", id_range: { start: 1, end: 100 } } })).toBe(true);
	});
	test("false for empty selectors (Orbit rejects but still bills)", () => {
		expect(hasSelectiveAnchor({ query_type: "traversal", node: { entity: "Project" } })).toBe(false);
		expect(hasSelectiveAnchor({ nodes: [{ entity: "Project", filters: {} }] })).toBe(false);
		// Empty node_ids / partial or empty id_range are NOT selective.
		expect(hasSelectiveAnchor({ nodes: [{ entity: "Project", node_ids: [] }] })).toBe(false);
		expect(hasSelectiveAnchor({ node: { entity: "Project", id_range: {} } })).toBe(false);
		expect(hasSelectiveAnchor({ node: { entity: "Project", id_range: { start: 1 } } })).toBe(false);
	});
});

// SIO-1151: filter-grammar contract, live-validated against Orbit format_version
// 3.0.1 on 2026-07-19. Filters are op-AS-KEY objects; the former { op, value }
// shape is rejected with compile_error "schema violation ... oneOf" for EVERY op
// (eq included), and aggregation_sort is a string mirroring order_by. These
// fixtures lock the shape so the next upstream drift fails here, not in
// production sub-agent turns.
describe("Orbit filter-grammar contract (SIO-1151)", () => {
	function walkForLegacyOpShape(value: unknown, path = "$"): string[] {
		const hits: string[] = [];
		if (Array.isArray(value)) {
			value.forEach((v, i) => {
				hits.push(...walkForLegacyOpShape(v, `${path}[${i}]`));
			});
			return hits;
		}
		if (value && typeof value === "object") {
			const rec = value as Record<string, unknown>;
			if ("op" in rec && "value" in rec) hits.push(path);
			for (const [k, v] of Object.entries(rec)) hits.push(...walkForLegacyOpShape(v, `${path}.${k}`));
		}
		return hits;
	}

	const ALL_BUILT = [
		buildBlastRadiusQuery({ symbol: "authenticate", groupPath: "pvhcorp" }),
		buildCrossProjectCallersQuery({ fqn: "Gitlab::Auth::authenticate" }),
		buildRecentDeploysQuery({ groupPath: "pvhcorp", since: "2026-07-01T00:00:00Z" }),
		buildPipelineFailuresQuery({ groupPath: "pvhcorp", since: "2026-07-01T00:00:00Z" }),
		buildRecentVulnerabilitiesQuery({ groupPath: "pvhcorp" }),
		buildMrForFileQuery({ sourceFile: "src/app.ts" }),
	];

	test("no builder emits the rejected legacy { op, value } filter shape", () => {
		for (const { queryTag, dsl } of ALL_BUILT) {
			expect({ tag: queryTag, legacySites: walkForLegacyOpShape(dsl) }).toEqual({
				tag: queryTag,
				legacySites: [],
			});
		}
	});

	test("blast radius uses op-as-key text filters", () => {
		const { dsl } = buildBlastRadiusQuery({ symbol: "authenticate", groupPath: "pvhcorp" });
		const nodes = dsl.nodes as Array<{ filters?: Record<string, unknown> }>;
		expect(nodes[0]?.filters).toEqual({ name: { token_match: "authenticate" } });
		expect(nodes[1]?.filters).toEqual({
			import_path: { any_tokens: "authenticate" },
			file_path: { contains: "pvhcorp" },
		});
	});

	test("recent deploys uses op-as-key eq/gte/starts_with filters", () => {
		const { dsl } = buildRecentDeploysQuery({ groupPath: "pvhcorp", since: "2026-07-01T00:00:00Z" });
		const nodes = dsl.nodes as Array<{ filters?: Record<string, unknown> }>;
		expect(nodes[0]?.filters).toEqual({ full_path: { starts_with: "pvhcorp/" } });
		expect(nodes[1]?.filters).toEqual({
			state: { eq: "merged" },
			merged_at: { gte: "2026-07-01T00:00:00Z" },
		});
	});

	test("vulnerabilities uses op-as-key in/eq filters", () => {
		const { dsl } = buildRecentVulnerabilitiesQuery({ groupPath: "pvhcorp" });
		const nodes = dsl.nodes as Array<{ filters?: Record<string, unknown> }>;
		expect(nodes[0]?.filters).toEqual({
			severity: { in: ["critical", "high"] },
			state: { eq: "detected" },
		});
	});

	test("pipeline failures uses string aggregation_sort mirroring order_by", () => {
		const { dsl } = buildPipelineFailuresQuery({ groupPath: "pvhcorp", since: "2026-07-01T00:00:00Z" });
		expect(dsl.aggregation_sort).toBe("-failures");
	});

	// CodeRabbit (PR #420): explicit fixtures for the remaining builders -- the
	// walker rejects the legacy shape but would not catch a regression to bare
	// implicit equality.
	test("cross-project callers uses op-as-key eq on fqn", () => {
		const { dsl } = buildCrossProjectCallersQuery({ fqn: "Gitlab::Auth::authenticate" });
		const nodes = dsl.nodes as Array<{ filters?: Record<string, unknown> }>;
		expect(nodes[0]?.filters).toEqual({ fqn: { eq: "Gitlab::Auth::authenticate" } });
	});

	test("pipeline failures uses op-as-key eq/gte filters on both nodes", () => {
		const { dsl } = buildPipelineFailuresQuery({ groupPath: "pvhcorp", since: "2026-07-01T00:00:00Z" });
		const nodes = dsl.nodes as Array<{ filters?: Record<string, unknown> }>;
		expect(nodes[0]?.filters).toEqual({
			status: { eq: "failed" },
			source: { eq: "merge_request_event" },
			created_at: { gte: "2026-07-01T00:00:00Z" },
		});
		expect(nodes[1]?.filters).toEqual({ full_path: { starts_with: "pvhcorp/" } });
	});

	test("MR-for-file uses op-as-key eq filters on old_path and state", () => {
		const { dsl } = buildMrForFileQuery({ sourceFile: "src/app.ts" });
		const nodes = dsl.nodes as Array<{ filters?: Record<string, unknown> }>;
		expect(nodes[0]?.filters).toEqual({ old_path: { eq: "src/app.ts" } });
		expect(nodes[2]?.filters).toEqual({ state: { eq: "merged" } });
	});
});
