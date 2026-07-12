// src/lib/classifyElasticError.ts
// SIO-1087: classify an Elasticsearch SDK error on its DOCUMENTED structured type
// (error.meta.body.error.type) and HTTP status (error.meta.statusCode) instead of regexing the
// message. The SDK copies `.type` into `.message`, so today's message.includes(...) works only by
// accident; reading the structured field is lossless and robust.

import type { ToolErrorKind } from "@devops-agent/shared";
import { errors } from "@elastic/elasticsearch";

const { ResponseError, TimeoutError, ConnectionError } = errors;

// ES error `type` -> shared kind. bad-query = the DSL/query is malformed (fix the query, e.g. the
// two-field range clause); not-found = the index does not exist; auth-denied = security_exception;
// throttled = circuit breaker. search_phase_execution_exception wraps the real cause in root_cause.
const ES_TYPE_TO_KIND: Record<string, ToolErrorKind> = {
	x_content_parse_exception: "bad-query",
	parsing_exception: "bad-query",
	query_shard_exception: "bad-query",
	index_not_found_exception: "not-found",
	security_exception: "auth-denied",
	circuit_breaking_exception: "throttled",
};

interface EsErrorCause {
	type?: string;
	root_cause?: Array<{ type?: string }>;
	caused_by?: { type?: string };
}

function readEsErrorType(err: unknown): string | undefined {
	if (!(err instanceof ResponseError)) return undefined;
	const body = (err.meta as { body?: unknown } | undefined)?.body;
	if (body == null || typeof body !== "object") return undefined;
	const cause = (body as { error?: unknown }).error;
	if (cause == null || typeof cause !== "object") return undefined;
	const c = cause as EsErrorCause;
	// search_phase_execution_exception hides the real reason in root_cause[0] / caused_by.
	return c.type ?? c.root_cause?.[0]?.type ?? c.caused_by?.type;
}

function readStatusCode(err: unknown): number | undefined {
	if (err instanceof ResponseError) {
		const sc = (err.meta as { statusCode?: unknown } | undefined)?.statusCode;
		return typeof sc === "number" ? sc : undefined;
	}
	return undefined;
}

// Returns the shared kind for a caught Elasticsearch error. Classification is by structured type /
// status, never message text; "unknown" when it is not a recognizable ES error.
export function classifyElasticError(error: unknown): ToolErrorKind {
	if (error instanceof TimeoutError) return "timeout";
	if (error instanceof ConnectionError) return "network";

	const type = readEsErrorType(error);
	if (type && ES_TYPE_TO_KIND[type]) return ES_TYPE_TO_KIND[type];

	// Fall back to HTTP status when the structured type is absent/unmapped.
	const status = readStatusCode(error);
	if (status === 401 || status === 403) return "auth-denied";
	if (status === 404) return "not-found";
	if (status === 429) return "throttled";
	if (status !== undefined && status >= 500 && status < 600) return "server-error";
	if (status !== undefined && status >= 400 && status < 500) return "bad-query";
	return "unknown";
}

export function esStatusCode(error: unknown): number | undefined {
	return readStatusCode(error);
}
