# Atlassian MCP Integration Design

Date: 2026-04-16
Status: Draft (awaiting user review)
Linear: [SIO-650](https://linear.app/siobytes/issue/SIO-650)

## Goal

Add Jira and Confluence as a sixth datasource in the DevOps incident analyzer, surfaced through a new `atlassian-agent` sub-agent that participates in the parallel fan-out alongside elastic, kafka, capella, konnect, and gitlab. The sub-agent provides read-only incident enrichment: linked tickets, runbook lookup, and historical incident correlation.

## Non-Goals

- Write operations to Jira or Confluence in v1 (issue creation, page updates, comments). The existing orchestrator-level `create-ticket.yaml` tool remains the path for ticket creation.
- Multi-site Atlassian support. v1 targets a single Atlassian Cloud site, selected by the resolved cloudId.
- Replacing the existing `notify-slack.yaml` or `create-ticket.yaml` orchestrator tools.
- Custom OAuth app registration. v1 relies on the MCP SDK's dynamic client registration against the Rovo endpoint.

## Architecture

New package `packages/mcp-server-atlassian` mirrors the structure of `packages/mcp-server-gitlab`, using the unified `createMcpApplication` bootstrap from `@devops-agent/shared`. Runs on port 9085 with stdio/http/agentcore transports.

```
packages/mcp-server-atlassian/
  src/
    index.ts                         createMcpApplication<AtlassianDatasource>
    server.ts                        discoverRemoteTools, write filter, register proxy + custom
    config/
      defaults.ts                    port 9085, endpoint, oauth callback port
      envMapping.ts                  ATLASSIAN_* env to config paths
      schemas.ts                     Zod AtlassianConfigSchema
      loader.ts
      index.ts
    atlassian-client/
      proxy.ts                       AtlassianMcpProxy: connect, listTools, callTool, resolveCloudId
      oauth-provider.ts              AtlassianOAuthProvider implementing OAuthClientProvider
      oauth-callback.ts              local callback server on :9185
      index.ts
    tools/
      index.ts                       registerAllTools
      proxy/
        index.ts                     proxy tool registration with write filter
        write-tools.ts               WRITE_TOOL_PATTERNS constant
      custom/
        find-linked-incidents.ts
        get-runbook-for-alert.ts
        get-incident-history.ts
        index.ts                     registerCustomTools
    transport/                       copied from mcp-server-gitlab
      factory.ts, http.ts, stdio.ts, middleware.ts, index.ts
    utils/
      env.ts, logger.ts, tracing.ts
    telemetry/
      telemetry.ts
  test/
    oauth-provider.test.ts
    proxy.test.ts
    proxy/write-tools.test.ts
    tools/custom/*.test.ts
    integration/server.integration.test.ts
  package.json
  tsconfig.json
  README.md                          OAuth flow, env vars, smoke test instructions
```

### Startup Data Flow

1. Load and validate config via `loadConfig()`.
2. Bootstrap transport via `createMcpApplication`.
3. `AtlassianMcpProxy.connect()` opens `StreamableHTTPClientTransport` to the Rovo endpoint with `AtlassianOAuthProvider` as the auth provider.
4. On first run, `UnauthorizedError` triggers the browser OAuth flow: open consent URL, wait for callback on the configured port, call `transport.finishAuth(code)`, reconnect.
5. `proxy.resolveCloudId()` calls Rovo's `getAccessibleAtlassianResources`, selects the resource matching `ATLASSIAN_SITE_NAME` if set, otherwise the first. If zero accessible resources, throw at startup.
6. `discoverRemoteTools()` lists the Rovo tools (~24 in the current Rovo manifest).
7. Write tools filtered out at registration when `ATLASSIAN_READ_ONLY=true` (default). Filtered count logged at info level.
8. Surviving proxy tools registered with the `atlassian_` prefix. Each wrapped call injects the cached cloudId.
9. Three custom tools registered: `findLinkedIncidents`, `getRunbookForAlert`, `getIncidentHistory`.
10. Server announces ready: `Atlassian MCP ready: cloudId=<id>, site=<name>, tools=<n_proxy>+<n_custom>, readOnly=<bool>`.

## Configuration

### Zod Schema

```typescript
export const ConfigSchema = z.object({
  application: z.object({
    name: z.string().min(1),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    environment: z.enum(["development", "staging", "production", "test"]),
    logLevel: z.enum(["debug", "info", "warn", "error"]),
  }),
  atlassian: z.object({
    mcpEndpoint: z.string().url().describe("Rovo MCP endpoint"),
    siteName: z.string().optional().describe("Atlassian site short name for cloudId match; first accessible resource used if unset"),
    readOnly: z.boolean().describe("Filter write tools at registration time"),
    oauthCallbackPort: z.number().int().min(1024).max(65535),
    incidentProjects: z.array(z.string()).describe("Jira project keys treated as incident projects for custom tools"),
  }),
  tracing: z.object({ /* same shape as GitLab */ }),
  monitoring: z.object({ /* same shape as GitLab */ }),
  transport: z.object({ /* same shape as GitLab, port default 9085 */ }),
});
```

### Env Mapping

| Env var | Config path | Default |
|---|---|---|
| `ATLASSIAN_MCP_URL` | `atlassian.mcpEndpoint` | `https://mcp.atlassian.com/v1/mcp` |
| `ATLASSIAN_SITE_NAME` | `atlassian.siteName` | unset |
| `ATLASSIAN_READ_ONLY` | `atlassian.readOnly` | `true` |
| `ATLASSIAN_OAUTH_CALLBACK_PORT` | `atlassian.oauthCallbackPort` | `9185` |
| `ATLASSIAN_INCIDENT_PROJECTS` | `atlassian.incidentProjects` | empty (warned at startup) |
| `MCP_TRANSPORT` | `transport.mode` | `stdio` |
| `MCP_HTTP_PORT` | `transport.httpPort` | `9085` |

## OAuth

`AtlassianOAuthProvider` implements `OAuthClientProvider` from the MCP SDK, identical in shape to `GitLabOAuthProvider`:

- Token storage path: `~/.mcp-auth/atlassian/<sanitized-endpoint>.json`. Sanitization replaces `://` and `/` with `-`. The token store is keyed by endpoint only, not by cloudId.
- `clientMetadata.client_name`: `devops-incident-analyzer-atlassian`.
- `redirectUrl`: `http://localhost:<oauthCallbackPort>/oauth/callback`.
- Relies on the Rovo server's support for OAuth dynamic client registration. No manual Atlassian OAuth app creation required.

The local callback server (`oauth-callback.ts`) is copied from the GitLab implementation, with the port read from config. It listens for one request, extracts the `code` query parameter, returns a minimal HTML success page, and resolves the awaited promise.

## Read-Only Filter

`tools/proxy/write-tools.ts` defines the write tool patterns:

```typescript
export const WRITE_TOOL_PATTERNS = [
  /^create/i,
  /^update/i,
  /^delete/i,
  /^add.*(?:Comment|Attachment)/i,
  /^transition/i,
  /^assign/i,
  /^move/i,
];

export function isWriteTool(name: string): boolean {
  return WRITE_TOOL_PATTERNS.some((re) => re.test(name));
}
```

`registerProxyTools` skips any Rovo tool matching `isWriteTool` when `readOnly` is true. The filtered count is logged. To enable writes in a future version, set `ATLASSIAN_READ_ONLY=false` without code changes.

## CloudId Resolution

`AtlassianMcpProxy.resolveCloudId()` is called once after a successful connect. It calls Rovo's `getAccessibleAtlassianResources`, which returns `[{ id, name, url, scopes }, ...]`. Selection logic:

- If `siteName` is set and matches a resource's `name`, use that resource's `id`.
- Otherwise, use `resources[0].id`.
- If `resources` is empty, throw `AtlassianStartupError("no accessible resources")` and refuse to start.

The resolved cloudId is cached as a private field on the proxy. Every `proxy.callTool(name, args)` injects it: `client.callTool({ name, arguments: { cloudId: this.cloudId, ...args } })`.

## Custom Tools

All three live under `tools/custom/`, wrap calls in `traceToolCall(name, fn)` with `dataSourceId: "atlassian"`, and export Zod schemas for both inputs and outputs.

### `findLinkedIncidents`

Inputs:
- `service: string` (required)
- `componentLabel: string` (optional)
- `withinDays: number` (default 30, max 365)
- `limit: number` (default 10, max 50)

Behavior: composes JQL from `incidentProjects` config + inputs, calls proxied `searchJiraIssuesUsingJql`, shapes the response. JQL template:

```
project in (<incidentProjects>) AND (labels = "<service>" OR text ~ "<service>")
AND created >= -<withinDays>d
ORDER BY created DESC
```

If `incidentProjects` is empty, fall back to `project is not EMPTY` and log a warning at the call site.

Output:
```typescript
{
  count: number;
  issues: Array<{
    key: string;
    summary: string;
    status: string;
    severity: string | null;
    createdAt: string;
    resolvedAt: string | null;
    mttrMinutes: number | null;
    url: string;
  }>;
}
```

Severity extraction: `priority.name` first, then `customfield_severity` if present, else `null`.

### `getRunbookForAlert`

Inputs:
- `service: string` (required)
- `errorKeywords: string[]` (required, max 10)
- `spaceKey: string` (optional, scopes to a Confluence space)
- `limit: number` (default 5, max 10)

Behavior: builds a CQL query from `service` plus each keyword, calls proxied `searchConfluencePages`. Then ranks results client-side:

```
score = (title contains service)         * 3
      + (title contains any keyword)     * 2
      + (label "runbook" present)        * 2
      + (page updated within 90d)        * 1
```

Returns the top `limit` results sorted by score descending. Why custom: collapses search and rank into one tool call so the agent doesn't need to read every match.

Output:
```typescript
{
  matches: Array<{
    pageId: string;
    title: string;
    spaceKey: string;
    excerpt: string;
    lastUpdated: string;
    relevanceScore: number;
    url: string;
  }>;
}
```

### `getIncidentHistory`

Inputs:
- `service: string` (required)
- `windowDays: number` (default 90, max 365)
- `groupBy: "week" | "month"` (default `"week"`)

Behavior: same JQL shape as `findLinkedIncidents` without a limit, then aggregates client-side into time buckets. MTTR is the mean of `resolved - created` in minutes, ignoring unresolved issues.

Output:
```typescript
{
  service: string;
  windowDays: number;
  totals: { incidentCount: number; mttrMinutes: number | null; unresolvedCount: number };
  buckets: Array<{ periodStart: string; count: number; mttrMinutes: number | null }>;
}
```

## Agent Wiring

### New Sub-Agent

`agents/incident-analyzer/agents/atlassian-agent/`:

```yaml
# agent.yaml
spec_version: "0.1.0"
name: atlassian-agent
version: 0.1.0
description: Read-only Jira and Confluence specialist for incident context, runbook lookup, and historical correlation

model:
  preferred: claude-haiku-4-5
  constraints:
    temperature: 0.1
    max_tokens: 2048

tools:
  - atlassian-api

compliance:
  risk_tier: low
  data_governance:
    pii_handling: redact
```

`SOUL.md`: terse role description. Scope is read-only enrichment, never proposes mitigations, returns structured findings (linked tickets, runbooks, MTTR trends) for the orchestrator to fold into aggregation.

### New Tool YAML

`agents/incident-analyzer/tools/atlassian-api.yaml` follows the same `action_tool_map` shape as `gitlab-api.yaml`:

| Action | Tools exposed |
|---|---|
| `incident_correlation` | `findLinkedIncidents`, `getIncidentHistory` |
| `runbook_lookup` | `getRunbookForAlert`, `atlassian_searchConfluencePages` |
| `jira_query` | `atlassian_searchJiraIssuesUsingJql`, `atlassian_getJiraIssue`, `atlassian_getJiraIssueComments` |
| `confluence_query` | `atlassian_searchConfluencePages`, `atlassian_getConfluencePage` |

This caps per-invocation tool count at 2-4 even though ~13 read-only tools are registered.

### Pipeline Touchpoints

Four files in `packages/agent`:

1. `mcp-bridge.ts` — add `atlassian: "atlassian-mcp"` to `serverMap`.
2. `supervisor.ts` — add `"atlassian"` to `AGENT_NAMES` and to the parallel fan-out branch.
3. `entity-extractor.ts` — add keyword routing: `["jira", "confluence", "ticket", "runbook", "incident page", "wiki"]` to `"atlassian"`.
4. `align.ts` and `aggregate.ts` — extend the per-source result type union to include the Atlassian custom-tool output shapes.

### Frontend

`apps/web/src/lib/components/DataSourceSelector.svelte` — add Atlassian as a selectable source toggle. One-line addition to the existing sources array.

### Env Additions

Append to `.env.example`:

```
ATLASSIAN_MCP_URL=https://mcp.atlassian.com/v1/mcp
ATLASSIAN_SITE_NAME=
ATLASSIAN_READ_ONLY=true
ATLASSIAN_INCIDENT_PROJECTS=INC,OPS
ATLASSIAN_OAUTH_CALLBACK_PORT=9185
ATLASSIAN_MCP_PORT=9085
```

## Error Handling

Three failure modes have explicit treatment:

1. **OAuth token expired or refresh fails.** `proxy.callTool` catches `UnauthorizedError`, re-triggers the browser auth flow once, retries the call once. If still failing, returns a structured error with `code: "ATLASSIAN_AUTH_REQUIRED"` so the supervisor marks the Atlassian branch skipped without failing the pipeline.

2. **CloudId resolution fails at startup.** Throw `AtlassianStartupError` immediately. Don't degrade silently into a half-broken state where every tool call fails.

3. **Rovo upstream timeout or 5xx.** Wrap `proxy.callTool` with a 30s timeout. On timeout or 5xx, return `{ isError: true, content: [{ type: "text", text: "Atlassian upstream unavailable: <reason>" }] }`. The supervisor's per-branch error handling folds this into aggregation as a missing source.

No retries beyond the one auth-refresh retry. No exponential backoff. Adding retry latency hurts the parallel pipeline more than missing one source's data.

## Observability

- All tool calls wrapped in `traceToolCall(name, fn)` with `dataSourceId: "atlassian"`.
- OpenTelemetry attributes per call: `mcp.datasource = "atlassian"`, `mcp.tool = <name>`, `atlassian.cloud_id = <resolved>`.
- Startup log line: `Atlassian MCP ready: cloudId=<id>, site=<name>, tools=<n_proxy>+<n_custom>, readOnly=<bool>`.
- LangSmith: existing `devops-incident-analyzer` project. Sub-agent traces nest under the supervisor.

## Testing

### Unit Tests

`packages/mcp-server-atlassian/test/`:

- `oauth-provider.test.ts` — token storage path sanitization, redirect URL shape, metadata serialization. No live OAuth.
- `proxy/write-tools.test.ts` — `isWriteTool` truth table covering known write tool names plus read counter-examples.
- `proxy.test.ts` — `resolveCloudId` selection (siteName match, fallback to first, throw on empty), `callTool` cloudId injection (mocked underlying `client.callTool`), one-shot auth retry logic.
- `tools/custom/*.test.ts` — one per custom tool. Mock `proxy.callTool` to return canned Rovo responses, assert shaped output. Critical assertions:
  - `find-linked-incidents`: JQL composition correctness, severity extraction fallback chain.
  - `get-runbook-for-alert`: ranking heuristic correctness, ordering by score.
  - `get-incident-history`: MTTR aggregation correctness, unresolved-issue handling, bucket boundaries.

### Integration Test

`test/integration/server.integration.test.ts` boots the MCP server in stdio mode against a mocked Rovo endpoint built with `Bun.serve()`. Verifies tool registration, write filter, end-to-end `callTool` flow. Mock skips OAuth.

### Live Smoke Test

`bun run smoke:atlassian` script connects to real Rovo, runs `findLinkedIncidents` against a known service, prints results. Documented in package README. Not automated because it requires interactive OAuth.

## Implementation Order

1. Package scaffold: `package.json`, `tsconfig.json`, `src/index.ts`, `src/server.ts` skeleton, `transport/` copied verbatim from GitLab.
2. Config: schemas, env mapping, loader, defaults.
3. OAuth provider + callback server (adapt from GitLab).
4. Proxy: connect, OAuth handshake, `resolveCloudId`, `listTools`, `callTool` with cloudId injection and one-shot auth retry.
5. Write filter and proxy tool registration.
6. Custom tools (one at a time, with unit tests as TDD).
7. Integration test against mocked Rovo.
8. Sub-agent definition (`atlassian-agent/agent.yaml`, `SOUL.md`).
9. Tool YAML (`atlassian-api.yaml`) with action map.
10. Pipeline wiring (`mcp-bridge.ts`, `supervisor.ts`, `entity-extractor.ts`, `align.ts`, `aggregate.ts`).
11. Frontend: `DataSourceSelector.svelte` toggle.
12. `.env.example` additions, package README, smoke test script.

## Risks and Open Questions

- **Rovo tool name stability.** The write filter relies on Atlassian's naming conventions. If they ship a write tool that doesn't match the pattern (e.g., `addReaction`), it would leak through. Mitigation: log all registered tool names at startup in debug mode so additions show up in CI logs.
- **Dynamic client registration support.** Rovo currently supports it, but if Atlassian ever requires manual client registration, the OAuth provider would need a `client_id` env var. Out of scope for v1.
- **Incident project discovery.** v1 requires `ATLASSIAN_INCIDENT_PROJECTS` to be set for custom tools to filter correctly. A future version could auto-discover by querying Jira project metadata for an "incident management" category, but that's premature without concrete need.
- **OAuth callback port collision.** Port 9185 is hardcoded as the default. If a user runs both GitLab (currently uses its own port) and Atlassian MCP servers locally and both are mid-OAuth, ports must not collide. v1 mitigates by using a different default port; the env var lets users override.

## Acceptance Criteria

- `bun run --filter '@devops-agent/mcp-server-atlassian' typecheck` passes.
- `bun run --filter '@devops-agent/mcp-server-atlassian' test` passes (unit + integration).
- Booting the MCP server with valid OAuth completes the consent flow, resolves a cloudId, and logs the startup ready line.
- Calling `findLinkedIncidents` against a real Atlassian site returns shaped output matching the Zod schema.
- The supervisor pipeline's parallel fan-out includes the Atlassian branch, and an incident query mentioning "jira" or "runbook" routes to it.
- The frontend `DataSourceSelector` shows an Atlassian toggle and respects user selection.
