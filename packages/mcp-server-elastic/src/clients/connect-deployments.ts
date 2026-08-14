// src/clients/connect-deployments.ts
// SIO: boot resilience for multi-deployment Elastic. A single deployment's transient
// connect failure must NOT crash the whole server (previously buildDeploymentClient threw
// and killed all N). Skip+warn failures, throw only when ALL fail, and re-point the default
// to a surviving deployment when the configured default is the one that failed.

import type { Client } from "@elastic/elasticsearch";

export interface DeploymentConnectSpec {
	id: string;
}

export interface ConnectDeploymentsResult<C = Client> {
	clients: Map<string, C>;
	defaultId: string;
	failures: Array<{ id: string; error: string }>;
}

export interface ConnectDeploymentsLogger {
	warn: (meta: Record<string, unknown>, msg: string) => void;
	info: (meta: Record<string, unknown>, msg: string) => void;
}

// Connect each spec sequentially via `connectOne`. Failures are collected, not thrown.
// - If every spec fails -> throw (nothing to serve).
// - `defaultId` stays as requested when that deployment connected; otherwise it falls back
//   to the first surviving client so the registry's default-must-exist invariant holds.
export async function connectDeployments<S extends DeploymentConnectSpec, C = Client>(
	specs: S[],
	requestedDefaultId: string,
	connectOne: (spec: S) => Promise<C>,
	log: ConnectDeploymentsLogger,
): Promise<ConnectDeploymentsResult<C>> {
	const clients = new Map<string, C>();
	const failures: Array<{ id: string; error: string }> = [];

	for (const spec of specs) {
		try {
			clients.set(spec.id, await connectOne(spec));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			failures.push({ id: spec.id, error: message });
			log.warn(
				{ deploymentId: spec.id, error: message },
				"Deployment failed to connect at startup; skipping it. Other deployments are unaffected.",
			);
		}
	}

	if (clients.size === 0) {
		const summary = failures.map((f) => `${f.id}: ${f.error}`).join("; ");
		throw new Error(`All ${specs.length} Elasticsearch deployment(s) failed to connect: ${summary}`);
	}

	let defaultId = requestedDefaultId;
	if (!clients.has(defaultId)) {
		// The configured default failed. Re-point to the first surviving deployment so the
		// registry (which requires the default to exist) still initializes.
		const fallback = clients.keys().next().value as string;
		log.warn(
			{ requestedDefaultId, fallbackDefaultId: fallback },
			"Default deployment failed to connect; re-pointing default to a surviving deployment.",
		);
		defaultId = fallback;
	}

	if (failures.length > 0) {
		log.info(
			{ connected: clients.size, failed: failures.length, failedIds: failures.map((f) => f.id) },
			"Elasticsearch startup completed with partial deployment availability.",
		);
	}

	return { clients, defaultId, failures };
}
