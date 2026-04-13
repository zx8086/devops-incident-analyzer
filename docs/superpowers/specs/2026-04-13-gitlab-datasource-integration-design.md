# GitLab Data Source Integration Design

## Context

The DevOps incident analyzer currently correlates incidents across 4 data sources (Elasticsearch, Kafka, Couchbase Capella, Kong Konnect). Adding GitLab as a 5th data source enables end-to-end incident analysis that includes CI/CD pipelines, merge requests, code changes, and deployment correlation. This is a prerequisite for future GitLab Knowledge Graph (GKG) integration for deep code analysis.

GitLab ships a built-in MCP server at `/api/v4/mcp` with 15 tools (issues, MRs, pipelines, search, semantic code search). Rather than reimplementing these, we create a proxy MCP server that forwards requests to GitLab's endpoint while also exposing additional code analysis tools via GitLab's REST API.

## Architecture

### Approach: Full Pattern Replica with Proxy

Create `packages/mcp-server-gitlab` following the same architecture as all 4 existing MCP servers (createMcpApplication bootstrap, Zod config, shared transport). The server has two tool sources:

1. **Proxy tools** -- Dynamically discovered from GitLab's built-in MCP server and re-registered locally with `gitlab_` prefix
2. **Code analysis tools** -- Custom tools calling GitLab REST/GraphQL API for file browsing, blame, diffs, and commit history

Authentication uses a GitLab Personal Access Token (PAT) for both proxy and REST API calls.

### Package Structure

```
packages/mcp-server-gitlab/
  src/
    index.ts                      # createMcpApplication<GitLabDatasource> bootstrap
    server.ts                     # McpServer instance + tool registration
    config/
      index.ts                    # Config export & singleton
      schemas.ts                  # ServerConfigSchema, GitLabConfigSchema
      defaults.ts                 # Default values (port 9084)
      envMapping.ts               # Env var mapping
      loader.ts                   # Load + validate from env
    tools/
      index.ts                    # registerAllTools (proxy + code analysis)
      types.ts                    # Shared tool types
      proxy/
        index.ts                  # Dynamic proxy tool registration
      code-analysis/
        get-file-content.ts       # Read file content from repo
        get-blame.ts              # Git blame for a file
        get-commit-diff.ts        # Diff for a specific commit
        list-commits.ts           # List recent commits
        get-repository-tree.ts    # Browse repo file structure
    transport/
      index.ts
      factory.ts                  # Standard transport factory
    gitlab-client/
      index.ts                    # GitLab REST/GraphQL API client (PAT auth)
      proxy.ts                    # MCP proxy client (connects to /api/v4/mcp)
    utils/
      logger.ts                   # Pino logger
      tracing.ts                  # LangSmith/OTEL tracing init
    telemetry/
      telemetry.ts
  tests/
  package.json
  tsconfig.json
```

### Proxy Mechanism

1. At startup, use `@modelcontextprotocol/sdk`'s `Client` class to connect to GitLab's MCP endpoint (`{instanceUrl}/api/v4/mcp`) via `StreamableHTTPClientTransport`
2. Call `client.listTools()` to discover available remote tools
3. For each remote tool, register a local tool on the `McpServer` instance with `gitlab_` prefix (e.g., `search` -> `gitlab_search`), preserving the original input schema
4. Each local tool handler calls `client.callTool(originalToolName, args)` on the remote connection and returns the result
5. Register custom code analysis tools alongside proxied tools
6. PAT is passed as a Bearer token in the HTTP transport headers to GitLab's endpoint

### Configuration

**Zod Schemas:**

```typescript
const GitLabConfigSchema = z.object({
  instanceUrl: z.string().url(),
  personalAccessToken: z.string().min(1),
  defaultProjectId: z.string().optional(),
});

const ServerConfigSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  transportMode: z.enum(["stdio", "http", "both", "agentcore"]),
  port: z.number(),       // default: 9084
  host: z.string(),
  path: z.string().startsWith("/"),
  sessionMode: z.enum(["stateless", "stateful"]),
  idleTimeout: z.number().int().min(10).max(255),
  apiKey: z.string().optional(),
  allowedOrigins: z.string().optional(),
});
```

**Environment Variables:**

