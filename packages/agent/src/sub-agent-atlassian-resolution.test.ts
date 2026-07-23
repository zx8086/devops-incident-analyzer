// agent/src/sub-agent-atlassian-resolution.test.ts

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type ToolDefinition, ToolDefinitionSchema } from "@devops-agent/gitagent-bridge";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { parse } from "yaml";
import { selectToolsByAction } from "./sub-agent.ts";

// SIO-1182: minimal atlassian tool def mirroring agents/incident-analyzer/tools/atlassian-api.yaml.
// runbook_lookup deliberately OMITS findLinkedIncidents so the tests below prove the RESOLUTION
// MAPPING (not the action map) is what force-includes it -- a regression removing it from
// RESOLUTION_TOOLS_BY_DATASOURCE.atlassian makes these fail, as it should. The fixture-drift
// suite at the bottom parses the real YAML so this mirror cannot silently diverge on the
// critical names.
const atlassianToolDef: ToolDefinition = ToolDefinitionSchema.parse({
	name: "atlassian-api",
	description: "test fixture",
	input_schema: { type: "object", properties: {}, required: [] },
	tool_mapping: {
		mcp_server: "atlassian",
		mcp_patterns: ["atlassian_*", "findLinkedIncidents", "getRunbookForAlert", "getIncidentHistory"],
		action_tool_map: {
			incident_correlation: ["findLinkedIncidents", "getIncidentHistory", "atlassian_fetch"],
			runbook_lookup: ["getRunbookForAlert", "atlassian_searchConfluenceUsingCql", "atlassian_fetch"],
		},
	},
});

function fakeTools(names: string[]): StructuredToolInterface[] {
	return names.map((name) => ({ name }) as unknown as StructuredToolInterface);
}

// > MAX_TOOLS_PER_AGENT (25) so the filter path runs -- the live server registers 34.
function buildAtlassianTools(): StructuredToolInterface[] {
	const filler = Array.from({ length: 26 }, (_, i) => `atlassian_filler_${i}`);
	return fakeTools([
		...filler,
		"atlassian_search",
		"atlassian_fetch",
		"findLinkedIncidents",
		"getIncidentHistory",
		"getRunbookForAlert",
		"atlassian_searchConfluenceUsingCql",
	]);
}

// SIO-1182: findLinkedIncidents is the sole input to extractAtlassianFindings (same class as
// SIO-1178's gitlab_list_merge_requests). It must survive EVERY action selection, not just
// incident_correlation -- that is what the resolution set guarantees.
describe("SIO-1182: findLinkedIncidents is always in the atlassian tool budget", () => {
	test("runbook_lookup selection includes findLinkedIncidents via the resolution set", () => {
		const allTools = buildAtlassianTools();
		const { tools, filtered } = selectToolsByAction(
			allTools,
			"atlassian",
			{ atlassian: ["runbook_lookup"] },
			atlassianToolDef,
		);
		const names = tools.map((t) => t.name);

		expect(filtered).toBe(true);
		expect(names).toContain("findLinkedIncidents");
		expect(names).toContain("getRunbookForAlert");
		expect(tools.length).toBeLessThanOrEqual(25);
	});

	test("findLinkedIncidents survives when the action-resolved set already fills the budget", () => {
		const manyRunbookTools = Array.from({ length: 25 }, (_, i) => `atlassian_runbook_${i}`);
		const toolDef: ToolDefinition = ToolDefinitionSchema.parse({
			name: "atlassian-api",
			description: "test fixture",
			input_schema: { type: "object", properties: {}, required: [] },
			tool_mapping: {
				mcp_server: "atlassian",
				mcp_patterns: ["atlassian_*", "findLinkedIncidents"],
				action_tool_map: { runbook_lookup: manyRunbookTools, incident_correlation: ["findLinkedIncidents"] },
			},
		});
		const allTools = fakeTools([
			...Array.from({ length: 26 }, (_, i) => `atlassian_filler_${i}`),
			...manyRunbookTools,
			"atlassian_search",
			"findLinkedIncidents",
		]);
		const { tools } = selectToolsByAction(allTools, "atlassian", { atlassian: ["runbook_lookup"] }, toolDef);
		const names = tools.map((t) => t.name);
		expect(names).toContain("findLinkedIncidents");
		expect(names).toContain("atlassian_search");
		expect(tools.length).toBeLessThanOrEqual(25);
	});
});

// SIO-1182 fixture-drift guard: parse the REAL atlassian-api.yaml. The audit (SIO-1181) found the
// search-then-read gap shipped three times (SIO-1154, SIO-1159, SIO-1182) because nothing pinned
// the reader coverage: atlassian_search is force-included everywhere and returns ARIs, so every
// belt must carry the ARI reader (atlassian_fetch) plus both id-specific readers.
describe("SIO-1182: atlassian-api.yaml action map keeps search-then-read closed", () => {
	const yamlPath = new URL("../../../agents/incident-analyzer/tools/atlassian-api.yaml", import.meta.url);
	const parsed = ToolDefinitionSchema.parse(parse(readFileSync(yamlPath, "utf8")));
	const actionMap = parsed.tool_mapping?.action_tool_map ?? {};
	const belts = Object.entries(actionMap);
	const allMapped = Object.values(actionMap).flat();

	test("every belt carries the ARI reader atlassian_fetch", () => {
		expect(belts.length).toBeGreaterThan(0);
		for (const [action, tools] of belts) {
			expect({ action, hasFetch: tools.includes("atlassian_fetch") }).toEqual({ action, hasFetch: true });
		}
	});

	test("every belt carries both id-specific readers", () => {
		for (const [action, tools] of belts) {
			expect({ action, jiraReader: tools.includes("atlassian_getJiraIssue") }).toEqual({
				action,
				jiraReader: true,
			});
			expect({ action, pageReader: tools.includes("atlassian_getConfluencePage") }).toEqual({
				action,
				pageReader: true,
			});
		}
	});

	test("incident_correlation exposes the typed-finding feeder and history composer", () => {
		expect(actionMap.incident_correlation).toContain("findLinkedIncidents");
		expect(actionMap.incident_correlation).toContain("getIncidentHistory");
	});

	test("read_only map exposes no write tools", () => {
		const writeTools = [
			"atlassian_createJiraIssue",
			"atlassian_editJiraIssue",
			"atlassian_addCommentToJiraIssue",
			"atlassian_transitionJiraIssue",
			"atlassian_addWorklogToJiraIssue",
			"atlassian_createIssueLink",
			"atlassian_createConfluencePage",
			"atlassian_updateConfluencePage",
			"atlassian_createConfluenceFooterComment",
			"atlassian_createConfluenceInlineComment",
		];
		for (const name of writeTools) {
			expect(allMapped).not.toContain(name);
		}
	});
});
