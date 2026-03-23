// src/utils/sessionContext.ts
// Re-exports from shared tracing module for backward compatibility
export {
	type SessionContext,
	runWithSession,
	getCurrentSession,
	createSessionContext,
} from "@devops-agent/shared";
