// agent/src/agent-memory-install.ts
//
// SIO-938: wires the Couchbase Agent Memory backend into the lifecycle seams,
// mirroring memory-promotion.ts. installAgentMemory() is called once at web
// process startup. Both registrations are no-ops unless LIVE_MEMORY_BACKEND is
// "agent-memory", so the default file backend is untouched.

import { registerMemoryFlusher, registerMemoryRecaller } from "./lifecycle.ts";
import { endAgentMemorySession, recallAgentMemory, selectedBackend, setActiveMemorySession } from "./memory-backend.ts";

export function installAgentMemory(): void {
	registerMemoryRecaller(async ({ agentName, threadId, query }) => {
		if (selectedBackend() !== "agent-memory") return undefined;
		// Bind the active session so subsequent writer enqueues attach to it.
		setActiveMemorySession(agentName, threadId);
		return recallAgentMemory(agentName, threadId, query ?? "recent incidents, decisions, and in-flight work");
	});

	registerMemoryFlusher(async () => {
		if (selectedBackend() !== "agent-memory") return;
		await endAgentMemorySession();
	});
}
