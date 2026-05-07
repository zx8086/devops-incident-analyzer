# MCP Server Configuration

> **Targets:** Bun 1.3.9+ | LangGraph | TypeScript 5.x
> **Last updated:** 2026-05-07

Deep dive into how each of the six MCP servers is configured. All servers follow the same 4-pillar configuration pattern, but each has distinct schema shapes, authentication models, and feature gates. This document covers the pattern itself, then walks through each server's specifics.

For all environment variable names and defaults, see [Environment Variables](environment-variables.md).

---

## Configuration Pattern

### The 4-Pillar Approach

Every MCP server in this monorepo structures its configuration across four files in a `config/` directory:

```
packages/mcp-server-{name}/src/config/
  defaults.ts      # Pillar 1: Fallback values
  envMapping.ts    # Pillar 2: Env var -> config path mapping
  schemas.ts       # Pillar 3: Zod validation schemas
  loader.ts        # Pillar 4: Merge + validate pipeline
```

The loader executes a deterministic pipeline on startup:

```
.env file -> Bun.env -> loader.ts
                          |
defaults.ts ------------> deep-clone
                          |
envMapping.ts ----------> overlay env values (with type coercion)
                          |
schemas.ts (Zod) -------> configSchema.parse()
                          |
                       AppConfig (validated, typed)
```

**Step 1: Deep-clone defaults.** The loader copies `defaults.ts` values to avoid mutation of the module-level object.

**Step 2: Overlay environment variables.** For each entry in `envMapping.ts`, the loader reads the corresponding `Bun.env` value. If present, it writes the value to the dot-path specified in the mapping. Type coercion handles booleans (`"true"` -> `true`) and numbers (`"9092"` -> `9092`).

**Step 3: Validate with Zod.** The merged object is passed through `configSchema.parse()` from `schemas.ts`. If validation fails, the server exits with a descriptive error listing which fields failed and why.

### Why This Pattern

- **Defaults are explicit.** Every config field has a visible fallback value in source code.
- **Environment mapping is declarative.** Adding a new env var means adding one line to `envMapping.ts`.
- **Validation is strict.** Zod `.parse()` (not `.safeParse()`) throws on invalid config, preventing the server from starting with bad state.
- **No `.default()` in schemas.** Defaults live in `defaults.ts`, not in Zod schemas. This keeps the two concerns separated and makes defaults grep-able.

---

## Elasticsearch MCP Server

**Package:** `packages/mcp-server-elastic`
**Config directory:** `packages/mcp-server-elastic/src/config/`
**Tool count:** ~84 (~77 cluster + 7 conditional cloud/billing on `EC_API_KEY`)

### Configuration Schema

The Elasticsearch server has the most complex configuration due to its multi-deployment architecture. A single server instance manages connections to multiple Elasticsearch clusters.

```
ElasticConfig
  deployments: Map<string, DeploymentConfig>
    url: string (required)
    auth:
      apiKey?: string
      username?: string
      password?: string
  transport:
    mode: "stdio" | "http" | "sse" | "both" | "agentcore"
    port: number
  langsmith:
    project: string
```

### Multi-Deployment Mode

The `ELASTIC_DEPLOYMENTS` variable contains a comma-separated list of deployment IDs. The loader iterates over each ID and reads its `URL`, `API_KEY`, `USERNAME`, and `PASSWORD` variables dynamically. The env-key transform is uppercase + hyphens-to-underscores (`eu-cld` -> `ELASTIC_EU_CLD_*`):

```
ELASTIC_DEPLOYMENTS=eu-cld,us-cld
                       |       |
                       v       v
            ELASTIC_EU_CLD_*  ELASTIC_US_CLD_*
```

Each deployment is independently authenticated. One deployment might use API key auth while another uses basic auth. The server validates that each deployment has at least one valid auth method.

### Authentication Options

