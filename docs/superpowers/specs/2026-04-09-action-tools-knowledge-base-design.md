# Action Tools & Knowledge Base Design

SIO-634 (notify-slack), SIO-635 (create-ticket), SIO-638 (knowledge base loading)

## Problem

The gitagent definitions declare `notify-slack` and `create-ticket` tools with full YAML schemas and `requires_confirmation: true`, but no runtime execution exists. The `knowledge/` directory has an `index.yaml` catalog with 3 categories but no content and no loader in `loadAgent()`.

## Design Decisions

- **Hybrid execution**: LLM generates action proposals (summary, title, pre-filled params) during the `proposeMitigation` node. Frontend renders confirmation cards. Server executes on user approval.
- **Unified action executor**: Single module handles both tools (and future action tools) with schema validation from tool YAML.
- **Linear for tickets**: Tickets created via Linear API in a dedicated incidents project (separate from the DevOps Incident Analyzer development project). Configured via `LINEAR_TEAM_ID` and `LINEAR_PROJECT_ID` env vars.
- **Slack Bot Token**: `@slack/web-api` for channel flexibility and thread support. Configured via `SLACK_BOT_TOKEN` and `SLACK_DEFAULT_CHANNEL`.
- **Knowledge as context**: Loaded at `loadAgent()` time, injected into system prompts for the mitigation node. No vector embeddings (future optimization).

---

## Section 1: Action Tool Architecture

### New State Fields

Add to `AgentState` in `packages/agent/src/state.ts`:

```typescript
pendingActions: Annotation<PendingAction[]>({
  reducer: (_, next) => next,
  default: () => [],
}),

actionResults: Annotation<ActionResult[]>({
  reducer: (prev, next) => [...prev, ...next],
  default: () => [],
}),
```

Add to `packages/shared/src/agent-state.ts`:

```typescript
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

### Proposal Generation

The existing `proposeMitigation` node in `packages/agent/src/mitigation.ts` is extended. After generating mitigation steps, a second LLM call generates action proposals when severity is `high` or `critical`:

```
Input: finalAnswer + normalizedIncident + mitigationSteps
Output: PendingAction[] (0-2 items: one notify-slack, one create-ticket)
```

The LLM produces:
- **notify-slack**: `{ channel, message (summary), severity }` -- message is a concise incident summary, not the full report
- **create-ticket**: `{ title (under 80 chars), description (structured summary), severity, affected_services, datasources_queried }` -- the full incident report is attached later by the executor

The proposal prompt instructs the LLM to only suggest actions when the analysis warrants them (high/critical severity, clear findings).

### SSE Stream Extension

Add a new `StreamEvent` variant in `packages/shared/src/agent-state.ts`:

```typescript
z.object({
  type: z.literal("pending_actions"),
  actions: z.array(PendingActionSchema),
}),
```

Emitted after the `proposeMitigation` node completes (in `apps/web/src/routes/api/agent/stream/+server.ts`), alongside the existing `node_end` event for `proposeMitigation`.

### Frontend Confirmation Flow

**New component**: `ActionConfirmationCard.svelte` in `apps/web/src/lib/components/`

Renders inside `ChatMessage.svelte` after the assistant response, before `FollowUpSuggestions`. Each pending action shows:
- Tool icon (Slack logo or ticket icon)
- Pre-filled params (editable fields for channel, message, title, description)
- "Approve" and "Dismiss" buttons
- Severity badge with color coding

**Store extension** in `agent.svelte.ts`:
- `pendingActions: PendingAction[]` state field
- `handleEvent` processes `pending_actions` events
- `executeAction(actionId: string, editedParams?: Record<string, unknown>)` sends POST to new API endpoint
- `dismissAction(actionId: string)` removes from pending list

### API Endpoint

**New**: `apps/web/src/routes/api/agent/actions/+server.ts`

```
POST /api/agent/actions
Body: { actionId, tool, params, threadId, reportContent }
Response: { status, result }
```

This endpoint:
1. Validates params against the gitagent tool YAML schema (loaded via `getAgent()`)
2. Checks `requiresApproval()` -- always true for these tools, but enforces the contract
3. Routes to the appropriate executor (Slack or Linear)
4. Returns structured result

---

## Section 2: Slack Integration (SIO-634)

### Package

New file: `packages/agent/src/action-tools/slack-notifier.ts`

### Dependencies

- `@slack/web-api` -- official Slack SDK, lightweight, well-typed

### Configuration

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_DEFAULT_CHANNEL=#incidents
```

