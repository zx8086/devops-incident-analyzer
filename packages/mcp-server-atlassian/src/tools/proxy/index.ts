// src/tools/proxy/index.ts

import { buildToolErrorEnvelope } from "@devops-agent/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AtlassianMcpProxy, ProxyToolInfo } from "../../atlassian-client/index.js";
import { createContextLogger } from "../../utils/logger.js";
import { traceToolCall } from "../../utils/tracing.js";
import { CUSTOM_OVERRIDDEN_UPSTREAM_TOOLS } from "../custom/index.js";
import { isWriteTool } from "./write-tools.js";

const log = createContextLogger("proxy-tools");

const TOOL_PREFIX = "atlassian_";

// SIO-1159: CQL's `type` field accepts only content types; LLM callers point it at
// Jira with `type = issue` and get an opaque upstream 400 (run 270378e0). Reject it
// up front with a structured bad-input envelope steering to the JQL tool. Handles
// `type = issue`, `type = "issue"`, and `issue` anywhere inside `type IN (...)`,
// case-insensitively -- while ignoring occurrences inside quoted search text
// (e.g. `text ~ "type = issue"` is valid CQL and must pass through).
const CQL_TYPE_EQ_RE = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([\w-]+))/gi;
const CQL_TYPE_IN_RE = /\btype\s+in\s*\(([^)]*)\)/gi;

function quotedRanges(s: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	const re = /"[^"]*"|'[^']*'/g;
	let m: RegExpExecArray | null = re.exec(s);
	while (m !== null) {
		ranges.push([m.index, m.index + m[0].length]);
		m = re.exec(s);
	}
	return ranges;
}

function insideQuotes(pos: number, ranges: Array<[number, number]>): boolean {
	return ranges.some(([start, end]) => pos > start && pos < end);
}

function isIssueValue(value: string): boolean {
	const v = value
		.trim()
		.replace(/^["']|["']$/g, "")
		.toLowerCase();
	return v === "issue" || v === "issues";
}

function cqlTargetsIssueType(cql: string): boolean {
	const ranges = quotedRanges(cql);
	CQL_TYPE_EQ_RE.lastIndex = 0;
	let m: RegExpExecArray | null = CQL_TYPE_EQ_RE.exec(cql);
	while (m !== null) {
		if (!insideQuotes(m.index, ranges) && isIssueValue(m[1] ?? m[2] ?? m[3] ?? "")) return true;
		m = CQL_TYPE_EQ_RE.exec(cql);
	}
	CQL_TYPE_IN_RE.lastIndex = 0;
	m = CQL_TYPE_IN_RE.exec(cql);
	while (m !== null) {
		if (!insideQuotes(m.index, ranges) && (m[1] ?? "").split(",").some(isIssueValue)) return true;
		m = CQL_TYPE_IN_RE.exec(cql);
	}
	return false;
}

// Exported for tests. Returns the rejection envelope when the cql arg targets Jira
// issues, null otherwise.
export function cqlIssueTypeRejection(
	toolName: string,
	args: Record<string, unknown>,
): ReturnType<typeof buildToolErrorEnvelope> | null {
	if (toolName !== "searchConfluenceUsingCql") return null;
	const cql = args.cql;
	if (typeof cql !== "string" || !cqlTargetsIssueType(cql)) return null;
	return buildToolErrorEnvelope({
		kind: "bad-input",
		message: "CQL rejected before upstream: 'type = issue' is not a valid Confluence content type.",
		advice:
			"Confluence CQL `type` accepts only: space, user, page, blogpost, comment, attachment. " +
			"Jira issues are searched with JQL -- use atlassian_searchJiraIssuesUsingJql (or free-text atlassian_search) instead.",
	});
}

interface ProxyCallResult {
	content?: Array<{ type: string; text: string }>;
	isError?: boolean;
}

function jsonSchemaTypeToZod(key: string, prop: Record<string, unknown>): z.ZodTypeAny {
	const description = typeof prop.description === "string" ? prop.description : key;
	switch (prop.type) {
		case "string":
			return z.union([z.string(), z.number().transform(String)]).describe(description);
		case "number":
		case "integer":
			return z.number().describe(description);
		case "boolean":
			return z.boolean().describe(description);
		case "array":
			return z.array(z.unknown()).describe(description);
		default:
			return z.unknown().describe(description);
	}
}

function buildZodShapeFromJsonSchema(inputSchema: ProxyToolInfo["inputSchema"]): Record<string, z.ZodTypeAny> {
	const properties = inputSchema.properties ?? {};
	const required = new Set(inputSchema.required ?? []);
	const shape: Record<string, z.ZodTypeAny> = {};
	for (const [key, prop] of Object.entries(properties)) {
		if (key === "cloudId") continue;
		const field = jsonSchemaTypeToZod(key, (prop ?? {}) as Record<string, unknown>);
		shape[key] = required.has(key) ? field : field.optional();
	}
	return shape;
}

export interface ProxyRegistrationOptions {
	readOnly: boolean;
}

export function registerProxyTools(
	server: McpServer,
	proxy: AtlassianMcpProxy,
	remoteTools: ProxyToolInfo[],
	opts: ProxyRegistrationOptions,
): { registered: number; filtered: number } {
	const registered: string[] = [];
	let filtered = 0;

	for (const tool of remoteTools) {
		if (opts.readOnly && isWriteTool(tool.name)) {
			filtered++;
			continue;
		}
		// SIO-706: tools with a hand-written wrapper in custom/ override the generic proxy.
		// Registering both would throw at server.tool(name, ...) on the second call.
		if (CUSTOM_OVERRIDDEN_UPSTREAM_TOOLS.has(tool.name)) {
			continue;
		}
		const prefixedName = tool.name.startsWith(TOOL_PREFIX) ? tool.name : `${TOOL_PREFIX}${tool.name}`;
		const zodShape = buildZodShapeFromJsonSchema(tool.inputSchema);

		const handler = async (args: Record<string, unknown>) => {
			return traceToolCall(prefixedName, async () => {
				try {
					// SIO-1159: reject Jira-targeted CQL before the upstream round trip. The
					// envelope rides a RESOLVED result (isError:false) per the SIO-1087
					// convention so the agent classifies it structurally, not as a malfunction.
					const rejection = cqlIssueTypeRejection(tool.name, args);
					if (rejection) {
						return { content: [{ type: "text" as const, text: JSON.stringify(rejection) }] };
					}
					const result = (await proxy.callTool(tool.name, args)) as ProxyCallResult;
					const content = (result.content ?? []).map((c) => ({
						type: "text" as const,
						text: typeof c.text === "string" ? c.text : JSON.stringify(c),
					}));
					if (result.isError) return { content, isError: true };
					return { content };
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					log.error({ tool: prefixedName, error: message }, "Proxy tool call failed");
					return {
						content: [{ type: "text" as const, text: `Error: ${message}` }],
						isError: true,
					};
				}
			});
		};

		server.tool(prefixedName, tool.description, zodShape, handler);
		registered.push(prefixedName);
	}

	log.info({ registered: registered.length, filtered, readOnly: opts.readOnly }, "Atlassian proxy tools registered");
	return { registered: registered.length, filtered };
}
