// src/utils/sessionContext.ts
import { AsyncLocalStorage } from "node:async_hooks";

export interface SessionContext {
	sessionId: string;
	connectionId: string;
	transportMode: "stdio" | "http" | "both";
	clientInfo?: {
		name?: string;
		version?: string;
		platform?: string;
	};
	userId?: string;
	startTime?: number;
}

const sessionStorage = new AsyncLocalStorage<SessionContext>();

export function runWithSession<T>(context: SessionContext, fn: () => T | Promise<T>): T | Promise<T> {
	return sessionStorage.run(context, fn);
}

export function getCurrentSession(): SessionContext | undefined {
	return sessionStorage.getStore();
}

export function createSessionContext(
	connectionId: string,
	transportMode: "stdio" | "http" | "both",
	sessionId?: string,
	clientInfo?: SessionContext["clientInfo"],
): SessionContext {
	return {
		sessionId: sessionId || connectionId,
		connectionId,
		transportMode,
		clientInfo,
		startTime: Date.now(),
	};
}
