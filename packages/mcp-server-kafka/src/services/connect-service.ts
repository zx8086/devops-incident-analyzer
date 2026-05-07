// src/services/connect-service.ts

import type { AppConfig } from "../config/schemas.ts";

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

	private async request<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
		const init: RequestInit = { method, headers: this.headers };
		if (body !== undefined) init.body = JSON.stringify(body);

		const response = await fetch(`${this.baseUrl}${path}`, init);

		if (!response.ok) {
			const errorBody = await response.text().catch(() => "Unknown error");
			throw new Error(`Kafka Connect error ${response.status}: ${errorBody}`);
		}

		// Some Connect endpoints (e.g., DELETE) return 204 No Content
		if (response.status === 204) return undefined as T;

		return (await response.json()) as T;
	}
}