| Variable | Purpose | Default |
|----------|---------|---------|
| `GITLAB_INSTANCE_URL` | GitLab instance base URL | (required) |
| `GITLAB_PERSONAL_ACCESS_TOKEN` | PAT with `api` scope | (required) |
| `GITLAB_DEFAULT_PROJECT_ID` | Default project for queries | (optional) |
| `MCP_PORT` | Server port | 9084 |
| `MCP_TRANSPORT` | Transport mode | stdio |
| `MCP_SERVER_NAME` | Server name | gitlab-mcp-server |

### Port Assignment

| Server | Port |
|--------|------|
| Elastic MCP | 9080 |
| Kafka MCP | 9081 |
| Couchbase MCP | 9082 |
| Konnect MCP | 9083 |
| **GitLab MCP** | **9084** |

## Gitagent Sub-Agent Definition

### Directory Structure

```
agents/incident-analyzer/agents/gitlab-agent/
  agent.yaml
  SOUL.md
```

### agent.yaml

```yaml
spec_version: "0.1.0"
name: gitlab-agent
version: 0.1.0
description: Read-only GitLab CI/CD, merge request, and code analysis specialist

model:
  preferred: claude-haiku-4-5
  constraints:
    temperature: 0.1
    max_tokens: 2048

tools:
  - gitlab-api

compliance:
  risk_tier: low
  data_governance:
    pii_handling: redact
```

### SOUL.md

GitLab specialist identity covering:
- CI/CD pipeline analysis (failure patterns, duration trends, job logs)
- Merge request and code review tracking (approvals, diffs, conflicts)
- Repository browsing and code analysis (file tree, blame, content)
- Commit history and deployment correlation (recent changes, authors)
- Semantic code search for symbol resolution from stack traces
- Issue tracking and work item management

Output standards: evidence-backed claims with API response data, ISO 8601 timestamps, connectivity failure reporting.

### Tool YAML Facade

File: `agents/incident-analyzer/tools/gitlab-api.yaml`

Action categories in `action_tool_map`:
- `issues` -- `gitlab_create_issue`, `gitlab_get_issue`, `gitlab_create_workitem_note`, `gitlab_get_workitem_notes`
- `merge_requests` -- `gitlab_get_merge_request`, `gitlab_get_merge_request_commits`, `gitlab_get_merge_request_diffs`, `gitlab_get_merge_request_pipelines`, `gitlab_create_merge_request`
- `pipelines` -- `gitlab_manage_pipeline`, `gitlab_get_pipeline_jobs`
- `search` -- `gitlab_search`, `gitlab_search_labels`, `gitlab_semantic_code_search`
- `code_analysis` -- `gitlab_get_file_content`, `gitlab_get_blame`, `gitlab_get_commit_diff`, `gitlab_list_commits`, `gitlab_get_repository_tree`

`mcp_server: gitlab`, `mcp_patterns: ["gitlab_*"]`

### Parent Agent Registration

Add to `agents/incident-analyzer/agent.yaml`:
- `gitlab-agent` in agents section with `delegation: auto`
- `gitlab-api` in tools list

## Pipeline Integration (All Touchpoints)

### 1. `packages/shared/src/datasource.ts`
- Add `GitLabConfigSchema` (instanceUrl, personalAccessToken, defaultProjectId)
- Add `"gitlab"` to `DATA_SOURCE_IDS` array: `["elastic", "kafka", "couchbase", "konnect", "gitlab"]`
- Export `GitLabConfig` type

### 2. `packages/agent/src/mcp-bridge.ts`
- Add `gitlabUrl?: string` to `McpClientConfig`
- Add `{ name: "gitlab-mcp", url: "${config.gitlabUrl}/mcp" }` to server entries
- Add `gitlab: "gitlab-mcp"` to `serverMap` in `getToolsForDataSource`

### 3. `packages/agent/src/supervisor.ts`
- Add `gitlab: "gitlab-agent"` to `AGENT_NAMES`

### 4. `packages/agent/src/entity-extractor.ts`
- Add mapping: `"gitlab" or "pipeline" or "merge request" or "CI/CD" or "code" or "commit" or "deploy" -> "gitlab"`
- Add instruction: `"Always include 'gitlab' alongside other datasources for complex incidents -- GitLab context is supplementary for code and deployment correlation."`
- Update `buildActionCatalog()` to include gitlab actions

### 5. `packages/agent/src/normalizer.ts`
- Update prompt to include `gitlab` in available datasources list

### 6. `apps/web/src/lib/server/agent.ts`
- Add `GITLAB_MCP_URL` env var to `McpClientConfig` construction

