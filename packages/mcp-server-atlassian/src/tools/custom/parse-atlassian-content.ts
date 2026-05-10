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
		return null;
	}

	for (const block of blocks) {
		if (block.text.startsWith(AUTH_REQUIRED_PREFIX)) {
			throw new AtlassianAuthRequiredError(block.text);
		}
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

	// Pin the first 200 chars of every block so future debugging has evidence of the actual
	// upstream shape rather than a generic "Failed to parse" warning.
	const samples = blocks.map((b) => b.text.slice(0, 200));
	opts.log.warn(
		{ ...opts.context, upstreamTool: opts.upstreamTool, blockCount: blocks.length, samples },
		`Failed to parse ${opts.upstreamTool} response`,
	);
	return null;
}
