// agent/src/skill-promote-git.test.ts
import { describe, expect, test } from "bun:test";
import {
	buildPrBody,
	buildPrTitle,
	type GitRunner,
	promotionBranchName,
	promotionCommitMessage,
	runPromotion,
} from "./skill-promote-git.ts";

function fakeRunner(overrides: Record<string, { ok: boolean; stdout?: string; stderr?: string }> = {}) {
	const calls: string[][] = [];
	const runner: GitRunner = {
		run(argv) {
			calls.push(argv);
			const key = argv.slice(0, 3).join(" ");
			const hit = Object.entries(overrides).find(([k]) => key.startsWith(k))?.[1];
			return { ok: hit?.ok ?? true, stdout: hit?.stdout ?? "", stderr: hit?.stderr ?? "" };
		},
	};
	return { runner, calls };
}

const INPUT = {
	agent: "incident-analyzer",
	skill: "lag-correlation",
	skillFile: "/repo/agents/incident-analyzer/skills/lag-correlation/SKILL.md",
	manifestFile: "/repo/agents/incident-analyzer/agent.yaml",
	annotations: { learned_from: "thread:t1", learned_at: "2026-07-30T10:00:00Z", task_category: "lag-correlation" },
};

describe("pure builders (SIO-1345)", () => {
	test("branch, commit message, title", () => {
		expect(promotionBranchName("incident-analyzer", "lag-correlation")).toBe("skill/incident-analyzer/lag-correlation");
		expect(promotionCommitMessage({ agent: "a", skill: "s" })).toBe("promote learned skill s (a)");
		expect(promotionCommitMessage({ agent: "a", skill: "s", ticket: "SIO-9" })).toBe(
			"SIO-9: promote learned skill s (a)",
		);
		expect(buildPrTitle("a", "s")).toBe("Promote learned skill: s (a)");
	});
	test("pr body carries provenance and the merge-activates note", () => {
		const body = buildPrBody(INPUT);
		expect(body).toContain("thread:t1");
		expect(body).toContain("2026-07-30T10:00:00Z");
		expect(body).toContain("Merging this PR activates the skill");
	});
});

describe("runPromotion (SIO-1345)", () => {
	test("happy path: status, branch off, write, add/commit/push, pr, return", () => {
		const { runner, calls } = fakeRunner({
			"git rev-parse --abbrev-ref": { ok: true, stdout: "main\n" },
			"gh pr create": { ok: true, stdout: "https://github.com/o/r/pull/1\n" },
		});
		let wrote = false;
		const result = runPromotion(runner, INPUT, () => {
			wrote = true;
		});
		expect(wrote).toBe(true);
		expect(result.branch).toBe("skill/incident-analyzer/lag-correlation");
		expect(result.prUrl).toBe("https://github.com/o/r/pull/1");
		expect(result.manualSteps).toEqual([]);
		expect(calls[0]).toEqual(["git", "status", "--porcelain"]);
		expect(calls.at(-1)).toEqual(["git", "checkout", "main"]);
	});
	test("dirty tree aborts before any branch is created", () => {
		const { runner, calls } = fakeRunner({ "git status --porcelain": { ok: true, stdout: " M x.ts\n" } });
		expect(() => runPromotion(runner, INPUT, () => {})).toThrow(/not clean/);
		expect(calls).toHaveLength(1);
	});
	test("gh failure degrades to a manual step instead of throwing", () => {
		const { runner } = fakeRunner({
			"git rev-parse --abbrev-ref": { ok: true, stdout: "main\n" },
			"gh pr create": { ok: false, stderr: "gh: not logged in" },
		});
		const result = runPromotion(runner, INPUT, () => {});
		expect(result.prUrl).toBeUndefined();
		expect(result.manualSteps.join(" ")).toContain("gh pr create");
	});
	test("commit failure throws with the failing argv", () => {
		const { runner } = fakeRunner({
			"git rev-parse --abbrev-ref": { ok: true, stdout: "main\n" },
			"git commit -m": { ok: false, stderr: "hook rejected" },
		});
		expect(() => runPromotion(runner, INPUT, () => {})).toThrow(/git commit/);
	});
});