| Method | Variables | Use Case |
|--------|-----------|----------|
| API Key | `ELASTIC_{ID}_API_KEY` | Production deployments, fine-grained permissions |
| Basic Auth | `ELASTIC_{ID}_USERNAME` + `ELASTIC_{ID}_PASSWORD` | Development, staging, legacy clusters |

API key authentication is preferred for production because it supports scoped permissions without exposing cluster credentials.

### Per-Call Deployment Switching (SIO-675)

Cluster-scoped tools (e.g. `elasticsearch_cluster_info`, `elasticsearch_search`) accept an optional `deployment` argument so a single MCP session can route individual calls to different clusters without restarting the server. The dispatcher resolves the target deployment in this order (`packages/mcp-server-elastic/src/tools/index.ts:361-393`):

1. The explicit `deployment` arg in the tool call.
2. The `x-elastic-deployment` HTTP header (HTTP transport only).
3. The `ELASTIC_DEFAULT_DEPLOYMENT` env var.
4. The first ID in `ELASTIC_DEPLOYMENTS`.

An unknown deployment ID returns `McpError(InvalidParams)` listing the valid IDs. The schema for each cluster tool is augmented with the `deployment` field at registration time so MCP clients see the valid IDs as an enum.

### Elastic Cloud Deployment + Billing Tools (SIO-674)

When `EC_API_KEY` is set, the server registers 7 additional org-scoped tools that talk to `https://api.elastic-cloud.com`:

- `elasticsearch_cloud_list_deployments`, `elasticsearch_cloud_get_deployment`, `elasticsearch_cloud_get_plan_activity`, `elasticsearch_cloud_get_plan_history`
- `elasticsearch_billing_get_org_costs`, `elasticsearch_billing_get_deployment_costs`, `elasticsearch_billing_get_org_charts`

These use the org-scoped `EC_API_KEY` credential, which is **distinct** from the per-deployment cluster API keys. When `EC_API_KEY` is unset, the tools do not register and the server boots normally — self-hosted ES users do not need an Elastic Cloud account. See [Environment Variables](environment-variables.md#elastic-cloud-deployment--billing-api-sio-674) for the full env-var list.

### Claude Desktop Integration

To wire the Elasticsearch MCP server into Claude Desktop, add the following to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows). The `args[1]` path must be **absolute** because Claude Desktop spawns the process from its own working directory:

```json
{
  "mcpServers": {
    "elastic": {
      "command": "bun",
      "args": [
        "run",
        "/absolute/path/to/devops-incident-analyzer/packages/mcp-server-elastic/src/index.ts"
      ],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "ELASTIC_DEPLOYMENTS": "eu-cld,us-cld,eu-b2b,ap-cld,gl-cld-reporting,eu-onboarding,eu-cld-monitor,ap-cld-monitor,gl-testing,us-cld-monitor",
        "ELASTIC_DEFAULT_DEPLOYMENT": "eu-cld",
        "ELASTIC_EU_CLD_URL": "https://...",
        "ELASTIC_EU_CLD_API_KEY": "...",
        "ELASTIC_US_CLD_URL": "https://...",
        "ELASTIC_US_CLD_API_KEY": "...",
        "ELASTIC_EU_B2B_URL": "https://...",
        "ELASTIC_EU_B2B_API_KEY": "...",
        "ELASTIC_AP_CLD_URL": "https://...",
        "ELASTIC_AP_CLD_API_KEY": "...",
        "ELASTIC_GL_CLD_REPORTING_URL": "https://...",
        "ELASTIC_GL_CLD_REPORTING_API_KEY": "...",
        "ELASTIC_EU_ONBOARDING_URL": "https://...",
        "ELASTIC_EU_ONBOARDING_API_KEY": "...",
        "ELASTIC_EU_CLD_MONITOR_URL": "https://...",
        "ELASTIC_EU_CLD_MONITOR_API_KEY": "...",
        "ELASTIC_AP_CLD_MONITOR_URL": "https://...",
        "ELASTIC_AP_CLD_MONITOR_API_KEY": "...",
        "ELASTIC_GL_TESTING_URL": "https://...",
        "ELASTIC_GL_TESTING_API_KEY": "...",
        "ELASTIC_US_CLD_MONITOR_URL": "https://...",
        "ELASTIC_US_CLD_MONITOR_API_KEY": "...",
        "EC_API_KEY": "...",
        "EC_DEFAULT_ORG_ID": "..."
      }
    }
  }
}
```

