// agent/src/sub-agent-raw-output-mismatch.test.ts
import { describe, expect, test } from "bun:test";
import { suspectToolNames } from "./sub-agent.ts";

// SIO-1780: the pointer attached to subagent.raw_output_count_mismatch.
describe("suspectToolNames", () => {
	test("names the tools with more messages than raw captures", () => {
		const raw = [{ toolName: "gitlab_search" }, { toolName: "gitlab_search" }];
		const messages = [
			{ name: "gitlab_search" },
			{ name: "gitlab_search" },
			{ name: "mystery_tool" },
			{ name: "mystery_tool" },
		];
		expect(suspectToolNames(raw, messages)).toEqual(["mystery_tool"]);
	});

	test("balanced capture yields nothing", () => {
		expect(suspectToolNames([{ toolName: "a" }], [{ name: "a" }])).toEqual([]);
	});

	test("a nameless message is reported as unnamed rather than dropped", () => {
		expect(suspectToolNames([], [{}])).toEqual(["unnamed"]);
	});
});
