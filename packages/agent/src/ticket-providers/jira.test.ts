// agent/src/ticket-providers/jira.test.ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildCreateIssueArgs, createJiraTicketProvider } from "./jira.ts";
import type { McpToolInvoker } from "./types.ts";
import { TicketProviderError } from "./types.ts";

const fixture = (name: string) => Bun.file(join(import.meta.dir, "__fixtures__", name)).text();

const projectsFixture = await fixture("visible-projects.json");
const lookupFixture = await fixture("lookup-account-id.json");
const issueTypesFixture = await fixture("issue-types.json");
const epicSearchFixture = await fixture("epic-search.json");
const createFixture = await fixture("create-issue.json");

interface RecordedCall {
	toolName: string;
	args: Record<string, unknown>;
}

function fakeInvoker(
	responses: Record<string, string | Error | Array<string | Error>>,
	calls: RecordedCall[] = [],
): McpToolInvoker {
	return {
		hasTool: (toolName) => toolName in responses,
		invoke: (toolName, args) => {
			calls.push({ toolName, args });
			const entry = responses[toolName];
			const response = Array.isArray(entry) ? entry.shift() : entry;
			if (response === undefined) return Promise.reject(new Error(`no fake response for ${toolName}`));
			if (response instanceof Error) return Promise.reject(response);
			return Promise.resolve(response);
		},
	};
}

const singlePageProjects = JSON.stringify({
	isLast: true,
	values: [{ id: "10062", key: "DEVOPS", name: "DevOpsProject" }],
});

describe("isAvailable", () => {
	test("true when the create tool is registered on the bridge", () => {
		const provider = createJiraTicketProvider({ invoker: fakeInvoker({ atlassian_createJiraIssue: "{}" }) });
		expect(provider.isAvailable()).toBe(true);
	});

	test("false when the create tool is missing (read-only or disconnected MCP)", () => {
		const provider = createJiraTicketProvider({ invoker: fakeInvoker({}) });
		expect(provider.isAvailable()).toBe(false);
	});
});

describe("listProjects", () => {
	test("follows isLast pagination and maps the pinned values shape", async () => {
		const calls: RecordedCall[] = [];
		const pageTwo = JSON.stringify({
			isLast: true,
			values: [{ id: "10345", key: "JIRA", name: "PVH ECOM JIRA Unification" }],
		});
		const provider = createJiraTicketProvider({
			// The real fixture is page one (isLast false, 70 total on the site).
			invoker: fakeInvoker({ atlassian_getVisibleJiraProjects: [projectsFixture, pageTwo] }, calls),
		});
		const projects = await provider.listProjects();
		expect(projects).toEqual([
			{ id: "10062", key: "DEVOPS", name: "DevOpsProject" },
			{ id: "10115", key: "LRDTP", name: "LRD+ Test Project" },
			{ id: "10345", key: "JIRA", name: "PVH ECOM JIRA Unification" },
		]);
		expect(calls).toHaveLength(2);
		expect(calls[0]?.args).toEqual({ action: "create", maxResults: 50, startAt: 0 });
		expect(calls[1]?.args).toEqual({ action: "create", maxResults: 50, startAt: 2 });
	});

	test("stops at a single page when isLast is true", async () => {
		const calls: RecordedCall[] = [];
		const provider = createJiraTicketProvider({
			invoker: fakeInvoker({ atlassian_getVisibleJiraProjects: singlePageProjects }, calls),
		});
		const projects = await provider.listProjects();
		expect(projects).toHaveLength(1);
		expect(calls).toHaveLength(1);
	});

	test("passes searchString when a query is given", async () => {
		const calls: RecordedCall[] = [];
		const provider = createJiraTicketProvider({
			invoker: fakeInvoker({ atlassian_getVisibleJiraProjects: singlePageProjects }, calls),
		});
		await provider.listProjects("devops");
		expect(calls[0]?.args).toEqual({ action: "create", maxResults: 50, startAt: 0, searchString: "devops" });
	});

	test("caches per query within the TTL and refetches after expiry", async () => {
		const calls: RecordedCall[] = [];
		let clock = 1_000;
		const provider = createJiraTicketProvider({
			invoker: fakeInvoker({ atlassian_getVisibleJiraProjects: singlePageProjects }, calls),
			now: () => clock,
		});
		await provider.listProjects();
		await provider.listProjects();
		expect(calls).toHaveLength(1);
		await provider.listProjects("devops");
		expect(calls).toHaveLength(2);
		clock += 5 * 60 * 1000 + 1;
		await provider.listProjects();
		expect(calls).toHaveLength(3);
	});
});

