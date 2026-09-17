// src/tools/proxy/index.ts

import { buildToolErrorEnvelope } from "@devops-agent/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AtlassianMcpProxy, ProxyToolInfo } from "../../atlassian-client/index.js";
import { createContextLogger } from "../../utils/logger.js";
import { traceToolCall } from "../../utils/tracing.js";
import { DESCRIPTION_TRUNCATE_BYTES, truncateLongString } from "../custom/get-jira-issue.js";
import { CUSTOM_OVERRIDDEN_UPSTREAM_TOOLS } from "../custom/index.js";
import { toolErrorResult } from "../error-envelope.js";
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
	// SIO-1183: kind bad-query (was bad-input, which maps to category "unknown" = degrading).
	// A rejected query string is the textbook bad-query do-not-blind-retry case.
	return buildToolErrorEnvelope({
		kind: "bad-query",
		message: "CQL rejected before upstream: 'type = issue' is not a valid Confluence content type.",
		advice:
			"Confluence CQL `type` accepts only: space, user, page, blogpost, comment, attachment. " +
			"Jira issues are searched with JQL -- use atlassian_searchJiraIssuesUsingJql (or free-text atlassian_search) instead.",
	});
}

// SIO-1774: a JQL search returns every matching issue's FULL description. On run f77ce7dd a
// well-formed search (maxResults 10, 8 issues) came back at 127 KB, because four of the hits were
// this agent's own earlier incident reports filed as tickets, 16-22 KB of markdown each. The
// single-issue tool has capped descriptions at 4 KB since SIO-706; search went through this
// generic proxy and never got the same treatment. A search result is a list to pick from: the
// head of each description is enough to choose, and atlassian_getJiraIssue returns the whole one.
// Anything that is not the expected JSON shape passes through untouched. Exported for tests.
export function slimJqlSearchText(toolName: string, text: string): string {
	if (toolName !== "searchJiraIssuesUsingJql") return text;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return text;
	}
	const issues = (parsed as { issues?: unknown } | null)?.issues;
	if (!Array.isArray(issues)) return text;
	const truncated: string[] = [];
	let strippedKeys = 0;
	for (const issue of issues as Array<{ key?: unknown; fields?: Record<string, unknown> }>) {
		strippedKeys += stripUiMetadata(issue);
		const description = issue?.fields?.description;
		if (!issue.fields || typeof description !== "string") continue;
		const slim = truncateLongString(description, DESCRIPTION_TRUNCATE_BYTES);
		if (slim === description) continue;
		issue.fields.description = slim;
		truncated.push(typeof issue.key === "string" ? issue.key : "?");
	}
	if (truncated.length === 0 && strippedKeys === 0) return text;
	return JSON.stringify({
		...(parsed as Record<string, unknown>),
		_projection: {
			descriptionTruncatedToBytes: DESCRIPTION_TRUNCATE_BYTES,
			truncatedIssues: truncated,
			droppedUiKeys: [...UI_METADATA_KEYS],
			hint: 'Descriptions are cut to their head in search results. Call atlassian_getJiraIssue with fields="*" for a full one.',
		},
	});
}

// Keys that exist for a browser, not a reader: on the real payload reporter, project, status and
// issuetype were ~3 KB per issue, nearly all of it avatar URL sets, icon URLs and REST self-links.
const UI_METADATA_KEYS = new Set(["avatarUrls", "iconUrl", "self", "expand"]);
function stripUiMetadata(node: unknown): number {
	if (!node || typeof node !== "object") return 0;
	if (Array.isArray(node)) return node.reduce<number>((n, child) => n + stripUiMetadata(child), 0);
	let removed = 0;
	const record = node as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (UI_METADATA_KEYS.has(key)) {
			delete record[key];
			removed += 1;
		} else {
			removed += stripUiMetadata(record[key]);
		}
	}
	return removed;
}

// SIO-1183: a Jira issue key fed to the Confluence page reader guarantees an upstream 400
// (observed live 07-21: getConfluencePage(pageId: "DEVOPS-1396"), SIO-1181 audit). Reject
// locally with steering instead of burning the round trip. Same resolved-result convention
// as the CQL guard. Exported for tests.
const JIRA_ISSUE_KEY_RE = /^[A-Z][A-Z0-9]*-\d+$/;

export function confluencePageIdRejection(
	toolName: string,
	args: Record<string, unknown>,
): ReturnType<typeof buildToolErrorEnvelope> | null {
	if (toolName !== "getConfluencePage") return null;
	const pageId = args.pageId;
	if (typeof pageId !== "string" || !JIRA_ISSUE_KEY_RE.test(pageId.trim())) return null;
	return buildToolErrorEnvelope({
		kind: "bad-input",
		message: `pageId rejected before upstream: "${pageId}" is a Jira issue key, not a Confluence page id.`,
		advice:
			"atlassian_getConfluencePage takes a numeric Confluence pageId (or tiny-link id). " +
			`For a Jira issue key like "${pageId}" use atlassian_getJiraIssue; for an ARI from atlassian_search results use atlassian_fetch.`,
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
		// Registering both would throw at registerTool(name, ...) on the second call.
		if (CUSTOM_OVERRIDDEN_UPSTREAM_TOOLS.has(tool.name)) {
			continue;
		}
		const prefixedName = tool.name.startsWith(TOOL_PREFIX) ? tool.name : `${TOOL_PREFIX}${tool.name}`;
		const zodShape = buildZodShapeFromJsonSchema(tool.inputSchema);

		const handler = async (args: Record<string, unknown>) => {
			return traceToolCall(prefixedName, async () => {
				try {
					// SIO-1159/SIO-1183: reject doomed calls before the upstream round trip. The
					// envelope rides a RESOLVED result (isError:false) per the SIO-1087
					// convention so the agent classifies it structurally, not as a malfunction.
					const rejection = cqlIssueTypeRejection(tool.name, args) ?? confluencePageIdRejection(tool.name, args);
					if (rejection) {
						return { content: [{ type: "text" as const, text: JSON.stringify(rejection) }] };
					}
					const result = (await proxy.callTool(tool.name, args)) as ProxyCallResult;
					const content = (result.content ?? []).map((c) => ({
						type: "text" as const,
						text: slimJqlSearchText(tool.name, typeof c.text === "string" ? c.text : JSON.stringify(c)),
					}));
					// Upstream isError prose passes through UNWRAPPED (SIO-1181 runbook): we cannot
					// classify upstream prose better than the agent's fallback.
					if (result.isError) return { content, isError: true };
					return { content };
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					log.error({ tool: prefixedName, error: message }, "Proxy tool call failed");
					// SIO-1183: envelope the locally-thrown path (-32001 timeouts, fetch failed)
					// so the agent stops classifying these as "unknown".
					return toolErrorResult(error);
				}
			});
		};

		// SIO-1416: registerTool config style (SDK v2 removes the .tool() sugar). No
		// annotations here -- the upstream surface is discovered at boot and we cannot
		// assert per-tool hints for tools we do not own; WRITE_TOOL_PATTERNS filtering
		// above remains the write gate.
		server.registerTool(prefixedName, { description: tool.description, inputSchema: zodShape }, handler);
		registered.push(prefixedName);
	}

	log.info({ registered: registered.length, filtered, readOnly: opts.readOnly }, "Atlassian proxy tools registered");
	return { registered: registered.length, filtered };
}
