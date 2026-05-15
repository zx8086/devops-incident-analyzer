// src/transport/factory.ts
import { type AgentCoreTransportResult, createBootstrapAdapter, startAgentCoreTransport } from "@devops-agent/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TransportConfig } from "../config/schemas.ts";
import { createContextLogger, logger } from "../utils/logger.ts";
import { type HttpTransportResult, startHttpTransport } from "./http.ts";
import { type StdioTransportResult, startStdioTransport } from "./stdio.ts";

const log = createContextLogger("transport");

export interface TransportResult {
	stdio?: StdioTransportResult;
	http?: HttpTransportResult;
	agentcore?: AgentCoreTransportResult;
	closeAll(): Promise<void>;
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
	const modes = resolveTransportMode(config.mode);
	log.info({ mode: config.mode, ...modes }, "Resolving transport mode");

	const result: TransportResult = {
		async closeAll() {
			if (result.agentcore) await result.agentcore.close();
			if (result.http) await result.http.close();
			if (result.stdio) await result.stdio.close();
		},
	};

	if (modes.agentcore) {
		result.agentcore = await startAgentCoreTransport(serverFactory, createBootstrapAdapter(logger), {
			port: config.port,
			host: config.host,
			path: config.path,
		});
	}

	if (modes.http) {
		result.http = await startHttpTransport(serverFactory, {
			port: config.port,
			host: config.host,
			path: config.path,
		});
	}

	if (modes.stdio) {
		const server = serverFactory();
		result.stdio = await startStdioTransport(server);
	}

	log.info({ mode: config.mode, ...modes }, "Transport initialized");
	return result;
}
