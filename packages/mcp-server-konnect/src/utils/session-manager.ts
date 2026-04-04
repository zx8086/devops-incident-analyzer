// src/utils/session-manager.ts
// Re-exports from shared tracing module with konnect-specific additions
import {
	generateSessionId,
	getCurrentSession,
	getCurrentSessionId,
	runWithSession,
	type SessionContext,
	createSessionContext as sharedCreateSessionContext,
	detectClient as sharedDetectClient,
} from "@devops-agent/shared";
import { createContextLogger } from "./logger.js";

const log = createContextLogger("session");

export type { SessionContext };
export { generateSessionId, getCurrentSession, getCurrentSessionId, runWithSession };

// Konnect uses "sse" as transport mode; map it to shared "http"
export function createSessionContext(
	connectionId: string,
	transportMode: "stdio" | "sse" | "http" | "both",
	sessionId?: string,
	clientInfo?: SessionContext["clientInfo"],
	userId?: string,
): SessionContext {
	const normalizedTransport = transportMode === "sse" ? "http" : transportMode;
	return sharedCreateSessionContext(
		connectionId,
		normalizedTransport as "stdio" | "http" | "both",
		sessionId,
		clientInfo,
		userId,
	);
}

export function detectClient(transportMode: "stdio" | "sse" | "http"): SessionContext["clientInfo"] {
	const normalized = transportMode === "sse" ? "http" : transportMode;
	return sharedDetectClient(normalized) as SessionContext["clientInfo"];
}

export function logSessionInfo(prefix = "Session Info") {
	const session = getCurrentSession();
	if (session) {
		log.debug(
			{
				sessionId: `${session.sessionId?.substring(0, 10)}...`,
				connectionId: `${session.connectionId?.substring(0, 10)}...`,
				client: session.clientInfo?.name || "unknown",
				transport: session.transportMode,
				duration: session.startTime ? Date.now() - session.startTime : 0,
			},
			`${prefix}:`,
		);
	} else {
		log.debug(`${prefix}: No active session`);
	}
}