Validated via Zod schema in `packages/shared/src/config.ts`:

```typescript
export const SlackConfigSchema = z.object({
  botToken: z.string().startsWith("xoxb-"),
  defaultChannel: z.string(),
});
```

### Execution

```typescript
export async function executeSlackNotify(params: {
  channel: string;
  message: string;
  severity: string;
  thread_ts?: string;
  reportContent?: string;
}): Promise<{ sent: boolean; timestamp: string; channel: string }>
```

- Uses `WebClient` from `@slack/web-api`
- Posts to `params.channel` (falls back to `SLACK_DEFAULT_CHANNEL`)
- Severity-based formatting: color-coded attachment sidebar (critical=red, high=orange, medium=yellow, low=blue, info=gray)
- Message structure: summary text in the main body, full incident report as a Slack attachment (collapsible)
- Thread support: if `thread_ts` provided, posts as reply
- Error handling: catches Slack API errors, returns structured error with category

### Message Format

```
[CRITICAL] Incident Alert
--
{LLM-generated summary message}

Datasources queried: elastic, kafka, couchbase
Confidence: 0.85
```

Full report attached as a Slack file snippet (text attachment) for reference without cluttering the channel.

---

## Section 3: Linear Ticket Integration (SIO-635)

### Package

New file: `packages/agent/src/action-tools/ticket-creator.ts`

### Dependencies

- `@linear/sdk` -- official Linear SDK

### Configuration

```
LINEAR_API_KEY=lin_api_...
LINEAR_TEAM_ID=<siobytes-team-id>
LINEAR_PROJECT_ID=<incidents-project-id>
```

Validated via Zod schema in `packages/shared/src/config.ts`:

```typescript
export const LinearConfigSchema = z.object({
  apiKey: z.string().startsWith("lin_api_"),
  teamId: z.string().uuid(),
  projectId: z.string().uuid(),
});
```

### Execution

```typescript
export async function executeCreateTicket(params: {
  title: string;
  description: string;
  severity: string;
  affected_services?: string[];
  datasources_queried?: string[];
  reportContent?: string;
}): Promise<{ ticket_id: string; url: string }>
```

- Creates issue via `LinearClient.createIssue()`
- Severity maps to Linear priority: critical=1 (urgent), high=2, medium=3, low=4
- Title: LLM-generated summary (under 80 chars)
- Description: LLM-generated structured description with sections (Summary, Affected Services, Datasources Queried, Key Findings)
- Full incident report: attached as a Linear document attachment (markdown)
- Labels: auto-applies "incident" label (created if missing)
- Project: assigned to configured incidents project

### Ticket Description Template

```markdown
## Incident Summary
{LLM-generated description}

## Affected Services
- service-a (prod)
- service-b (staging)

## Datasources Analyzed
- Elasticsearch (prod deployment)
- Kafka (MSK)

## Confidence
Score: 0.85

---
Full incident report attached.
```

---

## Section 4: Unified Action Executor (SIO-634 + SIO-635)

### Package

New file: `packages/agent/src/action-tools/executor.ts`

### Design

Single entry point that routes to the correct handler:

```typescript
export async function executeAction(
  action: PendingAction,
  context: { reportContent: string; threadId: string },
): Promise<ActionResult>
```

Responsibilities:
1. Load tool definition from `getAgent().tools` by `action.tool`
2. Validate `action.params` against tool's `input_schema`
3. Check `requiresApproval()` (defense-in-depth -- frontend already confirmed)
4. Route to `executeSlackNotify()` or `executeCreateTicket()`
5. Log execution via `getLogger("agent:action-executor")`
6. Return `ActionResult` with success/error status

### Configuration Check

On startup, the executor checks which action tools are configured:

