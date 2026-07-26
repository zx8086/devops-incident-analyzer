// gitagent-bridge/src/skill-tools.test.ts

import { describe, expect, test } from "bun:test";
import { extractPromptToolNames, extractSkillToolNames, type SkillSource } from "./skill-tools.ts";

function source(skills: Record<string, string>, sharedSkills: Record<string, string> = {}): SkillSource {
	return {
		skills: new Map(Object.entries(skills)),
		sharedSkills: new Map(Object.entries(sharedSkills)),
	};
}

describe("SIO-1228: extractSkillToolNames", () => {
	test("extracts backticked snake_case tool names from skill prose", () => {
		const agent = source({
			"project-resolution":
				"Before any project-scoped tool (`gitlab_list_commits`, `gitlab_get_file_content`,\n" +
				"`gitlab_get_blame`), call `gitlab_search` scoped to the group.",
		});
		expect(extractSkillToolNames(agent)).toEqual([
			"gitlab_get_blame",
			"gitlab_get_file_content",
			"gitlab_list_commits",
			"gitlab_search",
		]);
	});

	test("returns sorted unique names across multiple skills", () => {
		const agent = source({
			a: "use `gitlab_search` then `gitlab_get_file_content`",
			b: "`gitlab_get_file_content` again, plus `gitlab_blast_radius`",
		});
		expect(extractSkillToolNames(agent)).toEqual(["gitlab_blast_radius", "gitlab_get_file_content", "gitlab_search"]);
	});

	// The regex deliberately over-matches; the bind site discards anything that is
	// not a real runtime tool. These are the prose identifiers it will pick up.
	test("over-matches prose identifiers (discarded later by intersection with real tools)", () => {
		const agent = source({ s: "A bare service name is not a valid `project_id`; scope by `group_id`." });
		expect(extractSkillToolNames(agent)).toEqual(["group_id", "project_id"]);
	});

	test("ignores non-snake_case backticked tokens and unbackticked words", () => {
		const agent = source({
			s: "Call `foo` and `Bar` and `customer-assignments` and gitlab_get_file_content unbackticked.",
		});
		expect(extractSkillToolNames(agent)).toEqual([]);
	});

	test("includes shared skills", () => {
		const agent = source({ local: "`gitlab_search`" }, { shared: "`gitlab_blast_radius`" });
		expect(extractSkillToolNames(agent)).toEqual(["gitlab_blast_radius", "gitlab_search"]);
	});

	// Mirrors buildSystemPromptParts: a local skill shadows a shared one of the same
	// name, so only the local body is in the prompt and only its tools are promised.
	test("a local skill shadows a shared skill of the same name", () => {
		const agent = source({ dup: "`gitlab_search`" }, { dup: "`gitlab_blast_radius`" });
		expect(extractSkillToolNames(agent)).toEqual(["gitlab_search"]);
	});

	test("activeSkills filters which skills contribute", () => {
		const agent = source({
			a: "`gitlab_search`",
			b: "`gitlab_get_file_content`",
		});
		expect(extractSkillToolNames(agent, ["a"])).toEqual(["gitlab_search"]);
	});

	test("returns [] for an agent with no skills", () => {
		expect(extractSkillToolNames(source({}))).toEqual([]);
	});

	test("skips frontmatter so metadata keys are not mistaken for tools", () => {
		const agent = source({
			s: "---\nname: code-search\nallowed_tools: `some_meta_token`\n---\n\nUse `gitlab_search`.",
		});
		expect(extractSkillToolNames(agent)).toEqual(["gitlab_search"]);
	});
});

// SIO-1234: the binding canary only ever scanned skills, so aws-agent -- which declares no
// `skills:` block at all but whose 32.7KB RULES.md names 62 tools -- measured as zero.
describe("extractPromptToolNames", () => {
	function promptSource(over: Partial<SkillSource> = {}): SkillSource {
		return { skills: new Map(), sharedSkills: new Map(), ...over };
	}

	test.each([
		["soul", { soul: "Use `aws_list_estates` first." }],
		["rules", { rules: "Call `aws_list_estates` before anything else." }],
		["duties", { duties: "Only `aws_list_estates` is permitted." }],
		["sharedContext", { sharedContext: "Prefer `aws_list_estates`." }],
	])("collects tool names from %s", (_label, over) => {
		expect(extractPromptToolNames(promptSource(over))).toEqual(["aws_list_estates"]);
	});

	// The aws-agent shape exactly: no skills, everything in RULES.md.
	test("finds tools for an agent with no skills block at all", () => {
		const agent = promptSource({ rules: "Chain `aws_ecs_list_clusters` -> `aws_ecs_list_services`." });
		expect(extractSkillToolNames(agent)).toEqual([]);
		expect(extractPromptToolNames(agent)).toEqual(["aws_ecs_list_clusters", "aws_ecs_list_services"]);
	});

	test("unions skills with the prompt bodies and dedupes", () => {
		const agent = promptSource({
			skills: new Map([["s", "Use `tool_one`."]]),
			rules: "Use `tool_one` and `tool_two`.",
		});
		expect(extractPromptToolNames(agent)).toEqual(["tool_one", "tool_two"]);
	});

	test("strips frontmatter the same way renderSkill does", () => {
		const agent = promptSource({ rules: "---\ndescription: uses `not_a_tool`\n---\n\nCall `real_tool`." });
		expect(extractPromptToolNames(agent)).toEqual(["real_tool"]);
	});

	test("is a superset of extractSkillToolNames", () => {
		const agent = promptSource({ skills: new Map([["s", "`skill_tool`"]]), rules: "`rules_tool`" });
		const skillOnly = extractSkillToolNames(agent);
		const all = extractPromptToolNames(agent);
		for (const name of skillOnly) expect(all).toContain(name);
	});

	test("returns [] when no prompt body names a tool", () => {
		expect(extractPromptToolNames(promptSource({ rules: "Be careful and thorough." }))).toEqual([]);
	});

	// The bodies are optional, so every pre-SIO-1234 caller/fixture still satisfies SkillSource.
	test("tolerates an agent with only the two skill maps", () => {
		expect(extractPromptToolNames(promptSource())).toEqual([]);
	});
});
