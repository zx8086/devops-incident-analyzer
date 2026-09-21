// packages/agent/src/eval/mcp-tool-dataset.test.ts
// SIO-1398: fixture-drift guard. The dataset names concrete MCP tools; if one is renamed,
// removed, or dropped from an action map, expected_tools_fired would go red on a LIVE run and
// read as a model regression rather than as dataset rot. This parses the REAL agent YAML (same
// idiom as skill-tool-coverage.test.ts) so the drift is caught offline, for free, instead.

import { describe, expect, test } from "bun:test";
import { getAllActionToolNames, loadAgent } from "@devops-agent/gitagent-bridge";
import { getAgentsDir } from "../paths.ts";
import { coveredDatasources, examplesForDatasource, MCP_TOOL_DATASET } from "./mcp-tool-dataset.ts";

const agent = loadAgent(getAgentsDir("incident-analyzer"));
const declaredToolNames = new Set<string>();
for (const toolDef of agent.tools) {
	for (const name of getAllActionToolNames(toolDef)) declaredToolNames.add(name);
}

describe("mcp-tool dataset shape", () => {
	test("covers all 7 datasources", () => {
		expect(coveredDatasources()).toEqual(["atlassian", "aws", "couchbase", "elastic", "gitlab", "kafka", "konnect"]);
	});

	test("every example pins exactly one datasource", () => {
		// The pin is what makes a failure attributable to ONE server; two datasources would fan
		// out to two sub-agents and blur which one misbehaved.
		for (const example of MCP_TOOL_DATASET) {
			expect(example.inputs.uiSelectedDataSources).toHaveLength(1);
		}
	});

	test("every example carries tool-level ground truth with a justification", () => {
		for (const example of MCP_TOOL_DATASET) {
			const expected = example.outputs.expectedToolUse;
			expect(expected).toBeDefined();
			expect(expected?.requiredToolGroups.length).toBeGreaterThan(0);
			for (const group of expected?.requiredToolGroups ?? []) {
				expect(group.anyOf.length).toBeGreaterThan(0);
				// `why` is mandatory so a future red group is distinguishable from a group that
				// merely transcribed whatever the agent happened to do that day.
				expect(group.why.trim().length).toBeGreaterThan(0);
			}
		}
	});

	test("examplesForDatasource filters on the pin and rejects unknown datasources", () => {
		expect(examplesForDatasource("elastic").length).toBeGreaterThan(0);
		expect(examplesForDatasource("not-a-datasource")).toEqual([]);
		for (const example of examplesForDatasource("kafka")) {
			expect(example.inputs.uiSelectedDataSources).toEqual(["kafka"]);
		}
	});
});

