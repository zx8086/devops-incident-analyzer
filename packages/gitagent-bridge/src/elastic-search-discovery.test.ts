// gitagent-bridge/src/elastic-search-discovery.test.ts
//
// SIO-1855: the SHIPPED elastic-logs.yaml must let a search dispatch reach the mapping
// tools. Asserted against the real file, not a fixture: a fixture would still pass if
// someone removed the tools from the config that actually runs.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { resolveActionTools } from "./tool-mapping.ts";
import type { ToolDefinition } from "./types.ts";

const YAML_PATH = join(import.meta.dir, "../../../agents/incident-analyzer/tools/elastic-logs.yaml");

function elasticLogsTool(): ToolDefinition {
	return parse(readFileSync(YAML_PATH, "utf-8")) as ToolDefinition;
}

describe("SIO-1855 field discovery is reachable from the search action", () => {
	// The regression: esql_query lived in `search` while get_mappings lived only in
	// index_management, and `action` is a single-string enum -- so a search dispatch could
	// not look up a field name and guessed instead. Measured over one week: 356 ES|QL calls,
	// ZERO mapping lookups, 136 "Unknown column [...], did you mean [...]?" failures.
	test("a search dispatch resolves the mapping tools", () => {
		const { toolNames } = resolveActionTools(elasticLogsTool(), ["search"]);
		expect(toolNames).toContain("elasticsearch_get_mappings");
		expect(toolNames).toContain("elasticsearch_get_field_mapping");
	});

	test("the query tools that were failing are still in the same group", () => {
		const { toolNames } = resolveActionTools(elasticLogsTool(), ["search"]);
		// Discovery is only useful where the guessing happens, so these must co-exist.
		for (const tool of ["elasticsearch_esql_query", "elasticsearch_search", "elasticsearch_execute_sql_query"]) {
			expect(toolNames).toContain(tool);
		}
	});

	// Action selection exists to cap context (MAX_TOOLS_PER_AGENT = 25 in sub-agent.ts).
	// Widening `search` is only safe while it stays under that bar.
	test("the search group stays well inside the per-agent tool cap", () => {
		const { toolNames } = resolveActionTools(elasticLogsTool(), ["search"]);
		expect(toolNames.length).toBeLessThanOrEqual(25);
	});

	test("index_management keeps them too, so nothing was moved out from under it", () => {
		const { toolNames } = resolveActionTools(elasticLogsTool(), ["index_management"]);
		expect(toolNames).toContain("elasticsearch_get_mappings");
	});

	// This agent is read-only (compliance/allowed-actions.yaml). Discovery must not have
	// smuggled a data- or index-mutating tool into the search path.
	//
	// Named explicitly rather than pattern-matched: `elasticsearch_async_search_delete`
	// releases a search CONTEXT the agent itself opened, which is read-only in effect and
	// was already in this group. A /_(delete|put|...)/ regex flags it and teaches the next
	// reader that the rule is about the verb rather than about mutating stored data.
	test("no data- or index-mutating tool entered the search group", () => {
		const { toolNames } = resolveActionTools(elasticLogsTool(), ["search"]);
		const mutating = [
			"elasticsearch_put_mapping",
			"elasticsearch_index_document",
			"elasticsearch_delete_document",
			"elasticsearch_delete_index",
			"elasticsearch_create_index",
			"elasticsearch_update_document",
			"elasticsearch_delete_by_query",
			"elasticsearch_update_by_query",
			"elasticsearch_bulk_operations",
			"elasticsearch_reindex_documents",
		];
		for (const name of mutating) expect(toolNames).not.toContain(name);
	});
});