### 7. `apps/web/src/lib/components/DataSourceSelector.svelte`
- Add `gitlab: "GitLab"` to `labels` record

### 8. `apps/web/src/routes/api/datasources/+server.ts`
- Include gitlab in datasource status/health response

### 9. Root `.env` / `.env.example`
- Add `GITLAB_MCP_URL=http://localhost:9084`
- Add `GITLAB_INSTANCE_URL=https://gitlab.com`
- Add `GITLAB_PERSONAL_ACCESS_TOKEN=<pat>`
- Add `GITLAB_DEFAULT_PROJECT_ID=<optional>`

## Tool Inventory

### Proxied Tools (from GitLab MCP server, 15 tools)

| Tool | Action Category | Description |
|------|----------------|-------------|
| `gitlab_get_mcp_server_version` | -- | Server version |
| `gitlab_create_issue` | issues | Create project issue |
| `gitlab_get_issue` | issues | Get issue details |
| `gitlab_create_merge_request` | merge_requests | Create MR |
| `gitlab_get_merge_request` | merge_requests | Get MR details |
| `gitlab_get_merge_request_commits` | merge_requests | List MR commits |
| `gitlab_get_merge_request_diffs` | merge_requests | Get MR diffs |
| `gitlab_get_merge_request_pipelines` | merge_requests | Get MR pipelines |
| `gitlab_get_pipeline_jobs` | pipelines | List pipeline jobs |
| `gitlab_manage_pipeline` | pipelines | Manage CI/CD pipelines |
| `gitlab_create_workitem_note` | issues | Comment on work item |
| `gitlab_get_workitem_notes` | issues | Get work item comments |
| `gitlab_search` | search | Instance-wide search |
| `gitlab_search_labels` | search | Search labels |
| `gitlab_semantic_code_search` | search | Semantic code search |

### Custom Code Analysis Tools (via REST API, 5 tools)

| Tool | Action Category | GitLab API Endpoint |
|------|----------------|---------------------|
| `gitlab_get_file_content` | code_analysis | `GET /projects/:id/repository/files/:path` |
| `gitlab_get_blame` | code_analysis | `GET /projects/:id/repository/files/:path/blame` |
| `gitlab_get_commit_diff` | code_analysis | `GET /projects/:id/repository/commits/:sha/diff` |
| `gitlab_list_commits` | code_analysis | `GET /projects/:id/repository/commits` |
| `gitlab_get_repository_tree` | code_analysis | `GET /projects/:id/repository/tree` |

**Total: ~20 tools** (15 proxied + 5 custom)

## Routing: "Always Include" Behavior

GitLab is treated as supplementary for all complex incident investigations. The entity extractor prompt instructs the LLM to always include `gitlab` alongside explicitly mentioned datasources. This means:

- If user mentions "elasticsearch logs are slow" -> extracted datasources: `["elastic", "gitlab"]`
- If user mentions "check everything" -> extracted datasources: `["elastic", "kafka", "couchbase", "konnect", "gitlab"]`
- If user explicitly asks about only gitlab -> extracted datasources: `["gitlab"]`

The supervisor validates that the GitLab MCP server is connected and has tools before dispatching the gitlab-agent, so if the server is down, it gracefully skips.

## Future: GKG Integration Path

This design supports future GitLab Knowledge Graph integration:
- The `gitlab-client/` module can be extended with a `graph.ts` adapter
- New tools can be added to `tools/code-analysis/` for graph queries (callers, callees, neighbors)
- The `action_tool_map` in the tool YAML can be extended with a `graph_analysis` action category
- The proxy mechanism can coexist with or be replaced by GKG endpoints

## Verification

1. **Unit tests**: Config loading, tool registration, proxy forwarding, REST API client
2. **Type checking**: `bun run typecheck` across all packages
3. **Lint**: `bun run lint` passes
4. **YAML validation**: `bun run yaml:check` validates new agent.yaml and tool YAML
5. **Integration test**: Start mcp-server-gitlab, verify tools/list returns all 20 tools
6. **Pipeline test**: Run full agent pipeline with gitlab datasource, verify supervisor dispatches gitlab-agent
7. **UI test**: DataSourceSelector shows GitLab pill, connected/disconnected states work
8. **Proxy test**: Verify a proxied tool (e.g., gitlab_search) returns correct results from GitLab
