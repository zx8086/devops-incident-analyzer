// src/transport/factory.ts

import type { IdentityCard, ReadinessSnapshot, TransportListenInfo } from "@devops-agent/shared";
import { type AgentCoreTransportResult, createBootstrapAdapter, startAgentCoreTransport } from "@devops-agent/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createContextLogger, logger } from "../utils/logger.js";
import type { HttpTransportResult } from "./http.js";
import { startHttpTransport } from "./http.js";
import type { StdioTransportResult } from "./stdio.js";
import { startStdioTransport } from "./stdio.js";

const log = createContextLogger("transport");

function splitCommaSeparated(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

export interface TransportConfig {
	mode: string;
	port: number;
	host: string;
	path: string;
	sessionMode: "stateless" | "stateful";
	idleTimeout: number;
	apiKey?: string;
	allowedOrigins?: string;
}

export interface TransportResult {
	stdio?: StdioTransportResult;
	http?: HttpTransportResult;
	agentcore?: AgentCoreTransportResult;
	listen?: TransportListenInfo;
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
	// SIO-780: optional readiness probe wired into HTTP transport's /ready route.
	// Stdio and AgentCore transports ignore this argument (no HTTP surface to
	// register the route on; AgentCore's framework health is authoritative).
	readinessProbe?: () => Promise<ReadinessSnapshot>,
	// SIO-780: identity card threaded from createMcpApplication into /identity route
	identityCard?: IdentityCard,
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
			readinessProbe,
			identityCard,
		});
	}

	if (useStdio) {
		const server = serverFactory();
		result.stdio = await startStdioTransport(server);
	}

	log.info(
		{
			mode: config.mode,
			stdio: useStdio,
			http: useHttp,
			agentcore: useAgentCore,
		},
		"Transport initialized",
	);

	// Surface the bound listener so the bootstrap logs a uniform startup line.
	if (result.http) {
		result.listen = {
			mode: "http",
			port: result.http.server.port,
			url: `http://${config.host}:${result.http.server.port}${config.path}`,
		};
	} else if (result.agentcore) {
		result.listen = {
			mode: "agentcore",
			port: config.port,
			url: `http://${config.host}:${config.port}${config.path}`,
		};
	} else {
		result.listen = { mode: "stdio" };
	}

	return result;
}