Notes:

- Trim the deployment list to whatever subset you actually have credentials for. Every ID in `ELASTIC_DEPLOYMENTS` must have a matching `ELASTIC_{ID}_URL` and either an `_API_KEY` or `_USERNAME`+`_PASSWORD` pair, or boot will fail.
- Omit `ELASTIC_DEFAULT_DEPLOYMENT` to default to the first ID in the list.
- Omit `EC_API_KEY` and `EC_DEFAULT_ORG_ID` if you do not need the Elastic Cloud + Billing tools — the server boots fine without them.
- For local-dev or single-cluster use, leave `ELASTIC_DEPLOYMENTS` unset and use the legacy `ES_URL` + `ES_API_KEY` shape instead.
- After saving, fully quit and relaunch Claude Desktop (not just close the window) so it re-spawns the MCP child process.

---

## Kafka MCP Server

**Package:** `packages/mcp-server-kafka`
**Config directory:** `packages/mcp-server-kafka/src/config/`
**Tool count:** 15 base + 15 optional (schema registry + ksqlDB)

### Configuration Schema

```
KafkaConfig
  provider: "local" | "msk" | "confluent"
  brokers: string[]
  featureGates:
    allowWrites: boolean
    allowDestructive: boolean
    schemaRegistry: boolean
    ksql: boolean
  transport:
    mode: "stdio" | "http" | "sse" | "both" | "agentcore"
    port: number
  langsmith:
    project: string
```

### Provider System

The provider determines connection behavior, authentication, and which AWS services are involved:

| Provider | Auth Method | Connection | Additional Services |
|----------|------------|------------|---------------------|
| `local` | None (PLAINTEXT) | Direct broker connection | None |
| `msk` | Selectable via `MSK_AUTH_MODE`: IAM (default), TLS-only, or none | MSK bootstrap brokers | CloudWatch metrics, MSK API |
| `confluent` | API key/secret (SASL/PLAIN) | Confluent Cloud endpoint | Schema Registry, ksqlDB |

The provider is set once via `KAFKA_PROVIDER` and determines which authentication path the connection factory uses. Switching providers does not require code changes -- only environment variable updates.

For the `msk` provider, `MSK_AUTH_MODE` selects the auth path:

| `MSK_AUTH_MODE` | Connection | Bootstrap broker string used |
|-----------------|-----------|-----------------------------|
| `none` (default) | PLAINTEXT, unauthenticated | `BootstrapBrokerString` |
| `tls` | TLS only, no SASL | `BootstrapBrokerStringTls` |
| `iam` | SASL/OAUTHBEARER + TLS (explicit opt-in) | `BootstrapBrokerStringSaslIam` |

The default is `none`. IAM-authenticated MSK requires `MSK_AUTH_MODE=iam` set explicitly. The resolved auth mode is included in the startup log line ("Creating Kafka provider").

`MSK_AUTH_MODE=none` requires the cluster to have been created with `Unauthenticated` enabled. See [`docs/deployment/agentcore-msk-no-auth.md`](../deployment/agentcore-msk-no-auth.md) for the full deployment path.

### Feature Gates

Feature gates restrict which tool categories the server exposes. This is a safety mechanism to prevent accidental writes in read-only environments.

| Gate | Controls | Default |
|------|----------|---------|
| `allowWrites` | Topic produce, consumer group reset | `false` |
| `allowDestructive` | Topic deletion, partition reassignment | `false` |
| `schemaRegistry` | Schema CRUD, compatibility checks | `false` |
| `ksql` | ksqlDB query execution | `false` |