describe("dataset tool names resolve against the real action maps", () => {
	test("every required-group tool name is declared in some action_tool_map", () => {
		const missing: string[] = [];
		for (const example of MCP_TOOL_DATASET) {
			for (const group of example.outputs.expectedToolUse?.requiredToolGroups ?? []) {
				for (const name of group.anyOf) {
					if (!declaredToolNames.has(name)) missing.push(`${example.metadata?.ticketKey}: ${name}`);
				}
			}
		}
		expect(missing).toEqual([]);
	});

	test("every known-good anchor is declared, and is also one of its example's required tools", () => {
		for (const example of MCP_TOOL_DATASET) {
			const expected = example.outputs.expectedToolUse;
			const requiredNames = new Set((expected?.requiredToolGroups ?? []).flatMap((g) => g.anyOf));
			for (const anchor of expected?.knownGoodAnchors ?? []) {
				expect(declaredToolNames.has(anchor.toolName)).toBe(true);
				// An anchor the example never required could never fire, so its "must return rows"
				// promise would be vacuous -- it would silently never be checked.
				expect(requiredNames.has(anchor.toolName)).toBe(true);
			}
		}
	});

	test("anchors are mirrored onto inputs so the run function can see them", () => {
		for (const example of MCP_TOOL_DATASET) {
			const anchors = (example.outputs.expectedToolUse?.knownGoodAnchors ?? []).map((a) => a.toolName);
			if (anchors.length === 0) {
				expect(example.inputs.knownGoodAnchorTools ?? []).toEqual([]);
			} else {
				expect(example.inputs.knownGoodAnchorTools).toEqual(anchors);
			}
		}
	});

	test("no anchor is on a tool whose result a model-chosen filter can narrow", () => {
		// The rule learned the hard way: an anchor asserts "this tool MUST return rows". That only
		// holds for tools with no narrowing argument. gitlab_list_merge_requests produced a false
		// empty-anchor TWICE -- the model reasonably added `updated_after` and the project's MRs
		// fell outside that window. Same risk on any filterable LIST tool.
		const FILTERABLE_LIST_TOOLS = new Set([
			"gitlab_list_merge_requests",
			"gitlab_list_commits",
			"gitlab_search",
			"kafka_list_topics",
			"kafka_list_consumer_groups",
			"elasticsearch_list_indices",
			"elasticsearch_search",
			"atlassian_searchJiraIssuesUsingJql",
		]);
		const offenders: string[] = [];
		for (const example of MCP_TOOL_DATASET) {
			for (const anchor of example.outputs.expectedToolUse?.knownGoodAnchors ?? []) {
				if (FILTERABLE_LIST_TOOLS.has(anchor.toolName)) {
					offenders.push(`${example.metadata?.ticketKey}: ${anchor.toolName}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	test("no example forbids a tool it also requires", () => {
		for (const example of MCP_TOOL_DATASET) {
			const expected = example.outputs.expectedToolUse;
			const requiredNames = new Set((expected?.requiredToolGroups ?? []).flatMap((g) => g.anyOf));
			for (const forbidden of expected?.forbiddenTools ?? []) {
				// A tool in both sets is unsatisfiable: firing it zeroes the key, not firing it
				// fails the group.
				expect(requiredNames.has(forbidden)).toBe(false);
			}
		}
	});

	// SIO-1866: the staleness guard. GitLab's `include` enums live UPSTREAM, behind the proxy
	// to its native /api/v4/mcp -- GitLab can add a value with no commit in this repo to review.
	// Each new value is a potential false negative: a composite call that satisfies a group the
	// dataset still describes by the dedicated tool name alone. Checked offline against the
	// recorded upstream schema so it surfaces in CI rather than as an unexplained metric dip
	// weeks later (the MR !383 case cost a session to diagnose from scratch).
	//
	// When this fails: GitLab changed the enum. Decide per value whether a group needs
	// anySubResourceOf, then update UPSTREAM_INCLUDE_ENUMS to match. Do NOT just widen the
	// expected set to silence it -- that is the rot this test exists to catch.
	test("every upstream include value is either mapped or explicitly waived", () => {
		// Recorded from a live tools/list against the GitLab MCP server, 2026-09-21.
		const UPSTREAM_INCLUDE_ENUMS: Record<string, string[]> = {
			gitlab_get_job: ["log", "artifacts"],
			gitlab_get_commit: ["diff", "notes"],
			gitlab_get_merge_request: ["diffs", "commits", "notes", "pipelines", "discussions", "approvals", "conflicts"],
			gitlab_get_pipeline: ["jobs", "downstream_pipelines", "bridge_jobs", "artifacts"],
			gitlab_get_work_item: ["notes", "related_merge_requests"],
		};
		// Values that cannot stand in for a dedicated tool the dataset requires: no group names
		// a tool whose rows these carry. Listed explicitly so adding one is a decision, not a
		// silent omission.
		const WAIVED = new Set([
			"artifacts", // no group requires an artifacts tool
			"discussions", // distinct from notes; no group requires it
			"approvals", // no group requires an approvals tool
			"conflicts", // no group requires a conflicts tool
			"downstream_pipelines", // no group requires downstream pipeline state
			"bridge_jobs", // no group requires bridge jobs
			"related_merge_requests", // no group requires this linkage
			"commits", // gitlab_list_commits groups pair it with gitlab_get_commit_diff, already covered
			"diffs", // the MR diff group already accepts gitlab_get_merge_request itself
		]);
		const mapped = new Set(
			MCP_TOOL_DATASET.flatMap((example) => example.outputs.expectedToolUse?.requiredToolGroups ?? []).flatMap(
				(group) => group.anySubResourceOf ?? [],
			),
		);
		const unaccounted = [...new Set(Object.values(UPSTREAM_INCLUDE_ENUMS).flat())].filter(
			(value) => !mapped.has(value as never) && !WAIVED.has(value),
		);
		expect(unaccounted).toEqual([]);
	});
});
