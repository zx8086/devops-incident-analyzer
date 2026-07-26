// agent/src/sub-agent-skill-tool-binding.test.ts

import { describe, expect, test } from "bun:test";
import { type ToolDefinition, ToolDefinitionSchema } from "@devops-agent/gitagent-bridge";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { selectToolsByAction } from "./sub-agent.ts";

// Mirrors agents/incident-analyzer/tools/gitlab-api.yaml. gitlab_get_file_content lives
// ONLY in code_analysis -- the group the failing eval turns did not select.
const gitlabToolDef: ToolDefinition = ToolDefinitionSchema.parse({
	name: "gitlab-api",
	description: "test fixture",
	input_schema: { type: "object", properties: {}, required: [] },
	tool_mapping: {
		mcp_server: "gitlab",
		mcp_patterns: ["gitlab_*"],
		action_tool_map: {
			pipelines: ["gitlab_get_pipeline_jobs", "gitlab_get_job_log"],
			search: ["gitlab_search", "gitlab_semantic_code_search"],
			code_analysis: ["gitlab_get_file_content", "gitlab_get_blame", "gitlab_get_repository_tree"],
		},
	},
});

function fakeTools(names: string[]): StructuredToolInterface[] {
	return names.map((name) => ({ name }) as unknown as StructuredToolInterface);
}

// > MAX_TOOLS_PER_AGENT (25) so the filter path runs at all.
function buildGitlabTools(): StructuredToolInterface[] {
	return fakeTools([
		...Array.from({ length: 26 }, (_, i) => `gitlab_filler_${i}`),
		"gitlab_get_pipeline_jobs",
		"gitlab_get_job_log",
		"gitlab_search",
		"gitlab_semantic_code_search",
		"gitlab_get_file_content",
		"gitlab_get_blame",
		"gitlab_get_repository_tree",
		"gitlab_list_merge_requests",
		"gitlab_graph_schema",
		"gitlab_blast_radius",
	]);
}

// The tool names the gitlab-agent's SKILL.md prose promises the model it can call.
const GITLAB_SKILL_TOOLS = ["gitlab_get_file_content", "gitlab_get_repository_tree", "gitlab_search"];

