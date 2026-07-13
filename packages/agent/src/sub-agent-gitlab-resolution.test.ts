// agent/src/sub-agent-gitlab-resolution.test.ts

import { describe, expect, test } from "bun:test";
import { type ToolDefinition, ToolDefinitionSchema } from "@devops-agent/gitagent-bridge";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { selectToolsByAction } from "./sub-agent.ts";

// SIO-1029: minimal gitlab tool def mirroring agents/incident-analyzer/tools/gitlab-api.yaml.
// gitlab_search lives in the `search` action group, separate from the project-scoped
// `code_analysis` group -- the split that caused the search tool to be filtered out.
const gitlabToolDef: ToolDefinition = ToolDefinitionSchema.parse({
	name: "gitlab-api",
	description: "test fixture",
	input_schema: { type: "object", properties: {}, required: [] },
	tool_mapping: {
		mcp_server: "gitlab",
		mcp_patterns: ["gitlab_*"],
		action_tool_map: {
			merge_requests: ["gitlab_get_merge_request", "gitlab_get_merge_request_commits"],
			pipelines: ["gitlab_manage_pipeline", "gitlab_get_pipeline_jobs"],
			search: ["gitlab_search", "gitlab_search_labels", "gitlab_semantic_code_search"],
			code_analysis: [
				"gitlab_get_file_content",
				"gitlab_get_blame",
				"gitlab_get_commit_diff",
				"gitlab_list_commits",
				"gitlab_get_repository_tree",
			],
		},
	},
});

function fakeTools(names: string[]): StructuredToolInterface[] {
	return names.map((name) => ({ name }) as unknown as StructuredToolInterface);
}

// > MAX_TOOLS_PER_AGENT (25) so the filter path runs.
function buildGitlabTools(): StructuredToolInterface[] {
	const filler = Array.from({ length: 26 }, (_, i) => `gitlab_filler_${i}`);
	return fakeTools([
		...filler,
		"gitlab_search",
		"gitlab_search_labels",
		"gitlab_semantic_code_search",
		"gitlab_get_file_content",
		"gitlab_get_blame",
		"gitlab_get_commit_diff",
		"gitlab_list_commits",
		"gitlab_get_repository_tree",
	]);
}

describe("SIO-1029: gitlab_search is always in the gitlab tool budget", () => {
	test("code_analysis selection includes gitlab_search alongside project-scoped tools", () => {
		const allTools = buildGitlabTools();
		const { tools, filtered } = selectToolsByAction(allTools, "gitlab", { gitlab: ["code_analysis"] }, gitlabToolDef);
		const names = tools.map((t) => t.name);

		expect(filtered).toBe(true);
		expect(names).toContain("gitlab_search"); // the resolver -- was previously filtered out
		expect(names).toContain("gitlab_list_commits");
		expect(names).toContain("gitlab_get_repository_tree");
		expect(tools.length).toBeLessThanOrEqual(25);
	});

	test("gitlab_search survives even when the action-resolved set already fills the budget", () => {
		// 25 code_analysis-ish tools resolved; resolution tool must still make the cut.
		const manyCodeTools = Array.from({ length: 25 }, (_, i) => `gitlab_code_${i}`);
		const toolDef: ToolDefinition = ToolDefinitionSchema.parse({
			name: "gitlab-api",
			description: "test fixture",
			input_schema: { type: "object", properties: {}, required: [] },
			tool_mapping: {
				mcp_server: "gitlab",
				mcp_patterns: ["gitlab_*"],
				action_tool_map: { code_analysis: manyCodeTools, search: ["gitlab_search"] },
			},
		});
		const allTools = fakeTools([
			...Array.from({ length: 26 }, (_, i) => `gitlab_filler_${i}`),
			...manyCodeTools,
			"gitlab_search",
		]);
		const { tools } = selectToolsByAction(allTools, "gitlab", { gitlab: ["code_analysis"] }, toolDef);
		const names = tools.map((t) => t.name);
		expect(names).toContain("gitlab_search");
		expect(tools.length).toBeLessThanOrEqual(25);
	});

	test("non-gitlab datasources are unaffected (no resolution tools unioned)", () => {
		const kafkaDef: ToolDefinition = ToolDefinitionSchema.parse({
			name: "kafka-introspect",
			description: "test fixture",
			input_schema: { type: "object", properties: {}, required: [] },
			tool_mapping: {
				mcp_server: "kafka",
				mcp_patterns: ["kafka_*"],
				action_tool_map: { consumer_lag: ["kafka_get_consumer_group_lag"] },
			},
		});
		const allTools = fakeTools([
			...Array.from({ length: 26 }, (_, i) => `kafka_filler_${i}`),
			"kafka_get_consumer_group_lag",
		]);
		const { tools } = selectToolsByAction(allTools, "kafka", { kafka: ["consumer_lag"] }, kafkaDef);
		const names = tools.map((t) => t.name);
		expect(names).toEqual(["kafka_get_consumer_group_lag"]);
		expect(names).not.toContain("gitlab_search");
	});
});

// SIO-1096: the atlassian "resolution" tool -- force-included AND prepended on every path -- is the
// broad Rovo atlassian_search, NOT getVisibleJiraProjects. Jira projects are team/org-named, so
// name-matching resolved nothing and the model kept reporting "no prana project / 0 incidents".
describe("SIO-1096: atlassian_search is the atlassian resolution tool (not getVisibleJiraProjects)", () => {
	const atlassianDef: ToolDefinition = ToolDefinitionSchema.parse({
		name: "atlassian-api",
		description: "test fixture",
		input_schema: { type: "object", properties: {}, required: [] },
		tool_mapping: {
			mcp_server: "atlassian",
			mcp_patterns: ["atlassian_*", "findLinkedIncidents", "getRunbookForAlert", "getIncidentHistory"],
			// CodeRabbit: incident_correlation deliberately OMITS atlassian_search so the test proves
			// the RESOLUTION MAPPING (not the action) is what force-includes it. A regression removing
			// RESOLUTION_TOOLS_BY_DATASOURCE.atlassian would then make this test fail, as it should.
			action_tool_map: {
				incident_correlation: ["findLinkedIncidents", "getIncidentHistory"],
				runbook_lookup: ["getRunbookForAlert", "atlassian_searchConfluenceUsingCql"],
			},
		},
	});

	test("atlassian_search is force-included AND prepended even when the action does not request it", () => {
		// incident_correlation does NOT list atlassian_search -- it must appear ONLY via the resolution
		// mapping, prepended to the front of the tool list (that's what steers the model toward it).
		const allTools = fakeTools([
			...Array.from({ length: 26 }, (_, i) => `atlassian_filler_${i}`),
			"atlassian_search",
			"findLinkedIncidents",
			"getIncidentHistory",
			"atlassian_getVisibleJiraProjects",
		]);
		const { tools, filtered } = selectToolsByAction(
			allTools,
			"atlassian",
			{ atlassian: ["incident_correlation"] },
			atlassianDef,
		);
		const names = tools.map((t) => t.name);
		expect(filtered).toBe(true);
		// Prepended by withResolutionTools -> first in the list, so the model leads with it.
		expect(names[0]).toBe("atlassian_search");
		// getVisibleJiraProjects is NO LONGER the resolution tool, so it is not force-injected.
		expect(names).not.toContain("atlassian_getVisibleJiraProjects");
	});
});