The `allowDestructive` gate requires `allowWrites` to also be `true`. The config loader validates this constraint and fails with a clear error if `allowDestructive=true` but `allowWrites=false`.

### Schema Registry

When `SCHEMA_REGISTRY_ENABLED=true`, the server registers additional tools for managing Avro, JSON Schema, and Protobuf schemas. Schema Registry connection details are derived from the provider configuration.

### ksqlDB

When `KSQL_ENABLED=true`, the server exposes tools for executing ksqlDB queries. This is only applicable to Confluent provider deployments.

---

## Couchbase Capella MCP Server

**Package:** `packages/mcp-server-couchbase`
**Config directory:** `packages/mcp-server-couchbase/src/config/`
**Tool count:** ~15

### Configuration Schema

```
CouchbaseConfig
  connection:
    hostname: string (required)
    username: string (required)
    password: string (required)
    bucket?: string
  transport:
    mode: "stdio" | "http" | "sse" | "both" | "agentcore"
    port: number
  langsmith:
    project: string
```

### Connection Parameters

The Couchbase server connects to a single Capella cluster. Unlike the Elasticsearch server, there is no multi-cluster support -- each MCP server instance serves one cluster.

| Parameter | Source | Notes |
|-----------|--------|-------|
| Hostname | `CB_HOSTNAME` | Capella cluster endpoint (e.g., `cb.xxxxxxxx.cloud.couchbase.com`) |
| Username | `CB_USERNAME` | Database user with appropriate read permissions |
| Password | `CB_PASSWORD` | Database user password |
| Bucket | `CB_BUCKET` | Optional default bucket; tools can override per-query |

### Bucket Configuration

The `CB_BUCKET` variable sets a default bucket for queries that do not specify one explicitly. Tools that require a bucket will use this default if the agent does not provide a bucket name in the tool call. If `CB_BUCKET` is not set and a tool does not specify a bucket, the tool returns an error prompting the agent to provide one.

---

## Kong Konnect MCP Server

**Package:** `packages/mcp-server-konnect`
**Config directory:** `packages/mcp-server-konnect/src/config/`
**Tool count:** 15 enhanced + proxy surface

### Configuration Schema

```
KonnectConfig
  auth:
    accessToken: string (required)
  region: "us" | "eu" | "au" | "me" | "in"
  elicitation:
    enabled: boolean
  transport:
    mode: "stdio" | "http" | "sse" | "both" | "agentcore"
    port: number
  langsmith:
    project: string
```

### Token Authentication

The Konnect MCP server authenticates using a personal or system access token from the Konnect dashboard. The token is passed as a Bearer token in all API requests.

| Variable | Purpose |
|----------|---------|
| `KONNECT_ACCESS_TOKEN` | Authenticates all Konnect API requests |

Tokens should have the minimum required permissions for your use case. For the incident analyzer, read-only access to control planes, services, routes, and plugins is sufficient.

### Region Selection

The region determines which Konnect API endpoint the server communicates with. This must match the region where your Konnect organization's control planes are deployed.

| Region | API Endpoint |
|--------|-------------|
| `us` | `https://us.api.konghq.com` |
| `eu` | `https://eu.api.konghq.com` |
| `au` | `https://au.api.konghq.com` |
| `me` | `https://me.api.konghq.com` |
| `in` | `https://in.api.konghq.com` |

### Elicitation Gates

The Konnect server supports MCP elicitation, where the server can prompt the agent for additional information during tool execution. This is controlled by a feature gate in the configuration. When enabled, tools may ask the agent clarifying questions before returning results.

---

## GitLab MCP Server

**Package:** `packages/mcp-server-gitlab`
**Config directory:** `packages/mcp-server-gitlab/src/config/`
**Tool count:** proxy + 5-8 custom tools (dynamic, varies based on remote MCP endpoint discovery)

### Configuration Schema

