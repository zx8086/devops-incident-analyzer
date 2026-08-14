// src/clients/connect-deployments.ts
// SIO: boot resilience for multi-deployment Elastic. A single deployment's transient
// connect failure must NOT crash the whole server (previously buildDeploymentClient threw
// and killed all N). Skip+warn failures, throw only when ALL fail, and re-point the default
// to a surviving deployment when the configured default is the one that failed.

import { type Client, errors } from "@elastic/elasticsearch";

// A deterministic local misconfiguration (e.g. an unreadable caCert path, invalid client
// options) as opposed to a transient connectivity failure. connectDeployments tolerates
// connectivity failures (skip+warn) but rethrows these so a broken config fails loudly at
// startup instead of being silently masked by a surviving deployment.
export class DeploymentConfigError extends Error {
	readonly deploymentId: string;
	constructor(deploymentId: string, cause: unknown) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		super(`Deployment "${deploymentId}" has an invalid configuration: ${detail}`);
		this.name = "DeploymentConfigError";
		this.deploymentId = deploymentId;
		// Retain the original cause for diagnostics regardless of its type. Error.cause is `unknown`,
		// so a string/object cause is preserved rather than dropped.
		this.cause = cause;
	}
}

// SIO-1467: an authentication/authorization rejection (HTTP 401/403) from the startup probe. Unlike
// a transient outage, a bad/expired credential or a permissions gap will not fix itself, so this is
// fatal: connectDeployments rethrows it rather than skipping the deployment, so the operator sees
// the broken credential at startup instead of it being masked by a surviving deployment.
export class DeploymentAuthError extends Error {
	readonly deploymentId: string;
	readonly statusCode: number;
	constructor(deploymentId: string, statusCode: number, cause: unknown) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		super(
			`Deployment "${deploymentId}" rejected authentication during the startup probe (HTTP ${statusCode}): ${detail}`,
		);
		this.name = "DeploymentAuthError";
		this.deploymentId = deploymentId;
		this.statusCode = statusCode;
		this.cause = cause;
	}
}

// True when a probe error is an Elasticsearch auth/authz rejection (401/403), as opposed to a
// transient connectivity failure (ConnectionError, TimeoutError, NoLivingConnectionsError, 5xx).
// The @elastic SDK surfaces HTTP-level failures as ResponseError with a numeric statusCode.
export function isAuthProbeFailure(error: unknown): boolean {
	return error instanceof errors.ResponseError && (error.statusCode === 401 || error.statusCode === 403);
}

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
// - On a FATAL rethrow (DeploymentConfigError / DeploymentAuthError), every client already
//   connected in this pass is closed via `closeOne` first, so a fatal failure part-way through
//   does not leak the pools of earlier successful deployments (SIO-1467 / CodeRabbit #660).
export async function connectDeployments<S extends DeploymentConnectSpec, C = Client>(
	specs: S[],
	requestedDefaultId: string,
	connectOne: (spec: S) => Promise<C>,
	log: ConnectDeploymentsLogger,
	closeOne?: (client: C) => Promise<void>,
): Promise<ConnectDeploymentsResult<C>> {
	const clients = new Map<string, C>();
	const failures: Array<{ id: string; error: string }> = [];

	// Best-effort close of every already-connected client. Used before a fatal rethrow so the pools
	// opened for earlier successful deployments are not leaked. Never throws -- a close failure is
	// logged and must not mask the fatal error we are about to propagate.
	const closeConnected = async (): Promise<void> => {
		if (!closeOne) return;
		for (const [id, client] of clients) {
			try {
				await closeOne(client);
			} catch (closeError) {
				log.warn(
					{ deploymentId: id, error: closeError instanceof Error ? closeError.message : String(closeError) },
					"Failed to close an Elasticsearch client while unwinding after a fatal startup error.",
				);
			}
		}
	};

	for (const spec of specs) {
		try {
			clients.set(spec.id, await connectOne(spec));
		} catch (error) {
			// A local misconfiguration or an auth/authz rejection is not a transient outage -- fail
			// loudly rather than silently routing the operator's requests through a different,
			// surviving cluster while hiding a broken credential or config.
			if (error instanceof DeploymentConfigError || error instanceof DeploymentAuthError) {
				await closeConnected();
				throw error;
			}
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
