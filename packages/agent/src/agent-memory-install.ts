// agent/src/agent-memory-install.ts
//
// SIO-938: wires the Couchbase Agent Memory backend into the lifecycle seams,
// mirroring memory-promotion.ts. installAgentMemory() is called once at web
// process startup. Both registrations are no-ops unless LIVE_MEMORY_BACKEND is
// "agent-memory", so the default file backend is untouched.

import { registerMemoryFlusher, registerMemoryRecaller, registerPostTurnFlusher } from "./lifecycle.ts";
import {
	agentMemoryHealthy,
	endAgentMemorySession,
	flushAgentMemoryAfterTurn,
	recallAgentMemory,
	selectedBackend,
	setActiveMemorySession,
} from "./memory-backend.ts";

export function installAgentMemory(): void {
	registerMemoryRecaller(async ({ agentName, threadId, query }) => {
		if (selectedBackend() !== "agent-memory") return undefined;
		// Bind the active session so subsequent writer enqueues attach to it even
		// when the service is unreachable now (writes queue for a later retry).
		setActiveMemorySession(agentName, threadId);
		// Skip recall against a dead/saturated service rather than emit a noisy
		// per-turn failure; this turn just runs without recalled context.
		if (!(await agentMemoryHealthy())) return undefined;
		return recallAgentMemory(agentName, threadId, query ?? "recent incidents, decisions, and in-flight work");
	});

	registerMemoryFlusher(async ({ agentName, threadId }) => {
		if (selectedBackend() !== "agent-memory") return;
		// SIO-955: pass the thread explicitly so cold teardown (unload beacon /
		// idle-TTL sweep, where no in-process turn bound activeRef) still ends the
		// right session instead of silently no-opping.
		await endAgentMemorySession(agentName, threadId);
	});

	// SIO-942: persist this turn's blocks without ending the session, so live
	// memory survives even when teardown never fires (the common case for sessions
	// closed by a process restart rather than the teardown endpoint).
	registerPostTurnFlusher(async ({ agentName, threadId }) => {
		if (selectedBackend() !== "agent-memory") return;
		await flushAgentMemoryAfterTurn(agentName, threadId);
	});
}
