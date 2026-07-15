// src/tools/custom/parse-atlassian-content.ts
//
// SIO-704: shared parser for the {content: [{type, text}, ...]} envelope returned by the
// Atlassian MCP proxy. Three custom wrappers used to JSON.parse the first text block and
// fall back to empty results on any failure -- which silently swallowed both genuine errors
// and the ATLASSIAN_AUTH_REQUIRED signal emitted by atlassian-client/proxy.ts:185-189.

interface McpTextContent {
	type: string;
	text: string;
}

interface McpToolResult {
	content?: unknown;
	isError?: boolean;
}

const AUTH_REQUIRED_PREFIX = "ATLASSIAN_AUTH_REQUIRED";

export class AtlassianAuthRequiredError extends Error {
	readonly code = "ATLASSIAN_AUTH_REQUIRED";
	constructor(message: string) {
		super(message);
		this.name = "AtlassianAuthRequiredError";
	}
}

// SIO-1116: the upstream signalled a failure (result.isError) whose text block is not JSON --
// e.g. a `-32602 Input validation error` from an upstream schema change. Previously the parser
// returned null here, which every caller treats as an empty result, so a broken tool call
// silently read as "no data" for a whole run. Throwing surfaces it: each tool's registration
// try/catch converts it into a real { isError: true } tool result the LLM can see and react to.
export class AtlassianUpstreamError extends Error {
	readonly code = "ATLASSIAN_UPSTREAM_ERROR";
	constructor(
		readonly upstreamTool: string,
		message: string,
	) {
		super(message);
		this.name = "AtlassianUpstreamError";
	}
}

interface ParseLogger {
	warn: (meta: Record<string, unknown>, msg: string) => void;
}

interface ParseOptions {
	upstreamTool: string;
	context: Record<string, unknown>;
	log: ParseLogger;
}

function isTextContent(c: unknown): c is McpTextContent {
	return (
		typeof c === "object" &&
		c !== null &&
		"type" in c &&
		(c as { type: unknown }).type === "text" &&
		"text" in c &&
		typeof (c as { text: unknown }).text === "string"
	);
}

// Returns the parsed JSON object on success, or null when no text block parses to an object.
// Throws AtlassianAuthRequiredError when any text block carries the auth-required signal so
// the caller surfaces the failure to the LLM instead of returning empty matches.
export function parseAtlassianTextContent<T>(result: McpToolResult, opts: ParseOptions): T | null {
	const blocks = Array.isArray(result.content) ? result.content.filter(isTextContent) : [];

	if (blocks.length === 0) {
		opts.log.warn(
			{ ...opts.context, upstreamTool: opts.upstreamTool, isError: result.isError },
			"Atlassian response had no text content blocks",
		);
		// SIO-1116: an isError result with no text blocks is a failure, not an empty match set.
		if (result.isError) {
			throw new AtlassianUpstreamError(opts.upstreamTool, `Upstream ${opts.upstreamTool} error: no content blocks`);
		}
		return null;
	}

	for (const block of blocks) {
		if (block.text.startsWith(AUTH_REQUIRED_PREFIX)) {
			throw new AtlassianAuthRequiredError(block.text);
		}
	}

	// SIO-1116: short-circuit an upstream failure BEFORE the JSON-parse loop. If an isError result
	// carries a body that happens to be valid JSON (e.g. a structured `{error: ...}` envelope from
	// the upstream), the loop below would return it as T and the caller would treat the failure as
	// successful data. Throw here so every error result surfaces, JSON or not. (The auth-required
	// signal above is a more specific isError case and keeps its own typed error.) Pin the first
	// 200 chars of every block so debugging has evidence of the actual upstream shape.
	if (result.isError) {
		const samples = blocks.map((b) => b.text.slice(0, 200));
		throw new AtlassianUpstreamError(opts.upstreamTool, `Upstream ${opts.upstreamTool} error: ${samples.join(" | ")}`);
	}

	for (const block of blocks) {
		try {
			const parsed = JSON.parse(block.text) as unknown;
			if (typeof parsed === "object" && parsed !== null) {
				return parsed as T;
			}
		} catch {
			// try the next block
		}
	}

	// A successful (isError falsy) response we simply can't parse degrades gracefully to null.
	// Pin the samples so a future shape drift has evidence rather than a generic warning.
	const samples = blocks.map((b) => b.text.slice(0, 200));
	opts.log.warn(
		{ ...opts.context, upstreamTool: opts.upstreamTool, blockCount: blocks.length, samples },
		`Failed to parse ${opts.upstreamTool} response`,
	);
	return null;
}
