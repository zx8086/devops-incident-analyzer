// src/gitlab-client/orbit.ts

import { z } from "zod";
import { createContextLogger } from "../utils/logger.js";

const log = createContextLogger("orbit");

export interface OrbitRestConfig {
	instanceUrl: string;
	// PAT with read_api scope; falls back to the GitLab PAT when a dedicated
	// Orbit token is not provided (SIO-1076).
	personalAccessToken: string;
	queryPath: string;
	schemaPath: string;
	statusPath: string;
	timeout: number;
}

// The Orbit query DSL is an open JSON object validated server-side; we treat it
// as an opaque record here (the DSL builders in tools/orbit/dsl.ts construct it).
export type OrbitQuery = Record<string, unknown>;

// POST /orbit/query returns { result: { rows, columns, group_columns, ... }, row_count }.
// All entity ids come back as strings (JS precision), so downstream schemas use
// z.union([z.number(), z.string()]) for ids. .catchall keeps unknown Beta fields.
const OrbitQueryResponseSchema = z
	.object({
		result: z
			.object({
				rows: z.array(z.unknown()).optional(),
				columns: z.array(z.unknown()).optional(),
				group_columns: z.array(z.unknown()).optional(),
			})
			.catchall(z.unknown())
			.optional(),
		query_type: z.string().optional(),
		row_count: z.number().optional(),
	})
	.catchall(z.unknown());
export type OrbitQueryResponse = z.infer<typeof OrbitQueryResponseSchema>;

// GET /orbit/status. SIO-1077: the live gitlab.com Orbit (v0.86.0) returns a
// { user, system: { status, components[] } } shape -- NOT the top-level `status`/`domains`
// shape originally assumed. We accept BOTH: the live system/components shape and the legacy
// documented shape, so a self-hosted/older Orbit that reports `status: "indexed"` still
// resolves. .catchall keeps unknown fields for forward-compat.
const OrbitComponentSchema = z
	.object({
		name: z.string(),
		status: z.string().optional(),
		replicas: z.object({ ready: z.number().optional(), desired: z.number().optional() }).optional(),
	})
	.catchall(z.unknown());

export const OrbitStatusResponseSchema = z
	.object({
		// Live shape (gitlab.com Orbit >= 0.86.0)
		user: z.object({ available: z.boolean().optional() }).catchall(z.unknown()).optional(),
		system: z
			.object({
				status: z.string().optional(), // "healthy" | "unhealthy" | ...
				version: z.string().optional(),
				components: z.array(OrbitComponentSchema).optional(),
			})
			.catchall(z.unknown())
			.optional(),
		// Legacy documented shape (kept for older/self-hosted Orbit)
		status: z.string().optional(), // "indexed" | "indexing" | ...
		domains: z
			.object({
				sdlc: z.object({ indexed: z.boolean().optional(), last_updated: z.string().optional() }).optional(),
				code: z.object({ indexed: z.boolean().optional(), last_updated: z.string().optional() }).optional(),
			})
			.optional(),
		projects: z.object({ total: z.number().optional(), indexed: z.number().optional() }).optional(),
	})
	.catchall(z.unknown());
export type OrbitStatusResponse = z.infer<typeof OrbitStatusResponseSchema>;

// The two indexer components that must be healthy for cross-project graph queries.
const REQUIRED_INDEXERS = ["gkg-indexer-sdlc", "gkg-indexer-code"] as const;

export class OrbitUnavailableError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "OrbitUnavailableError";
	}
}

export class OrbitRestClient {
	private readonly instanceUrl: string;
	private readonly headers: Record<string, string>;
	private readonly timeout: number;
	private readonly queryPath: string;
	private readonly schemaPath: string;
	private readonly statusPath: string;