```
GitLabConfig
  application:
    name: string
    version: string (semver)
    environment: "development" | "staging" | "production" | "test"
    logLevel: "debug" | "info" | "warn" | "error"
  gitlab:
    instanceUrl: string (required, URL)
    personalAccessToken: string (required)
    defaultProjectId?: string
    timeout: number (1000-60000)
    retryAttempts: number (0-5)
    retryDelay: number (100-5000)
  tracing:
    enabled: boolean
    apiKey?: string
    project: string
    endpoint: string (URL)
    sessionName: string
    tags: string[]
    samplingRate: number (0-1)
  monitoring:
    enabled: boolean
    healthCheckInterval: number (5000-300000)
    metricsCollection: boolean
  transport:
    mode: "stdio" | "http" | "both" | "agentcore"
    port: number (1024-65535)
    host: string
    path: string (starts with "/")
    sessionMode: "stateless" | "stateful"
    idleTimeout: number (10-255)
    apiKey: string
    allowedOrigins: string
```

### Hybrid Tool Architecture

Unlike other MCP servers that implement all tools directly, the GitLab MCP server uses a two-source tool registration pattern:

1. **Proxy tools** -- At startup, the server connects to GitLab's native MCP endpoint (`{instanceUrl}/api/v4/mcp`), discovers available tools, and re-registers them locally with a `gitlab_` prefix. These tools forward requests through the proxy client.

2. **Custom code-analysis tools** -- Five tools implemented as direct REST API calls to GitLab's API v4: `gitlab_get_file_content`, `gitlab_get_blame`, `gitlab_get_commit_diff`, `gitlab_list_commits`, `gitlab_get_repository_tree`.

Both categories are registered on the same `McpServer` instance and appear as a unified tool set to the agent.

### Token Authentication

| Variable | Purpose |
|----------|---------|
| `GITLAB_PERSONAL_ACCESS_TOKEN` | Authenticates all GitLab API requests (proxy and custom tools) |
| `GITLAB_INSTANCE_URL` | Base URL for the GitLab instance (default: `https://gitlab.com`) |

The token requires the `api` scope. For self-hosted GitLab instances, set the instance URL to your deployment (e.g., `https://gitlab.company.com`).

### Deferred Retry for Embeddings

The proxy layer includes special handling for GitLab's `semantic_code_search` tool. When a project's code embeddings haven't been indexed yet, GitLab returns an error indicating indexing is in progress. The proxy detects this pattern and retries with exponential backoff (10s, 20s, 40s) up to 3 times, giving the indexing process time to complete.

---

## Atlassian MCP Server

**Package:** `packages/mcp-server-atlassian`
**Config directory:** `packages/mcp-server-atlassian/src/config/`
**Tool count:** proxy + custom tools (dynamic, discovered from Atlassian Cloud MCP endpoint at startup)

### Configuration Schema

```
AtlassianConfig
  application:
    name: string
    version: string (semver)
    environment: "development" | "staging" | "production" | "test"
    logLevel: "debug" | "info" | "warn" | "error"
  atlassian:
    upstreamUrl: string (required, URL)       # ATLASSIAN_MCP_URL
    siteName: string (required)                # ATLASSIAN_SITE_NAME
    oauthCallbackPort: number                  # ATLASSIAN_OAUTH_CALLBACK_PORT
    readOnly: boolean                          # ATLASSIAN_READ_ONLY (default: true)
    incidentProjects: string[]                 # ATLASSIAN_INCIDENT_PROJECTS (allowlist)
    timeout: number                            # ATLASSIAN_TIMEOUT
  tracing:
    enabled: boolean
    project: string
    apiKey?: string
  monitoring:
    enabled: boolean
    healthCheckInterval: number
  transport:
    mode: "stdio" | "http" | "agentcore"
    port: number                               # ATLASSIAN_MCP_PORT (default: 9085)
```

### OAuth 2.0 Flow

The Atlassian MCP server authenticates to Atlassian Cloud via OAuth 2.0. At startup:

