// apps/web/src/routes/api/tickets/[provider]/server.test.ts
import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

interface FakeProvider {
	id: string;
	label: string;
	isAvailable: () => boolean;
	listProjects: (query?: string) => Promise<unknown[]>;
	searchAssignees: (query: string) => Promise<unknown[]>;
	listIssueTypes: (projectKey: string) => Promise<unknown[]>;
	listEpics: (projectKey: string) => Promise<unknown[]>;
	createTicket: (req: unknown) => Promise<unknown>;
	addComment: (issueKey: string, body: string) => Promise<{ id: string }>;
}

function baseProvider(overrides: Partial<FakeProvider> = {}): FakeProvider {
	return {
		id: "jira",
		label: "Jira",
		isAvailable: () => true,
		listProjects: () => Promise.resolve([]),
		searchAssignees: () => Promise.resolve([]),
		listIssueTypes: () => Promise.resolve([]),
		listEpics: () => Promise.resolve([]),
		createTicket: () => Promise.resolve({ key: "X-1" }),
		addComment: () => Promise.resolve({ id: "c1" }),
		...overrides,
	};
}

let mockProvider: FakeProvider | undefined;
const curationCalls: Array<{ incidentId: string; ticketKey: string }> = [];
const keyDecisions: unknown[] = [];
let curationError: Error | null = null;

// SIO-780/SIO-1045: mock.module is process-global in bun; include every export
// touched by any sibling web test so the @devops-agent/agent module link
// succeeds regardless of test-file ordering.
mock.module("@devops-agent/agent", () => ({
	AttachmentError: class AttachmentError extends Error {},
	GRAPH_DEADLINE_KEY: "graphDeadlineAt",
	buildGraph: () => Promise.resolve({}),
	buildIacGraph: () => Promise.resolve({}),
	createMcpClient: () => Promise.resolve(),
	stopHealthPolling: () => undefined,
	flushLangSmithCallbacks: () => Promise.resolve(),
	getAgent: () => ({ manifest: {}, tools: [], subAgents: new Map(), knowledge: [] }),
	getAgentByName: () => ({ manifest: {}, tools: [], subAgents: new Map(), knowledge: [] }),
	iacTurnOutcome: () => "completed",
	getConnectedServers: () => [] as string[],
	getServerStates: () => ({}),
	processAttachments: () => Promise.resolve({ contentBlocks: [], metadata: [], warnings: [] }),
	mcpEvents: new EventEmitter(),
	appliedSkillsForNames: () => [] as unknown[],
	installSkillLearner: () => undefined,
	promoteToMemory: () => Promise.resolve(),
	executeAction: () => Promise.resolve(),
	getAvailableActionTools: () => [] as unknown[],
	reconcileAll: () => Promise.resolve({ reconciled: 0, skipped: 0, errors: 0 }),
	reconcileEnabled: () => false,
	runTopologySweep: () => Promise.resolve({ sources: {} }),
	topologyCronEnabled: () => false,
	selectedBackend: () => "file" as const,
	// SIO-1124: the /api/tickets routes import these from this same specifier.
	getTicketProvider: (id: string) => (id === "jira" ? mockProvider : undefined),
	listAvailableTicketProviders: () => [] as unknown[],
	// SIO-1134: the tickets POST route curates the KG incident on creation.
	isKnowledgeGraphEnabled: () => true,
	getGraphStore: () => Promise.resolve({}),
	linkIncidentTicket: (_store: unknown, incidentId: string, ticketKey: string) => {
		curationCalls.push({ incidentId, ticketKey });
		return curationError ? Promise.reject(curationError) : Promise.resolve();
	},
	recordKeyDecision: (entry: unknown) => {
		keyDecisions.push(entry);
	},
	// SIO-1135: the tickets POST route also mirrors the curated incident to durable facts.
	writeCurationMirrorFacts: () => Promise.resolve({ incidentFactWritten: false, rootCauseFactWritten: false }),
}));
let mcpConnectError: Error | null = null;

mock.module("$lib/server/agent", () => ({
	ensureMcpConnected: async () => {
		if (mcpConnectError) throw mcpConnectError;
	},
	invokeAgent: async () => ({ async *[Symbol.asyncIterator]() {} }),
	resumeAgent: async () => ({ async *[Symbol.asyncIterator]() {} }),
	getPendingInterrupt: async () => undefined,
	getIacTurnOutcome: async () => "completed",
	getLastAssistantText: async () => "",
	pruneThreadState: async () => {},
	runPostTurn: async () => {},
	setSessionOutcome: () => undefined,
	incrementSseConnections: () => undefined,
	decrementSseConnections: () => undefined,
	getActiveSseConnections: () => 0,
	getAgentRuntimeStatus: () => ({
		graphReady: false,
		iacGraphReady: false,
		mcpInitialized: false,
		checkpointerType: "memory" as const,
	}),
	sessionTeardown: async () => {},
}));

