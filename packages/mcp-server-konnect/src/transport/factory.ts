// src/transport/factory.ts
import { type AgentCoreTransportResult, createBootstrapAdapter, startAgentCoreTransport } from "@devops-agent/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TransportConfig } from "../config/index.js";
import { createContextLogger, logger } from "../utils/logger.js";

const log = createContextLogger("transport");

import type { HttpTransportResult } from "./http.ts";
import { startHttpTransport } from "./http.ts";
import type { StdioTransportResult } from "./stdio.ts";
import { startStdioTransport } from "./stdio.ts";

export interface TransportResult {
	stdio?: StdioTransportResult;
	http?: HttpTransportResult;
	agentcore?: AgentCoreTransportResult;
	closeAll(): Promise<void>;
}

function splitCommaSeparated(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

export function resolveTransportMode(mode: string): { stdio: boolean; http: boolean; agentcore: boolean } {
	switch (mode) {
		case "http":
			return { stdio: false, http: true, agentcore: false };
		case "both":
			return { stdio: true, http: true, agentcore: false };
		case "agentcore":
			return { stdio: false, http: false, agentcore: true };
		default:
			return { stdio: true, http: false, agentcore: false };
	}
}

export async function createTransport(
	config: TransportConfig,
	serverFactory: () => McpServer,
): Promise<TransportResult> {
	const { stdio: useStdio, http: useHttp, agentcore: useAgentCore } = resolveTransportMode(config.mode);
	log.info({ mode: config.mode, stdio: useStdio, http: useHttp, agentcore: useAgentCore }, "Resolving transport mode");

	const result: TransportResult = {
		async closeAll() {
			if (result.agentcore) await result.agentcore.close();
			if (result.http) await result.http.close();
			if (result.stdio) await result.stdio.close();
		},
	};

	if (useAgentCore) {
		result.agentcore = await startAgentCoreTransport(serverFactory, createBootstrapAdapter(logger), {
			port: config.port,
			host: config.host,
			path: config.path,
		});
	}

	if (useHttp) {
		const allowedOrigins = splitCommaSeparated(config.allowedOrigins || undefined);
		result.http = await startHttpTransport(serverFactory, {
			port: config.port,
			host: config.host,
			path: config.path,
			sessionMode: config.sessionMode,
			idleTimeout: config.idleTimeout,
			apiKey: config.apiKey || undefined,
			allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : undefined,
		});
	}

	if (useStdio) {
		const server = serverFactory();
		result.stdio = await startStdioTransport(server);
	}

	log.info({ mode: config.mode, stdio: useStdio, http: useHttp, agentcore: useAgentCore }, "Transport initialized");

	return result;
}
