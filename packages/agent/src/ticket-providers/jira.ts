// agent/src/ticket-providers/jira.ts
import type { CreateTicketRequest, TicketAssignee, TicketIssueType, TicketProject } from "@devops-agent/shared";
import { z } from "zod";
import { createBridgeToolInvoker } from "./bridge-invoker.ts";
import { type McpToolInvoker, type TicketProvider, TicketProviderError } from "./types.ts";

const CREATE_TOOL = "atlassian_createJiraIssue";
const PROJECTS_TOOL = "atlassian_getVisibleJiraProjects";
const LOOKUP_TOOL = "atlassian_lookupJiraAccountId";
const ISSUE_TYPES_TOOL = "atlassian_getJiraProjectIssueTypesMetadata";

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_RESULTS = 50;

// Response shapes pinned live against the Rovo upstream (SIO-1124 step 1;
// trimmed captures in __fixtures__/). z.object strips unknown keys, so upstream
// additions don't break parsing; missing pinned fields fail loudly instead.
const VisibleProjectsResponseSchema = z.object({
	values: z.array(z.object({ id: z.string(), key: z.string(), name: z.string() })),
});
const LookupAccountResponseSchema = z.object({
	data: z.object({
		users: z.object({
			users: z.array(z.object({ accountId: z.string(), displayName: z.string() })),
		}),
	}),
});
const IssueTypesResponseSchema = z.object({
	issueTypes: z.array(z.object({ id: z.string(), name: z.string(), subtask: z.boolean() })),
});
const CreateIssueResponseSchema = z.object({ key: z.string() });

// Single place that maps the provider-agnostic request onto the pinned
// atlassian_createJiraIssue schema (required: projectKey, issueTypeName,
// summary; assignee travels as assignee_account_id; contentFormat "markdown"
// keeps the description a plain string).
export function buildCreateIssueArgs(req: CreateTicketRequest): Record<string, unknown> {
	return {
		projectKey: req.projectKey,
		issueTypeName: req.issueTypeName,
		summary: req.summary,
		description: req.description,
		contentFormat: "markdown",
		...(req.assigneeId ? { assignee_account_id: req.assigneeId } : {}),
	};
}

interface CacheEntry<T> {
	at: number;
	value: T;
}

export interface JiraTicketProviderOptions {
	invoker?: McpToolInvoker;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
}

export function createJiraTicketProvider(options: JiraTicketProviderOptions = {}): TicketProvider {
	const invoker = options.invoker ?? createBridgeToolInvoker("atlassian");
	const env = options.env ?? process.env;
	const now = options.now ?? Date.now;

	const projectsCache = new Map<string, CacheEntry<TicketProject[]>>();
	const issueTypesCache = new Map<string, CacheEntry<TicketIssueType[]>>();

	function fresh<T>(entry: CacheEntry<T> | undefined): T | undefined {
		return entry && now() - entry.at < CACHE_TTL_MS ? entry.value : undefined;
	}

	async function call<T>(
		toolName: string,
		args: Record<string, unknown>,
		schema: z.ZodType<T>,
		what: string,
	): Promise<T> {
		let text: string;
		try {
			text = await invoker.invoke(toolName, args);
		} catch (err) {
			if (err instanceof TicketProviderError) throw err;
			throw new TicketProviderError(`Jira ${what} failed: ${err instanceof Error ? err.message : String(err)}`, {
				cause: err,
			});
		}
		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch {
			throw new TicketProviderError(`Jira ${what} returned a non-JSON payload: ${text.slice(0, 200)}`);
		}
		const parsed = schema.safeParse(json);
		if (!parsed.success) {
			throw new TicketProviderError(`Jira ${what} returned an unexpected shape: ${parsed.error.message}`);
		}
		return parsed.data;
	}

	return {
		id: "jira",
		label: "Jira",
		// Self-gating: false while the Atlassian MCP is disconnected or running
		// read-only (the create tool is filtered out at registration there).
		isAvailable() {
			return invoker.hasTool(CREATE_TOOL);
		},
		async listProjects(query) {
			const cacheKey = query ?? "";
			const cached = fresh(projectsCache.get(cacheKey));
			if (cached) return cached;
			const parsed = await call(
				PROJECTS_TOOL,
				// action "create" filters to projects the caller may create issues in.
				{ action: "create", maxResults: MAX_RESULTS, ...(query ? { searchString: query } : {}) },
				VisibleProjectsResponseSchema,
				"project list",
			);
			projectsCache.set(cacheKey, { at: now(), value: parsed.values });
			return parsed.values;
		},
		async searchAssignees(query) {
			const parsed = await call(LOOKUP_TOOL, { searchString: query }, LookupAccountResponseSchema, "assignee lookup");
			return parsed.data.users.users.map((u): TicketAssignee => ({ id: u.accountId, displayName: u.displayName }));
		},
		async listIssueTypes(projectKey) {
			const cached = fresh(issueTypesCache.get(projectKey));
			if (cached) return cached;
			const parsed = await call(
				ISSUE_TYPES_TOOL,
				{ projectIdOrKey: projectKey, maxResults: MAX_RESULTS },
				IssueTypesResponseSchema,
				"issue type list",
			);
			const issueTypes = parsed.issueTypes
				.filter((t) => !t.subtask)
				.map((t): TicketIssueType => ({ id: t.id, name: t.name }));
			issueTypesCache.set(projectKey, { at: now(), value: issueTypes });
			return issueTypes;
		},
		async createTicket(req) {
			const parsed = await call(CREATE_TOOL, buildCreateIssueArgs(req), CreateIssueResponseSchema, "issue create");
			const site = env.ATLASSIAN_SITE_NAME;
			return { key: parsed.key, ...(site ? { url: `https://${site}.atlassian.net/browse/${parsed.key}` } : {}) };
		},
	};
}
