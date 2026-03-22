// src/transport/factory.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { splitCommaSeparated } from "../config/helpers.ts";
import type { AppConfig } from "../config/schemas.ts";
import { getLogger } from "../logging/container.ts";
import type { HttpTransportResult } from "./http.ts";
import { startHttpTransport } from "./http.ts";
import type { StdioTransportResult } from "./stdio.ts";
import { startStdioTransport } from "./stdio.ts";

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
  config: AppConfig,
  serverFactory: () => McpServer,
): Promise<TransportResult> {
  const logger = getLogger();
  const { stdio: useStdio, http: useHttp } = resolveTransportMode(config.transport.mode);

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

  logger.info("Transport initialized", {
    mode: config.transport.mode,
    stdio: useStdio,
    http: useHttp,
  });

  return result;
}
