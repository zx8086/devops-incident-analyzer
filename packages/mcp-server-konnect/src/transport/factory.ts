// src/transport/factory.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config/index.js";
import { createContextLogger } from "../utils/mcp-logger.js";

const log = createContextLogger("transport");

import type { HttpTransportResult } from "./http.ts";
import { startHttpTransport } from "./http.ts";
import type { StdioTransportResult } from "./stdio.ts";
import { startStdioTransport } from "./stdio.ts";

export interface TransportResult {
	stdio?: StdioTransportResult;
	http?: HttpTransportResult;
	closeAll(): Promise<void>;
}

function splitCommaSeparated(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

export function resolveTransportMode(mode: string): { stdio: boolean; http: boolean } {
	switch (mode) {
		case "http":
			return { stdio: false, http: true };
		case "both":
			return { stdio: true, http: true };
		default:
			return { stdio: true, http: false };
	}
}

export async function createTransport(config: Config, serverFactory: () => McpServer): Promise<TransportResult> {
	const { stdio: useStdio, http: useHttp } = resolveTransportMode(config.transport.mode);
	log.info({ mode: config.transport.mode, stdio: useStdio, http: useHttp }, "Resolving transport mode");

	const result: TransportResult = {
		async closeAll() {
			if (result.http) await result.http.close();
			if (result.stdio) await result.stdio.close();
		},
	};

	if (useHttp) {
		const allowedOrigins = splitCommaSeparated(config.transport.allowedOrigins || undefined);
		result.http = await startHttpTransport(serverFactory, {
			port: config.transport.port,
			host: config.transport.host,
			path: config.transport.path,
			sessionMode: config.transport.sessionMode,
			idleTimeout: config.transport.idleTimeout,
			apiKey: config.transport.apiKey || undefined,
			allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : undefined,
		});
	}

	if (useStdio) {
		const server = serverFactory();
		result.stdio = await startStdioTransport(server);
	}

	log.info({ mode: config.transport.mode, stdio: useStdio, http: useHttp }, "Transport initialized");

	return result;
}