```typescript
export function getAvailableActionTools(): string[]
```

Returns tool names whose env vars are present (e.g., `SLACK_BOT_TOKEN` set -> "notify-slack" available). The frontend uses this to only show confirmation cards for configured tools.

New API endpoint: `GET /api/agent/actions/available` returns the list.

---

## Section 5: Knowledge Base Loading (SIO-638)

### Loader Extension

Extend `loadAgent()` in `packages/gitagent-bridge/src/manifest-loader.ts`:

```typescript
export interface KnowledgeEntry {
  category: string;
  filename: string;
  content: string;
}

export interface LoadedAgent {
  manifest: AgentManifest;
  soul: string;
  rules: string;
  tools: ToolDefinition[];
  skills: Map<string, string>;
  subAgents: Map<string, LoadedAgent>;
  knowledge: KnowledgeEntry[];  // NEW
}
```

Loading logic:
1. Read `knowledge/index.yaml` if it exists
2. For each category, scan the declared `path` directory
3. Read all `.md` files (skip `.gitkeep`)
4. Return as `KnowledgeEntry[]` with `{ category, filename, content }`
5. If `knowledge/` or `index.yaml` doesn't exist, return empty array

### Knowledge Index Schema

New Zod schema in `packages/gitagent-bridge/src/types.ts`:

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
```

### Prompt Injection

Extend `buildSystemPrompt()` in `packages/gitagent-bridge/src/skill-loader.ts` to include knowledge:

```typescript
export function buildSystemPrompt(agent: LoadedAgent, activeSkills?: string[]): string {
  const sections: string[] = [];
  // ... existing soul, rules, skills ...

  // Knowledge base context
  if (agent.knowledge.length > 0) {
    const knowledgeSection = buildKnowledgeSection(agent.knowledge);
    sections.push(knowledgeSection);
  }

  return sections.join("\n\n---\n\n");
}
```

Knowledge is grouped by category in the prompt:

```
## Knowledge Base

### Runbooks
#### high-cpu-usage.md
{content}

#### kafka-consumer-lag.md
{content}

### Systems Map
#### service-dependencies.md
{content}