1. The server starts a local HTTP listener on `ATLASSIAN_OAUTH_CALLBACK_PORT` (default 9185) for the OAuth redirect.
2. The user is directed to Atlassian's authorization URL to grant access to the configured `ATLASSIAN_SITE_NAME`.
3. Atlassian redirects to the callback with an auth code, which the server exchanges for an access token.
4. The token is used for all subsequent proxy calls to `ATLASSIAN_MCP_URL` (default `https://mcp.atlassian.com/v1/mcp`).

Tokens are refreshed automatically when they near expiration.

### Read-Only Mode

`ATLASSIAN_READ_ONLY=true` (the default) disables all write operations: creating issues, transitioning issue states, adding comments, and editing Confluence pages. The incident analyzer's compliance layer depends on this flag being true.

### Incident Project Allowlist

`ATLASSIAN_INCIDENT_PROJECTS` restricts queries to a comma-separated allowlist of Jira project keys (e.g., `INC,OPS`). When set, the server filters proxied tool responses so that issues from other projects do not leak into incident investigations. When unset, all projects visible to the OAuth token are available.

### Hybrid Tool Architecture

Like the GitLab MCP, the Atlassian MCP combines proxy-discovered tools from the upstream Atlassian Cloud MCP endpoint with custom tools for incident-specific filtering. Proxied tools are prefixed with `atlassian_`.

---

## Transport Configuration

All six MCP servers share the same transport abstraction. The transport mode is set via `MCP_TRANSPORT` and `MCP_PORT` environment variables, which are common across all servers.

### Transport Modes

| Mode | Port | Use Case | Session Model |
|------|------|----------|---------------|
| `stdio` | -- | CLI integrations, Claude Desktop, IDE plugins | Persistent (process lifetime) |
| `http` | Configurable | Agent connection via Streamable HTTP | Stateless (per-request) |
| `sse` | Configurable | Agent connection via Server-Sent Events | Persistent (connection lifetime) |
| `both` | Configurable | Stdio + HTTP simultaneously | Mixed |
| `agentcore` | 8000 | AWS Bedrock AgentCore Runtime | Stateless (per-request) |

### Mode Details

**stdio** is the default mode. The server reads MCP messages from stdin and writes responses to stdout. This is the standard mode for MCP integrations with Claude Desktop, VS Code extensions, and other tools that spawn the server as a child process. No port is needed.

**http** exposes a Streamable HTTP endpoint at the configured port. Each request creates a new MCP session, processes the tool call, and returns the result. This is the recommended mode for the agent's `MultiServerMCPClient` connection.

**sse** exposes a Server-Sent Events endpoint. The client establishes a persistent connection, and the server pushes responses as events. This mode supports long-running tool executions with progress updates.

**both** starts stdio and HTTP transports simultaneously. This allows the server to be used both as a CLI integration and as a network service. Useful during development when you want to test with Claude Desktop while also running the agent.

**agentcore** is a specialized HTTP mode for AWS Bedrock AgentCore Runtime. It binds to port 8000 on `0.0.0.0`, exposes `/mcp` for Streamable HTTP, `/ping` for health checks, and `/health` for detailed status. Each request is fully stateless -- a new `McpServer` instance is created per request and disposed after completion.

### Common Transport Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MCP_TRANSPORT` | No | `stdio` | Transport mode selection |
| `MCP_PORT` | No | Varies by server | Port for HTTP/SSE modes |

---

## See Also

- [Environment Variables](environment-variables.md) -- complete variable listing with defaults
- [Local Development](../deployment/local-development.md) -- running servers with specific transport modes

---

## Changelog

| Date | Change |
|------|--------|
| 2026-04-04 | Initial MCP server configuration reference created (Phase 3: Configuration + Deployment) |
| 2026-04-13 | Added GitLab MCP server configuration (SIO-647): hybrid proxy + custom tools, token auth, deferred retry |
| 2026-04-23 | Added Atlassian MCP server configuration: OAuth 2.0, read-only mode, incident-project allowlist, hybrid proxy + custom |
