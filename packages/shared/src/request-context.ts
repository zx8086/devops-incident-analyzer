// shared/src/request-context.ts
import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
	threadId: string;
	runId: string;
	requestId: string;
	// SIO-1887: the invoked top-level agent (incident-analyzer, elastic-iac, ...).
	// The live-memory writer resolves its per-agent runtime dir from this, so no
	// caller has to thread a baseDir through every write. Absent -> the historical
	// incident-analyzer default.
	agentName?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T | Promise<T>): T | Promise<T> {
	return storage.run(ctx, fn);
}

export function getCurrentRequestContext(): RequestContext | undefined {
	return storage.getStore();
}