	constructor(config: OrbitRestConfig) {
		// Orbit paths are already absolute (/api/v4/orbit/...), so the base is the
		// bare instance URL -- NOT instanceUrl + /api/v4 like GitLabRestClient.
		this.instanceUrl = config.instanceUrl.replace(/\/+$/, "");
		this.headers = {
			Authorization: `Bearer ${config.personalAccessToken}`,
			"Content-Type": "application/json",
		};
		this.timeout = config.timeout;
		this.queryPath = config.queryPath;
		this.schemaPath = config.schemaPath;
		this.statusPath = config.statusPath;
	}

	// GET /orbit/status -- free. Boot probe + "still indexing" check. Validated so
	// availability logic never branches on an unvalidated/evolving Orbit shape.
	async getStatus(): Promise<OrbitStatusResponse> {
		const raw = await this.request<unknown>({ path: this.statusPath, method: "GET" });
		return OrbitStatusResponseSchema.parse(raw);
	}

	// GET /orbit/schema -- free. Ontology (node/edge types). Passed through to the
	// LLM verbatim, so no schema is imposed on Orbit's own schema payload.
	async getSchema(): Promise<unknown> {
		return this.request<unknown>({ path: this.schemaPath, method: "GET" });
	}

	// POST /orbit/query -- BILLED (GitLab Credits). format:"raw" for structured JSON
	// we parse; the default "llm" is compact text for direct model consumption.
	async query(dsl: OrbitQuery, format: "raw" | "llm" = "raw"): Promise<OrbitQueryResponse> {
		const raw = await this.request<unknown>({
			path: this.queryPath,
			method: "POST",
			body: { query: dsl, format },
		});
		return OrbitQueryResponseSchema.parse(raw);
	}

	private async request<T>(options: { path: string; method: "GET" | "POST"; body?: unknown }): Promise<T> {
		const url = `${this.instanceUrl}${options.path}`;
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), this.timeout);

		try {
			const response = await fetch(url, {
				method: options.method,
				headers: this.headers,
				body: options.body ? JSON.stringify(options.body) : undefined,
				signal: controller.signal,
			});

			if (!response.ok) {
				const errorBody = await response.text().catch(() => "");
				throw new OrbitUnavailableError(
					`Orbit API error ${response.status}: ${response.statusText}. ${errorBody}`,
					response.status,
				);
			}

			return (await response.json()) as T;
		} catch (error) {
			// AbortError and network failures surface as unavailable so callers
			// can soft-fail rather than crash the sub-agent turn.
			if (error instanceof OrbitUnavailableError) throw error;
			log.warn({ path: options.path, error }, "Orbit request failed");
			throw new OrbitUnavailableError(error instanceof Error ? error.message : String(error));
		} finally {
			clearTimeout(timeoutId);
		}
	}
}

// Derive availability from a status response. SIO-1077: supports BOTH the live gitlab.com
// system/components shape and the legacy status/domains shape.
//
// Live shape: Orbit is available when system.status is "healthy" (or "indexed") AND both
// required indexer components (gkg-indexer-sdlc, gkg-indexer-code) are present, healthy, and
// have at least one ready replica -- i.e. the graph is actually being served, not just the
// deployment object existing.
//
// Legacy shape: top-level status === "indexed", or both sdlc+code domains indexed.
export function isOrbitIndexed(status: OrbitStatusResponse): boolean {
	// Live shape first.
	const system = status.system;
	if (system) {
		const systemOk = system.status === "healthy" || system.status === "indexed";
		if (systemOk && Array.isArray(system.components)) {
			const indexersReady = REQUIRED_INDEXERS.every((name) => {
				const c = system.components?.find((comp) => comp.name === name);
				if (!c) return false;
				const statusOk = c.status === undefined || c.status === "healthy";
				const ready = c.replicas?.ready ?? 0;
				return statusOk && ready >= 1;
			});
			if (indexersReady) return true;
		}
	}

	// Legacy shape.
	if (status.status === "indexed") return true;
	const sdlc = status.domains?.sdlc?.indexed === true;
	const code = status.domains?.code?.indexed === true;
	return sdlc && code;
}
