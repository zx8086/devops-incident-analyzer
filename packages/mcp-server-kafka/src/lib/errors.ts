// src/lib/errors.ts

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// SIO-725/728/729: optional upstream metadata carried alongside the message.
// Populated by fetchUpstream() when an HTTP-backed Confluent service errors out,
// then forwarded by wrap.ts into the ResponseBuilder ---STRUCTURED--- sentinel
// so the agent's correlation engine can read hostname/contentType/status as
// first-class fields instead of regexing the message.
export interface UpstreamErrorMetadata {
	hostname?: string;
	upstreamContentType?: string;
	statusCode?: number;
	upstreamBodyPreview?: string;
}

export class KafkaToolError extends Error {
	public readonly hostname?: string;
	public readonly upstreamContentType?: string;
	public readonly statusCode?: number;
	public readonly upstreamBodyPreview?: string;

	constructor(
		message: string,
		public readonly code: ErrorCode,
		public readonly details?: Record<string, unknown>,
		upstream?: UpstreamErrorMetadata,
	) {
		super(message);
		this.name = "KafkaToolError";
		if (upstream) {
			this.hostname = upstream.hostname;
			this.upstreamContentType = upstream.upstreamContentType;
			this.statusCode = upstream.statusCode;
			this.upstreamBodyPreview = upstream.upstreamBodyPreview;
		}
	}

	toMcpError(): McpError {
		return new McpError(this.code, this.message);
	}
}

export function invalidParams(message: string, details?: Record<string, unknown>): KafkaToolError {
	return new KafkaToolError(message, ErrorCode.InvalidParams, details);
}

export function invalidRequest(message: string, details?: Record<string, unknown>): KafkaToolError {
	return new KafkaToolError(message, ErrorCode.InvalidRequest, details);
}

export function internalError(message: string, details?: Record<string, unknown>): KafkaToolError {
	return new KafkaToolError(message, ErrorCode.InternalError, details);
}

// SIO-725 + SIO-729: build a KafkaToolError that carries upstream metadata.
// Caller has already composed the human-readable message (with hostname inline
// for log/transcript readability); this factory just attaches the structured
// metadata so wrap.ts can forward it via the sentinel. service names match the
// strings findConfluent5xxToolErrors regex falls back on: "ksqlDB",
// "Kafka Connect", "Schema Registry", "REST Proxy".
export function upstreamError(message: string, metadata: UpstreamErrorMetadata): KafkaToolError {
	return new KafkaToolError(message, ErrorCode.InternalError, undefined, metadata);
}

export function normalizeError(error: unknown): McpError {
	if (error instanceof McpError) return error;
	if (error instanceof KafkaToolError) return error.toMcpError();
	if (error instanceof z.ZodError) {
		const message = error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
		return new McpError(ErrorCode.InvalidParams, message);
	}
	const message = error instanceof Error ? error.message : String(error);
	return new McpError(ErrorCode.InternalError, message);
}