describe("searchAssignees", () => {
	test("unwraps the data.users.users envelope", async () => {
		const provider = createJiraTicketProvider({
			invoker: fakeInvoker({ atlassian_lookupJiraAccountId: lookupFixture }),
		});
		const assignees = await provider.searchAssignees("Sample");
		expect(assignees).toEqual([
			{ id: "70121:00000000-aaaa-bbbb-cccc-000000000001", displayName: "Sample Admin" },
			{ id: "557058:00000000-1111-2222-3333-444444444444", displayName: "Sample User" },
		]);
	});
});

describe("listIssueTypes", () => {
	test("filters subtask types and caches per project", async () => {
		const calls: RecordedCall[] = [];
		const provider = createJiraTicketProvider({
			invoker: fakeInvoker({ atlassian_getJiraProjectIssueTypesMetadata: issueTypesFixture }, calls),
		});
		const issueTypes = await provider.listIssueTypes("DEVOPS");
		expect(issueTypes.map((t) => t.name)).toEqual(["Epic", "Task", "Bug"]);
		expect(calls[0]?.args).toEqual({ projectIdOrKey: "DEVOPS", maxResults: 50 });
		await provider.listIssueTypes("DEVOPS");
		expect(calls).toHaveLength(1);
	});
});

describe("listEpics", () => {
	test("queries open epics via JQL and maps key/summary", async () => {
		const calls: RecordedCall[] = [];
		const provider = createJiraTicketProvider({
			invoker: fakeInvoker({ atlassian_searchJiraIssuesUsingJql: epicSearchFixture }, calls),
		});
		const epics = await provider.listEpics("DEVOPS");
		expect(epics).toEqual([
			{ key: "DEVOPS-1354", summary: "Agentic Investigations" },
			{ key: "DEVOPS-1333", summary: "Kafka MCP AgentCore - MSK Integration Infrastructure" },
		]);
		expect(calls[0]?.args).toEqual({
			jql: "project = DEVOPS AND issuetype = Epic AND statusCategory != Done ORDER BY created DESC",
			fields: ["summary"],
			maxResults: 50,
		});
	});

	test("caches per project within the TTL", async () => {
		const calls: RecordedCall[] = [];
		const provider = createJiraTicketProvider({
			invoker: fakeInvoker({ atlassian_searchJiraIssuesUsingJql: epicSearchFixture }, calls),
		});
		await provider.listEpics("DEVOPS");
		await provider.listEpics("DEVOPS");
		expect(calls).toHaveLength(1);
	});

	test("rejects project keys that are not JQL-safe", async () => {
		const provider = createJiraTicketProvider({ invoker: fakeInvoker({}) });
		const err = await provider.listEpics('X" OR 1=1').catch((e: unknown) => e);
		expect(err).toBeInstanceOf(TicketProviderError);
		expect((err as TicketProviderError).message).toContain("Invalid project key");
	});
});

describe("buildCreateIssueArgs", () => {
	const base = {
		projectKey: "DEVOPS",
		issueTypeName: "Task",
		summary: "Kafka lag",
		description: "Report body",
	};

	test("includes assignee_account_id when an assignee is chosen", () => {
		expect(buildCreateIssueArgs({ ...base, assigneeId: "70121:abc", epicKey: null })).toEqual({
			...base,
			contentFormat: "markdown",
			assignee_account_id: "70121:abc",
		});
	});

	test("omits assignee_account_id for the unassigned path", () => {
		expect(buildCreateIssueArgs({ ...base, assigneeId: null, epicKey: null })).toEqual({
			...base,
			contentFormat: "markdown",
		});
	});

	test("includes parent when an epic is chosen and omits it otherwise", () => {
		expect(buildCreateIssueArgs({ ...base, assigneeId: null, epicKey: "DEVOPS-1354" })).toEqual({
			...base,
			contentFormat: "markdown",
			parent: "DEVOPS-1354",
		});
	});
});

