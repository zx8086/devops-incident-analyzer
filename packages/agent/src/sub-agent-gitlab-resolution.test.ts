// agent/src/sub-agent-gitlab-resolution.test.ts

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type ToolDefinition, ToolDefinitionSchema } from "@devops-agent/gitagent-bridge";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { parse } from "yaml";
import { selectToolsByAction } from "./sub-agent.ts";

// SIO-1029: minimal gitlab tool def mirroring agents/incident-analyzer/tools/gitlab-api.yaml.
// gitlab_search lives in the `search` action group, separate from the project-scoped
// `code_analysis` group -- the split that caused the search tool to be filtered out.
// SIO-1178: mirror updated -- merge_requests carries list_merge_requests + notes,
// pipelines carries job-log reading (see the fixture-drift test below, which parses the
// real YAML so this mirror can never silently diverge on the critical names).
// SIO-1918: names follow GitLab's consolidated tools (get_job with include: log replaced
// get_job_log, semantic_search replaced semantic_code_search, and so on).
const gitlabToolDef: ToolDefinition = ToolDefinitionSchema.parse({
	name: "gitlab-api",
	description: "test fixture",
	input_schema: { type: "object", properties: {}, required: [] },
	tool_mapping: {
		mcp_server: "gitlab",
		mcp_patterns: ["gitlab_*"],
		action_tool_map: {
			merge_requests: ["gitlab_list_merge_requests", "gitlab_get_merge_request", "gitlab_get_merge_request_notes"],
			pipelines: ["gitlab_get_pipeline", "gitlab_get_job"],
			search: ["gitlab_search", "gitlab_search_labels", "gitlab_semantic_search"],
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
		"gitlab_semantic_search",
		"gitlab_get_file_content",
		"gitlab_get_blame",
		"gitlab_get_commit_diff",
		"gitlab_list_commits",
		"gitlab_get_repository_tree",
		"gitlab_list_merge_requests",
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

// SIO-1178: gitlab_list_merge_requests is the sole input to extractGitLabFindings and the
// gitlab-deploy-vs-datastore-runtime correlation rule. It must survive EVERY action selection,
// not just merge_requests -- that is what the resolution set guarantees.
describe("SIO-1178: gitlab_list_merge_requests is always in the gitlab tool budget", () => {
	test("code_analysis selection includes gitlab_list_merge_requests via the resolution set", () => {
		const allTools = buildGitlabTools();
		const { tools, filtered } = selectToolsByAction(allTools, "gitlab", { gitlab: ["code_analysis"] }, gitlabToolDef);
		const names = tools.map((t) => t.name);

		expect(filtered).toBe(true);
		expect(names).toContain("gitlab_list_merge_requests");
		expect(tools.length).toBeLessThanOrEqual(25);
	});

	test("gitlab_list_merge_requests survives when the action-resolved set already fills the budget", () => {
		const manyCodeTools = Array.from({ length: 25 }, (_, i) => `gitlab_code_${i}`);
		const toolDef: ToolDefinition = ToolDefinitionSchema.parse({
			name: "gitlab-api",
			description: "test fixture",
			input_schema: { type: "object", properties: {}, required: [] },
			tool_mapping: {
				mcp_server: "gitlab",
				mcp_patterns: ["gitlab_*"],
				action_tool_map: { code_analysis: manyCodeTools, merge_requests: ["gitlab_list_merge_requests"] },
			},
		});
		const allTools = fakeTools([
			...Array.from({ length: 26 }, (_, i) => `gitlab_filler_${i}`),
			...manyCodeTools,
			"gitlab_list_merge_requests",
		]);
		const { tools } = selectToolsByAction(allTools, "gitlab", { gitlab: ["code_analysis"] }, toolDef);
		const names = tools.map((t) => t.name);
		expect(names).toContain("gitlab_list_merge_requests");
		expect(tools.length).toBeLessThanOrEqual(25);
	});
});

// SIO-1178 fixture-drift guard: parse the REAL gitlab-api.yaml so the mirrored fixtures in this
// file and the shipped action map can never silently diverge on the critical tool names.
describe("SIO-1178: gitlab-api.yaml action map carries the critical tools", () => {
	const yamlPath = new URL("../../../agents/incident-analyzer/tools/gitlab-api.yaml", import.meta.url);
	const parsed = ToolDefinitionSchema.parse(parse(readFileSync(yamlPath, "utf8")));
	const actionMap = parsed.tool_mapping?.action_tool_map ?? {};
	const allMapped = Object.values(actionMap).flat();

	test("merge_requests exposes the flagship correlation tool and MR notes", () => {
		expect(actionMap.merge_requests).toContain("gitlab_list_merge_requests");
		expect(actionMap.merge_requests).toContain("gitlab_get_merge_request_notes");
	});

	test("pipelines exposes job-log reading", () => {
		// SIO-1918: gitlab_get_job with include: ["log"] is what replaced gitlab_get_job_log.
		expect(actionMap.pipelines).toContain("gitlab_get_job");
		expect(actionMap.pipelines).toContain("gitlab_get_pipeline");
	});

	// SIO-1918: a mapped name the server does not serve resolves to nothing, silently --
	// nine of twenty-seven entries were in that state after GitLab unlisted its per-facet
	// tools. UPSTREAM_LISTED is GitLab's tools/list on 2026-10-02 (gitlab.com, 38 tools;
	// regenerate by calling GitLabMcpProxy.listTools() and prefixing gitlab_); OWN_TOOLS are
	// the 13 this server registers itself (code-analysis + orbit). The list goes stale when
	// GitLab changes its surface, which is the point: update it from a fresh capture, and
	// this test then names every mapped tool that no longer exists.
	const UPSTREAM_LISTED = [
		"accept_merge_request",
		"add_branch",
		"add_commit",
		"fork_repository",
		"get_artifact_file",
		"get_commit",
		"get_job",
		"get_mcp_server_version",
		"get_merge_request",
		"get_merge_request_notes",
		"get_pipeline",
		"get_project",
		"get_repository_file",
		"get_saved_view_work_items",
		"get_user",
		"get_work_item",
		"get_work_item_types",
		"link_work_items",
		"list_branches",
		"list_commits",
		"list_groups",
		"list_merge_requests",
		"list_pipelines",
		"list_project_members",
		"list_projects",
		"list_releases",
		"list_repository_tree",
		"list_tags",
		"list_work_items",
		"manage_pipeline",
		"save_merge_request",
		"save_merge_request_review",
		"save_note",
		"save_pipeline",
		"save_work_item",
		"search",
		"search_labels",
		"semantic_search",
	].map((n) => `gitlab_${n}`);
	const OWN_TOOLS = [
		"gitlab_get_file_content",
		"gitlab_get_blame",
		"gitlab_get_commit_diff",
		"gitlab_list_commits",
		"gitlab_get_repository_tree",
		"gitlab_list_merge_requests",
		"gitlab_graph_schema",
		"gitlab_blast_radius",
		"gitlab_cross_project_callers",
		"gitlab_recent_deploys",
		"gitlab_pipeline_failures",
		"gitlab_recent_vulnerabilities",
		"gitlab_orbit_query_graph",
	];

	test("every mapped tool is one the server serves", () => {
		const served = new Set([...UPSTREAM_LISTED, ...OWN_TOOLS]);
		expect(allMapped.filter((name) => !served.has(name))).toEqual([]);
	});

	test("none of the tools GitLab unlisted in 19.4/19.5 is mapped", () => {
		const unlisted = [
			"gitlab_get_issue",
			"gitlab_get_workitem_notes",
			"gitlab_get_merge_request_commits",
			"gitlab_get_merge_request_diffs",
			"gitlab_get_merge_request_pipelines",
			"gitlab_get_merge_request_conflicts",
			"gitlab_get_pipeline_jobs",
			"gitlab_get_job_log",
			"gitlab_semantic_code_search",
		];
		for (const name of unlisted) expect(allMapped).not.toContain(name);
	});

	test("read_only map exposes no write tools", () => {
		const writeTools = [
			"gitlab_create_issue",
			"gitlab_create_merge_request",
			"gitlab_create_merge_request_note",
			"gitlab_create_workitem_note",
			"gitlab_link_work_items",
			"gitlab_attach_scan_profile",
			// CodeRabbit (PR #441): manage_pipeline creates/retries/cancels/deletes
			// pipelines despite its list action -- write-capable, so unmapped.
			"gitlab_manage_pipeline",
			// SIO-1918: the write tools GitLab serves today.
			"gitlab_save_work_item",
			"gitlab_save_merge_request",
			"gitlab_save_merge_request_review",
			"gitlab_save_note",
			"gitlab_save_pipeline",
			"gitlab_accept_merge_request",
			"gitlab_add_branch",
			"gitlab_add_commit",
			"gitlab_fork_repository",
		];
		for (const name of writeTools) {
			expect(allMapped).not.toContain(name);
		}
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
