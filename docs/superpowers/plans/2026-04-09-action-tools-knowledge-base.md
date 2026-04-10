# Action Tools & Knowledge Base Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement runtime execution for notify-slack and create-ticket action tools (hybrid LLM proposal + user confirmation), and load gitagent knowledge/ directory into agent context.

**Architecture:** The mitigation node generates action proposals (PendingAction[]) streamed to the frontend via SSE. The frontend renders editable confirmation cards. On approval, a POST endpoint routes to Slack Web API or Linear SDK. Knowledge files are loaded by loadAgent() and injected into system prompts for the mitigation node.

**Tech Stack:** Bun, LangGraph, @slack/web-api, @linear/sdk, Zod, SvelteKit, Svelte 5 runes, Tailwind CSS

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `packages/shared/src/action-types.ts` | PendingAction, ActionResult Zod schemas and types |
| `packages/agent/src/action-tools/slack-notifier.ts` | Slack Web API integration |
| `packages/agent/src/action-tools/slack-notifier.test.ts` | Slack notifier unit tests |
| `packages/agent/src/action-tools/ticket-creator.ts` | Linear SDK integration |
| `packages/agent/src/action-tools/ticket-creator.test.ts` | Ticket creator unit tests |
| `packages/agent/src/action-tools/executor.ts` | Unified action executor routing |
| `packages/agent/src/action-tools/executor.test.ts` | Executor unit tests |
| `apps/web/src/routes/api/agent/actions/+server.ts` | POST endpoint for executing actions |
| `apps/web/src/routes/api/agent/actions/available/+server.ts` | GET endpoint for available action tools |
| `apps/web/src/lib/components/ActionConfirmationCard.svelte` | Confirmation UI for pending actions |
| `agents/incident-analyzer/knowledge/runbooks/high-error-rate.md` | Runbook: high error rate investigation |
| `agents/incident-analyzer/knowledge/runbooks/kafka-consumer-lag.md` | Runbook: Kafka consumer lag |
| `agents/incident-analyzer/knowledge/runbooks/database-slow-queries.md` | Runbook: Couchbase slow queries |
| `agents/incident-analyzer/knowledge/systems-map/service-dependencies.md` | Service dependency topology |
| `agents/incident-analyzer/knowledge/slo-policies/api-latency-slo.md` | SLO definitions and thresholds |

### Modified Files

| File | Change |
|------|--------|
| `packages/shared/src/agent-state.ts` | Add `pending_actions` StreamEvent variant |
| `packages/shared/src/config.ts` | Add SlackConfigSchema, LinearConfigSchema |
| `packages/shared/src/index.ts` | Export new schemas/types |
| `packages/agent/package.json` | Add @slack/web-api, @linear/sdk dependencies |
| `packages/agent/src/state.ts` | Add pendingActions, actionResults annotations |
| `packages/agent/src/mitigation.ts` | Add action proposal generation, knowledge-aware prompting |
| `packages/agent/src/prompt-context.ts` | Expose knowledge for mitigation context |
| `packages/agent/src/index.ts` | Export action executor |
| `packages/gitagent-bridge/src/types.ts` | Add KnowledgeIndexSchema, KnowledgeCategorySchema |
| `packages/gitagent-bridge/src/manifest-loader.ts` | Add knowledge loading, KnowledgeEntry type |
| `packages/gitagent-bridge/src/skill-loader.ts` | Add knowledge section to buildSystemPrompt() |
| `packages/gitagent-bridge/src/index.ts` | Export new types |
| `packages/gitagent-bridge/src/index.test.ts` | Add knowledge loading tests |
| `apps/web/src/routes/api/agent/stream/+server.ts` | Emit pending_actions SSE event |
| `apps/web/src/lib/stores/agent.svelte.ts` | Handle pending_actions, add executeAction/dismissAction |
| `apps/web/src/lib/components/ChatMessage.svelte` | Render ActionConfirmationCard |

---

### Task 1: Shared Types -- PendingAction and ActionResult Schemas

**Files:**
- Create: `packages/shared/src/action-types.ts`
- Modify: `packages/shared/src/agent-state.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Create action-types.ts with Zod schemas**

```typescript
// shared/src/action-types.ts
import { z } from "zod";

export const PendingActionSchema = z.object({
	id: z.string(),
	tool: z.enum(["notify-slack", "create-ticket"]),
	params: z.record(z.string(), z.unknown()),
	reason: z.string(),
});
export type PendingAction = z.infer<typeof PendingActionSchema>;

export const ActionResultSchema = z.object({
	actionId: z.string(),
	tool: z.string(),
	status: z.enum(["success", "error"]),
	result: z.record(z.string(), z.unknown()).optional(),
	error: z.string().optional(),
});
export type ActionResult = z.infer<typeof ActionResultSchema>;
```

- [ ] **Step 2: Add pending_actions SSE event variant to StreamEventSchema**

In `packages/shared/src/agent-state.ts`, add to the `StreamEventSchema` discriminated union (after the `low_confidence` variant):

```typescript
z.object({
	type: z.literal("pending_actions"),
	actions: z.array(PendingActionSchema),
}),
```

Add import at top of the file:

```typescript
import { PendingActionSchema } from "./action-types.ts";
```

- [ ] **Step 3: Export from shared/src/index.ts**

Add to `packages/shared/src/index.ts`:

```typescript
export {
	type ActionResult,
	ActionResultSchema,
	type PendingAction,
	PendingActionSchema,
} from "./action-types.ts";
```

- [ ] **Step 4: Run typecheck**

Run: `bun run --filter '@devops-agent/shared' typecheck`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/action-types.ts packages/shared/src/agent-state.ts packages/shared/src/index.ts
git commit -m "SIO-634, SIO-635: Add PendingAction and ActionResult shared types"
```

---

### Task 2: Configuration Schemas -- Slack and Linear

**Files:**
- Modify: `packages/shared/src/config.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Add SlackConfigSchema and LinearConfigSchema to config.ts**

Append to `packages/shared/src/config.ts`:

```typescript
export const SlackConfigSchema = z.object({
	botToken: z.string().startsWith("xoxb-"),
	defaultChannel: z.string(),
});
export type SlackConfig = z.infer<typeof SlackConfigSchema>;

export const LinearConfigSchema = z.object({
	apiKey: z.string().startsWith("lin_api_"),
	teamId: z.string(),
	projectId: z.string(),
});
export type LinearConfig = z.infer<typeof LinearConfigSchema>;
```

- [ ] **Step 2: Export from shared/src/index.ts**

Add to the config.ts export block in `packages/shared/src/index.ts`:

```typescript
export {
	type AgentConfig,
	AgentConfigSchema,
	type LinearConfig,
	LinearConfigSchema,
	type ServerConfig,
	ServerConfigSchema,
	type SlackConfig,
	SlackConfigSchema,
} from "./config.ts";
```

- [ ] **Step 3: Run typecheck**

Run: `bun run --filter '@devops-agent/shared' typecheck`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/config.ts packages/shared/src/index.ts
git commit -m "SIO-634, SIO-635: Add Slack and Linear configuration schemas"
```

---

### Task 3: Agent State -- pendingActions and actionResults

**Files:**
- Modify: `packages/agent/src/state.ts`

- [ ] **Step 1: Add pendingActions and actionResults annotations**

In `packages/agent/src/state.ts`, add import:

```typescript
import type { ActionResult, PendingAction } from "@devops-agent/shared";
```

Update the existing import to include the new types (ActionResult and PendingAction are already re-exported from shared index). Then add after the `lowConfidence` annotation:

```typescript
	// SIO-634, SIO-635: Action proposals from mitigation node, awaiting user confirmation
	pendingActions: Annotation<PendingAction[]>({
		reducer: (_, next) => next,
		default: () => [],
	}),

	// SIO-634, SIO-635: Results from executed actions
	actionResults: Annotation<ActionResult[]>({
		reducer: (prev, next) => [...prev, ...next],
		default: () => [],
	}),
```

- [ ] **Step 2: Run typecheck**

Run: `bun run --filter '@devops-agent/agent' typecheck`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add packages/agent/src/state.ts
git commit -m "SIO-634, SIO-635: Add pendingActions and actionResults to AgentState"
```

---

### Task 4: Slack Notifier -- Tests First

**Files:**
- Create: `packages/agent/src/action-tools/slack-notifier.test.ts`
- Create: `packages/agent/src/action-tools/slack-notifier.ts`

- [ ] **Step 1: Install @slack/web-api dependency**

Run: `cd /Users/Simon.Owusu@Tommy.com/WebstormProjects/devops-incident-analyzer && bun add @slack/web-api --cwd packages/agent`

- [ ] **Step 2: Write failing tests**

Create `packages/agent/src/action-tools/slack-notifier.test.ts`:

```typescript
// agent/src/action-tools/slack-notifier.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { executeSlackNotify, getSeverityColor, isSlackConfigured } from "./slack-notifier.ts";

