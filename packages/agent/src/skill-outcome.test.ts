// agent/src/skill-outcome.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillFrontmatter } from "@devops-agent/gitagent-bridge";
import { SkillFrontmatterSchema } from "@devops-agent/gitagent-bridge";
import { parse } from "yaml";
import { getWorkspaceRoot } from "./paths.ts";
import {
	appliedSkillsForNames,
	computeConfidence,
	isSkillOutcomeTrackingEnabled,
	nextFrontmatter,
	outcomeForTurn,
	recordSkillOutcome,
	recordSkillOutcomesForTurn,
	rewriteFrontmatter,
} from "./skill-outcome.ts";

describe("computeConfidence (SIO-1016, Laplace smoothing)", () => {
	test("a fresh promoted skill (0/0) sits at exactly the seeded 0.5", () => {
		expect(computeConfidence(0, 0)).toBe(0.5);
	});

	test("moves toward the observed success rate without hitting the extremes", () => {
		// (success + 1) / (usage + 2)
		expect(computeConfidence(1, 1)).toBeCloseTo(2 / 3, 10); // 1 of 1 success
		expect(computeConfidence(0, 1)).toBeCloseTo(1 / 3, 10); // 0 of 1 success
		expect(computeConfidence(9, 10)).toBeCloseTo(10 / 12, 10); // 9 of 10
		// never exactly 1 or 0 on small samples
		expect(computeConfidence(5, 5)).toBeLessThan(1);
		expect(computeConfidence(0, 5)).toBeGreaterThan(0);
	});
});

const BASE: SkillFrontmatter = {
	name: "lag-correlation",
	description: "Correlate Kafka lag with ES error spikes.",
	confidence: 0.5,
	usage_count: 0,
	success_count: 0,
	failure_count: 0,
};

describe("nextFrontmatter (SIO-1016)", () => {
	test("a success bumps usage + success and recomputes confidence", () => {
		const next = nextFrontmatter(BASE, "success");
		expect(next.usage_count).toBe(1);
		expect(next.success_count).toBe(1);
		expect(next.failure_count).toBe(0);
		expect(next.confidence).toBeCloseTo(2 / 3, 10);
	});

	test("a failure bumps usage + failure and lowers confidence", () => {
		const next = nextFrontmatter(BASE, "failure");
		expect(next.usage_count).toBe(1);
		expect(next.success_count).toBe(0);
		expect(next.failure_count).toBe(1);
		expect(next.confidence).toBeCloseTo(1 / 3, 10);
	});

	test("treats absent counts as 0 (a hand-authored skill with no learning fields)", () => {
		const next = nextFrontmatter({ name: "thin" }, "success");
		expect(next.usage_count).toBe(1);
		expect(next.success_count).toBe(1);
		expect(next.failure_count).toBe(0);
		expect(next.confidence).toBeCloseTo(2 / 3, 10);
	});

	test("the result still parses under SkillFrontmatterSchema", () => {
		const next = nextFrontmatter(BASE, "failure");
		expect(() => SkillFrontmatterSchema.parse(next)).not.toThrow();
	});
});

describe("rewriteFrontmatter (SIO-1016)", () => {
	const FILE = [
		"---",
		"name: lag-correlation",
		"confidence: 0.5",
		"usage_count: 0",
		"success_count: 0",
		"failure_count: 0",
		"---",
		"",
		"# Lag correlation",
		"",
		"## Procedure",
		"",
		"Pull lag, then errors, then align.",
		"",
	].join("\n");

	test("swaps only the frontmatter block and preserves the body verbatim", () => {
		const updated = rewriteFrontmatter(FILE, "success");
		// body preserved
		expect(updated).toContain("# Lag correlation");
		expect(updated).toContain("Pull lag, then errors, then align.");
		// frontmatter advanced
		const afterOpening = updated.indexOf("\n") + 1;
		const closing = updated.slice(afterOpening).search(/^---\r?\n?/m);
		const fm = SkillFrontmatterSchema.parse(parse(updated.slice(afterOpening, afterOpening + closing)));
		expect(fm.usage_count).toBe(1);
		expect(fm.success_count).toBe(1);
		expect(fm.confidence).toBeCloseTo(2 / 3, 10);
	});

	test("returns the file unchanged when there is no frontmatter to update", () => {
		const noFm = "# Just a markdown skill\n\nNo frontmatter here.\n";
		expect(rewriteFrontmatter(noFm, "success")).toBe(noFm);
	});
});

describe("isSkillOutcomeTrackingEnabled (SIO-1016)", () => {
	test("true only for 'true' / '1'", () => {
		expect(isSkillOutcomeTrackingEnabled({ SKILL_OUTCOME_TRACKING_ENABLED: "true" })).toBe(true);
		expect(isSkillOutcomeTrackingEnabled({ SKILL_OUTCOME_TRACKING_ENABLED: "1" })).toBe(true);
		expect(isSkillOutcomeTrackingEnabled({ SKILL_OUTCOME_TRACKING_ENABLED: "yes" })).toBe(false);
		expect(isSkillOutcomeTrackingEnabled({})).toBe(false);
	});
});

