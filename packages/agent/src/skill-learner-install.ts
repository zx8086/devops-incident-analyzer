// agent/src/skill-learner-install.ts
//
// SIO-1015: wires the skill-learning post-turn seam, mirroring agent-memory-install.
// installSkillLearner() is called once at web process startup. The learner core
// reads a completed-turn snapshot, but getGraph/getState live in the runtime layer
// (apps/web), so the caller injects a `readTurn` reader rather than this package
// importing the web app. No-op unless SKILL_LEARNING_ENABLED + agent-memory backend.
//
// SIO-1016: the SAME post-turn slot (registerPostTurnLearner is a single slot, last
// registration wins) also runs the confidence feedback loop. The two halves are
// INDEPENDENT: learning gates on SKILL_LEARNING_ENABLED + agent-memory and writes a
// durable fact; outcome tracking gates on SKILL_OUTCOME_TRACKING_ENABLED and updates
// promoted SKILL.md files (works on the file backend too). Each is best-effort and a
// failure in one never affects the other.

import { getLogger } from "@devops-agent/observability";
import { registerPostTurnLearner } from "./lifecycle.ts";
import { selectedBackend } from "./memory-backend.ts";
import { isSkillLearningEnabled, learnFromTurn, type SkillLearnerTurn } from "./skill-learner.ts";
import {
	type AppliedSkill,
	isSkillOutcomeTrackingEnabled,
	outcomeForTurn,
	recordSkillOutcomesForTurn,
} from "./skill-outcome.ts";

const logger = getLogger("agent:skill-learner-install");

// Reads the just-completed turn into the learner's input, or null when the turn
// can't be read / isn't eligible. `nowIso` is supplied by the caller so the core
// stays deterministic (no Date in the learner).
export type TurnReader = (ctx: { agentName: string; threadId: string }) => Promise<SkillLearnerTurn | null>;

// SIO-1016: the snapshot the outcome loop needs -- the coarse success signal plus the
// set of PROMOTED skills applied this turn (each with its on-disk SKILL.md path). The
// reader lives in the web app (it knows the manifest + graph state). NOTE: there is no
// reliable per-turn "this catalog skill was applied" signal today, so the production
// reader returns appliedSkills:[] (a documented no-op) until a follow-up ticket adds an
// application trace. The mechanism is shipped + tested so wiring it later is trivial.
export interface OutcomeTurn {
	hadError: boolean;
	confidenceScore: number;
	appliedSkills: AppliedSkill[];
}
export type OutcomeTurnReader = (ctx: { agentName: string; threadId: string }) => Promise<OutcomeTurn | null>;

// The outcome-tracking half of the post-turn callback, exported for direct testing.
// Gated + best-effort: never throws to the caller. ctx defaults so unit tests can call
// it without a graph (the reader is a stub).
export async function runSkillOutcomeTracking(
	readOutcome: OutcomeTurnReader,
	ctx: { agentName: string; threadId: string } = { agentName: "incident-analyzer", threadId: "" },
): Promise<void> {
	if (!isSkillOutcomeTrackingEnabled()) return;
	try {
		const turn = await readOutcome(ctx);
		if (!turn || turn.appliedSkills.length === 0) return;
		await recordSkillOutcomesForTurn(turn.appliedSkills, outcomeForTurn(turn));
	} catch (error) {
		logger.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"skill outcome tracking failed; turn completion continues",
		);
	}
}

// SIO-1015 + SIO-1016: register the single post-turn learner. readOutcome is optional
// so the SIO-1015 call site (learning only) is unchanged; when supplied, the confidence
// feedback loop runs alongside learning in the same callback.
export function installSkillLearner(
	readTurn: TurnReader,
	now: () => string = () => new Date().toISOString(),
	readOutcome?: OutcomeTurnReader,
): void {
	registerPostTurnLearner(async ({ agentName, threadId }) => {
		// SIO-1016 outcome tracking is independent of learning's gates -- run it first so a
		// disabled-learning install still tracks outcomes.
		if (readOutcome) await runSkillOutcomeTracking(readOutcome, { agentName, threadId });

		// Cheap gates first so a disabled/file-backend install never reads state.
		if (!isSkillLearningEnabled()) return;
		if (selectedBackend() !== "agent-memory") return;
		const turn = await readTurn({ agentName, threadId });
		if (!turn) return;
		await learnFromTurn(turn, now());
	});
}