const { POST } = await import("./+server.ts");
const { POST: postComment } = await import("./comment/+server.ts");
const { GET: getProjects } = await import("./projects/+server.ts");
const { GET: getAssignees } = await import("./assignees/+server.ts");
const { GET: getIssueTypes } = await import("./issue-types/+server.ts");
const { GET: getEpics } = await import("./epics/+server.ts");

const validBody = {
	projectKey: "DEVOPS",
	issueTypeName: "Task",
	summary: "Kafka lag",
	description: "Report body",
	assigneeId: null,
	epicKey: null,
};

function postEvent(provider: string, body: unknown) {
	return {
		params: { provider },
		request: new Request(`http://localhost/api/tickets/${provider}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
	} as never;
}

function postCommentEvent(provider: string, body: unknown) {
	return {
		params: { provider },
		request: new Request(`http://localhost/api/tickets/${provider}/comment`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
	} as never;
}

function getEvent(provider: string, path: string, search: string) {
	return {
		params: { provider },
		url: new URL(`http://localhost/api/tickets/${provider}/${path}${search}`),
	} as never;
}

describe("POST /api/tickets/[provider]", () => {
	test("404 for an unknown provider id", async () => {
		mockProvider = baseProvider();
		const res = await POST(postEvent("linear", validBody));
		expect(res.status).toBe(404);
	});

	test("404 when the provider is unavailable", async () => {
		mockProvider = baseProvider({ isAvailable: () => false });
		const res = await POST(postEvent("jira", validBody));
		expect(res.status).toBe(404);
	});

	test("400 on an invalid body", async () => {
		mockProvider = baseProvider();
		const res = await POST(postEvent("jira", { ...validBody, summary: "" }));
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("Invalid request");
	});

	test("creates a ticket and returns the provider result", async () => {
		const received: unknown[] = [];
		mockProvider = baseProvider({
			createTicket: (req) => {
				received.push(req);
				return Promise.resolve({ key: "DEVOPS-1382", url: "https://pvhcorp.atlassian.net/browse/DEVOPS-1382" });
			},
		});
		const res = await POST(postEvent("jira", validBody));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			key: "DEVOPS-1382",
			url: "https://pvhcorp.atlassian.net/browse/DEVOPS-1382",
		});
		expect(received).toEqual([validBody]);
	});

	test("502 when the provider fails", async () => {
		mockProvider = baseProvider({
			createTicket: () => Promise.reject(new Error("assignee not assignable")),
		});
		const res = await POST(postEvent("jira", validBody));
		expect(res.status).toBe(502);
		expect((await res.json()).error).toContain("assignee not assignable");
	});

	test("502 JSON when MCP connect fails (resolution sits inside the error boundary)", async () => {
		mockProvider = baseProvider();
		mcpConnectError = new Error("connect ECONNREFUSED");
		try {
			const res = await POST(postEvent("jira", validBody));
			expect(res.status).toBe(502);
			expect((await res.json()).error).toContain("ECONNREFUSED");
		} finally {
			mcpConnectError = null;
		}
	});

	test("SIO-1134: a requestId in the body curates the KG incident (ticketKey + mirror fact)", async () => {
		curationCalls.length = 0;
		keyDecisions.length = 0;
		mockProvider = baseProvider({ createTicket: () => Promise.resolve({ key: "DEVOPS-1382" }) });
		const res = await POST(postEvent("jira", { ...validBody, requestId: "req-abc" }));
		expect(res.status).toBe(200);
		expect(curationCalls).toEqual([{ incidentId: "req-abc", ticketKey: "DEVOPS-1382" }]);
		const fact = keyDecisions[0] as { annotations: Record<string, string> };
		expect(fact.annotations.kind).toBe("kg-incident-ticket");
		expect(fact.annotations.incident_id).toBe("req-abc");
		expect(fact.annotations.ticket).toBe("DEVOPS-1382");
	});

	test("SIO-1134: no requestId means no curation", async () => {
		curationCalls.length = 0;
		keyDecisions.length = 0;
		mockProvider = baseProvider();
		const res = await POST(postEvent("jira", validBody));
		expect(res.status).toBe(200);
		expect(curationCalls).toEqual([]);
		expect(keyDecisions).toEqual([]);
	});

	test("SIO-1134: a curation failure never fails the ticket creation", async () => {
		curationCalls.length = 0;
		keyDecisions.length = 0;
		curationError = new Error("kg store locked");
		try {
			mockProvider = baseProvider({ createTicket: () => Promise.resolve({ key: "DEVOPS-1383" }) });
			const res = await POST(postEvent("jira", { ...validBody, requestId: "req-def" }));
			expect(res.status).toBe(200);
			expect((await res.json()).key).toBe("DEVOPS-1383");
			expect(keyDecisions).toEqual([]);
		} finally {
			curationError = null;
		}
	});
});

