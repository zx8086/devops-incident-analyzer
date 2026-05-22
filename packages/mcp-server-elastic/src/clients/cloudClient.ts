// src/clients/cloudClient.ts
// SIO-674: Thin fetch wrapper for the org-scoped Elastic Cloud API at api.elastic-cloud.com.
// Distinct from the cluster client (different endpoint, different auth header). Returned as
// a singleton from initializeCloudClient(); callers see McpError on failure so the existing
// tool error path (createXxxMcpError) doesn't need to know about HTTP transport.

import { readFileSync } from "node:fs";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Config, ElasticCloudConfig } from "../config/schemas.js";
import { logger } from "../utils/logger.js";

export interface CloudRequestOptions {
	query?: Record<string, string | number | boolean | undefined>;
	signal?: AbortSignal;
	// When true, a 404 response resolves to null instead of throwing. Used by plan/activity
	// fallback paths where "deployment exists but has no in-flight plan" is a valid state.
	notFoundOk?: boolean;
}

// Subset of fetch we depend on -- typed loosely so test doubles can stand in.
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// SIO-826: operator-supplied per-IC rate catalog. JSON shape v1:
//   {
//     "$schema": "EC_RATE_CATALOG v1",
//     "refreshed": "2026-05-22",
//     "source": "free-form provenance note",        // optional
//     "rates": {
//       "<region>": { "<instance_configuration_id>": <ECU/GB-RAM-hour number> }
//     }
//   }
// Flattened in-memory to Map<"<region>::<normalized_ic>", number> so the simulate
// rate-resolution chain can look it up with the same shape as the billing-derived maps.
const RATE_CATALOG_SCHEMA = z.object({
	$schema: z.string().min(1),
	refreshed: z.string().min(1),
	source: z.string().optional(),
	rates: z.record(z.string(), z.record(z.string(), z.number().nonnegative())),
});

export interface RateCatalog {
	refreshed: string;
	source?: string;
	rates: Map<string, number>;
}

// Mirror of normalizeIc() in the simulate tool. Lives here too so the catalog flattens
// rate keys identically to how the billing rate maps are looked up. Kept in sync by
// convention -- both functions strip trailing ".<digits>" segments from IC ids so
// "aws.es.master.c5d.2" matches "aws.es.master.c5d".
function normalizeIcForCatalog(ic: string): string {
	return ic.replace(/(\.\d+)+$/, "");
}

function loadRateCatalog(path: string): RateCatalog | null {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		logger.warn(
			{ path, error: err instanceof Error ? err.message : String(err) },
			"EC_RATE_CATALOG_PATH set but file is not readable; ignoring catalog (simulate_hardware_profile_change falls back to env-var or 'unavailable')",
		);
		return null;
	}
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(raw);
	} catch (err) {
		logger.warn(
			{ path, error: err instanceof Error ? err.message : String(err) },
			"EC_RATE_CATALOG_PATH file is not valid JSON; ignoring catalog",
		);
		return null;
	}
	const validation = RATE_CATALOG_SCHEMA.safeParse(parsedJson);
	if (!validation.success) {
		logger.warn(
			{ path, issues: validation.error.issues.slice(0, 5) },
			"EC_RATE_CATALOG_PATH file does not match the v1 schema; ignoring catalog",
		);
		return null;
	}
	const data = validation.data;
	const flat = new Map<string, number>();
	let rateCount = 0;
	for (const [region, icRates] of Object.entries(data.rates)) {
		for (const [ic, rate] of Object.entries(icRates)) {
			if (rate <= 0) continue;
			flat.set(`${region}::${normalizeIcForCatalog(ic)}`, rate);
			rateCount++;
		}
	}
	if (rateCount === 0) {
		logger.warn({ path }, "EC_RATE_CATALOG_PATH file loaded but contains no positive rates; ignoring catalog");
		return null;
	}
	logger.info(
		{ path, refreshed: data.refreshed, source: data.source, rateCount },
		"loaded operator rate catalog (SIO-826)",
	);
	return { refreshed: data.refreshed, source: data.source, rates: flat };
}

export class CloudClient {
	private readonly endpoint: string;
	private readonly apiKey: string;
	private readonly requestTimeout: number;
	private readonly maxRetries: number;
	readonly defaultOrgId?: string;
	readonly pricePerGbRamHour?: number;
	readonly rateCatalog: RateCatalog | null;
	private readonly fetchImpl: FetchLike;

	constructor(config: ElasticCloudConfig, fetchImpl: FetchLike = fetch) {
		this.endpoint = config.endpoint.replace(/\/$/, "");
		this.apiKey = config.apiKey;
		this.requestTimeout = config.requestTimeout;
		this.maxRetries = config.maxRetries;
		this.defaultOrgId = config.defaultOrgId;
		this.pricePerGbRamHour = config.pricePerGbRamHour;
		this.rateCatalog = config.rateCatalogPath ? loadRateCatalog(config.rateCatalogPath) : null;
		this.fetchImpl = fetchImpl;
	}