describe("createTicket", () => {
	const request = {
		projectKey: "DEVOPS",
		issueTypeName: "Task",
		summary: "Kafka lag",
		description: "Report body",
		assigneeId: null,
		epicKey: null,
	};

	test("returns the created key and a browse URL from ATLASSIAN_SITE_NAME", async () => {
		const provider = createJiraTicketProvider({
			invoker: fakeInvoker({ atlassian_createJiraIssue: createFixture }),
			env: { ATLASSIAN_SITE_NAME: "pvhcorp" } as NodeJS.ProcessEnv,
		});
		expect(await provider.createTicket(request)).toEqual({
			key: "DEVOPS-1382",
			url: "https://pvhcorp.atlassian.net/browse/DEVOPS-1382",
		});
	});

	test("omits url when ATLASSIAN_SITE_NAME is unset", async () => {
		const provider = createJiraTicketProvider({
			invoker: fakeInvoker({ atlassian_createJiraIssue: createFixture }),
			env: {} as NodeJS.ProcessEnv,
		});
		expect(await provider.createTicket(request)).toEqual({ key: "DEVOPS-1382" });
	});

	test("wraps tool errors in TicketProviderError with the upstream message", async () => {
		const provider = createJiraTicketProvider({
			invoker: fakeInvoker({ atlassian_createJiraIssue: new Error("Error: assignee not assignable") }),
			env: {} as NodeJS.ProcessEnv,
		});
		const err = await provider.createTicket(request).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(TicketProviderError);
		expect((err as TicketProviderError).message).toContain("assignee not assignable");
	});

	test("rejects non-JSON payloads with a truncated excerpt", async () => {
		const provider = createJiraTicketProvider({
			invoker: fakeInvoker({ atlassian_createJiraIssue: "upstream exploded" }),
			env: {} as NodeJS.ProcessEnv,
		});
		const err = await provider.createTicket(request).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(TicketProviderError);
		expect((err as TicketProviderError).message).toContain("non-JSON");
	});

	test("rejects unexpected shapes (missing key)", async () => {
		const provider = createJiraTicketProvider({
			invoker: fakeInvoker({ atlassian_createJiraIssue: JSON.stringify({ id: "1" }) }),
			env: {} as NodeJS.ProcessEnv,
		});
		const err = await provider.createTicket(request).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(TicketProviderError);
		expect((err as TicketProviderError).message).toContain("unexpected shape");
	});
});

describe("addComment", () => {
	test("posts markdown with the pinned upstream arg names and returns the comment id", async () => {
		const calls: RecordedCall[] = [];
		const provider = createJiraTicketProvider({
			invoker: fakeInvoker({ atlassian_addCommentToJiraIssue: JSON.stringify({ id: "10501" }) }, calls),
		});
		expect(await provider.addComment("DEVOPS-1382", "Follow-up analysis")).toEqual({ id: "10501" });
		expect(calls[0]?.toolName).toBe("atlassian_addCommentToJiraIssue");
		expect(calls[0]?.args).toEqual({
			issueIdOrKey: "DEVOPS-1382",
			commentBody: "Follow-up analysis",
			contentFormat: "markdown",
		});
	});

	test("wraps tool errors in TicketProviderError with the upstream message", async () => {
		const provider = createJiraTicketProvider({
			invoker: fakeInvoker({ atlassian_addCommentToJiraIssue: new Error("Error: comment forbidden") }),
		});
		const err = await provider.addComment("DEVOPS-1382", "body").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(TicketProviderError);
		expect((err as TicketProviderError).message).toContain("comment forbidden");
	});

	test("rejects non-JSON payloads with a truncated excerpt", async () => {
		const provider = createJiraTicketProvider({
			invoker: fakeInvoker({ atlassian_addCommentToJiraIssue: "upstream exploded" }),
		});
		const err = await provider.addComment("DEVOPS-1382", "body").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(TicketProviderError);
		expect((err as TicketProviderError).message).toContain("non-JSON");
	});

	test("rejects unexpected shapes (missing id)", async () => {
		const provider = createJiraTicketProvider({
			invoker: fakeInvoker({ atlassian_addCommentToJiraIssue: JSON.stringify({ key: "DEVOPS-1" }) }),
		});
		const err = await provider.addComment("DEVOPS-1382", "body").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(TicketProviderError);
		expect((err as TicketProviderError).message).toContain("unexpected shape");
	});
});
