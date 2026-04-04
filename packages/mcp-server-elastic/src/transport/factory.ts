// src/transport/factory.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "../utils/logger.js";
import type { HttpTransportResult } from "./http.js";
import { startHttpTransport } from "./http.js";
import type { StdioTransportResult } from "./stdio.js";
import { startStdioTransport } from "./stdio.js";

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
	closeAll(): Promise<void>;
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

export async function createTransport(
	config: TransportConfig,
	serverFactory: () => McpServer,
): Promise<TransportResult> {
	const { stdio: useStdio, http: useHttp } = resolveTransportMode(config.mode);
	logger.info({ mode: config.mode, stdio: useStdio, http: useHttp }, "Resolving transport mode");

	const result: TransportResult = {
		async closeAll() {
			if (result.http) await result.http.close();
			if (result.stdio) await result.stdio.close();
		},
	};

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

	logger.info(
		{
			mode: config.mode,
			stdio: useStdio,
			http: useHttp,
		},
		"Transport initialized",
	);

	return result;
}