// Mock @slack/web-api
const mockPostMessage = mock(() =>
	Promise.resolve({ ok: true, ts: "1234567890.123456", channel: "C12345" }),
);
const mockFilesUpload = mock(() => Promise.resolve({ ok: true }));

mock.module("@slack/web-api", () => ({
	WebClient: class {
		chat = { postMessage: mockPostMessage };
		files = { uploadV2: mockFilesUpload };
	},
}));

describe("slack-notifier", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
		process.env.SLACK_DEFAULT_CHANNEL = "#test-incidents";
		mockPostMessage.mockClear();
		mockFilesUpload.mockClear();
	});

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	test("isSlackConfigured returns true when env vars set", () => {
		expect(isSlackConfigured()).toBe(true);
	});

	test("isSlackConfigured returns false when SLACK_BOT_TOKEN missing", () => {
		delete process.env.SLACK_BOT_TOKEN;
		expect(isSlackConfigured()).toBe(false);
	});

	test("getSeverityColor maps severity levels", () => {
		expect(getSeverityColor("critical")).toBe("#E01E5A");
		expect(getSeverityColor("high")).toBe("#E87722");
		expect(getSeverityColor("medium")).toBe("#ECB22E");
		expect(getSeverityColor("low")).toBe("#2EB67D");
		expect(getSeverityColor("info")).toBe("#36C5F0");
	});

	test("sends message to specified channel with severity formatting", async () => {
		const result = await executeSlackNotify({
			channel: "#critical-alerts",
			message: "Service degradation detected",
			severity: "critical",
		});

		expect(result.sent).toBe(true);
		expect(result.timestamp).toBe("1234567890.123456");
		expect(result.channel).toBe("C12345");
		expect(mockPostMessage).toHaveBeenCalledTimes(1);

		const callArgs = mockPostMessage.mock.calls[0][0] as Record<string, unknown>;
		expect(callArgs.channel).toBe("#critical-alerts");
		expect(callArgs.text).toContain("Service degradation detected");
	});

	test("falls back to default channel when channel is empty", async () => {
		await executeSlackNotify({
			channel: "",
			message: "Test",
			severity: "info",
		});

		const callArgs = mockPostMessage.mock.calls[0][0] as Record<string, unknown>;
		expect(callArgs.channel).toBe("#test-incidents");
	});

	test("includes thread_ts when provided", async () => {
		await executeSlackNotify({
			channel: "#alerts",
			message: "Update",
			severity: "medium",
			thread_ts: "1234567890.000000",
		});

		const callArgs = mockPostMessage.mock.calls[0][0] as Record<string, unknown>;
		expect(callArgs.thread_ts).toBe("1234567890.000000");
	});

	test("uploads report as file when reportContent provided", async () => {
		await executeSlackNotify({
			channel: "#alerts",
			message: "Summary",
			severity: "high",
			reportContent: "Full incident report here",
		});

		expect(mockPostMessage).toHaveBeenCalledTimes(1);
		expect(mockFilesUpload).toHaveBeenCalledTimes(1);
	});

	test("returns error result when Slack API fails", async () => {
		mockPostMessage.mockImplementationOnce(() => Promise.reject(new Error("channel_not_found")));

		const result = await executeSlackNotify({
			channel: "#nonexistent",
			message: "Test",
			severity: "info",
		});

		expect(result.sent).toBe(false);
		expect(result.timestamp).toBe("");
		expect(result.channel).toBe("");
	});
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test packages/agent/src/action-tools/slack-notifier.test.ts`
Expected: FAIL (module not found or functions not exported)

- [ ] **Step 4: Implement slack-notifier.ts**

Create `packages/agent/src/action-tools/slack-notifier.ts`:

```typescript
// agent/src/action-tools/slack-notifier.ts
import { SlackConfigSchema } from "@devops-agent/shared";
import { WebClient } from "@slack/web-api";

const SEVERITY_COLORS: Record<string, string> = {
	critical: "#E01E5A",
	high: "#E87722",
	medium: "#ECB22E",
	low: "#2EB67D",
	info: "#36C5F0",
};

export function getSeverityColor(severity: string): string {
	return SEVERITY_COLORS[severity] ?? SEVERITY_COLORS.info;
}

export function isSlackConfigured(): boolean {
	return !!process.env.SLACK_BOT_TOKEN && !!process.env.SLACK_DEFAULT_CHANNEL;
}

function getSlackConfig() {
	return SlackConfigSchema.parse({
		botToken: process.env.SLACK_BOT_TOKEN,
		defaultChannel: process.env.SLACK_DEFAULT_CHANNEL,
	});
}

export async function executeSlackNotify(params: {
	channel: string;
	message: string;
	severity: string;
	thread_ts?: string;
	reportContent?: string;
}): Promise<{ sent: boolean; timestamp: string; channel: string }> {
	const config = getSlackConfig();
	const client = new WebClient(config.botToken);
	const channel = params.channel || config.defaultChannel;
	const color = getSeverityColor(params.severity);
	const severityLabel = params.severity.toUpperCase();

	try {
		const result = await client.chat.postMessage({
			channel,
			text: `[${severityLabel}] Incident Alert`,
			...(params.thread_ts && { thread_ts: params.thread_ts }),
			attachments: [
				{
					color,
					blocks: [
						{
							type: "section",
							text: { type: "mrkdwn", text: params.message },
						},
						{
							type: "context",
							elements: [
								{ type: "mrkdwn", text: `Severity: *${severityLabel}*` },
							],
						},
					],
				},
			],
		});

		// Upload full report as a snippet if provided
		if (params.reportContent && result.ts) {
			await client.files.uploadV2({
				channel_id: String(result.channel),
				content: params.reportContent,
				filename: "incident-report.md",
				title: "Full Incident Report",
				thread_ts: result.ts,
			});
		}

		return {
			sent: true,
			timestamp: String(result.ts ?? ""),
			channel: String(result.channel ?? ""),
		};
	} catch {
		return { sent: false, timestamp: "", channel: "" };
	}
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/agent/src/action-tools/slack-notifier.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/action-tools/slack-notifier.ts packages/agent/src/action-tools/slack-notifier.test.ts packages/agent/package.json
git commit -m "SIO-634: Implement Slack notifier with severity formatting and file upload"
```

---

### Task 5: Ticket Creator -- Tests First

**Files:**
- Create: `packages/agent/src/action-tools/ticket-creator.test.ts`
- Create: `packages/agent/src/action-tools/ticket-creator.ts`

- [ ] **Step 1: Install @linear/sdk dependency**

Run: `cd /Users/Simon.Owusu@Tommy.com/WebstormProjects/devops-incident-analyzer && bun add @linear/sdk --cwd packages/agent`

- [ ] **Step 2: Write failing tests**

Create `packages/agent/src/action-tools/ticket-creator.test.ts`:

```typescript
// agent/src/action-tools/ticket-creator.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
	buildTicketDescription,
	executeCreateTicket,
	isLinearConfigured,
	severityToPriority,
} from "./ticket-creator.ts";

const mockCreateIssue = mock(() =>
	Promise.resolve({
		success: true,
		issue: Promise.resolve({
			id: "ISSUE-123",
			identifier: "INC-42",
			url: "https://linear.app/team/issue/INC-42",
		}),
	}),
);

const mockCreateAttachment = mock(() => Promise.resolve({ success: true }));

mock.module("@linear/sdk", () => ({
	LinearClient: class {
		createIssue = mockCreateIssue;
		createAttachment = mockCreateAttachment;
	},
}));