describe("recordSkillOutcome (SIO-1016, file I/O)", () => {
	let dir: string;
	let file: string;
	const prior = process.env.SKILL_OUTCOME_TRACKING_ENABLED;

	const SKILL = [
		"---",
		"name: lag-correlation",
		"confidence: 0.5",
		"usage_count: 0",
		"success_count: 0",
		"failure_count: 0",
		"---",
		"",
		"## Procedure",
		"",
		"Pull lag, then errors, then align.",
		"",
	].join("\n");

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "skill-outcome-test-"));
		file = join(dir, "SKILL.md");
		process.env.SKILL_OUTCOME_TRACKING_ENABLED = "true";
	});
	afterEach(() => {
		if (prior === undefined) delete process.env.SKILL_OUTCOME_TRACKING_ENABLED;
		else process.env.SKILL_OUTCOME_TRACKING_ENABLED = prior;
		rmSync(dir, { recursive: true, force: true });
	});

	test("advances a promoted skill's counts + confidence on success", async () => {
		writeFileSync(file, SKILL, "utf8");
		await recordSkillOutcome(file, "success");
		const fm = SkillFrontmatterSchema.parse(parse(splitFm(readFileSync(file, "utf8"))));
		expect(fm.usage_count).toBe(1);
		expect(fm.success_count).toBe(1);
		expect(fm.confidence).toBeCloseTo(2 / 3, 10);
	});

	test("is a no-op when the file does not exist (unpromoted proposal)", async () => {
		// recordSkillOutcome must not throw and must not create the file.
		await recordSkillOutcome(file, "success");
		expect(readFileSyncOrNull(file)).toBeNull();
	});

	test("is a no-op when tracking is disabled by env", async () => {
		process.env.SKILL_OUTCOME_TRACKING_ENABLED = "false";
		writeFileSync(file, SKILL, "utf8");
		await recordSkillOutcome(file, "failure");
		expect(readFileSync(file, "utf8")).toBe(SKILL); // untouched
	});

	test("serializes concurrent writes to the same file (no lost update)", async () => {
		writeFileSync(file, SKILL, "utf8");
		await Promise.all([
			recordSkillOutcome(file, "success"),
			recordSkillOutcome(file, "success"),
			recordSkillOutcome(file, "failure"),
		]);
		const fm = SkillFrontmatterSchema.parse(parse(splitFm(readFileSync(file, "utf8"))));
		// all three applied, none lost
		expect(fm.usage_count).toBe(3);
		expect(fm.success_count).toBe(2);
		expect(fm.failure_count).toBe(1);
	});
});

describe("outcomeForTurn (SIO-1016)", () => {
	test("success when the turn had no error and confidence is at/above the floor", () => {
		expect(outcomeForTurn({ hadError: false, confidenceScore: 0.8 })).toBe("success");
		expect(outcomeForTurn({ hadError: false, confidenceScore: 0.6 })).toBe("success");
	});
	test("failure on an error or below-floor confidence", () => {
		expect(outcomeForTurn({ hadError: true, confidenceScore: 0.9 })).toBe("failure");
		expect(outcomeForTurn({ hadError: false, confidenceScore: 0.4 })).toBe("failure");
	});
});

describe("recordSkillOutcomesForTurn (SIO-1016)", () => {
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
		dir = mkdtempSync(join(tmpdir(), "skill-outcome-turn-"));
		process.env.SKILL_OUTCOME_TRACKING_ENABLED = "true";
	});
	afterEach(() => {
		if (prior === undefined) delete process.env.SKILL_OUTCOME_TRACKING_ENABLED;
		else process.env.SKILL_OUTCOME_TRACKING_ENABLED = prior;
		rmSync(dir, { recursive: true, force: true });
	});

	test("applies the turn outcome to each named skill's file", async () => {
		const a = join(dir, "a", "SKILL.md");
		const b = join(dir, "b", "SKILL.md");
		writeFileSync(mkParent(a), SKILL, "utf8");
		writeFileSync(mkParent(b), SKILL, "utf8");
		await recordSkillOutcomesForTurn(
			[
				{ name: "a", filePath: a },
				{ name: "b", filePath: b },
			],
			"success",
		);
		for (const f of [a, b]) {
			const fm = SkillFrontmatterSchema.parse(parse(splitFm(readFileSync(f, "utf8"))));
			expect(fm.usage_count).toBe(1);
			expect(fm.success_count).toBe(1);
		}
	});

	test("empty applied-skill set writes nothing (today's no-signal default)", async () => {
		// No throw, no files created.
		await recordSkillOutcomesForTurn([], "success");
		expect(true).toBe(true);
	});
});

describe("appliedSkillsForNames (SIO-1018)", () => {
	test("maps each name to its agents/<agent>/skills/<name>/SKILL.md path", () => {
		const root = getWorkspaceRoot();
		const result = appliedSkillsForNames("incident-analyzer", ["lag-correlation"]);
		expect(result).toEqual([
			{
				name: "lag-correlation",
				filePath: join(root, "agents", "incident-analyzer", "skills", "lag-correlation", "SKILL.md"),
			},
		]);
	});

	test("empty names -> empty list", () => {
		expect(appliedSkillsForNames("incident-analyzer", [])).toEqual([]);
	});
});

function mkParent(filePath: string): string {
	mkdirSync(join(filePath, ".."), { recursive: true });
	return filePath;
}

function splitFm(content: string): string {
	const afterOpening = content.indexOf("\n") + 1;
	const closing = content.slice(afterOpening).search(/^---\r?\n?/m);
	return content.slice(afterOpening, afterOpening + closing);
}

function readFileSyncOrNull(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}
