// src/clients/cloudClient.ts
// SIO-674: Thin fetch wrapper for the org-scoped Elastic Cloud API at api.elastic-cloud.com.
// Distinct from the cluster client (different endpoint, different auth header). Returned as
// a singleton from initializeCloudClient(); callers see McpError on failure so the existing
// tool error path (createXxxMcpError) doesn't need to know about HTTP transport.

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { Config, ElasticCloudConfig } from "../config/schemas.js";
import { logger } from "../utils/logger.js";

export interface CloudRequestOptions {
	query?: Record<string, string | number | boolean | undefined>;
	signal?: AbortSignal;
}

// Subset of fetch we depend on -- typed loosely so test doubles can stand in.
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class CloudClient {
	private readonly endpoint: string;
	private readonly apiKey: string;
	private readonly requestTimeout: number;
	private readonly maxRetries: number;
	readonly defaultOrgId?: string;
	private readonly fetchImpl: FetchLike;

	constructor(config: ElasticCloudConfig, fetchImpl: FetchLike = fetch) {
		this.endpoint = config.endpoint.replace(/\/$/, "");
		this.apiKey = config.apiKey;
		this.requestTimeout = config.requestTimeout;
		this.maxRetries = config.maxRetries;
		this.defaultOrgId = config.defaultOrgId;
		this.fetchImpl = fetchImpl;
	}

	async get<T = unknown>(path: string, options: CloudRequestOptions = {}): Promise<T> {
		return this.request<T>("GET", path, options);
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
	private async request<T>(method: "GET", path: string, options: CloudRequestOptions): Promise<T> {
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
