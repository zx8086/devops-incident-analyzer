// packages/agent/src/eval/coverage-targets.test.ts
// SIO-1398: the coverage target is DERIVED from three in-repo sources, so these tests pin the
// derivation itself -- if a runbook gains a tool, or TYPED_FINDING_TOOLS grows, the target set
// must grow with it automatically rather than silently staying stale.

import { describe, expect, test } from "bun:test";
import { ORBIT_TOOL_NAMES } from "../correlation/extractors/orbit.ts";
import { RESOLUTION_TOOLS_BY_DATASOURCE } from "../sub-agent.ts";
import { TYPED_FINDING_TOOLS } from "../sub-agent-instrumentation.ts";
import {
	buildCoverageTargets,
	coverageTargetsByDatasource,
	datasourceForTool,
	reportCoverage,
	runbookToolCitations,
} from "./coverage-targets.ts";

describe("datasourceForTool", () => {
	test.each([
		["elasticsearch_search", "elastic"],
		["kafka_list_dlq_topics", "kafka"],
		["ksql_list_queries", "kafka"],
		["connect_list_connectors", "kafka"],
		["capella_get_system_indexes", "couchbase"],
		["gitlab_blast_radius", "gitlab"],
		["aws_ecs_list_tasks", "aws"],
		["konnect_list_services", "konnect"],
		["atlassian_search", "atlassian"],
		// The atlassian MCP's custom tools carry no prefix -- mapped explicitly, and the reason
		// findLinkedIncidents (sole input to the atlassian extractor, SIO-1182) resolves at all.
		["findLinkedIncidents", "atlassian"],
	])("%s -> %s", (tool, expected) => {
		expect(datasourceForTool(tool)).toBe(expected);
	});

	test("an unrecognised name is reported as unknown rather than silently bucketed", () => {
		expect(datasourceForTool("totally_made_up_tool")).toBe("unknown");
	});
});

describe("runbookToolCitations", () => {
	test("reads every runbook and returns non-empty tool lists", () => {
		const citations = runbookToolCitations();
		expect(citations.size).toBeGreaterThanOrEqual(9);
		for (const [runbook, tools] of citations) {
			expect(tools.length, `${runbook} declared no tools`).toBeGreaterThan(0);
			for (const tool of tools) expect(tool).toMatch(/^[a-zA-Z][a-zA-Z0-9_]*$/);
		}
	});

	test("picks up the cross-datasource runbooks (they are not single-datasource by filename)", () => {
		const citations = runbookToolCitations();
		// kafka-consumer-lag cites elastic and couchbase tools too -- proof the derivation keys
		// on the tool name, not the runbook's apparent topic.
		const kafkaLag = citations.get("kafka-consumer-lag") ?? [];
		const datasources = new Set(kafkaLag.map(datasourceForTool));
		expect(datasources.size).toBeGreaterThan(1);
	});
});

describe("buildCoverageTargets", () => {
	const targets = buildCoverageTargets();

	test("every target resolves to a real datasource", () => {
		const unknown = targets.filter((t) => t.dataSource === "unknown");
		expect(unknown.map((t) => t.toolName)).toEqual([]);
	});

	test("covers all 7 datasources", () => {
		expect([...coverageTargetsByDatasource().keys()].sort()).toEqual([
			"atlassian",
			"aws",
			"couchbase",
			"elastic",
			"gitlab",
			"kafka",
			"konnect",
		]);
	});

	test("is a superset of every source it derives from", () => {
		const names = new Set(targets.map((t) => t.toolName));
		for (const tool of TYPED_FINDING_TOOLS) expect(names.has(tool), `missing typed-finding ${tool}`).toBe(true);
		for (const tool of ORBIT_TOOL_NAMES) expect(names.has(tool), `missing orbit ${tool}`).toBe(true);
		for (const tools of Object.values(RESOLUTION_TOOLS_BY_DATASOURCE)) {
			for (const tool of tools) expect(names.has(tool), `missing resolution ${tool}`).toBe(true);
		}
		for (const tools of runbookToolCitations().values()) {
			for (const tool of tools) expect(names.has(tool), `missing runbook tool ${tool}`).toBe(true);
		}
	});

	test("records every source that names a tool, so multi-source tools are identifiable", () => {
		// gitlab_list_merge_requests is the canonical example: runbook-cited, feeds the gitlab
		// extractor, AND force-included via RESOLUTION -- all three sources.
		const mr = targets.find((t) => t.toolName === "gitlab_list_merge_requests");
		expect(mr?.sources.sort()).toEqual(["resolution", "runbook", "typed-finding"]);
		expect(mr?.runbooks.length).toBeGreaterThan(0);
	});

	test("deduplicates: a tool cited by several runbooks appears once", () => {
		const names = targets.map((t) => t.toolName);
		expect(names.length).toBe(new Set(names).size);
	});

	test("no target is a known write/destructive tool", () => {
		// The eval must never call these. If a runbook ever cites one, this fails loudly rather
		// than letting the dataset generate an example that mutates production.
		const forbidden = /^(.*_delete_|.*_create_|.*_update_|.*_put_|kafka_produce|capella_upsert|gitlab_manage_pipeline)/;
		expect(targets.filter((t) => forbidden.test(t.toolName)).map((t) => t.toolName)).toEqual([]);
	});
});

describe("reportCoverage", () => {
	test("reports nothing covered for an empty exercised set", () => {
		const report = reportCoverage(new Set());
		expect(report.covered).toBe(0);
		expect(report.missing.length).toBe(report.total);
	});

	test("reports full coverage when everything was exercised", () => {
		const all = new Set(buildCoverageTargets().map((t) => t.toolName));
		const report = reportCoverage(all);
		expect(report.covered).toBe(report.total);
		expect(report.missing).toEqual([]);
	});

	test("per-datasource totals sum to the overall total", () => {
		const report = reportCoverage(new Set(["elasticsearch_search"]));
		const summed = [...report.byDatasource.values()].reduce((n, s) => n + s.total, 0);
		expect(summed).toBe(report.total);
		expect(report.covered).toBe(1);
	});
});
