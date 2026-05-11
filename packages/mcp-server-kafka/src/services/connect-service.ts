// src/services/connect-service.ts

import type { AppConfig } from "../config/schemas.ts";
import { fetchUpstream } from "../lib/upstream-fetch.ts";

export interface ConnectClusterInfo {
	version: string;
	commit: string;
	kafka_cluster_id: string;
}

export interface ConnectConnectorState {
	state: "RUNNING" | "PAUSED" | "FAILED" | "UNASSIGNED" | "RESTARTING" | "DESTROYED";
	worker_id: string;
	trace?: string;
}

export interface ConnectConnectorStatus {
	name: string;
	type: "source" | "sink";
	connector: ConnectConnectorState;
	tasks: Array<ConnectConnectorState & { id: number }>;
}

export interface ConnectConnectorListEntry {
	name: string;
	status?: ConnectConnectorStatus;
	info?: {
		name: string;
		type: string;
		config: Record<string, string>;
		tasks: Array<{ connector: string; task: number }>;
	};
}

export class ConnectService {
	private readonly baseUrl: string;
	private readonly headers: Record<string, string>;

	constructor(config: AppConfig) {
		this.baseUrl = config.connect.url.replace(/\/$/, "");
		this.headers = {
			"Content-Type": "application/json",
			Accept: "application/json",
		};

		if (config.connect.apiKey && config.connect.apiSecret) {
			this.headers.Authorization = `Basic ${btoa(`${config.connect.apiKey}:${config.connect.apiSecret}`)}`;
		}
	}

	async probeReachability(timeoutMs = 5000): Promise<void> {
		// SIO-725/729: see restproxy-service.probeReachability comment.
		await fetchUpstream(
			`${this.baseUrl}/`,
			{ method: "GET", headers: this.headers, signal: AbortSignal.timeout(timeoutMs) },
			{ serviceLabel: "Kafka Connect", baseUrl: this.baseUrl },
		);
	}

	async getClusterInfo(): Promise<ConnectClusterInfo> {
		return this.request<ConnectClusterInfo>("GET", "/");
	}

	async listConnectors(): Promise<{
		connectors: Record<string, ConnectConnectorListEntry>;
		count: number;
	}> {
		// expand=status returns a map keyed by connector name with embedded status + info
		const result = await this.request<Record<string, ConnectConnectorListEntry>>(
			"GET",
			"/connectors?expand=status&expand=info",
		);
		return { connectors: result, count: Object.keys(result).length };
	}

	async getConnectorStatus(name: string): Promise<ConnectConnectorStatus> {
		return this.request<ConnectConnectorStatus>("GET", `/connectors/${encodeURIComponent(name)}/status`);
	}

	async getConnectorTaskStatus(name: string, taskId: number): Promise<ConnectConnectorState & { id: number }> {
		return this.request<ConnectConnectorState & { id: number }>(
			"GET",
			`/connectors/${encodeURIComponent(name)}/tasks/${taskId}/status`,
		);
	}

	async pauseConnector(name: string): Promise<void> {
		await this.request<void>("PUT", `/connectors/${encodeURIComponent(name)}/pause`);
	}

	async resumeConnector(name: string): Promise<void> {
		await this.request<void>("PUT", `/connectors/${encodeURIComponent(name)}/resume`);
	}

	async restartConnector(name: string, options?: { includeTasks?: boolean; onlyFailed?: boolean }): Promise<void> {
		const qs: string[] = [];
		if (options?.includeTasks !== undefined) qs.push(`includeTasks=${options.includeTasks}`);
		if (options?.onlyFailed !== undefined) qs.push(`onlyFailed=${options.onlyFailed}`);
		const path = `/connectors/${encodeURIComponent(name)}/restart${qs.length ? `?${qs.join("&")}` : ""}`;
		await this.request<void>("POST", path);
	}

	async restartConnectorTask(name: string, taskId: number): Promise<void> {
		await this.request<void>("POST", `/connectors/${encodeURIComponent(name)}/tasks/${taskId}/restart`);
	}

	async deleteConnector(name: string): Promise<void> {
		await this.request<void>("DELETE", `/connectors/${encodeURIComponent(name)}`);
	}

	private async request<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
		const init: RequestInit = { method, headers: this.headers };
		if (body !== undefined) init.body = JSON.stringify(body);

		// SIO-725/729: error / non-JSON paths surface via upstreamError() carrying
		// hostname, content-type, status, body preview.
		const response = await fetchUpstream(`${this.baseUrl}${path}`, init, {
			serviceLabel: "Kafka Connect",
			baseUrl: this.baseUrl,
		});

		// Connect returns 204 (DELETE) and 202 (pause/resume) with no body
		if (response.status === 204 || response.status === 202) return undefined as T;

		return (await response.json()) as T;
	}
}
