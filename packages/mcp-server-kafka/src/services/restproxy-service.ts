// src/services/restproxy-service.ts
import type { AppConfig } from "../config/schemas";
import { fetchUpstream } from "../lib/upstream-fetch.ts";
import { sliceTopics } from "./topic-pagination.ts";

// SIO-714: Confluent REST Proxy v2 reserves application/vnd.kafka.json.v2+json for the
// request body of produce calls embedding JSON records. Everything else (metadata reads,
// consumer lifecycle, produce response) uses application/vnd.kafka.v2+json. Sending the
// wrong type on Accept results in HTTP 406/415.
const REST_PROXY_V2_DEFAULT = "application/vnd.kafka.v2+json";
const REST_PROXY_V2_JSON_RECORDS = "application/vnd.kafka.json.v2+json";

export class RestProxyService {
	private readonly baseUrl: string;
	private readonly authHeader?: string;

	constructor(config: AppConfig) {
		this.baseUrl = config.restproxy.url.replace(/\/$/, "");
		if (config.restproxy.apiKey && config.restproxy.apiSecret) {
			this.authHeader = `Basic ${btoa(`${config.restproxy.apiKey}:${config.restproxy.apiSecret}`)}`;
		}
	}

	private buildHeaders(contentType: string = REST_PROXY_V2_DEFAULT): Record<string, string> {
		const headers: Record<string, string> = {
			"Content-Type": contentType,
			Accept: REST_PROXY_V2_DEFAULT,
		};
		if (this.authHeader) headers.Authorization = this.authHeader;
		return headers;
	}

	async probeReachability(timeoutMs = 5000): Promise<void> {
		// SIO-725/729: probe goes through fetchUpstream so a misconfigured baseUrl
		// or nginx HTML 503 surfaces with hostname + content-type metadata, not a
		// bare "HTTP 502" string.
		await fetchUpstream(
			`${this.baseUrl}/topics`,
			{ method: "GET", headers: this.buildHeaders(), signal: AbortSignal.timeout(timeoutMs) },
			{ serviceLabel: "REST Proxy", baseUrl: this.baseUrl },
		);
	}

	async listTopics(): Promise<string[]> {
		return this.request<string[]>("GET", "/topics");
	}

	// SIO-736: paged variant. REST Proxy v2 /topics has no upstream pagination,
	// so fetch all once and slice client-side via the SIO-735 shared helper.
	async listTopicsPaged(options: { prefix?: string; limit: number; offset: number }): Promise<{
		topics: { name: string }[];
		total: number;
		truncated: boolean;
		hint?: string;
	}> {
		const raw = await this.request<string[]>("GET", "/topics");
		const sliced = sliceTopics(raw, { prefix: options.prefix, limit: options.limit, offset: options.offset });
		return {
			topics: sliced.topics.map((name) => ({ name })),
			total: sliced.total,
			truncated: sliced.truncated,
			...(sliced.hint ? { hint: sliced.hint } : {}),
		};
	}

	async getTopic(name: string): Promise<{
		name: string;
		configs: Record<string, string>;
		partitions: Array<{ partition: number; leader: number; replicas: Array<unknown> }>;
	}> {
		return this.request("GET", `/topics/${encodeURIComponent(name)}`);
	}

	async getPartitions(
		topic: string,
	): Promise<
		Array<{ partition: number; leader: number; replicas: Array<{ broker: number; leader: boolean; in_sync: boolean }> }>
	> {
		return this.request("GET", `/topics/${encodeURIComponent(topic)}/partitions`);
	}

	async produceMessages(
		topic: string,
		records: Array<{ key?: unknown; value: unknown; partition?: number }>,
		_format: "json" | "binary" = "json",
	): Promise<{
		key_schema_id?: number;
		value_schema_id?: number;
		offsets: Array<{ partition: number; offset: number; error_code?: number; error?: string }>;
	}> {
		return this.request("POST", `/topics/${encodeURIComponent(topic)}`, { records }, REST_PROXY_V2_JSON_RECORDS);
	}

	async createConsumer(
		group: string,
		options?: {
			name?: string;
			format?: "json" | "binary";
			autoOffsetReset?: "earliest" | "latest";
			autoCommitEnable?: boolean;
		},
	): Promise<{ instance_id: string; base_uri: string }> {
		const body: Record<string, unknown> = {};
		if (options?.name) body.name = options.name;
		if (options?.format) body.format = options.format;
		if (options?.autoOffsetReset) body["auto.offset.reset"] = options.autoOffsetReset;
		if (options?.autoCommitEnable !== undefined) body["auto.commit.enable"] = String(options.autoCommitEnable);
		return this.request("POST", `/consumers/${encodeURIComponent(group)}`, body);
	}

	async subscribe(group: string, instance: string, topics: string[]): Promise<void> {
		await this.request<void>(
			"POST",
			`/consumers/${encodeURIComponent(group)}/instances/${encodeURIComponent(instance)}/subscription`,
			{ topics },
		);
	}

	async consumeRecords(
		group: string,
		instance: string,
		options?: { timeoutMs?: number; maxBytes?: number },
	): Promise<Array<{ topic: string; key?: unknown; value: unknown; partition: number; offset: number }>> {
		const qs: string[] = [];
		if (options?.timeoutMs !== undefined) qs.push(`timeout=${options.timeoutMs}`);
		if (options?.maxBytes !== undefined) qs.push(`max_bytes=${options.maxBytes}`);
		const path = `/consumers/${encodeURIComponent(group)}/instances/${encodeURIComponent(instance)}/records${qs.length ? `?${qs.join("&")}` : ""}`;
		return this.request("GET", path);
	}

	async commitOffsets(
		group: string,
		instance: string,
		offsets?: Array<{ topic: string; partition: number; offset: number }>,
	): Promise<void> {
		await this.request<void>(
			"POST",
			`/consumers/${encodeURIComponent(group)}/instances/${encodeURIComponent(instance)}/offsets`,
			offsets ? { offsets } : undefined,
		);
	}

	async deleteConsumer(group: string, instance: string): Promise<void> {
		await this.request<void>(
			"DELETE",
			`/consumers/${encodeURIComponent(group)}/instances/${encodeURIComponent(instance)}`,
		);
	}

	private async request<T>(
		method: "GET" | "POST" | "PUT" | "DELETE",
		path: string,
		body?: unknown,
		contentType?: string,
	): Promise<T> {
		const init: RequestInit = { method, headers: this.buildHeaders(contentType) };
		if (body !== undefined) init.body = JSON.stringify(body);
		// SIO-725/729: fetchUpstream throws an upstreamError() carrying hostname,
		// content-type, status, and body preview on any error or non-JSON response.
		// Success path returns the Response; we own the JSON / 204 / empty-body
		// parse below.
		const response = await fetchUpstream(`${this.baseUrl}${path}`, init, {
			serviceLabel: "REST Proxy",
			baseUrl: this.baseUrl,
		});
		if (response.status === 204) return undefined as T;
		const text = await response.text();
		if (text.length === 0) return undefined as T;
		return JSON.parse(text) as T;
	}
}
