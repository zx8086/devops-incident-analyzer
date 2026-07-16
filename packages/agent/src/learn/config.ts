// agent/src/learn/config.ts
//
// SIO-1126: HIL learning lane gate. Defaults ON (kill-switch semantics, same idiom
// as RESOLVE_IDENTIFIERS_ENABLED): the lane only activates on an explicit
// "learn from TICKET-123" command, so it cannot fire on normal traffic. Set
// HIL_LEARNING_ENABLED=false (or 0) to disable the lane entirely.

export function isHilLearningEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.HIL_LEARNING_ENABLED;
	return v !== "false" && v !== "0";
}
