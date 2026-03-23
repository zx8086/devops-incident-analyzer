// src/utils/sessionContext.ts
// Re-exports from shared tracing module for backward compatibility
export {
	createSessionContext,
	getCurrentClientInfo,
	getCurrentSession,
	getCurrentSessionId,
	runWithSession,
	type SessionContext,
} from "@devops-agent/shared";
