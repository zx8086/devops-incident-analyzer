// gitagent-bridge/src/skill-tools.test.ts

import { describe, expect, test } from "bun:test";
import { extractSkillToolNames, type SkillSource } from "./skill-tools.ts";

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