describe("ticket-creator", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		process.env.LINEAR_API_KEY = "lin_api_test_key";
		process.env.LINEAR_TEAM_ID = "team-uuid-123";
		process.env.LINEAR_PROJECT_ID = "project-uuid-456";
		mockCreateIssue.mockClear();
		mockCreateAttachment.mockClear();
	});

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	test("isLinearConfigured returns true when env vars set", () => {
		expect(isLinearConfigured()).toBe(true);
	});

	test("isLinearConfigured returns false when LINEAR_API_KEY missing", () => {
		delete process.env.LINEAR_API_KEY;
		expect(isLinearConfigured()).toBe(false);
	});

	test("severityToPriority maps correctly", () => {
		expect(severityToPriority("critical")).toBe(1);
		expect(severityToPriority("high")).toBe(2);
		expect(severityToPriority("medium")).toBe(3);
		expect(severityToPriority("low")).toBe(4);
		expect(severityToPriority("unknown")).toBe(3);
	});

	test("buildTicketDescription formats with all fields", () => {
		const desc = buildTicketDescription({
			description: "Service is returning 503 errors",
			affected_services: ["api-gateway", "auth-service"],
			datasources_queried: ["elastic", "kafka"],
		});

		expect(desc).toContain("Service is returning 503 errors");
		expect(desc).toContain("api-gateway");
		expect(desc).toContain("auth-service");
		expect(desc).toContain("elastic");
		expect(desc).toContain("kafka");
	});

	test("buildTicketDescription handles missing optional fields", () => {
		const desc = buildTicketDescription({
			description: "Simple incident",
		});

		expect(desc).toContain("Simple incident");
		expect(desc).not.toContain("Affected Services");
		expect(desc).not.toContain("Datasources Analyzed");
	});

	test("creates ticket with correct priority mapping", async () => {
		const result = await executeCreateTicket({
			title: "High CPU on api-gateway",
			description: "API gateway pods showing 95% CPU",
			severity: "critical",
		});

		expect(result.ticket_id).toBe("INC-42");
		expect(result.url).toBe("https://linear.app/team/issue/INC-42");
		expect(mockCreateIssue).toHaveBeenCalledTimes(1);

		const callArgs = mockCreateIssue.mock.calls[0][0] as Record<string, unknown>;
		expect(callArgs.priority).toBe(1);
		expect(callArgs.title).toBe("High CPU on api-gateway");
	});

	test("attaches full report when reportContent provided", async () => {
		await executeCreateTicket({
			title: "Test incident",
			description: "Test description",
			severity: "medium",
			reportContent: "Full markdown report here",
		});

		expect(mockCreateIssue).toHaveBeenCalledTimes(1);
		expect(mockCreateAttachment).toHaveBeenCalledTimes(1);
	});

	test("returns error result when Linear API fails", async () => {
		mockCreateIssue.mockImplementationOnce(() => Promise.reject(new Error("auth_failed")));

		const result = await executeCreateTicket({
			title: "Test",
			description: "Test",
			severity: "low",
		});

		expect(result.ticket_id).toBe("");
		expect(result.url).toBe("");
	});
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test packages/agent/src/action-tools/ticket-creator.test.ts`
Expected: FAIL (module not found or functions not exported)

- [ ] **Step 4: Implement ticket-creator.ts**

Create `packages/agent/src/action-tools/ticket-creator.ts`:

```typescript
// agent/src/action-tools/ticket-creator.ts
import { LinearConfigSchema } from "@devops-agent/shared";
import { LinearClient } from "@linear/sdk";

const SEVERITY_PRIORITY: Record<string, number> = {
	critical: 1,
	high: 2,
	medium: 3,
	low: 4,
};

export function severityToPriority(severity: string): number {
	return SEVERITY_PRIORITY[severity] ?? 3;
}

export function isLinearConfigured(): boolean {
	return !!process.env.LINEAR_API_KEY && !!process.env.LINEAR_TEAM_ID && !!process.env.LINEAR_PROJECT_ID;
}

function getLinearConfig() {
	return LinearConfigSchema.parse({
		apiKey: process.env.LINEAR_API_KEY,
		teamId: process.env.LINEAR_TEAM_ID,
		projectId: process.env.LINEAR_PROJECT_ID,
	});
}

export function buildTicketDescription(params: {
	description: string;
	affected_services?: string[];
	datasources_queried?: string[];
}): string {
	const sections: string[] = [];

	sections.push(`## Incident Summary\n\n${params.description}`);

	if (params.affected_services && params.affected_services.length > 0) {
		const items = params.affected_services.map((s) => `- ${s}`).join("\n");
		sections.push(`## Affected Services\n\n${items}`);
	}

	if (params.datasources_queried && params.datasources_queried.length > 0) {
		const items = params.datasources_queried.map((s) => `- ${s}`).join("\n");
		sections.push(`## Datasources Analyzed\n\n${items}`);
	}

	return sections.join("\n\n");
}

