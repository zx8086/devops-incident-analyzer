// agent/src/skill-learner-install.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillFrontmatterSchema } from "@devops-agent/gitagent-bridge";
import { parse } from "yaml";
import { runSkillOutcomeTracking } from "./skill-learner-install.ts";

// SIO-1016: the outcome-tracking half of the post-turn callback, exercised directly
// (the install wires this into the single registerPostTurnLearner slot alongside
// learning). Independent of SKILL_LEARNING_ENABLED -- it has its own env gate and
// works on the file backend.
describe("runSkillOutcomeTracking (SIO-1016)", () => {
	let dir: string;
	const prior = process.env.SKILL_OUTCOME_TRACKING_ENABLED;
	const SKILL = [
		"---",
		"name: s",
		"usage_count: 0",
		"success_count: 0",
		"failure_count: 0",
		"---",
		"",
		"body",
		"",
	].join("\n");

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "skill-install-"));
		process.env.SKILL_OUTCOME_TRACKING_ENABLED = "true";
	});
	afterEach(() => {
		if (prior === undefined) delete process.env.SKILL_OUTCOME_TRACKING_ENABLED;
		else process.env.SKILL_OUTCOME_TRACKING_ENABLED = prior;
		rmSync(dir, { recursive: true, force: true });
	});

	test("bumps the applied skills' files on a successful turn", async () => {
		const file = join(dir, "s", "SKILL.md");
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, SKILL, "utf8");

		await runSkillOutcomeTracking(async () => ({
			hadError: false,
			confidenceScore: 0.9,
			appliedSkills: [{ name: "s", filePath: file }],
		}));

		const fm = SkillFrontmatterSchema.parse(parse(splitFm(readFileSync(file, "utf8"))));
		expect(fm.usage_count).toBe(1);
		expect(fm.success_count).toBe(1);
	});

	test("records a failure on a below-floor-confidence turn", async () => {
		const file = join(dir, "s", "SKILL.md");
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, SKILL, "utf8");

		await runSkillOutcomeTracking(async () => ({
			hadError: false,
			confidenceScore: 0.3,
			appliedSkills: [{ name: "s", filePath: file }],
		}));

		const fm = SkillFrontmatterSchema.parse(parse(splitFm(readFileSync(file, "utf8"))));
		expect(fm.usage_count).toBe(1);
		expect(fm.failure_count).toBe(1);
	});

	test("no-op when the reader returns null", async () => {
		await runSkillOutcomeTracking(async () => null);
		expect(true).toBe(true);
	});

	test("no-op when disabled by env (reader not even called)", async () => {
		process.env.SKILL_OUTCOME_TRACKING_ENABLED = "false";
		let called = false;
		await runSkillOutcomeTracking(async () => {
			called = true;
			return { hadError: false, confidenceScore: 0.9, appliedSkills: [] };
		});
		expect(called).toBe(false);
	});
});

function splitFm(content: string): string {
	const afterOpening = content.indexOf("\n") + 1;
	const closing = content.slice(afterOpening).search(/^---\r?\n?/m);
	return content.slice(afterOpening, afterOpening + closing);
}
