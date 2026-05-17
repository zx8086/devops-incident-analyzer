// shared/src/request-context.ts
import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
	threadId: string;
	runId: string;
	requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T | Promise<T>): T | Promise<T> {
	return storage.run(ctx, fn);
}

export function getCurrentRequestContext(): RequestContext | undefined {
	return storage.getStore();
}
