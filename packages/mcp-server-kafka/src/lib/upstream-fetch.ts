// src/lib/upstream-fetch.ts
//
// SIO-725 + SIO-729: shared upstream fetch helper for the four HTTP-backed
// Confluent services (REST Proxy, Schema Registry, Kafka Connect, ksqlDB).
// Centralises hostname capture and the non-JSON content-type guard so the
// nginx HTML 503 leak (the SIO-716 incident shape) can never surface raw HTML
// to the LLM and the agent's correlation engine always sees a real hostname
// in the resulting ToolError.
//
// Service callers replace their inline fetch + status check with this helper
// and own only the typed JSON parse on the returned Response.

import { type UpstreamErrorMetadata, upstreamError } from "./errors.ts";

// SIO-729: content-types we accept as JSON. Confluent services use the
// application/vnd.* variants (e.g. application/vnd.kafka.v2+json,
// application/vnd.schemaregistry.v1+json) so a substring match against "json"
// is too lax (matches application/jsonp) and exact application/json is too
// strict. Match either application/json* or application/vnd.*+json.
function isJsonContentType(headerValue: string | null): boolean {
	if (!headerValue) return false;
	const lower = headerValue.toLowerCase();
	if (lower.startsWith("application/json")) return true;
	if (lower.startsWith("application/vnd.") && lower.includes("+json")) return true;
	return false;
}

// SIO-725: derive hostname once per baseUrl. Invalid URLs (shouldn't reach
// here -- AppConfig validates at boot) get null so callers don't crash but
// the structured field is omitted from the resulting error.
function safeHostname(baseUrl: string): string | undefined {
	try {
		return new URL(baseUrl).hostname;
	} catch {
		return undefined;
	}
}

// SIO-729: cap the body preview attached to errors so a several-MB HTML page
// can't bloat the agent's tool-error state or LangSmith traces.
const BODY_PREVIEW_MAX = 200;

function previewBody(body: string): string {
	const stripped = body.replace(/\s+/g, " ").trim();
	return stripped.length <= BODY_PREVIEW_MAX ? stripped : `${stripped.slice(0, BODY_PREVIEW_MAX)}...`;
}

export interface FetchUpstreamOptions {
	// Human label used in the thrown error message. Must match the regex strings
	// the agent's findConfluent5xxToolErrors fallback recognises:
	// "ksqlDB", "Kafka Connect", "Schema Registry", "REST Proxy".
	serviceLabel: string;
	// baseUrl of the service (e.g. https://schemaregistry.prd.shared-services.eu.pvh.cloud).
	// Hostname is parsed from this; the full URL is path + baseUrl by the caller.
	baseUrl: string;
}

// SIO-725 + SIO-729: fetch from a Confluent upstream. On any non-ok status OR
// any non-JSON content-type (including captive-portal 200s), throws an
// upstreamError carrying hostname + content-type + real HTTP status + body
// preview. Returns the Response only when the request was 2xx AND the
// content-type is JSON-ish (so the caller can safely .json()).
//
// Callers that handle empty success bodies (e.g. REST Proxy's 204 commit) must
// check response.status themselves; this helper only intervenes on error /
// non-JSON paths.
export async function fetchUpstream(url: string, init: RequestInit, opts: FetchUpstreamOptions): Promise<Response> {
	const { serviceLabel, baseUrl } = opts;
	const hostname = safeHostname(baseUrl);
	const response = await fetch(url, init);
	const contentType = response.headers.get("content-type");

	if (!response.ok) {
		// SIO-729: read body once, regardless of type; we attach a preview to the
		// error metadata so operators can diagnose. The agent does not see this
		// preview unless the caller explicitly forwards it.
		const bodyText = await response.text().catch(() => "");
		const metadata: UpstreamErrorMetadata = {
			hostname,
			upstreamContentType: contentType ?? undefined,
			statusCode: response.status,
			upstreamBodyPreview: bodyText ? previewBody(bodyText) : undefined,
		};
		// SIO-725: hostname inline in the message for log/transcript readability.
		// Even when hostname is undefined the message is still useful; structured
		// fields are the load-bearing path for the correlation engine.
		const hostnamePart = hostname ? ` (${hostname})` : "";
		const contentTypePart = contentType && !isJsonContentType(contentType) ? ` returned ${contentType}` : "";
		throw upstreamError(`${serviceLabel}${hostnamePart}${contentTypePart} error ${response.status}`, metadata);
	}

	// SIO-729: success path with a lying content-type (e.g. nginx captive page
	// returning 200 with text/html when we asked for JSON). Treat as upstream
	// error -- the response isn't what we asked for. Keep the real 200 status
	// in metadata so it's clear this isn't a 5xx.
	if (!isJsonContentType(contentType)) {
		// 204 No Content has no body and no content-type; the caller's success
		// path handles it. Only fail when there IS a content-type and it's wrong.
		if (response.status !== 204 || contentType !== null) {
			if (contentType !== null) {
				const bodyText = await response.text().catch(() => "");
				const metadata: UpstreamErrorMetadata = {
					hostname,
					upstreamContentType: contentType,
					statusCode: response.status,
					upstreamBodyPreview: bodyText ? previewBody(bodyText) : undefined,
				};
				const hostnamePart = hostname ? ` (${hostname})` : "";
				throw upstreamError(
					`${serviceLabel}${hostnamePart} returned non-JSON ${contentType} with status ${response.status}`,
					metadata,
				);
			}
		}
	}

	return response;
}
