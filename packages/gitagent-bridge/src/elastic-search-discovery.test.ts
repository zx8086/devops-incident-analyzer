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
	// Derived from the NAME SHAPE, with one documented exception, rather than a hand-listed
	// set (Greptile, PR #864): a list only catches the tools someone remembered, so adding
	// elasticsearch_update_index_settings or _rollover to this group would leave a listed
	// assertion green while breaking the guarantee in its name. A pattern catches anything
	// new by default and has to be argued down, which is the safer direction to fail in.
	//
	// The single exception is `elasticsearch_async_search_delete`: it releases a search
	// CONTEXT this agent itself opened, mutating no stored data, and predates this change.
	test("no data- or index-mutating tool entered the search group", () => {
		const { toolNames } = resolveActionTools(elasticLogsTool(), ["search"]);
		const READ_ONLY_EXCEPTIONS = new Set(["elasticsearch_async_search_delete"]);
		const MUTATING_VERB = /_(put|create|update|delete|reindex|bulk|rollover|restore|clone|shrink|split)(_|$)/;

		const offenders = toolNames.filter((name) => MUTATING_VERB.test(name) && !READ_ONLY_EXCEPTIONS.has(name));
		expect(offenders).toEqual([]);
	});

	// The exception must stay narrow: if the tool it names ever leaves the group, the
	// carve-out should go with it rather than silently covering something else later.
	test("the read-only exception still applies to a tool that is actually present", () => {
		const { toolNames } = resolveActionTools(elasticLogsTool(), ["search"]);
		expect(toolNames).toContain("elasticsearch_async_search_delete");
	});
});