	async get<T = unknown>(path: string, options?: CloudRequestOptions & { notFoundOk?: false }): Promise<T>;
	async get<T = unknown>(path: string, options: CloudRequestOptions & { notFoundOk: true }): Promise<T | null>;
	async get<T = unknown>(path: string, options: CloudRequestOptions = {}): Promise<T | null> {
		return this.request<T>("GET", path, options);
	}

	// DELETE is idempotent, so it shares the retry path. Used by cancel-pending-plan style tools.
	async del<T = unknown>(path: string, options?: CloudRequestOptions & { notFoundOk?: false }): Promise<T>;
	async del<T = unknown>(path: string, options: CloudRequestOptions & { notFoundOk: true }): Promise<T | null>;
	async del<T = unknown>(path: string, options: CloudRequestOptions = {}): Promise<T | null> {
		return this.request<T>("DELETE", path, options);
	}

	private buildUrl(path: string, query?: CloudRequestOptions["query"]): string {
		const normalizedPath = path.startsWith("/") ? path : `/${path}`;
		const url = new URL(`${this.endpoint}${normalizedPath}`);
		if (query) {
			for (const [key, value] of Object.entries(query)) {
				if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
			}
		}
		return url.toString();
	}

	// Idempotent retry: 5xx and network errors back off and retry up to maxRetries. We never
	// retry 4xx -- a 401/404 retried doesn't change. PUT/POST should not call this method.
	private async request<T>(method: "GET" | "DELETE", path: string, options: CloudRequestOptions): Promise<T | null> {
		const url = this.buildUrl(path, options.query);
		const headers: Record<string, string> = {
			Authorization: `ApiKey ${this.apiKey}`,
			Accept: "application/json",
			"Content-Type": "application/json",
		};

		let lastError: unknown;
		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			const timeoutController = new AbortController();
			const timeoutId = setTimeout(() => timeoutController.abort(), this.requestTimeout);
			const signal = options.signal ?? timeoutController.signal;

			try {
				const response = await this.fetchImpl(url, { method, headers, signal });
				clearTimeout(timeoutId);

				if (response.ok) {
					return (await response.json()) as T;
				}

				if (response.status === 404 && options.notFoundOk) {
					return null;
				}

				const bodyText = await response.text().catch(() => "");
				const isRetriable = response.status >= 500 && response.status < 600;
				if (isRetriable && attempt < this.maxRetries) {
					const backoffMs = Math.min(2 ** attempt * 100, 5000);
					logger.warn(
						{
							url: this.redactUrl(url),
							status: response.status,
							attempt,
							backoffMs,
						},
						"Elastic Cloud API request failed with retriable status, backing off",
					);
					await new Promise((resolve) => setTimeout(resolve, backoffMs));
					continue;
				}

				throw new McpError(
					response.status >= 400 && response.status < 500 ? ErrorCode.InvalidParams : ErrorCode.InternalError,
					`[cloudClient] ${method} ${this.redactUrl(url)} -> ${response.status} ${response.statusText}`,
					{ status: response.status, body: bodyText.slice(0, 1000) },
				);
			} catch (error) {
				clearTimeout(timeoutId);
				if (error instanceof McpError) throw error;
				lastError = error;
				if (attempt < this.maxRetries) {
					const backoffMs = Math.min(2 ** attempt * 100, 5000);
					logger.warn(
						{
							url: this.redactUrl(url),
							error: error instanceof Error ? error.message : String(error),
							attempt,
							backoffMs,
						},
						"Elastic Cloud API network error, backing off",
					);
					await new Promise((resolve) => setTimeout(resolve, backoffMs));
				}
			}
		}

		throw new McpError(
			ErrorCode.InternalError,
			`[cloudClient] ${method} ${this.redactUrl(url)} failed after ${this.maxRetries + 1} attempts`,
			{ lastError: lastError instanceof Error ? lastError.message : String(lastError) },
		);
	}

	private redactUrl(url: string): string {
		// URL itself doesn't carry the ApiKey (it's in the Authorization header), but if a
		// caller ever puts a credential in the query string we strip it here defensively.
		try {
			const u = new URL(url);
			for (const key of ["api_key", "apikey", "key"]) {
				if (u.searchParams.has(key)) u.searchParams.set(key, "[REDACTED]");
			}
			return u.toString();
		} catch {
			return url;
		}
	}
}

export function initializeCloudClient(config: Config, fetchImpl?: FetchLike): CloudClient | null {
	if (!config.cloud) {
		logger.info("EC_API_KEY not set; Elastic Cloud + Billing tools will not register");
		return null;
	}
	logger.info(
		{
			endpoint: config.cloud.endpoint,
			defaultOrgId: config.cloud.defaultOrgId ?? null,
			requestTimeout: config.cloud.requestTimeout,
			maxRetries: config.cloud.maxRetries,
		},
		"Initialised Elastic Cloud client (lazy auth -- first call will surface auth errors)",
	);
	return new CloudClient(config.cloud, fetchImpl);
}
