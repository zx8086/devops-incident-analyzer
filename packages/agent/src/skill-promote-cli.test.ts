// agent/src/skill-promote-cli.test.ts
import { describe, expect, test } from "bun:test";
import { parsePromoteArgs, skillFilePath } from "./skill-promote-cli.ts";

describe("parsePromoteArgs (SIO-1017)", () => {
	test("parses --agent / --skill / --force", () => {
		const args = parsePromoteArgs(["--agent", "incident-analyzer", "--skill", "lag-correlation", "--force"]);
		expect(args.agent).toBe("incident-analyzer");
		expect(args.skill).toBe("lag-correlation");
		expect(args.force).toBe(true);
	});

	test("defaults agent to incident-analyzer and force to false", () => {
		const args = parsePromoteArgs(["--skill", "thin"]);
		expect(args.agent).toBe("incident-analyzer");
		expect(args.force).toBe(false);
	});

	test("throws when --skill is missing", () => {
		expect(() => parsePromoteArgs(["--agent", "incident-analyzer"])).toThrow(/--skill/);
	});
});

describe("skillFilePath (SIO-1017)", () => {
	test("builds agents/<agent>/skills/<name>/SKILL.md under the repo root", () => {
		const p = skillFilePath("/repo", "incident-analyzer", "lag-correlation");
		expect(p).toBe("/repo/agents/incident-analyzer/skills/lag-correlation/SKILL.md");
	});
});
