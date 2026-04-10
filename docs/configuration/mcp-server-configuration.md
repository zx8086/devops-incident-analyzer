# MCP Server Configuration

> **Targets:** Bun 1.3.9+ | LangGraph | TypeScript 5.x
> **Last updated:** 2026-04-04

Deep dive into how each of the four MCP servers is configured. All servers follow the same 4-pillar configuration pattern, but each has distinct schema shapes, authentication models, and feature gates. This document covers the pattern itself, then walks through each server's specifics.

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
**Tool count:** 69

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

The `ELASTIC_DEPLOYMENTS` variable contains a comma-separated list of deployment IDs. The loader iterates over each ID and reads its `URL`, `API_KEY`, `USERNAME`, and `PASSWORD` variables dynamically:

```
ELASTIC_DEPLOYMENTS=production,staging
                       |          |
                       v          v
          ELASTIC_PRODUCTION_*   ELASTIC_STAGING_*
```

Each deployment is independently authenticated. Production might use API key auth while staging uses basic auth. The server validates that each deployment has at least one valid auth method.

### Authentication Options

| Method | Variables | Use Case |
|--------|-----------|----------|
| API Key | `ELASTIC_{ID}_API_KEY` | Production deployments, fine-grained permissions |
| Basic Auth | `ELASTIC_{ID}_USERNAME` + `ELASTIC_{ID}_PASSWORD` | Development, staging, legacy clusters |

API key authentication is preferred for production because it supports scoped permissions without exposing cluster credentials.

---

## Kafka MCP Server

**Package:** `packages/mcp-server-kafka`
**Config directory:** `packages/mcp-server-kafka/src/config/`
**Tool count:** 30

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
| `msk` | AWS IAM (SASL/OAUTHBEARER) | MSK bootstrap brokers | CloudWatch metrics, MSK API |
| `confluent` | API key/secret (SASL/PLAIN) | Confluent Cloud endpoint | Schema Registry, ksqlDB |

The provider is set once via `KAFKA_PROVIDER` and determines which authentication path the connection factory uses. Switching providers does not require code changes -- only environment variable updates.

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
**Tool count:** 24

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
**Tool count:** 67

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

## Transport Configuration

All four MCP servers share the same transport abstraction. The transport mode is set via `MCP_TRANSPORT` and `MCP_PORT` environment variables, which are common across all servers.

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