describe("POST /api/tickets/[provider]/comment", () => {
	const validComment = { issueKey: "DEVOPS-1382", body: "Follow-up analysis markdown" };

	test("404 for an unknown provider id", async () => {
		mockProvider = baseProvider();
		const res = await postComment(postCommentEvent("linear", validComment));
		expect(res.status).toBe(404);
	});

	test("404 when the provider is unavailable", async () => {
		mockProvider = baseProvider({ isAvailable: () => false });
		const res = await postComment(postCommentEvent("jira", validComment));
		expect(res.status).toBe(404);
	});

	test("400 on an invalid body (empty issueKey)", async () => {
		mockProvider = baseProvider();
		const res = await postComment(postCommentEvent("jira", { ...validComment, issueKey: "" }));
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("Invalid request");
	});

	test("posts the comment and returns { ok, id }", async () => {
		const received: Array<{ issueKey: string; body: string }> = [];
		mockProvider = baseProvider({
			addComment: (issueKey, body) => {
				received.push({ issueKey, body });
				return Promise.resolve({ id: "10501" });
			},
		});
		const res = await postComment(postCommentEvent("jira", validComment));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, id: "10501" });
		expect(received).toEqual([{ issueKey: "DEVOPS-1382", body: "Follow-up analysis markdown" }]);
	});

	test("502 when the provider fails", async () => {
		mockProvider = baseProvider({
			addComment: () => Promise.reject(new Error("comment forbidden")),
		});
		const res = await postComment(postCommentEvent("jira", validComment));
		expect(res.status).toBe(502);
		expect((await res.json()).error).toContain("comment forbidden");
	});

	test("502 JSON when MCP connect fails (resolution sits inside the error boundary)", async () => {
		mockProvider = baseProvider();
		mcpConnectError = new Error("connect ECONNREFUSED");
		try {
			const res = await postComment(postCommentEvent("jira", validComment));
			expect(res.status).toBe(502);
			expect((await res.json()).error).toContain("ECONNREFUSED");
		} finally {
			mcpConnectError = null;
		}
	});
});

describe("GET /api/tickets/[provider]/projects", () => {
	test("passes the trimmed query through and returns projects", async () => {
		const queries: Array<string | undefined> = [];
		mockProvider = baseProvider({
			listProjects: (query) => {
				queries.push(query);
				return Promise.resolve([{ id: "10062", key: "DEVOPS", name: "DevOpsProject" }]);
			},
		});
		const res = await getProjects(getEvent("jira", "projects", "?query=%20devops%20"));
		expect(await res.json()).toEqual({ projects: [{ id: "10062", key: "DEVOPS", name: "DevOpsProject" }] });
		expect(queries).toEqual(["devops"]);
	});

	test("omits the query when blank", async () => {
		const queries: Array<string | undefined> = [];
		mockProvider = baseProvider({
			listProjects: (query) => {
				queries.push(query);
				return Promise.resolve([]);
			},
		});
		await getProjects(getEvent("jira", "projects", ""));
		expect(queries).toEqual([undefined]);
	});
});

describe("GET /api/tickets/[provider]/assignees", () => {
	test("400 when the query is under 2 characters", async () => {
		mockProvider = baseProvider();
		const res = await getAssignees(getEvent("jira", "assignees", "?query=s"));
		expect(res.status).toBe(400);
	});

	test("returns mapped assignees", async () => {
		mockProvider = baseProvider({
			searchAssignees: () => Promise.resolve([{ id: "70121:abc", displayName: "Simon Owusu" }]),
		});
		const res = await getAssignees(getEvent("jira", "assignees", "?query=simon"));
		expect(await res.json()).toEqual({ assignees: [{ id: "70121:abc", displayName: "Simon Owusu" }] });
	});
});

describe("GET /api/tickets/[provider]/epics", () => {
	test("400 when projectKey is missing", async () => {
		mockProvider = baseProvider();
		const res = await getEpics(getEvent("jira", "epics", ""));
		expect(res.status).toBe(400);
	});

	test("returns epics for the project", async () => {
		const keys: string[] = [];
		mockProvider = baseProvider({
			listEpics: (projectKey) => {
				keys.push(projectKey);
				return Promise.resolve([{ key: "DEVOPS-1354", summary: "Agentic Investigations" }]);
			},
		});
		const res = await getEpics(getEvent("jira", "epics", "?projectKey=DEVOPS"));
		expect(await res.json()).toEqual({ epics: [{ key: "DEVOPS-1354", summary: "Agentic Investigations" }] });
		expect(keys).toEqual(["DEVOPS"]);
	});
});

describe("GET /api/tickets/[provider]/issue-types", () => {
	test("400 when projectKey is missing", async () => {
		mockProvider = baseProvider();
		const res = await getIssueTypes(getEvent("jira", "issue-types", ""));
		expect(res.status).toBe(400);
	});

	test("returns issue types for the project", async () => {
		const keys: string[] = [];
		mockProvider = baseProvider({
			listIssueTypes: (projectKey) => {
				keys.push(projectKey);
				return Promise.resolve([{ id: "10008", name: "Task" }]);
			},
		});
		const res = await getIssueTypes(getEvent("jira", "issue-types", "?projectKey=DEVOPS"));
		expect(await res.json()).toEqual({ issueTypes: [{ id: "10008", name: "Task" }] });
		expect(keys).toEqual(["DEVOPS"]);
	});
});
