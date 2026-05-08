// src/services/restproxy-service.ts
import type { AppConfig } from "../config/schemas";

const REST_PROXY_V2_CONTENT_TYPE = "application/vnd.kafka.json.v2+json";

export class RestProxyService {
	private readonly baseUrl: string;
	private readonly headers: Record<string, string>;

	constructor(config: AppConfig) {
		this.baseUrl = config.restproxy.url.replace(/\/$/, "");
		this.headers = {
			"Content-Type": REST_PROXY_V2_CONTENT_TYPE,
			Accept: REST_PROXY_V2_CONTENT_TYPE,
		};
		if (config.restproxy.apiKey && config.restproxy.apiSecret) {
			this.headers.Authorization = `Basic ${btoa(`${config.restproxy.apiKey}:${config.restproxy.apiSecret}`)}`;
		}
	}

	async listTopics(): Promise<string[]> {
		return this.request<string[]>("GET", "/topics");
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
		return this.request("POST", `/topics/${encodeURIComponent(topic)}`, { records });
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

	private async request<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
		const init: RequestInit = { method, headers: this.headers };
		if (body !== undefined) init.body = JSON.stringify(body);
		const response = await fetch(`${this.baseUrl}${path}`, init);
		if (!response.ok) {
			const errorBody = await response.text().catch(() => "Unknown error");
			throw new Error(`REST Proxy error ${response.status}: ${errorBody}`);
		}
		if (response.status === 204) return undefined as T;
		const text = await response.text();
		if (text.length === 0) return undefined as T;
		return JSON.parse(text) as T;
	}
}