### SLO Policies
#### api-latency-slo.md
{content}
```

### Mitigation Node Enhancement

The `proposeMitigation` prompt in `packages/agent/src/mitigation.ts` is updated to reference loaded knowledge:

```
If a runbook is relevant to the incident, reference it by filename in relatedRunbooks.
Available runbooks: {list of filenames from knowledge/runbooks/}
```

This replaces the current hardcoded `"knowledge/runbooks/<topic>.md"` format hint with actual filenames.

### Initial Knowledge Content

Author realistic content for each category:

**runbooks/** (3 files):
- `high-error-rate.md` -- steps for investigating elevated 5xx rates across API gateway and backends
- `kafka-consumer-lag.md` -- diagnosing and resolving consumer group lag, partition rebalancing
- `database-slow-queries.md` -- Couchbase N1QL slow query investigation, index analysis

**systems-map/** (1 file):
- `service-dependencies.md` -- dependency graph of the 4 data sources (Kong -> backends -> Kafka -> Couchbase, Elasticsearch for observability)

**slo-policies/** (1 file):
- `api-latency-slo.md` -- P99 latency thresholds per service tier, error budget calculations, breach escalation procedures

Content is generic DevOps best practices tailored to the project's 4 data source stack. Each file is 50-150 lines of actionable, structured markdown.

---

## Section 6: File Changes Summary

### New Files

| File | Package | Purpose |
|------|---------|---------|
| `packages/agent/src/action-tools/executor.ts` | agent | Unified action executor routing |
| `packages/agent/src/action-tools/slack-notifier.ts` | agent | Slack Web API integration |
| `packages/agent/src/action-tools/ticket-creator.ts` | agent | Linear API integration |
| `apps/web/src/routes/api/agent/actions/+server.ts` | web | POST endpoint for action execution |
| `apps/web/src/routes/api/agent/actions/available/+server.ts` | web | GET endpoint for available action tools |
| `apps/web/src/lib/components/ActionConfirmationCard.svelte` | web | Confirmation UI for pending actions |
| `agents/incident-analyzer/knowledge/runbooks/high-error-rate.md` | gitagent | Runbook content |
| `agents/incident-analyzer/knowledge/runbooks/kafka-consumer-lag.md` | gitagent | Runbook content |
| `agents/incident-analyzer/knowledge/runbooks/database-slow-queries.md` | gitagent | Runbook content |
| `agents/incident-analyzer/knowledge/systems-map/service-dependencies.md` | gitagent | Service topology |
| `agents/incident-analyzer/knowledge/slo-policies/api-latency-slo.md` | gitagent | SLO definitions |

### Modified Files

| File | Change |
|------|--------|
| `packages/shared/src/agent-state.ts` | Add `PendingActionSchema`, `ActionResultSchema`, `pending_actions` StreamEvent variant |
| `packages/shared/src/config.ts` | Add `SlackConfigSchema`, `LinearConfigSchema` |
| `packages/shared/src/index.ts` | Export new schemas/types |
| `packages/agent/src/state.ts` | Add `pendingActions`, `actionResults` annotations |
| `packages/agent/src/mitigation.ts` | Add action proposal generation, knowledge-aware prompting |
| `packages/agent/src/prompt-context.ts` | Expose knowledge entries for mitigation context |
| `packages/gitagent-bridge/src/manifest-loader.ts` | Add knowledge loading to `loadAgent()`, export `KnowledgeEntry` |
| `packages/gitagent-bridge/src/skill-loader.ts` | Add knowledge section to `buildSystemPrompt()` |
| `packages/gitagent-bridge/src/types.ts` | Add `KnowledgeIndexSchema`, `KnowledgeCategorySchema` |
| `packages/gitagent-bridge/src/index.ts` | Export new types |
| `apps/web/src/routes/api/agent/stream/+server.ts` | Emit `pending_actions` SSE event after proposeMitigation |
| `apps/web/src/lib/stores/agent.svelte.ts` | Handle `pending_actions` events, add `executeAction`/`dismissAction` |
| `apps/web/src/lib/components/ChatMessage.svelte` | Render `ActionConfirmationCard` for pending actions |

### Dependencies

| Package | Dependency | Reason |
|---------|-----------|--------|
| `packages/agent` | `@slack/web-api` | Slack Bot Token API |
| `packages/agent` | `@linear/sdk` | Linear ticket creation |

---

## Section 7: Testing Strategy

### Unit Tests

- `packages/agent/src/action-tools/executor.test.ts` -- routes to correct handler, validates params, handles missing config
- `packages/agent/src/action-tools/slack-notifier.test.ts` -- mocked `WebClient`, severity formatting, error handling
- `packages/agent/src/action-tools/ticket-creator.test.ts` -- mocked `LinearClient`, severity-to-priority mapping, description template
- `packages/gitagent-bridge/src/manifest-loader.test.ts` -- extend existing tests for knowledge loading, empty dirs, missing index.yaml

### Integration Tests

- `packages/agent/src/mitigation.test.ts` -- extend to verify action proposals are generated for high-severity incidents
- Knowledge loading end-to-end: load agent with knowledge files, verify they appear in system prompt

### No Frontend Tests

Frontend components tested manually via the running app. The confirmation card is a simple form with buttons -- low risk.

---

## Section 8: Configuration & Environment

### New Environment Variables

```env
# SIO-634: Slack integration
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_DEFAULT_CHANNEL=#incidents

# SIO-635: Linear ticket integration
LINEAR_API_KEY=lin_api_your-key
LINEAR_TEAM_ID=your-team-uuid
LINEAR_PROJECT_ID=your-incidents-project-uuid
```

All optional. If not configured, the corresponding action tool is unavailable (no confirmation card rendered, no proposal generated).

### Graceful Degradation

- Missing `SLACK_BOT_TOKEN`: notify-slack proposals are not generated, tool excluded from available actions
- Missing `LINEAR_API_KEY`: create-ticket proposals are not generated, tool excluded from available actions
- Both missing: mitigation node works as before (no action proposals), zero behavior change