export async function executeCreateTicket(params: {
	title: string;
	description: string;
	severity: string;
	affected_services?: string[];
	datasources_queried?: string[];
	reportContent?: string;
}): Promise<{ ticket_id: string; url: string }> {
	const config = getLinearConfig();
	const client = new LinearClient({ apiKey: config.apiKey });

	const body = buildTicketDescription({
		description: params.description,
		affected_services: params.affected_services,
		datasources_queried: params.datasources_queried,
	});

	try {
		const issuePayload = await client.createIssue({
			teamId: config.teamId,
			projectId: config.projectId,
			title: params.title,
			description: body,
			priority: severityToPriority(params.severity),
		});

		const issue = await issuePayload.issue;
		if (!issue) {
			return { ticket_id: "", url: "" };
		}

		// Attach full incident report as a URL-encoded markdown attachment
		if (params.reportContent) {
			const dataUri = `data:text/markdown;base64,${Buffer.from(params.reportContent).toString("base64")}`;
			await client.createAttachment({
				issueId: issue.id,
				title: "Full Incident Report",
				url: dataUri,
			});
		}

		return {
			ticket_id: issue.identifier,
			url: issue.url,
		};
	} catch {
		return { ticket_id: "", url: "" };
	}
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/agent/src/action-tools/ticket-creator.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/action-tools/ticket-creator.ts packages/agent/src/action-tools/ticket-creator.test.ts packages/agent/package.json
git commit -m "SIO-635: Implement Linear ticket creator with severity-priority mapping"
```

---

### Task 6: Unified Action Executor -- Tests First

**Files:**
- Create: `packages/agent/src/action-tools/executor.test.ts`
- Create: `packages/agent/src/action-tools/executor.ts`
- Modify: `packages/agent/src/index.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/agent/src/action-tools/executor.test.ts`:

```typescript
// agent/src/action-tools/executor.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { PendingAction } from "@devops-agent/shared";
import { executeAction, getAvailableActionTools } from "./executor.ts";

// Mock the individual executors
mock.module("./slack-notifier.ts", () => ({
	isSlackConfigured: () => !!process.env.SLACK_BOT_TOKEN,
	executeSlackNotify: mock(() =>
		Promise.resolve({ sent: true, timestamp: "123.456", channel: "C123" }),
	),
	getSeverityColor: () => "#E01E5A",
}));

mock.module("./ticket-creator.ts", () => ({
	isLinearConfigured: () => !!process.env.LINEAR_API_KEY,
	executeCreateTicket: mock(() =>
		Promise.resolve({ ticket_id: "INC-1", url: "https://linear.app/issue/INC-1" }),
	),
	severityToPriority: () => 1,
	buildTicketDescription: () => "desc",
}));

describe("executor", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		process.env.SLACK_BOT_TOKEN = "xoxb-test";
		process.env.SLACK_DEFAULT_CHANNEL = "#test";
		process.env.LINEAR_API_KEY = "lin_api_test";
		process.env.LINEAR_TEAM_ID = "team-id";
		process.env.LINEAR_PROJECT_ID = "project-id";
	});

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	test("getAvailableActionTools returns both when configured", () => {
		const tools = getAvailableActionTools();
		expect(tools).toContain("notify-slack");
		expect(tools).toContain("create-ticket");
	});

	test("getAvailableActionTools excludes unconfigured tools", () => {
		delete process.env.SLACK_BOT_TOKEN;
		const tools = getAvailableActionTools();
		expect(tools).not.toContain("notify-slack");
		expect(tools).toContain("create-ticket");
	});

	test("getAvailableActionTools returns empty when nothing configured", () => {
		delete process.env.SLACK_BOT_TOKEN;
		delete process.env.LINEAR_API_KEY;
		const tools = getAvailableActionTools();
		expect(tools).toEqual([]);
	});

	test("executeAction routes notify-slack correctly", async () => {
		const action: PendingAction = {
			id: "action-1",
			tool: "notify-slack",
			params: { channel: "#alerts", message: "Test", severity: "critical" },
			reason: "High severity incident",
		};

		const result = await executeAction(action, {
			reportContent: "Full report",
			threadId: "thread-1",
		});

		expect(result.status).toBe("success");
		expect(result.tool).toBe("notify-slack");
		expect(result.actionId).toBe("action-1");
	});

	test("executeAction routes create-ticket correctly", async () => {
		const action: PendingAction = {
			id: "action-2",
			tool: "create-ticket",
			params: { title: "Incident", description: "Details", severity: "high" },
			reason: "Needs tracking",
		};

		const result = await executeAction(action, {
			reportContent: "Full report",
			threadId: "thread-1",
		});

		expect(result.status).toBe("success");
		expect(result.tool).toBe("create-ticket");
		expect(result.actionId).toBe("action-2");
	});

	test("executeAction returns error for unknown tool", async () => {
		const action = {
			id: "action-3",
			tool: "unknown-tool" as "notify-slack",
			params: {},
			reason: "test",
		};

		const result = await executeAction(action, {
			reportContent: "",
			threadId: "thread-1",
		});

		expect(result.status).toBe("error");
		expect(result.error).toContain("Unknown action tool");
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/agent/src/action-tools/executor.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement executor.ts**

Create `packages/agent/src/action-tools/executor.ts`:

```typescript
// agent/src/action-tools/executor.ts
import type { ActionResult, PendingAction } from "@devops-agent/shared";
import { executeSlackNotify, isSlackConfigured } from "./slack-notifier.ts";
import { executeCreateTicket, isLinearConfigured } from "./ticket-creator.ts";

export function getAvailableActionTools(): string[] {
	const available: string[] = [];
	if (isSlackConfigured()) available.push("notify-slack");
	if (isLinearConfigured()) available.push("create-ticket");
	return available;
}

export async function executeAction(
	action: PendingAction,
	context: { reportContent: string; threadId: string },
): Promise<ActionResult> {
	const base = { actionId: action.id, tool: action.tool };

	try {
		if (action.tool === "notify-slack") {
			const params = action.params as {
				channel?: string;
				message?: string;
				severity?: string;
				thread_ts?: string;
			};
			const result = await executeSlackNotify({
				channel: String(params.channel ?? ""),
				message: String(params.message ?? ""),
				severity: String(params.severity ?? "info"),
				thread_ts: params.thread_ts ? String(params.thread_ts) : undefined,
				reportContent: context.reportContent,
			});

			return result.sent
				? { ...base, status: "success", result: { timestamp: result.timestamp, channel: result.channel } }
				: { ...base, status: "error", error: "Slack message delivery failed" };
		}

		if (action.tool === "create-ticket") {
			const params = action.params as {
				title?: string;
				description?: string;
				severity?: string;
				affected_services?: string[];
				datasources_queried?: string[];
			};
			const result = await executeCreateTicket({
				title: String(params.title ?? "Untitled Incident"),
				description: String(params.description ?? ""),
				severity: String(params.severity ?? "medium"),
				affected_services: params.affected_services,
				datasources_queried: params.datasources_queried,
				reportContent: context.reportContent,
			});

			return result.ticket_id
				? { ...base, status: "success", result: { ticket_id: result.ticket_id, url: result.url } }
				: { ...base, status: "error", error: "Ticket creation failed" };
		}

		return { ...base, status: "error", error: `Unknown action tool: ${action.tool}` };
	} catch (err) {
		return { ...base, status: "error", error: err instanceof Error ? err.message : String(err) };
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/agent/src/action-tools/executor.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Export from agent index**

Add to `packages/agent/src/index.ts`:

```typescript
export { executeAction, getAvailableActionTools } from "./action-tools/executor.ts";
```

- [ ] **Step 6: Run typecheck**

Run: `bun run --filter '@devops-agent/agent' typecheck`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add packages/agent/src/action-tools/executor.ts packages/agent/src/action-tools/executor.test.ts packages/agent/src/index.ts
git commit -m "SIO-634, SIO-635: Implement unified action executor with routing"
```

---

### Task 7: Knowledge Base -- Gitagent Types and Index Schema

**Files:**
- Modify: `packages/gitagent-bridge/src/types.ts`
- Modify: `packages/gitagent-bridge/src/index.ts`

- [ ] **Step 1: Add KnowledgeIndexSchema and KnowledgeCategorySchema**

Append to `packages/gitagent-bridge/src/types.ts`:

```typescript
export const KnowledgeCategorySchema = z.object({
	path: z.string(),
	description: z.string(),
});

export const KnowledgeIndexSchema = z.object({
	name: z.string(),
	description: z.string(),
	version: z.string(),
	categories: z.record(z.string(), KnowledgeCategorySchema),
});
export type KnowledgeIndex = z.infer<typeof KnowledgeIndexSchema>;
```

- [ ] **Step 2: Export from gitagent-bridge index**

Add to `packages/gitagent-bridge/src/index.ts`:

```typescript
export {
	type KnowledgeIndex,
	KnowledgeIndexSchema,
	KnowledgeCategorySchema,
} from "./types.ts";
```

Also update the existing types.ts export block to include the new types.

- [ ] **Step 3: Run typecheck**

Run: `bun run --filter '@devops-agent/gitagent-bridge' typecheck`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add packages/gitagent-bridge/src/types.ts packages/gitagent-bridge/src/index.ts
git commit -m "SIO-638: Add KnowledgeIndex and KnowledgeCategory Zod schemas"
```

---

### Task 8: Knowledge Base -- Loader in manifest-loader.ts

**Files:**
- Modify: `packages/gitagent-bridge/src/manifest-loader.ts`
- Modify: `packages/gitagent-bridge/src/index.ts`
- Test: `packages/gitagent-bridge/src/index.test.ts`

- [ ] **Step 1: Write failing tests for knowledge loading**

Add to `packages/gitagent-bridge/src/index.test.ts`, inside a new `describe("knowledge-loader")` block after the existing `describe("compliance")` block:

```typescript
describe("knowledge-loader", () => {
	test("loads knowledge entries from agent directory", () => {
		const agent = loadAgent(AGENTS_DIR);
		expect(agent.knowledge).toBeDefined();
		expect(Array.isArray(agent.knowledge)).toBe(true);
	});

	test("loads runbook entries with correct category", () => {
		const agent = loadAgent(AGENTS_DIR);
		const runbooks = agent.knowledge.filter((k) => k.category === "runbooks");
		expect(runbooks.length).toBeGreaterThanOrEqual(1);
		for (const entry of runbooks) {
			expect(entry.filename).toMatch(/\.md$/);
			expect(entry.content.length).toBeGreaterThan(0);
		}
	});

	test("loads systems-map entries", () => {
		const agent = loadAgent(AGENTS_DIR);
		const systemsMap = agent.knowledge.filter((k) => k.category === "systems-map");
		expect(systemsMap.length).toBeGreaterThanOrEqual(1);
	});

	test("loads slo-policies entries", () => {
		const agent = loadAgent(AGENTS_DIR);
		const slo = agent.knowledge.filter((k) => k.category === "slo-policies");
		expect(slo.length).toBeGreaterThanOrEqual(1);
	});

	test("skips .gitkeep files", () => {
		const agent = loadAgent(AGENTS_DIR);
		const gitkeeps = agent.knowledge.filter((k) => k.filename === ".gitkeep");
		expect(gitkeeps.length).toBe(0);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/gitagent-bridge/src/index.test.ts`
Expected: FAIL on knowledge-loader tests (agent.knowledge undefined, or no entries found since knowledge files don't exist yet)

- [ ] **Step 3: Add KnowledgeEntry type and knowledge loading to manifest-loader.ts**

In `packages/gitagent-bridge/src/manifest-loader.ts`, add import:

```typescript
import { KnowledgeIndexSchema } from "./types.ts";
```

Add the `KnowledgeEntry` interface:

```typescript
export interface KnowledgeEntry {
	category: string;
	filename: string;
	content: string;
}
```

Update the `LoadedAgent` interface to include knowledge:

```typescript
export interface LoadedAgent {
	manifest: AgentManifest;
	soul: string;
	rules: string;
	tools: ToolDefinition[];
	skills: Map<string, string>;
	subAgents: Map<string, LoadedAgent>;
	knowledge: KnowledgeEntry[];
}
```

Add the knowledge loading function:

```typescript
function loadKnowledge(agentDir: string): KnowledgeEntry[] {
	const knowledgeDir = join(agentDir, "knowledge");
	const indexPath = join(knowledgeDir, "index.yaml");

	if (!existsSync(indexPath)) return [];

	const indexYaml = parse(readFileSync(indexPath, "utf-8"));
	const index = KnowledgeIndexSchema.safeParse(indexYaml);
	if (!index.success) return [];

	const entries: KnowledgeEntry[] = [];
	for (const [category, config] of Object.entries(index.data.categories)) {
		const categoryDir = join(knowledgeDir, config.path);
		if (!isDirectory(categoryDir)) continue;

		const files = readdirSync(categoryDir).filter(
			(f) => f.endsWith(".md") && f !== ".gitkeep",
		);
		for (const file of files) {
			const content = readFileSync(join(categoryDir, file), "utf-8").trim();
			if (content) {
				entries.push({ category, filename: file, content });
			}
		}
	}

	return entries;
}
```

Update the `loadAgent` function return to include knowledge:

```typescript
const knowledge = loadKnowledge(agentDir);

return { manifest, soul, rules, tools, skills, subAgents, knowledge };
```

- [ ] **Step 4: Update gitagent-bridge/src/index.ts exports**

Add `KnowledgeEntry` to the manifest-loader export:

```typescript
export { type KnowledgeEntry, type LoadedAgent, loadAgent } from "./manifest-loader.ts";
```

- [ ] **Step 5: Note -- tests will still fail because knowledge files don't exist yet. That's expected. We'll create them in Task 9 and run tests after.**

- [ ] **Step 6: Run typecheck to confirm the code compiles**

Run: `bun run --filter '@devops-agent/gitagent-bridge' typecheck`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add packages/gitagent-bridge/src/manifest-loader.ts packages/gitagent-bridge/src/index.ts packages/gitagent-bridge/src/index.test.ts
git commit -m "SIO-638: Add knowledge loading to loadAgent() and KnowledgeEntry type"
```

---

### Task 9: Knowledge Base -- Author Content

**Files:**
- Create: `agents/incident-analyzer/knowledge/runbooks/high-error-rate.md`
- Create: `agents/incident-analyzer/knowledge/runbooks/kafka-consumer-lag.md`
- Create: `agents/incident-analyzer/knowledge/runbooks/database-slow-queries.md`
- Create: `agents/incident-analyzer/knowledge/systems-map/service-dependencies.md`
- Create: `agents/incident-analyzer/knowledge/slo-policies/api-latency-slo.md`

- [ ] **Step 1: Create runbooks/high-error-rate.md**

```markdown
# High Error Rate Investigation

## Symptoms
- Elevated 5xx responses on API gateway (Kong Konnect)
- Error rate exceeding SLO threshold (>1% of requests)
- Backend service health checks failing

## Investigation Steps

### 1. Check API Gateway Error Distribution
Query Kong Konnect for status code breakdown by route and service over the last 30 minutes. Look for patterns: is the error rate uniform or concentrated on specific routes?

### 2. Identify Affected Backend Services
Cross-reference erroring routes with upstream service targets. Check if errors correlate with a specific deployment or instance.

### 3. Check Elasticsearch for Application Logs
Search for ERROR and FATAL log entries in the same time window. Filter by the affected service names. Look for stack traces, connection refused, or timeout patterns.

### 4. Verify Database Connectivity
If backend errors suggest database issues, check Couchbase Capella cluster health. Look for query timeouts, bucket memory pressure, or rebalancing operations.

### 5. Check Kafka for Async Processing Failures
If the erroring service produces or consumes Kafka messages, check consumer lag and dead letter topics. Stalled consumers can cause cascading timeouts.

## Escalation Criteria
- Error rate >5% sustained for 10+ minutes: page on-call
- Error rate >25%: escalate to incident commander
- Single service >50% error rate: consider emergency rollback (requires human approval)

## Safe Read-Only Checks
All investigation steps above are read-only. No write operations needed during investigation phase.
```

- [ ] **Step 2: Create runbooks/kafka-consumer-lag.md**

```markdown
# Kafka Consumer Lag Investigation

## Symptoms
- Consumer group lag exceeding threshold (>10,000 messages)
- Processing latency increasing
- Downstream services showing stale data

## Investigation Steps

### 1. Identify Lagging Consumer Groups
List all consumer groups and their lag per partition. Determine if lag is growing, stable, or recovering.

### 2. Check Consumer Instance Health
Verify the number of active consumers in the group matches expected count. Look for recent rebalancing events that may indicate consumer crashes or slow joins.

### 3. Analyze Partition Distribution
Check if lag is concentrated on specific partitions (hot partition) or distributed across all partitions (throughput bottleneck).

### 4. Check Producer Throughput
Compare current producer rate with historical baseline. A sudden spike in production rate can cause temporary lag even with healthy consumers.

### 5. Cross-Reference with Backend Services
Check Elasticsearch logs for the consumer application. Look for processing errors, deserialization failures, or external dependency timeouts that slow message processing.

### 6. Check for Dead Letter Topic Activity
If the consumer has a DLQ configured, check message count and recent entries. Poison messages can stall processing of an entire partition.

## Escalation Criteria
- Lag >100,000 and growing: page on-call
- Consumer group has 0 active members: immediate escalation
- Lag causing user-visible staleness: notify product team

## Recovery Actions (Require Human Approval)
- Reset consumer offset to latest (data loss trade-off)
- Scale consumer instances
- Temporarily increase partition count
```

- [ ] **Step 3: Create runbooks/database-slow-queries.md**

```markdown
# Couchbase Slow Query Investigation

## Symptoms
- N1QL query latency exceeding SLO (P99 > 500ms)
- Application timeouts when accessing Couchbase
- Capella cluster CPU or memory alerts

## Investigation Steps

### 1. Identify Slow Queries
Use Couchbase system catalog to find queries exceeding latency thresholds. Sort by execution time and frequency to prioritize investigation.

### 2. Analyze Query Execution Plans
Run EXPLAIN on the slowest queries. Look for full bucket scans (PrimaryScan), missing indexes, or inefficient key lookups.

### 3. Check Index Health
Verify all expected indexes exist and are online. Check for indexes in building state or with high mutation queue. Stale indexes produce slow reads.

### 4. Review Bucket Memory Quotas
Check resident ratio for the affected bucket. If resident ratio drops below 20%, queries hit disk more frequently, increasing latency.

### 5. Check for Hot Keys or Vbucket Imbalance
Identify if specific documents or vbuckets are receiving disproportionate traffic. Hot keys can saturate a single node.

### 6. Cross-Reference with Application Logs
Search Elasticsearch for connection pool exhaustion, timeout errors, or CAS conflict patterns from the application layer.

## Escalation Criteria
- Bucket memory resident ratio below 10%: page on-call
- Index build stuck for >30 minutes: escalate to DBA
- Query timeout rate >10%: consider circuit breaker activation (requires human approval)

## Safe Read-Only Checks
All investigation queries use system catalogs and EXPLAIN -- no data mutation.
```

- [ ] **Step 4: Create systems-map/service-dependencies.md**

```markdown
# Service Dependency Map

## Overview
The monitored infrastructure consists of 4 primary data planes connected through service dependencies. Each plane is observed through a dedicated MCP server.

## Dependency Graph

```
User Traffic
    |
    v
[Kong Konnect API Gateway] -- (routes, rate limits, auth plugins)
    |
    +---> [Backend Services] -- (application layer)
    |         |
    |         +---> [Couchbase Capella] -- (document store, N1QL queries)
    |         |
    |         +---> [Kafka Cluster] -- (async messaging, event streaming)
    |                   |
    |                   +---> [Downstream Consumers] -- (batch processing, analytics)
    |
    +---> [Elasticsearch] -- (log aggregation, observability, search)
```

## Data Flow Patterns

### Synchronous Path
1. Request arrives at Kong Konnect gateway
2. Gateway applies rate limiting, authentication, and routing
3. Request forwarded to backend service
4. Backend queries Couchbase for data
5. Response returned through gateway

### Asynchronous Path
1. Backend service produces message to Kafka topic
2. Consumer groups process messages independently
3. Consumers may query Couchbase or Elasticsearch as part of processing
4. Results stored or forwarded to downstream systems

### Observability Path
1. All services emit structured logs
2. Logs aggregated in Elasticsearch
3. Kong Konnect logs API request metrics separately
4. Couchbase exposes system vitals and slow query logs

## Failure Correlation Patterns

| Symptom | Primary Source | Check Also |
|---------|---------------|------------|
| 5xx errors on API | Kong Konnect | Backend logs in Elastic, Couchbase latency |
| Stale data in responses | Kafka consumer lag | Couchbase query timeouts |
| Slow API responses | Couchbase slow queries | Kafka backpressure, Kong rate limits |
| Missing logs | Elasticsearch cluster health | Backend service health |
```

- [ ] **Step 5: Create slo-policies/api-latency-slo.md**

```markdown
# API Latency SLO Definitions

## Service Tiers

### Tier 1: User-Facing APIs (via Kong Konnect)
- **P50 latency**: < 100ms
- **P99 latency**: < 500ms
- **Error rate**: < 0.1%
- **Availability**: 99.95%
- **Error budget**: 21.9 minutes/month

### Tier 2: Internal Service APIs
- **P50 latency**: < 200ms
- **P99 latency**: < 1000ms
- **Error rate**: < 0.5%
- **Availability**: 99.9%
- **Error budget**: 43.8 minutes/month

### Tier 3: Batch/Async Processing (Kafka Consumers)
- **Processing lag**: < 30 seconds (P99)
- **Message failure rate**: < 0.01%
- **Consumer group availability**: 99.9%

## Database SLOs (Couchbase Capella)

### Query Performance
- **Simple key lookups**: < 5ms P99
- **N1QL queries (indexed)**: < 100ms P99
- **N1QL queries (complex joins)**: < 500ms P99

### Cluster Health
- **Bucket resident ratio**: > 20%
- **Rebalance duration**: < 15 minutes
- **Node failover detection**: < 30 seconds

## Breach Escalation Procedures

### Warning (>50% error budget consumed)
- Notify engineering channel
- Begin investigation using read-only diagnostics
- No immediate action required

### Critical (>80% error budget consumed)
- Page on-call engineer
- Full incident investigation across all data sources
- Prepare rollback plan (requires human approval)

### Exhausted (100% error budget consumed)
- Incident declared
- All non-essential deployments frozen
- Root cause analysis initiated
- Create tracking ticket for post-mortem
```

- [ ] **Step 6: Run the knowledge loader tests**

Run: `bun test packages/gitagent-bridge/src/index.test.ts`
Expected: All tests PASS including the new knowledge-loader tests

- [ ] **Step 7: Commit**

```bash
git add agents/incident-analyzer/knowledge/runbooks/ agents/incident-analyzer/knowledge/systems-map/ agents/incident-analyzer/knowledge/slo-policies/
git commit -m "SIO-638: Author initial knowledge base content for runbooks, systems-map, and SLO policies"
```

---

### Task 10: Knowledge Base -- Inject into System Prompt

**Files:**
- Modify: `packages/gitagent-bridge/src/skill-loader.ts`
- Test: `packages/gitagent-bridge/src/index.test.ts`

- [ ] **Step 1: Write failing test for knowledge in system prompt**

Add to the existing `describe("skill-loader")` block in `packages/gitagent-bridge/src/index.test.ts`:

```typescript
	test("includes knowledge base in system prompt", () => {
		const agent = loadAgent(AGENTS_DIR);
		const prompt = buildSystemPrompt(agent);
		expect(prompt).toContain("## Knowledge Base");
		expect(prompt).toContain("### Runbooks");
		expect(prompt).toContain("high-error-rate.md");
	});

	test("sub-agent prompt does not include knowledge", () => {
		const agent = loadAgent(AGENTS_DIR);
		const elastic = agent.subAgents.get("elastic-agent") as ReturnType<typeof loadAgent>;
		const prompt = buildSystemPrompt(elastic);
		expect(prompt).not.toContain("## Knowledge Base");
	});
```

- [ ] **Step 2: Run tests to verify the knowledge test fails**

Run: `bun test packages/gitagent-bridge/src/index.test.ts`
Expected: New knowledge prompt tests FAIL (prompt doesn't contain "## Knowledge Base")

- [ ] **Step 3: Implement buildKnowledgeSection in skill-loader.ts**

Replace the contents of `packages/gitagent-bridge/src/skill-loader.ts`:

```typescript
// gitagent-bridge/src/skill-loader.ts
import type { KnowledgeEntry } from "./manifest-loader.ts";
import type { LoadedAgent } from "./manifest-loader.ts";

function buildKnowledgeSection(knowledge: KnowledgeEntry[]): string {
	const byCategory = new Map<string, KnowledgeEntry[]>();
	for (const entry of knowledge) {
		const existing = byCategory.get(entry.category) ?? [];
		existing.push(entry);
		byCategory.set(entry.category, existing);
	}

	const sections: string[] = ["## Knowledge Base"];
	for (const [category, entries] of byCategory) {
		const heading = category
			.split("-")
			.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
			.join(" ");
		sections.push(`### ${heading}`);
		for (const entry of entries) {
			sections.push(`#### ${entry.filename}\n\n${entry.content}`);
		}
	}

	return sections.join("\n\n");
}

export function buildSystemPrompt(agent: LoadedAgent, activeSkills?: string[]): string {
	const sections: string[] = [];

	if (agent.soul) {
		sections.push(agent.soul.trim());
	}

	if (agent.rules) {
		sections.push(agent.rules.trim());
	}

	const skillsToLoad = activeSkills ?? [...agent.skills.keys()];
	for (const skillName of skillsToLoad) {
		const content = agent.skills.get(skillName);
		if (content) {
			const bodyOnly = content.replace(/^---[\s\S]*?---\s*/m, "").trim();
			if (bodyOnly) {
				sections.push(`## Skill: ${skillName}\n\n${bodyOnly}`);
			}
		}
	}

	if (agent.knowledge.length > 0) {
		sections.push(buildKnowledgeSection(agent.knowledge));
	}

	return sections.join("\n\n---\n\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gitagent-bridge/src/index.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/gitagent-bridge/src/skill-loader.ts packages/gitagent-bridge/src/index.test.ts
git commit -m "SIO-638: Inject knowledge base into system prompt via buildSystemPrompt()"
```

---

### Task 11: Mitigation Node -- Action Proposals and Knowledge-Aware Prompting

**Files:**
- Modify: `packages/agent/src/mitigation.ts`
- Modify: `packages/agent/src/prompt-context.ts`

- [ ] **Step 1: Add knowledge helper to prompt-context.ts**

In `packages/agent/src/prompt-context.ts`, add:

```typescript
export function getRunbookFilenames(): string[] {
	const agent = getAgent();
	return agent.knowledge
		.filter((k) => k.category === "runbooks")
		.map((k) => k.filename);
}
```

- [ ] **Step 2: Add LlmRole for action proposal generation**

In `packages/agent/src/llm.ts`, add `"actionProposal"` to the `LlmRole` type union:

```typescript
export type LlmRole =
	| "orchestrator"
	| "classifier"
	| "subAgent"
	| "aggregator"
	| "responder"
	| "entityExtractor"
	| "followUp"
	| "normalizer"
	| "mitigation"
	| "actionProposal";
```

Add to `ROLE_OVERRIDES`:

```typescript
	actionProposal: { temperature: 0, maxTokens: 512 },
```

- [ ] **Step 3: Update mitigation.ts with knowledge-aware prompting and action proposals**

Replace the contents of `packages/agent/src/mitigation.ts`:

```typescript
// agent/src/mitigation.ts

import { getLogger } from "@devops-agent/observability";
import type { MitigationSteps, PendingAction } from "@devops-agent/shared";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { getAvailableActionTools } from "./action-tools/executor.ts";
import { createLlm } from "./llm.ts";
import { getRunbookFilenames } from "./prompt-context.ts";
import type { AgentStateType } from "./state.ts";

const logger = getLogger("agent:mitigation");

const MitigationOutputSchema = z.object({
	investigate: z.array(z.string()),
	monitor: z.array(z.string()),
	escalate: z.array(z.string()),
	relatedRunbooks: z.array(z.string()),
});

const ActionProposalSchema = z.object({
	actions: z.array(
		z.object({
			tool: z.enum(["notify-slack", "create-ticket"]),
			params: z.record(z.string(), z.unknown()),
			reason: z.string(),
		}),
	),
});

function buildMitigationPrompt(): string {
	const runbooks = getRunbookFilenames();
	const runbookHint =
		runbooks.length > 0
			? `\n\nAvailable runbooks: ${runbooks.join(", ")}\nReference relevant runbooks by filename in relatedRunbooks.`
			: '\nUse "knowledge/runbooks/<topic>.md" format for relatedRunbooks.';

	return `Based on the incident analysis report below, suggest safe, non-destructive mitigation steps.

Categorize each suggestion into exactly one category:
- investigate: additional read-only queries or checks to narrow the root cause
- monitor: specific metrics, thresholds, or dashboards to watch
- escalate: actions requiring human approval (scaling, rollback, config changes)
- relatedRunbooks: file paths or titles of relevant runbooks${runbookHint}

RULES:
- Never suggest destructive operations (restart, delete, drop, reset, truncate)
- All "investigate" suggestions must be read-only and safe to automate
- All "escalate" suggestions must explicitly state they require human approval
- Limit to 3-5 suggestions per category
- If the report confidence is low, lead investigate with broader diagnostic steps

Return ONLY valid JSON matching: { investigate: string[], monitor: string[], escalate: string[], relatedRunbooks: string[] }`;
}

function buildActionProposalPrompt(availableTools: string[]): string {
	const toolDescs: string[] = [];
	if (availableTools.includes("notify-slack")) {
		toolDescs.push(
			'- notify-slack: params { channel (string), message (string, concise summary), severity (critical|high|medium|low|info) }',
		);
	}
	if (availableTools.includes("create-ticket")) {
		toolDescs.push(
			'- create-ticket: params { title (string, under 80 chars), description (string, structured summary), severity (critical|high|medium|low), affected_services (string[]), datasources_queried (string[]) }',
		);
	}

	return `Based on the incident analysis below, suggest action tool invocations if the severity warrants it.

Available tools:
${toolDescs.join("\n")}

RULES:
- Only suggest actions for high or critical severity incidents
- For notify-slack: write a concise incident summary as the message, not the full report
- For create-ticket: write a clear title (under 80 chars) and structured description
- Include a brief reason explaining why this action is warranted
- If the incident does not warrant action, return an empty actions array

Return ONLY valid JSON matching: { actions: [{ tool, params, reason }] }`;
}

export async function proposeMitigation(
	state: AgentStateType,
	config?: RunnableConfig,
): Promise<Partial<AgentStateType>> {
	const report = state.finalAnswer;
	if (!report || report.length < 50) {
		logger.info("No substantial report to generate mitigations from");
		return {
			mitigationSteps: { investigate: [], monitor: [], escalate: [], relatedRunbooks: [] },
			pendingActions: [],
		};
	}

	const confidence = state.confidenceScore;
	const confidenceHint = confidence > 0 && confidence < 0.6
		? "\n\nNOTE: Report confidence is below 0.6. Lead with broader investigation steps and explicitly note data gaps."
		: "";

	const queriedSources = state.targetDataSources;
	const sourceContext = queriedSources.length > 0
		? `\nQueried datasources: ${queriedSources.join(", ")}`
		: "";

	const truncated = report.slice(0, 3000);
	let mitigationSteps: MitigationSteps = { investigate: [], monitor: [], escalate: [], relatedRunbooks: [] };
	let pendingActions: PendingAction[] = [];

	// Step 1: Generate mitigation steps
	const llm = createLlm("mitigation");
	try {
		const response = await llm.invoke(
			[
				{ role: "system", content: `${buildMitigationPrompt()}${confidenceHint}${sourceContext}` },
				{ role: "human", content: truncated },
			],
			config,
		);

		const text = String(response.content);
		const jsonMatch = text.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			const parsed = MitigationOutputSchema.parse(JSON.parse(jsonMatch[0]));
			mitigationSteps = { ...parsed };
			logger.info(
				{
					investigate: mitigationSteps.investigate.length,
					monitor: mitigationSteps.monitor.length,
					escalate: mitigationSteps.escalate.length,
					runbooks: mitigationSteps.relatedRunbooks.length,
				},
				"Mitigation steps generated",
			);
		} else {
			logger.warn("Failed to parse mitigation JSON from LLM response");
		}
	} catch (error) {
		logger.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"Mitigation generation failed",
		);
	}

	// Step 2: Generate action proposals (only if action tools are configured)
	const availableTools = getAvailableActionTools();
	const severity = state.normalizedIncident?.severity;
	const shouldPropose = availableTools.length > 0 && (severity === "critical" || severity === "high");

	if (shouldPropose) {
		const actionLlm = createLlm("actionProposal");
		try {
			const response = await actionLlm.invoke(
				[
					{ role: "system", content: buildActionProposalPrompt(availableTools) },
					{
						role: "human",
						content: `Severity: ${severity}\nConfidence: ${confidence}\nDatasources: ${queriedSources.join(", ")}\n\n${truncated}`,
					},
				],
				config,
			);

			const text = String(response.content);
			const jsonMatch = text.match(/\{[\s\S]*\}/);
			if (jsonMatch) {
				const parsed = ActionProposalSchema.parse(JSON.parse(jsonMatch[0]));
				pendingActions = parsed.actions
					.filter((a) => availableTools.includes(a.tool))
					.map((a) => ({
						id: crypto.randomUUID(),
						tool: a.tool,
						params: a.params,
						reason: a.reason,
					}));
				logger.info({ count: pendingActions.length }, "Action proposals generated");
			}
		} catch (error) {
			logger.warn(
				{ error: error instanceof Error ? error.message : String(error) },
				"Action proposal generation failed",
			);
		}
	}

	return { mitigationSteps, pendingActions };
}
```

- [ ] **Step 4: Run typecheck**

Run: `bun run --filter '@devops-agent/agent' typecheck`
Expected: No errors

- [ ] **Step 5: Run all agent tests**

Run: `bun test packages/agent/`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/mitigation.ts packages/agent/src/prompt-context.ts packages/agent/src/llm.ts
git commit -m "SIO-634, SIO-635, SIO-638: Knowledge-aware mitigation prompts and action proposals"
```

---

### Task 12: SSE Stream -- Emit pending_actions Event

**Files:**
- Modify: `apps/web/src/routes/api/agent/stream/+server.ts`

- [ ] **Step 1: Emit pending_actions after proposeMitigation node completes**

In `apps/web/src/routes/api/agent/stream/+server.ts`, find the `if (event.event === "on_chain_end"` block. After the existing `if (event.name === "followUp")` block and the `if (event.name === "checkConfidence")` block, add:

```typescript
										// SIO-634, SIO-635: Emit pending action proposals for user confirmation
										if (event.name === "proposeMitigation") {
											const pendingActions = event.data?.output?.pendingActions;
											if (Array.isArray(pendingActions) && pendingActions.length > 0) {
												send({ type: "pending_actions", actions: pendingActions });
											}
										}
```

- [ ] **Step 2: Run typecheck**

Run: `bun run --filter '@devops-agent/web' typecheck`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/api/agent/stream/+server.ts
git commit -m "SIO-634, SIO-635: Emit pending_actions SSE event from proposeMitigation node"
```

---

### Task 13: API Endpoints -- Action Execution and Available Tools

**Files:**
- Create: `apps/web/src/routes/api/agent/actions/+server.ts`
- Create: `apps/web/src/routes/api/agent/actions/available/+server.ts`

- [ ] **Step 1: Create POST /api/agent/actions endpoint**

Create `apps/web/src/routes/api/agent/actions/+server.ts`:

```typescript
// apps/web/src/routes/api/agent/actions/+server.ts
import { executeAction } from "@devops-agent/agent";
import { PendingActionSchema } from "@devops-agent/shared";
import { json } from "@sveltejs/kit";
import { z } from "zod";
import type { RequestHandler } from "./$types";

const ExecuteActionRequestSchema = z.object({
	action: PendingActionSchema,
	reportContent: z.string(),
	threadId: z.string(),
});

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = ExecuteActionRequestSchema.parse(await request.json());
		const result = await executeAction(body.action, {
			reportContent: body.reportContent,
			threadId: body.threadId,
		});
		return json(result);
	} catch (err) {
		if (err instanceof z.ZodError) {
			return json({ error: "Invalid request", details: err.issues }, { status: 400 });
		}
		return json(
			{ error: err instanceof Error ? err.message : "Unknown error" },
			{ status: 500 },
		);
	}
};
```

- [ ] **Step 2: Create GET /api/agent/actions/available endpoint**

Create `apps/web/src/routes/api/agent/actions/available/+server.ts`:

```typescript
// apps/web/src/routes/api/agent/actions/available/+server.ts
import { getAvailableActionTools } from "@devops-agent/agent";
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
	return json({ tools: getAvailableActionTools() });
};
```

- [ ] **Step 3: Run typecheck**

Run: `bun run --filter '@devops-agent/web' typecheck`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/api/agent/actions/+server.ts apps/web/src/routes/api/agent/actions/available/+server.ts
git commit -m "SIO-634, SIO-635: Add action execution and available tools API endpoints"
```

---

### Task 14: Frontend Store -- Handle pending_actions Events

**Files:**
- Modify: `apps/web/src/lib/stores/agent.svelte.ts`

- [ ] **Step 1: Add pending actions state and handlers**

In `apps/web/src/lib/stores/agent.svelte.ts`:

Add import at top:

```typescript
import type { ActionResult, DataSourceContext, PendingAction, StreamEvent } from "@devops-agent/shared";
```

(Replace the existing `import type { DataSourceContext, StreamEvent }` line.)

Inside `createAgentStore()`, add state variables after `let pendingAttachments`:

```typescript
	let pendingActions = $state<PendingAction[]>([]);
	let actionResults = $state<ActionResult[]>([]);
```

In `handleEvent`, add a new case before `case "done"`:

```typescript
			case "pending_actions":
				pendingActions = event.actions;
				break;
```

Add `executeAction` and `dismissAction` functions after `cancelStream`:

```typescript
	async function executeAction(action: PendingAction, reportContent: string) {
		try {
			const res = await fetch("/api/agent/actions", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					action,
					reportContent,
					threadId,
				}),
			});
			const result: ActionResult = await res.json();
			actionResults = [...actionResults, result];
			pendingActions = pendingActions.filter((a) => a.id !== action.id);
			return result;
		} catch {
			return null;
		}
	}

	function dismissAction(actionId: string) {
		pendingActions = pendingActions.filter((a) => a.id !== actionId);
	}
```

In `clearChat`, add:

```typescript
		pendingActions = [];
		actionResults = [];
```

In the return object, add:

```typescript
		get pendingActions() {
			return pendingActions;
		},
		get actionResults() {
			return actionResults;
		},
		executeAction,
		dismissAction,
```

- [ ] **Step 2: Run typecheck**

Run: `bun run --filter '@devops-agent/web' typecheck`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/stores/agent.svelte.ts
git commit -m "SIO-634, SIO-635: Handle pending_actions in agent store with execute/dismiss"
```

---

### Task 15: Frontend -- ActionConfirmationCard Component

**Files:**
- Create: `apps/web/src/lib/components/ActionConfirmationCard.svelte`
- Modify: `apps/web/src/lib/components/ChatMessage.svelte`

- [ ] **Step 1: Create ActionConfirmationCard.svelte**

Create `apps/web/src/lib/components/ActionConfirmationCard.svelte`:

```svelte
<script lang="ts">
// apps/web/src/lib/components/ActionConfirmationCard.svelte
import type { ActionResult, PendingAction } from "@devops-agent/shared";
import Icon from "./Icon.svelte";

let {
	action,
	onApprove,
	onDismiss,
	result,
}: {
	action: PendingAction;
	onApprove: (action: PendingAction) => void;
	onDismiss: (actionId: string) => void;
	result?: ActionResult;
} = $props();

let isExecuting = $state(false);

const toolLabels: Record<string, string> = {
	"notify-slack": "Send Slack Notification",
	"create-ticket": "Create Incident Ticket",
};

const toolIcons: Record<string, string> = {
	"notify-slack": "message-square",
	"create-ticket": "ticket",
};

const severityColors: Record<string, string> = {
	critical: "bg-red-100 text-red-800 border-red-200",
	high: "bg-orange-100 text-orange-800 border-orange-200",
	medium: "bg-yellow-100 text-yellow-800 border-yellow-200",
	low: "bg-blue-100 text-blue-800 border-blue-200",
	info: "bg-gray-100 text-gray-600 border-gray-200",
};

function getSeverity(): string {
	return String(action.params.severity ?? "medium");
}

async function handleApprove() {
	isExecuting = true;
	onApprove(action);
}
</script>

{#if result}
	<div class="rounded-lg border px-3 py-2 mt-2 {result.status === 'success' ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'}">
		<div class="flex items-center gap-2 text-sm">
			<Icon name={result.status === "success" ? "check" : "x"} class="w-4 h-4 {result.status === 'success' ? 'text-green-600' : 'text-red-600'}" />
			<span class="font-medium {result.status === 'success' ? 'text-green-800' : 'text-red-800'}">
				{toolLabels[action.tool] ?? action.tool}: {result.status === "success" ? "Completed" : "Failed"}
			</span>
			{#if result.status === "success" && result.result?.url}
				<a href={String(result.result.url)} target="_blank" rel="noopener noreferrer" class="text-tommy-navy underline ml-auto">
					View
				</a>
			{/if}
			{#if result.status === "error" && result.error}
				<span class="text-red-600 ml-auto">{result.error}</span>
			{/if}
		</div>
	</div>
{:else}
	<div class="rounded-lg border border-gray-200 bg-white px-3 py-3 mt-2 shadow-sm">
		<div class="flex items-center gap-2 mb-2">
			<Icon name={toolIcons[action.tool] ?? "tool"} class="w-4 h-4 text-tommy-navy" />
			<span class="text-sm font-semibold text-tommy-navy">{toolLabels[action.tool] ?? action.tool}</span>
			<span class="text-xs px-2 py-0.5 rounded-full border {severityColors[getSeverity()] ?? severityColors.medium}">
				{getSeverity()}
			</span>
		</div>

		<p class="text-xs text-gray-500 mb-2">{action.reason}</p>

		{#if action.tool === "notify-slack"}
			<div class="text-sm space-y-1 mb-3">
				<div><span class="text-gray-500">Channel:</span> {action.params.channel ?? "(default)"}</div>
				<div class="bg-gray-50 rounded p-2 text-xs whitespace-pre-wrap">{action.params.message}</div>
			</div>
		{/if}

		{#if action.tool === "create-ticket"}
			<div class="text-sm space-y-1 mb-3">
				<div><span class="text-gray-500">Title:</span> {action.params.title}</div>
				<div class="bg-gray-50 rounded p-2 text-xs whitespace-pre-wrap max-h-24 overflow-y-auto">{action.params.description}</div>
			</div>
		{/if}

		<div class="flex gap-2">
			<button
				onclick={handleApprove}
				disabled={isExecuting}
				class="px-3 py-1 text-xs font-medium rounded bg-tommy-navy text-white hover:bg-tommy-navy/90 disabled:opacity-50 transition-colors"
			>
				{isExecuting ? "Executing..." : "Approve"}
			</button>
			<button
				onclick={() => onDismiss(action.id)}
				disabled={isExecuting}
				class="px-3 py-1 text-xs font-medium rounded border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50 transition-colors"
			>
				Dismiss
			</button>
		</div>
	</div>
{/if}
```

- [ ] **Step 2: Integrate into ChatMessage.svelte**

In `apps/web/src/lib/components/ChatMessage.svelte`:

Add import:

```typescript
import type { ActionResult, PendingAction } from "@devops-agent/shared";
import ActionConfirmationCard from "./ActionConfirmationCard.svelte";
```

Add props:

```typescript
	let {
		message,
		index,
		isLast = false,
		isStreaming = false,
		onSuggestionClick,
		onFeedback,
		pendingActions = [],
		actionResults = [],
		onActionApprove,
		onActionDismiss,
	}: {
		message: ChatMessage;
		index: number;
		isLast?: boolean;
		isStreaming?: boolean;
		onSuggestionClick?: (s: string) => void;
		onFeedback?: (index: number, score: "up" | "down") => void;
		pendingActions?: PendingAction[];
		actionResults?: ActionResult[];
		onActionApprove?: (action: PendingAction) => void;
		onActionDismiss?: (actionId: string) => void;
	} = $props();
```

In the assistant message template, after the `FeedbackBar` block and before the `FollowUpSuggestions` block, add:

```svelte
        {#if !isStreaming && isLast && pendingActions.length > 0 && onActionApprove && onActionDismiss}
          {#each pendingActions as action (action.id)}
            <ActionConfirmationCard
              {action}
              onApprove={onActionApprove}
              onDismiss={onActionDismiss}
              result={actionResults.find((r) => r.actionId === action.id)}
            />
          {/each}
        {/if}
```

- [ ] **Step 3: Wire new props in +page.svelte**

In `apps/web/src/routes/+page.svelte`, update the `<ChatMessage>` inside the `{#each agentStore.messages}` loop (around line 93) to pass action props on the last message:

```svelte
        <ChatMessage
          message={msg}
          index={i}
          isLast={i === agentStore.messages.length - 1}
          isStreaming={false}
          onSuggestionClick={handleSuggestionClick}
          onFeedback={(idx, score) => agentStore.setFeedback(idx, score)}
          pendingActions={i === agentStore.messages.length - 1 ? agentStore.pendingActions : []}
          actionResults={i === agentStore.messages.length - 1 ? agentStore.actionResults : []}
          onActionApprove={(action) => agentStore.executeAction(action, msg.content)}
          onActionDismiss={(id) => agentStore.dismissAction(id)}
        />
```

This passes pending actions and results only to the last message in the list, so confirmation cards render at the bottom of the conversation.

- [ ] **Step 4: Run typecheck**

Run: `bun run --filter '@devops-agent/web' typecheck`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/components/ActionConfirmationCard.svelte apps/web/src/lib/components/ChatMessage.svelte apps/web/src/routes/+page.svelte
git commit -m "SIO-634, SIO-635: Add ActionConfirmationCard component and wire into ChatMessage"
```

---

### Task 16: Full Integration Verification

**Files:** None (verification only)

- [ ] **Step 1: Run all gitagent-bridge tests**

Run: `bun test packages/gitagent-bridge/`
Expected: All tests PASS (including new knowledge-loader and skill-loader knowledge tests)

- [ ] **Step 2: Run all agent tests**

Run: `bun test packages/agent/`
Expected: All tests PASS (including slack-notifier, ticket-creator, executor tests)

- [ ] **Step 3: Run full typecheck**

Run: `bun run typecheck`
Expected: No errors across all packages

- [ ] **Step 4: Run lint**

Run: `bun run lint`
Expected: No errors (run `bun run lint:fix` if formatting issues)

- [ ] **Step 5: Run YAML validation**

Run: `bun run yaml:check`
Expected: All agent YAML definitions valid

- [ ] **Step 6: Commit any lint/format fixes**

```bash
git add -A
git commit -m "SIO-634, SIO-635, SIO-638: Lint and format fixes"
```

(Skip this step if lint produced no changes.)

---

### Task 17: Update Linear Issues

- [ ] **Step 1: Move SIO-634 to In Progress**

Update SIO-634 status to "In Progress" and add implementation note.

- [ ] **Step 2: Move SIO-635 to In Progress**

Update SIO-635 status to "In Progress" and add implementation note.

- [ ] **Step 3: Move SIO-638 to In Progress**

Update SIO-638 status to "In Progress" and add implementation note.
