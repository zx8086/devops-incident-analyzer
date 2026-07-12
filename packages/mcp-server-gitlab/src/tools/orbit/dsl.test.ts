// src/tools/orbit/dsl.test.ts

import { describe, expect, test } from "bun:test";
import {
	buildBlastRadiusQuery,
	buildCrossProjectCallersQuery,
	buildPipelineFailuresQuery,
	buildRecentDeploysQuery,
	buildVulnsRecentMrQuery,
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
			buildVulnsRecentMrQuery({ groupPath: "g" }),
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
		const { queryTag, dsl } = buildVulnsRecentMrQuery({ groupPath: "pvhcorp" });
		expect(queryTag).toBe(ORBIT_QUERY_TAGS.vulnsRecentMr);
		expect(hasSelectiveNode(dsl)).toBe(true);
		const s = JSON.stringify(dsl);
		expect(s).toContain("critical");
		expect(s).toContain("high");
	});
});
