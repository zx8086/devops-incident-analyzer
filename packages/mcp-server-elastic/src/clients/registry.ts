// src/clients/registry.ts
// SIO-649: Holds the Map<deploymentId, Client> built at startup, plus a Proxy<Client> that
// transparently routes every call to whichever deployment the current request context
// selected. Tools keep accepting `esClient: Client` -- no per-tool changes needed.

import type { Client } from "@elastic/elasticsearch";
import { currentDeploymentId } from "./context.js";

interface Registry {
	clients: Map<string, Client>;
	defaultId: string;
	// The deployment id the operator configured as default. Differs from defaultId only when that
	// configured default failed to connect at startup and connectDeployments re-pointed to a
	// survivor. When they differ, implicit (deployment-omitted) operations fail closed rather than
	// silently running against a cluster the caller never selected.
	configuredDefaultId: string;
}

// Thrown when a request cannot be routed to the deployment the caller intended: either it named a
// deployment that is not connected, or it omitted the deployment while the configured default is
// unavailable. Routing fails closed instead of silently hitting a different cluster (which for a
// write-capable client could mutate the wrong data).
export class DeploymentUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DeploymentUnavailableError";
	}
}

let registry: Registry | null = null;

// registeredDefaultId is the survivor the registry will actually route implicit ops to;
// configuredDefaultId is what the operator asked for. They differ only after a re-point.
export function registerClients(clients: Map<string, Client>, defaultId: string, configuredDefaultId?: string): void {
	if (!clients.has(defaultId)) {
		throw new Error(`Default deployment "${defaultId}" is not in the client map`);
	}
	registry = { clients, defaultId, configuredDefaultId: configuredDefaultId ?? defaultId };
}

export function listRegisteredDeploymentIds(): string[] {
	return registry ? [...registry.clients.keys()] : [];
}

// Resolve the Client for the request's deployment, failing closed on an explicitly-selected
// unavailable deployment (Greptile #659 Issue 2): a request naming a deployment that is not
// connected must NOT silently fall through to the default (which for a write-capable client could
// mutate the wrong cluster). When no deployment is selected, the default client is returned; the
// case where the configured default itself was re-pointed is gated at the tool layer
// (assertDefaultAvailable) rather than here, because boot-time infrastructure reads the proxy with
// no request context and must not be rejected. See isDefaultReassigned().
function resolveClient(): Client {
	if (!registry) {
		throw new Error("Elasticsearch client registry not initialized");
	}
	const id = currentDeploymentId();
	if (id) {
		const client = registry.clients.get(id);
		if (!client) {
			throw new DeploymentUnavailableError(
				`Elasticsearch deployment "${id}" is not available (it failed to connect at startup or is not configured). ` +
					`Available deployments: ${[...registry.clients.keys()].join(", ")}.`,
			);
		}
		return client;
	}
	return registry.clients.get(registry.defaultId) as Client;
}

// True when the configured default failed at startup and routing was re-pointed to a survivor.
// The tool layer uses this to fail implicit (deployment-omitted) user operations closed, without
// affecting boot-time infrastructure reads of the proxy.
export function isDefaultReassigned(): boolean {
	return registry ? registry.defaultId !== registry.configuredDefaultId : false;
}

// The operator-configured default id (for building a clear "target X explicitly" error message).
export function configuredDefaultDeploymentId(): string | undefined {
	return registry?.configuredDefaultId;
}

// The tool-layer fail-closed decision for a cluster operation that supplied no `deployment` arg.
// Reject only when BOTH: the configured default was re-pointed to a survivor, AND the request has
// not selected a valid deployment via the x-elastic-deployment header (which the transport places
// in the request context before the handler runs). An HTTP header selection of a connected
// deployment is an explicit choice and must be honored; a truly implicit op against a re-pointed
// default is rejected so it never silently runs on a cluster the caller never chose.
export function shouldRejectImplicitOperation(headerDeploymentId: string | undefined): boolean {
	if (!isDefaultReassigned()) return false;
	const headerSelectsValid = headerDeploymentId !== undefined && !!registry && registry.clients.has(headerDeploymentId);
	return !headerSelectsValid;
}

// Proxy forwards every property read and method call to the request-resolved Client.
// Using `any` as the target lets us intercept arbitrary getters (info, indices, search,
// transport, etc.) without enumerating the Client surface area.
export function createClientProxy(): Client {
	const handler: ProxyHandler<Record<string, unknown>> = {
		get(_target, prop, _receiver) {
			const client = resolveClient();
			const value = Reflect.get(client as unknown as Record<string | symbol, unknown>, prop);
			return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(client) : value;
		},
		has(_target, prop) {
			const client = resolveClient();
			return Reflect.has(client as unknown as Record<string | symbol, unknown>, prop);
		},
	};
	return new Proxy({}, handler) as unknown as Client;
}
