// test/validate-incident-projects.test.ts

import { beforeEach, describe, expect, test } from "bun:test";
import type { AtlassianMcpProxy } from "../src/atlassian-client/index.js";
import {
	resetEffectiveProjectsCacheForTests,
	resolveEffectiveProjects,
} from "../src/tools/custom/validate-incident-projects.js";

function projectSearchResult(keys: string[]) {
	return {
		content: [{ type: "text", text: JSON.stringify({ values: keys.map((key) => ({ key })) }) }],
	};
}

function fakeProxy(existingKeys: string[], calls: { name: string; args: Record<string, unknown> }[] = []) {
	return {
		callTool: async (name: string, args: Record<string, unknown>) => {
			calls.push({ name, args });
			const searched = String(args.searchString ?? "");
			const matches = existingKeys.filter((k) => k.toUpperCase() === searched.toUpperCase());
			return projectSearchResult(matches);
		},
	} as unknown as AtlassianMcpProxy;
}

beforeEach(() => {
	resetEffectiveProjectsCacheForTests();
});

describe("SIO-1184: resolveEffectiveProjects", () => {
	test("empty config is the wildcard: no upstream call, empty projects", async () => {
		const calls: { name: string; args: Record<string, unknown> }[] = [];
		const result = await resolveEffectiveProjects(fakeProxy(["DEVOPS"], calls), []);
		expect(result).toEqual({ projects: [] });
		expect(calls.length).toBe(0);
	});

	test("all configured projects exist: unchanged, no warning", async () => {
		const result = await resolveEffectiveProjects(fakeProxy(["DEVOPS", "DOC"]), ["DEVOPS", "DOC"]);
		expect(result.projects).toEqual(["DEVOPS", "DOC"]);
		expect(result.configWarning).toBeUndefined();
	});

	test("nonexistent keys are dropped with a warning naming them", async () => {
		const result = await resolveEffectiveProjects(fakeProxy(["DEVOPS"]), ["DEVOPS", "INC"]);
		expect(result.projects).toEqual(["DEVOPS"]);
		expect(result.configWarning).toContain("INC");
		expect(result.configWarning).toContain("DEVOPS");
	});

	test("the INC,OPS shipped case: all keys dead falls back to the all-projects wildcard", async () => {
		const result = await resolveEffectiveProjects(fakeProxy(["DEVOPS"]), ["INC", "OPS"]);
		expect(result.projects).toEqual([]);
		expect(result.configWarning).toContain("INC, OPS");
		expect(result.configWarning).toContain("ALL projects");
	});

	test("key matching is case-insensitive on both sides", async () => {
		const result = await resolveEffectiveProjects(fakeProxy(["DEVOPS"]), ["devops"]);
		expect(result.projects).toEqual(["devops"]);
		expect(result.configWarning).toBeUndefined();
	});

	test("validation failure is soft: configured list used as-is, no throw", async () => {
		const proxy = {
			callTool: async () => {
				throw new Error("upstream down");
			},
		} as unknown as AtlassianMcpProxy;
		const result = await resolveEffectiveProjects(proxy, ["INC"]);
		expect(result).toEqual({ projects: ["INC"] });
	});

	test("result is memoized: second call does not re-probe upstream", async () => {
		const calls: { name: string; args: Record<string, unknown> }[] = [];
		const proxy = fakeProxy(["DEVOPS"], calls);
		await resolveEffectiveProjects(proxy, ["DEVOPS", "INC"]);
		const countAfterFirst = calls.length;
		await resolveEffectiveProjects(proxy, ["DEVOPS", "INC"]);
		expect(calls.length).toBe(countAfterFirst);
	});

	test("a failed validation is NOT memoized: next call retries", async () => {
		let attempts = 0;
		const proxy = {
			callTool: async (_name: string, args: Record<string, unknown>) => {
				attempts++;
				if (attempts === 1) throw new Error("transient");
				return projectSearchResult([String(args.searchString)]);
			},
		} as unknown as AtlassianMcpProxy;
		const first = await resolveEffectiveProjects(proxy, ["DEVOPS"]);
		expect(first).toEqual({ projects: ["DEVOPS"] });
		const second = await resolveEffectiveProjects(proxy, ["DEVOPS"]);
		expect(second.configWarning).toBeUndefined();
		expect(attempts).toBe(2);
	});
});