describe("SIO-1228: tools named in skill prose are always bound", () => {
	// The exact reproduction: the eval turns that failed selected pipelines, not
	// code_analysis, while the prompt still told the model to call gitlab_get_file_content.
	test("a pipelines-only selection still binds gitlab_get_file_content", () => {
		const allTools = buildGitlabTools();
		const { tools, filtered } = selectToolsByAction(
			allTools,
			"gitlab",
			{ gitlab: ["pipelines"] },
			gitlabToolDef,
			GITLAB_SKILL_TOOLS,
		);
		const names = tools.map((t) => t.name);

		expect(filtered).toBe(true);
		expect(names).toContain("gitlab_get_file_content");
		expect(names).toContain("gitlab_get_repository_tree");
		// The action-selected tools are still there -- skill tools are unioned, not substituted.
		expect(names).toContain("gitlab_get_pipeline_jobs");
		expect(tools.length).toBeLessThanOrEqual(25);
	});

	test("without the skill names, the same selection leaves the promised tool unbound", () => {
		// Pins that the fix -- not some other force-include -- is what binds it.
		const allTools = buildGitlabTools();
		const { tools } = selectToolsByAction(allTools, "gitlab", { gitlab: ["pipelines"] }, gitlabToolDef);
		expect(tools.map((t) => t.name)).not.toContain("gitlab_get_file_content");
	});

	test("skill tools survive when the action-resolved set already fills the budget", () => {
		const manyTools = Array.from({ length: 25 }, (_, i) => `gitlab_pipe_${i}`);
		const toolDef: ToolDefinition = ToolDefinitionSchema.parse({
			name: "gitlab-api",
			description: "test fixture",
			input_schema: { type: "object", properties: {}, required: [] },
			tool_mapping: {
				mcp_server: "gitlab",
				mcp_patterns: ["gitlab_*"],
				action_tool_map: { pipelines: manyTools, code_analysis: ["gitlab_get_file_content"] },
			},
		});
		const allTools = fakeTools([
			...Array.from({ length: 26 }, (_, i) => `gitlab_filler_${i}`),
			...manyTools,
			"gitlab_get_file_content",
		]);
		const { tools } = selectToolsByAction(allTools, "gitlab", { gitlab: ["pipelines"] }, toolDef, [
			"gitlab_get_file_content",
		]);
		expect(tools.map((t) => t.name)).toContain("gitlab_get_file_content");
		expect(tools.length).toBeLessThanOrEqual(25);
	});

	test("resolution tools keep priority over skill tools at the head of the list", () => {
		// SIO-1029/1084 A5 invariant: the discovery enumerator leads, so the model is
		// steered to search first. Skill tools follow it, then the action selection.
		const allTools = buildGitlabTools();
		const { tools } = selectToolsByAction(allTools, "gitlab", { gitlab: ["pipelines"] }, gitlabToolDef, [
			"gitlab_get_file_content",
		]);
		expect(tools[0]?.name).toBe("gitlab_search");
	});

	test("a skill name that is not a real runtime tool is inert", () => {
		// The extractor deliberately over-matches prose identifiers; they must not
		// invent tools or throw.
		const allTools = buildGitlabTools();
		const { tools } = selectToolsByAction(allTools, "gitlab", { gitlab: ["pipelines"] }, gitlabToolDef, [
			"project_id",
			"group_id",
			"gitlab_get_file_content",
		]);
		const names = tools.map((t) => t.name);
		expect(names).not.toContain("project_id");
		expect(names).not.toContain("group_id");
		expect(names).toContain("gitlab_get_file_content");
	});

	test("omitting skill names leaves selection byte-identical (kafka has no skills)", () => {
		// Guards the SIO-785 DLQ regression: force-including a broad listing tool for
		// kafka crowds out the specialized dlq tools. kafka declares no skills, so this
		// change must be provably inert there.
		const kafkaDef: ToolDefinition = ToolDefinitionSchema.parse({
			name: "kafka-introspect",
			description: "test fixture",
			input_schema: { type: "object", properties: {}, required: [] },
			tool_mapping: {
				mcp_server: "kafka",
				mcp_patterns: ["kafka_*"],
				action_tool_map: { dlq_messages: ["kafka_list_dlq_topics", "kafka_consume_messages"] },
			},
		});
		const allTools = fakeTools([
			...Array.from({ length: 26 }, (_, i) => `kafka_filler_${i}`),
			"kafka_list_dlq_topics",
			"kafka_consume_messages",
		]);
		const before = selectToolsByAction(allTools, "kafka", { kafka: ["dlq_messages"] }, kafkaDef);
		const after = selectToolsByAction(allTools, "kafka", { kafka: ["dlq_messages"] }, kafkaDef, []);
		expect(after.tools.map((t) => t.name)).toEqual(before.tools.map((t) => t.name));
		expect(after.tools.map((t) => t.name)).toEqual(["kafka_list_dlq_topics", "kafka_consume_messages"]);
	});

	test("skill tools are unioned on the all-actions fallback path too", () => {
		// No toolActions at all -> tier 2 (all curated names). The prompt still promises
		// the same tools, so the invariant must hold on every return path.
		const allTools = buildGitlabTools();
		const { tools } = selectToolsByAction(allTools, "gitlab", undefined, gitlabToolDef, GITLAB_SKILL_TOOLS);
		expect(tools.map((t) => t.name)).toContain("gitlab_get_file_content");
	});

	test("skill tools are unioned on the raw-slice fallback path too", () => {
		// action_tool_map names do not match runtime tool names (the konnect-style case),
		// so selection falls through to the raw slice.
		const mismatchedDef: ToolDefinition = ToolDefinitionSchema.parse({
			name: "gitlab-api",
			description: "test fixture",
			input_schema: { type: "object", properties: {}, required: [] },
			tool_mapping: {
				mcp_server: "gitlab",
				mcp_patterns: ["gitlab_*"],
				action_tool_map: { code_analysis: ["bare_unprefixed_name"] },
			},
		});
		const allTools = buildGitlabTools();
		const { tools } = selectToolsByAction(allTools, "gitlab", { gitlab: ["code_analysis"] }, mismatchedDef, [
			"gitlab_get_file_content",
		]);
		expect(tools.map((t) => t.name)).toContain("gitlab_get_file_content");
		expect(tools.length).toBeLessThanOrEqual(25);
	});

	test("no filtering happens at all when the datasource is under the cap", () => {
		const allTools = fakeTools(["gitlab_search", "gitlab_get_file_content"]);
		const { tools, filtered } = selectToolsByAction(
			allTools,
			"gitlab",
			{ gitlab: ["pipelines"] },
			gitlabToolDef,
			GITLAB_SKILL_TOOLS,
		);
		expect(filtered).toBe(false);
		expect(tools.length).toBe(2);
	});
});
