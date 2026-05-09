// packages/agent/src/sub-agent.test.ts
import { describe, expect, test } from "bun:test";
import { getSubAgentRecursionLimit } from "./sub-agent.ts";

describe("getSubAgentRecursionLimit", () => {
	test("returns 40 for elastic when env unset", () => {
		expect(getSubAgentRecursionLimit("elastic", {})).toBe(40);
	});

	test("returns undefined for non-elastic data sources", () => {
		for (const ds of ["kafka", "couchbase", "konnect", "gitlab", "atlassian"]) {
			expect(getSubAgentRecursionLimit(ds, { SUBAGENT_ELASTIC_RECURSION_LIMIT: "60" })).toBeUndefined();
		}
	});

	test("honors SUBAGENT_ELASTIC_RECURSION_LIMIT override for elastic", () => {
		expect(getSubAgentRecursionLimit("elastic", { SUBAGENT_ELASTIC_RECURSION_LIMIT: "60" })).toBe(60);
	});

	test("falls back to default on invalid env values", () => {
		// non-numeric, zero, negative, empty -- all clamp back to 40
		for (const raw of ["abc", "0", "-5", ""]) {
			expect(getSubAgentRecursionLimit("elastic", { SUBAGENT_ELASTIC_RECURSION_LIMIT: raw })).toBe(40);
		}
	});

	test("floors fractional env values", () => {
		expect(getSubAgentRecursionLimit("elastic", { SUBAGENT_ELASTIC_RECURSION_LIMIT: "50.7" })).toBe(50);
	});
});
