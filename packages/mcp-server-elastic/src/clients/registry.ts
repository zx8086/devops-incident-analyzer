// src/clients/registry.ts
// SIO-649: Holds the Map<deploymentId, Client> built at startup, plus a Proxy<Client> that
// transparently routes every call to whichever deployment the current request context
// selected. Tools keep accepting `esClient: Client` -- no per-tool changes needed.

import type { Client } from "@elastic/elasticsearch";
import { currentDeploymentId } from "./context.js";

interface Registry {
	clients: Map<string, Client>;
	defaultId: string;
}

let registry: Registry | null = null;

export function registerClients(clients: Map<string, Client>, defaultId: string): void {
	if (!clients.has(defaultId)) {
		throw new Error(`Default deployment "${defaultId}" is not in the client map`);
	}
	registry = { clients, defaultId };
}

export function listRegisteredDeploymentIds(): string[] {
	return registry ? [...registry.clients.keys()] : [];
}

// Resolve the Client for the request's deployment. Falls back to the default when no context
// is set (startup/boot) or when the header names an unknown deployment -- behavior here must
// be identical to pre-SIO-649 code paths so existing single-deployment setups don't notice.
function resolveClient(): Client {
	if (!registry) {
		throw new Error("Elasticsearch client registry not initialized");
	}
	const id = currentDeploymentId();
	if (id && registry.clients.has(id)) {
		return registry.clients.get(id) as Client;
	}
	return registry.clients.get(registry.defaultId) as Client;
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
