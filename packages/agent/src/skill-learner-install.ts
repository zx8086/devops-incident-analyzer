// agent/src/skill-learner-install.ts
//
// SIO-1015: wires the skill-learning post-turn seam, mirroring agent-memory-install.
// installSkillLearner() is called once at web process startup. The learner core
// reads a completed-turn snapshot, but getGraph/getState live in the runtime layer
// (apps/web), so the caller injects a `readTurn` reader rather than this package
// importing the web app. No-op unless SKILL_LEARNING_ENABLED + agent-memory backend.

import { registerPostTurnLearner } from "./lifecycle.ts";
import { selectedBackend } from "./memory-backend.ts";
import { isSkillLearningEnabled, learnFromTurn, type SkillLearnerTurn } from "./skill-learner.ts";

// Reads the just-completed turn into the learner's input, or null when the turn
// can't be read / isn't eligible. `nowIso` is supplied by the caller so the core
// stays deterministic (no Date in the learner).
export type TurnReader = (ctx: { agentName: string; threadId: string }) => Promise<SkillLearnerTurn | null>;

export function installSkillLearner(readTurn: TurnReader, now: () => string = () => new Date().toISOString()): void {
	registerPostTurnLearner(async ({ agentName, threadId }) => {
		// Cheap gates first so a disabled/file-backend install never reads state.
		if (!isSkillLearningEnabled()) return;
		if (selectedBackend() !== "agent-memory") return;
		const turn = await readTurn({ agentName, threadId });
		if (!turn) return;
		await learnFromTurn(turn, now());
	});
}
