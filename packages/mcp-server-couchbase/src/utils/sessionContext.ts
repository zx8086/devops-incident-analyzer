// src/utils/sessionContext.ts
// Re-exports from shared tracing module for backward compatibility
export {
	createSessionContext,
	getCurrentSession,
	runWithSession,
	type SessionContext,
} from "@devops-agent/shared";
