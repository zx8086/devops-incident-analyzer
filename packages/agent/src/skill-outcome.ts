// agent/src/skill-outcome.ts
//
// SIO-1016: the skill confidence feedback loop, "defer until promotion" (option 3
// of the design). Durable agent-memory kind:skill facts are immutable from the
// client, so unpromoted PROPOSALS keep their seeded confidence:0.5 forever. Once a
// human promotes a proposal to a real SKILL.md (SIO-1017), its frontmatter IS a
// mutable, git-tracked home for the counters -- so this module evolves
// usage/success/failure + a recomputed confidence on the FILE, never the fact.
//
// Pure transforms (computeConfidence, nextFrontmatter, rewriteFrontmatter) are unit-
// tested; recordSkillOutcome is the thin file I/O wrapped in a per-path async mutex
// (the web app is single-process; two turns finishing together must not interleave a
// read-modify-write on the same SKILL.md). Best-effort: never throws to the caller.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { type SkillFrontmatter, SkillFrontmatterSchema } from "@devops-agent/gitagent-bridge";
import { getLogger } from "@devops-agent/observability";
import { parse, stringify } from "yaml";

const logger = getLogger("agent:skill-outcome");

export type SkillOutcome = "success" | "failure";

export function isSkillOutcomeTrackingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.SKILL_OUTCOME_TRACKING_ENABLED;
	return v === "true" || v === "1";
}

// Laplace (add-one) smoothing: (success + 1) / (usage + 2). A fresh promoted skill
// (0/0) is exactly 0.5 -- matching the SIO-1015 seed -- and the value moves toward
// the observed success rate while never reaching 0 or 1 on small samples (so one bad
// turn can't zero a skill, and one good turn can't certify it).
export function computeConfidence(successCount: number, usageCount: number): number {
	return (successCount + 1) / (usageCount + 2);
}

// Pure: bump the counts for one application outcome and recompute confidence.
// Absent counts are treated as 0 so a hand-authored skill with no learning fields
// gains them on first tracked use.
export function nextFrontmatter(current: SkillFrontmatter, outcome: SkillOutcome): SkillFrontmatter {
	const usage = (current.usage_count ?? 0) + 1;
	const success = (current.success_count ?? 0) + (outcome === "success" ? 1 : 0);
	const failure = (current.failure_count ?? 0) + (outcome === "failure" ? 1 : 0);
	return {
		...current,
		usage_count: usage,
		success_count: success,
		failure_count: failure,
		confidence: computeConfidence(success, usage),
	};
}

// Locate the frontmatter block the same way parseSkillFrontmatter does (leading
// "---\n" + the next "---" line). Returns null when the file has no frontmatter.
function splitFrontmatter(content: string): { yaml: string; body: string } | null {
	if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return null;
	const afterOpening = content.indexOf("\n") + 1;
	const closing = content.slice(afterOpening).match(/^---\r?\n?/m);
	if (!closing || closing.index === undefined) return null;
	const yaml = content.slice(afterOpening, afterOpening + closing.index);
	const body = content.slice(afterOpening + closing.index + closing[0].length);
	return { yaml, body };
}

// Pure string->string: advance the frontmatter counts/confidence and re-emit the
// file, leaving the body verbatim. A file with no parseable frontmatter is returned
// unchanged (nothing to track).
export function rewriteFrontmatter(content: string, outcome: SkillOutcome): string {
	const split = splitFrontmatter(content);
	if (!split) return content;
	let current: SkillFrontmatter;
	try {
		current = SkillFrontmatterSchema.parse(parse(split.yaml) ?? {});
	} catch {
		// Malformed frontmatter: do not guess. Leave the file untouched.
		return content;
	}
	const updated = nextFrontmatter(current, outcome);
	const yaml = stringify(updated).trimEnd();
	return `---\n${yaml}\n---${split.body.startsWith("\n") ? "" : "\n"}${split.body}`;
}

// Serialize writes per absolute path: chain each path's pending op so two concurrent
// turns touching the same SKILL.md apply sequentially (in-process single-writer).
const pathLocks = new Map<string, Promise<void>>();
function withPathLock(filePath: string, op: () => void): Promise<void> {
	const prior = pathLocks.get(filePath) ?? Promise.resolve();
	const next = prior.then(op, op); // run regardless of a prior op's outcome
	// keep the chain alive but swallow errors so the map never holds a rejected promise
	pathLocks.set(
		filePath,
		next.catch(() => {}),
	);
	return next;
}

// The minimal turn signal needed to judge success. Mirrors the learner's gates:
// a turn is a SUCCESS only when it finished without error AND its confidence reached
// the floor; anything else is a FAILURE. No new LLM call -- the post-turn snapshot
// already carries both. MIN_CONFIDENCE matches skill-learner's pre-gate (0.6).
const MIN_CONFIDENCE = 0.6;
export function outcomeForTurn(turn: { hadError: boolean; confidenceScore: number }): SkillOutcome {
	return !turn.hadError && turn.confidenceScore >= MIN_CONFIDENCE ? "success" : "failure";
}

// A promoted skill exercised this turn: its catalog name + the absolute path to its
// SKILL.md. The CALLER owns attribution (which skills were applied) -- see the note in
// skill-learner-install.ts. recordSkillOutcomesForTurn just fans the turn outcome out
// across the provided set, each via recordSkillOutcome (gated, locked, best-effort).
export interface AppliedSkill {
	name: string;
	filePath: string;
}

export async function recordSkillOutcomesForTurn(applied: AppliedSkill[], outcome: SkillOutcome): Promise<void> {
	if (applied.length === 0) return; // today's default: no per-turn application signal exists yet
	for (const skill of applied) {
		await recordSkillOutcome(skill.filePath, outcome);
	}
}

// Record one application outcome against a promoted skill file. No-op (logged) when
// the file is absent (skill is unpromoted -> nothing to mutate) or tracking is off.
// Best-effort: a read/parse/write failure is logged, never thrown.
export async function recordSkillOutcome(filePath: string, outcome: SkillOutcome): Promise<void> {
	if (!isSkillOutcomeTrackingEnabled()) return;
	if (!existsSync(filePath)) {
		logger.debug({ filePath }, "skill-outcome: no SKILL.md (unpromoted); skipping");
		return;
	}
	await withPathLock(filePath, () => {
		try {
			const content = readFileSync(filePath, "utf8");
			const updated = rewriteFrontmatter(content, outcome);
			if (updated === content) return; // no frontmatter to advance
			writeFileSync(filePath, updated, "utf8");
			logger.info({ filePath, outcome }, "skill-outcome: advanced promoted skill confidence");
		} catch (error) {
			logger.warn(
				{ filePath, error: error instanceof Error ? error.message : String(error) },
				"skill-outcome: update failed; skipping",
			);
		}
	});
}
