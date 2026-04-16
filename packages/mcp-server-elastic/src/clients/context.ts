// src/clients/context.ts
// SIO-649: Per-request deployment context. HTTP middleware enters this context for the
// lifetime of a request so tool handlers (running downstream) see the caller's chosen
// deployment without needing to accept a new parameter.

import { AsyncLocalStorage } from "node:async_hooks";

interface DeploymentContext {
	deploymentId: string;
}

const storage = new AsyncLocalStorage<DeploymentContext>();

export const DEPLOYMENT_HEADER = "x-elastic-deployment";

export function runWithDeployment<T>(deploymentId: string, fn: () => T): T {
	return storage.run({ deploymentId }, fn);
}

// Returns the deployment ID from the current request context, or undefined if called
// outside any request (e.g. startup code) or if no header was provided.
export function currentDeploymentId(): string | undefined {
	return storage.getStore()?.deploymentId;
}
