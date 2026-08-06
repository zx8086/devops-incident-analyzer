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
});
