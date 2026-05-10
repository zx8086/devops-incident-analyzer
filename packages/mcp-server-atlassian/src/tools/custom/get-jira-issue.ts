// src/tools/custom/get-jira-issue.ts
//
// SIO-706: a leaner getJiraIssue that ships only the fields the runbook needs.
// The upstream getJiraIssue tool (Atlassian Rovo MCP) returns the full Jira
// issue (60-122KB observed), which exceeds SUBAGENT_TOOL_RESULT_CAP_BYTES
// (default 64KB) and gets text-truncated, losing the second half of the
// payload regardless of which fields the agent actually needed.
//
// This wrapper:
// - exposes a `fields` parameter ("triage" preset, explicit list, or "*")
// - forwards `fields` to the upstream call (Jira REST honors `?fields=`)
// - applies client-side projection in case the upstream proxy ignores it
// - emits a `_projection` sentinel so the LLM sees what it's looking at

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AtlassianMcpProxy } from "../../atlassian-client/index.js";
import { createContextLogger } from "../../utils/logger.js";
import { traceToolCall } from "../../utils/tracing.js";
import { parseAtlassianTextContent } from "./parse-atlassian-content.js";

const log = createContextLogger("get-jira-issue");

// Triage preset: high-signal fields that fit comfortably under the 64KB cap
// even for issues with long descriptions. Custom severity field included
// because find-linked-incidents already reads it.
export const TRIAGE_FIELDS = [
	"summary",
	"status",
	"priority",
	"customfield_severity",
	"assignee",
	"reporter",
	"created",
	"updated",
	"resolutiondate",
	"labels",
	"components",
	"issuetype",
	"description",
] as const;

const DESCRIPTION_TRUNCATE_BYTES = 4_096;

export const InputSchema = z.object({
	issueIdOrKey: z.string().describe("Jira issue key (e.g. INC-123) or numeric ID"),
	fields: z
		.union([z.string(), z.array(z.string())])
		.optional()
		.describe(
			'Field projection. Default: triage preset (summary, status, priority, severity, assignee, reporter, created, updated, resolutiondate, labels, components, issuetype, description). Pass an array of field names, a comma-separated string, or "*" for the full issue. Be aware: "*" frequently exceeds the 64KB tool-result cap and triggers truncation.',
		),
});

export type GetJiraIssueInput = z.infer<typeof InputSchema>;

interface JiraIssueResponse {
	id?: string;
	key?: string;
	self?: string;
	fields?: Record<string, unknown>;
	renderedFields?: Record<string, unknown>;
}

// Normalize the fields parameter into a list of field names. "*" means "everything".
function normalizeFields(input: GetJiraIssueInput["fields"]): string[] | "*" {
	if (input === undefined) return [...TRIAGE_FIELDS];
	if (typeof input === "string") {
		const trimmed = input.trim();
		if (trimmed === "*" || trimmed === "all") return "*";
		return trimmed
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	}
	if (input.length === 1 && (input[0] === "*" || input[0] === "all")) return "*";
	return input;
}

// Truncate a string field to a byte budget with a visible marker. Used for
// `description` which can be many KB of free-form text.
function truncateLongString(value: unknown, byteBudget: number): unknown {
	if (typeof value !== "string") return value;
	const bytes = Buffer.byteLength(value, "utf8");
	if (bytes <= byteBudget) return value;
	// Slice in characters, leave ~80 bytes of marker space.
	const head = value.slice(0, byteBudget - 80);
	return `${head}\n... [truncated, ${bytes} bytes total]`;
}

// Project the upstream response onto the requested field set. When fields="*"
// the response is returned as-is. When fields is a list, only those keys are
// kept under fields, and a _projection sentinel is added at the top level.
function projectIssue(parsed: JiraIssueResponse, fields: string[] | "*"): unknown {
	if (fields === "*") return parsed;
	const out: Record<string, unknown> = {
		id: parsed.id,
		key: parsed.key,
		self: parsed.self,
	};
	const projected: Record<string, unknown> = {};
	const upstreamFields = parsed.fields ?? {};
	for (const fieldName of fields) {
		if (fieldName in upstreamFields) {
			projected[fieldName] =
				fieldName === "description"
					? truncateLongString(upstreamFields[fieldName], DESCRIPTION_TRUNCATE_BYTES)
					: upstreamFields[fieldName];
		}
	}
	out.fields = projected;
	out._projection = {
		applied: fields,
		droppedFromFields: Object.keys(upstreamFields).filter((k) => !fields.includes(k)),
		hint: 'Pass fields="*" or an explicit list to retrieve dropped fields.',
	};
	return out;
}

export async function getJiraIssue(proxy: AtlassianMcpProxy, input: GetJiraIssueInput): Promise<unknown> {
	const fields = normalizeFields(input.fields);
	const upstreamArgs: Record<string, unknown> = {
		issueIdOrKey: input.issueIdOrKey,
	};
	// Only include fields when narrowing -- "*" means "let the upstream decide"
	// (default behaviour, safest for compatibility with Rovo's schema).
	if (fields !== "*") {
		upstreamArgs.fields = fields;
	}

	log.info(
		{ issueIdOrKey: input.issueIdOrKey, fieldsProjection: fields === "*" ? "*" : fields.length },
		"Fetching Jira issue",
	);

	const result = await proxy.callTool("getJiraIssue", upstreamArgs);

	const parsed = parseAtlassianTextContent<JiraIssueResponse>(result as { content?: unknown }, {
		upstreamTool: "getJiraIssue",
		context: { issueIdOrKey: input.issueIdOrKey },
		log,
	});
	if (!parsed) {
		return {
			id: undefined,
			key: input.issueIdOrKey,
			fields: {},
			_projection: {
				applied: fields === "*" ? "*" : fields,
				error: "Upstream returned no parseable content",
			},
		};
	}

	return projectIssue(parsed, fields);
}

export function registerGetJiraIssue(server: McpServer, proxy: AtlassianMcpProxy): void {
	server.tool(
		"atlassian_getJiraIssue",
		'Fetch a Jira issue by key or ID. Returns a triage-sized projection by default (summary, status, priority, severity, assignee, reporter, dates, labels, components, issuetype, description truncated to ~4KB). Pass `fields` to narrow further or pass `"*"` for the full issue (frequently exceeds the 64KB tool-result cap).',
		{
			issueIdOrKey: InputSchema.shape.issueIdOrKey,
			fields: InputSchema.shape.fields,
		},
		async (args) => {
			return traceToolCall("atlassian_getJiraIssue", async () => {
				try {
					const output = await getJiraIssue(proxy, {
						issueIdOrKey: args.issueIdOrKey,
						fields: args.fields,
					});
					return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					log.error({ error: message }, "atlassian_getJiraIssue tool failed");
					return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
				}
			});
		},
	);
}
