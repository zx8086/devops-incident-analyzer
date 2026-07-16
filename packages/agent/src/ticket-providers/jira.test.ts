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

function fakeInvoker(responses: Record<string, string | Error>, calls: RecordedCall[] = []): McpToolInvoker {
	return {
		hasTool: (toolName) => toolName in responses,
		invoke: (toolName, args) => {
			calls.push({ toolName, args });
			const response = responses[toolName];
			if (response === undefined) return Promise.reject(new Error(`no fake response for ${toolName}`));
			if (response instanceof Error) return Promise.reject(response);
			return Promise.resolve(response);
		},
	};
}

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
	test("maps the pinned values shape and passes action=create", async () => {
		const calls: RecordedCall[] = [];
		const provider = createJiraTicketProvider({
			invoker: fakeInvoker({ atlassian_getVisibleJiraProjects: projectsFixture }, calls),
		});
		const projects = await provider.listProjects();
		expect(projects).toEqual([
			{ id: "10062", key: "DEVOPS", name: "DevOpsProject" },
			{ id: "10115", key: "LRDTP", name: "LRD+ Test Project" },
		]);
		expect(calls[0]?.args).toEqual({ action: "create", maxResults: 50 });
	});

	test("passes searchString when a query is given", async () => {
		const calls: RecordedCall[] = [];
		const provider = createJiraTicketProvider({
			invoker: fakeInvoker({ atlassian_getVisibleJiraProjects: projectsFixture }, calls),
		});
		await provider.listProjects("devops");
		expect(calls[0]?.args).toEqual({ action: "create", maxResults: 50, searchString: "devops" });
	});

	test("caches per query within the TTL and refetches after expiry", async () => {
		const calls: RecordedCall[] = [];
		let clock = 1_000;
		const provider = createJiraTicketProvider({
			invoker: fakeInvoker({ atlassian_getVisibleJiraProjects: projectsFixture }, calls),
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
		const assignees = await provider.searchAssignees("Simon");
		expect(assignees).toEqual([
			{ id: "70121:86ec4ccf-9601-42a5-ab81-d15240b5de71", displayName: "Simon Owusu" },
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
