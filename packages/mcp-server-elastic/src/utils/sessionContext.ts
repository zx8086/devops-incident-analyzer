// src/utils/sessionContext.ts
// Re-exports from shared tracing module for backward compatibility
export {
	type SessionContext,
	runWithSession,
	getCurrentSession,
	getCurrentSessionId,
	getCurrentClientInfo,
	createSessionContext,
} from "@devops-agent/shared";
