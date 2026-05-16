# Environment Variables Reference

> **Targets:** Bun 1.3.9+ | LangGraph | TypeScript 5.x
> **Last updated:** 2026-05-10

Complete reference for all environment variables used across the DevOps Incident Analyzer monorepo. Variables are grouped by service. Each table lists the variable name, whether it is required, its default value (if any), and a description.

---

## Overview

The `.env.example` file at the repository root is the source of truth for all environment variables. Copy it to `.env` before first run:

```bash
cp .env.example .env
```

Bun loads `.env` automatically -- no `dotenv` package is needed. Variables follow a consistent naming convention:

- `SERVICE_PROPERTY` for top-level settings (e.g., `KAFKA_PROVIDER`)
- `SERVICE_ID_PROPERTY` for multi-instance settings (e.g., `ELASTIC_PRODUCTION_URL`)
- Boolean values: `true` or `false` (case-insensitive, coerced by the config loader)
- List values: comma-separated strings (e.g., `ELASTIC_DEPLOYMENTS=production,staging`)

Each MCP server's config loader reads these variables via its `envMapping.ts` file, overlays them onto defaults from `defaults.ts`, and validates the result with the Zod schema in `schemas.ts`. See [MCP Server Configuration](mcp-server-configuration.md) for details on the 4-pillar pattern.

---

## AWS

AWS credentials for Bedrock LLM inference. All three variables are required for the agent to make LLM calls.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AWS_REGION` | Yes | `eu-west-1` | AWS region for Bedrock model access |
| `AWS_ACCESS_KEY_ID` | Yes | -- | IAM access key ID |
| `AWS_SECRET_ACCESS_KEY` | Yes | -- | IAM secret access key |

The agent uses Bedrock for Claude model inference. Ensure your IAM user has `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` permissions for the configured region.

---

## LangSmith

LangSmith provides tracing, feedback collection, and evaluation for the agent pipeline and individual MCP servers.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LANGSMITH_API_KEY` | Yes (for tracing) | -- | LangSmith API key from smith.langchain.com |
| `LANGSMITH_PROJECT` | No | `devops-incident-analyzer` | LangSmith project name for agent traces |
| `LANGSMITH_TRACING` | No | `true` | Enable or disable LangSmith tracing globally |
| `ELASTIC_LANGSMITH_PROJECT` | No | `elastic-mcp-server` | LangSmith project for Elasticsearch MCP server traces |
| `KAFKA_LANGSMITH_PROJECT` | No | `kafka-mcp-server` | LangSmith project for Kafka MCP server traces |
| `COUCHBASE_LANGSMITH_PROJECT` | No | `couchbase-mcp-server` | LangSmith project for Couchbase MCP server traces |
| `KONNECT_LANGSMITH_PROJECT` | No | `konnect-mcp-server` | LangSmith project for Kong Konnect MCP server traces |
| `GITLAB_LANGSMITH_PROJECT` | No | `gitlab-mcp-server` | LangSmith project for GitLab MCP server traces |
| `ATLASSIAN_LANGSMITH_PROJECT` | No | `atlassian-mcp-server` | LangSmith project for Atlassian MCP server traces |
| `OPENAI_API_KEY` | Yes (for `eval:agent` only) | -- | gpt-4o-mini API key used by the `response_quality` LLM judge in the LangSmith eval pipeline (`packages/agent/src/eval/`). Not required for normal agent operation; only needed when running `bun run eval:agent`. SIO-680/682. |

Each MCP server writes traces to its own LangSmith project. This allows per-server dashboards while the main agent project captures the orchestration layer. Set `LANGSMITH_TRACING=false` to disable all tracing (useful for local development without a LangSmith account).

---

## Elasticsearch MCP Server

The Elasticsearch MCP server supports multi-deployment configuration, allowing a single server instance to query multiple Elasticsearch clusters.

### Multi-Deployment Configuration

Deployments are defined by a comma-separated list of deployment IDs. Each deployment ID becomes a prefix for its connection variables. The env-key transform is: uppercase, hyphens replaced with underscores. So `eu-cld` becomes the prefix `ELASTIC_EU_CLD_`.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ELASTIC_DEPLOYMENTS` | Yes | -- | Comma-separated deployment IDs (e.g., `eu-cld,us-cld`) |
| `ELASTIC_DEFAULT_DEPLOYMENT` | No | First ID in `ELASTIC_DEPLOYMENTS` | Deployment used when a tool call omits the `deployment` arg and no `x-elastic-deployment` HTTP header is present (SIO-675). Must match an ID in `ELASTIC_DEPLOYMENTS`. |

For each deployment ID (referred to as `{ID}` below), provide one of two authentication methods:

### Per-Deployment Connection Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ELASTIC_{ID}_URL` | Yes | -- | Elasticsearch cluster URL including port |
| `ELASTIC_{ID}_API_KEY` | Conditional | -- | API key authentication (preferred) |
| `ELASTIC_{ID}_USERNAME` | Conditional | -- | Basic auth username (alternative to API key) |
| `ELASTIC_{ID}_PASSWORD` | Conditional | -- | Basic auth password (paired with username) |
| `ELASTIC_{ID}_CA_CERT` | No | -- | TLS CA cert (PEM string or file path) for clusters with a private CA |

Each deployment requires either `ELASTIC_{ID}_API_KEY` or both `ELASTIC_{ID}_USERNAME` and `ELASTIC_{ID}_PASSWORD`. API key authentication is preferred for production deployments.

Example using the canonical 10-deployment list from `.env.example`:

```bash
ELASTIC_DEPLOYMENTS=eu-cld,us-cld,eu-b2b,ap-cld,gl-cld-reporting,eu-onboarding,eu-cld-monitor,ap-cld-monitor,gl-testing,us-cld-monitor
ELASTIC_DEFAULT_DEPLOYMENT=eu-cld

ELASTIC_EU_CLD_URL=https://eu-cld.es.example.com:9243
ELASTIC_EU_CLD_API_KEY=your-eu-cld-api-key
ELASTIC_US_CLD_URL=https://us-cld.es.example.com:9243
ELASTIC_US_CLD_API_KEY=your-us-cld-api-key
# ... one URL + API_KEY pair per deployment ID
```

If `ELASTIC_DEPLOYMENTS` is unset, the server falls back to legacy single-deployment mode using `ES_URL`, `ES_API_KEY`, `ES_USERNAME`, `ES_PASSWORD`, `ES_CA_CERT`.

### Per-Call Search Timeout (SIO-708)

The `elasticsearch_search` tool uses a separate per-call timeout from the shared client `requestTimeout`. Defaults are conservative for heavy aggregations on multi-billion-doc indices. See [Troubleshooting > Elasticsearch Search Times Out at ~30 Seconds](../operations/troubleshooting.md#elasticsearch-search-times-out-at-30-seconds-sio-708) for the failure mode this addresses.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ELASTIC_SEARCH_REQUEST_TIMEOUT_MS` | No | `60000` | Per-call transport timeout for `elasticsearch_search`, in ms. Independent of the shared client `requestTimeout` (also raised — schema cap is now 120 000 ms, was 60 000 before SIO-708). |
| `ELASTIC_SEARCH_MAX_RETRIES` | No | `0` | Per-call retry count for `elasticsearch_search`. Default `0` so transient transport errors fail fast rather than stacking 30 s timeouts. |

### Elastic Cloud Deployment + Billing API (SIO-674)

These variables enable the 7 organization-scoped tools (`elasticsearch_cloud_*` and `elasticsearch_billing_*`) that talk to `https://api.elastic-cloud.com`. They are **independent** of the per-deployment cluster API keys above and use a separate Elastic Cloud organization API key. When `EC_API_KEY` is unset, those 7 tools simply do not register and the server boots normally for self-hosted users.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `EC_API_KEY` | No | -- | Org-scoped Elastic Cloud API key. Generated at Elastic Cloud console -> User profile -> API keys. Gates registration of cloud + billing tools. |
| `EC_API_ENDPOINT` | No | `https://api.elastic-cloud.com` | Override only for non-public Elastic Cloud regions. |
| `EC_DEFAULT_ORG_ID` | No | -- | Fallback `org_id` for billing tools when no `org_id` arg is passed. Without it, every billing tool call must include `org_id` explicitly. |
| `EC_REQUEST_TIMEOUT` | No | `30000` | Request timeout in ms. |
| `EC_MAX_RETRIES` | No | `3` | Retry count on 5xx responses with exponential backoff. |

---

## Kafka MCP Server

The Kafka MCP server uses a provider system to support multiple Kafka deployment types and feature gates to control write access.

### Provider Selection

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `KAFKA_PROVIDER` | No | `local` | Kafka provider: `local`, `msk`, or `confluent` |
| `KAFKA_BROKERS` | Yes | `localhost:9092` | Comma-separated list of Kafka broker addresses |

The provider determines authentication and connection behavior:

- `local` -- Plain connection to local brokers, no authentication
- `msk` -- AWS MSK; auth is selected via `MSK_AUTH_MODE` (see below). Defaults to IAM.
- `confluent` -- Confluent Cloud with API key/secret authentication

### MSK Auth Mode

`MSK_AUTH_MODE` selects how the Kafka MCP server connects to an MSK cluster. It applies only when `KAFKA_PROVIDER=msk`.

| Value | Behaviour | Bootstrap broker port (typical) |
|-------|-----------|---------------------------------|
| `none` (default) | Unauthenticated PLAINTEXT. Uses `BootstrapBrokerString`. The cluster must have been created with `Unauthenticated` enabled. | `9092` |
| `tls` | TLS-only, no SASL. Uses `BootstrapBrokerStringTls`. | `9094` |
| `iam` | SASL/OAUTHBEARER with IAM-signed token + TLS. Uses `BootstrapBrokerStringSaslIam`. Set explicitly to opt in. | `9098` |

The default is `none` because the project's MSK cluster is provisioned without authentication. Existing IAM-authenticated deployments must set `MSK_AUTH_MODE=iam` explicitly. The resolved auth mode is logged at startup ("Creating Kafka provider"), so the connection posture is always visible from the logs.

When `MSK_AUTH_MODE=none`, `kafka-cluster:*` IAM permissions are not required by the runtime. See [`docs/deployment/agentcore-msk-no-auth.md`](../deployment/agentcore-msk-no-auth.md) for the full no-auth deployment path.

### MSK Connection

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MSK_BOOTSTRAP_BROKERS` | No | -- | Comma-separated bootstrap brokers. If set, skips runtime-side `GetBootstrapBrokers`. |
| `MSK_CLUSTER_ARN` | No | -- | MSK cluster ARN. Used for broker discovery (when `MSK_BOOTSTRAP_BROKERS` is unset) and for `kafka_get_cluster_info`. |
| `MSK_AUTH_MODE` | No | `iam` | See above. |
| `AWS_REGION` | No | `eu-west-1` | AWS region for MSK and IAM token signing. |

Either `MSK_BOOTSTRAP_BROKERS` or `MSK_CLUSTER_ARN` must be set when `KAFKA_PROVIDER=msk`.

### Feature Gates

Feature gates control which tool categories are available. All default to `false` for safety. After SIO-682, `KAFKA_ALLOW_WRITES` and `KAFKA_ALLOW_DESTRUCTIVE` gate not just core Kafka writes but also Confluent Connect, Schema Registry, and REST Proxy write/destructive tools registered through the same MCP server.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `KAFKA_ALLOW_WRITES` | No | `false` | Enable write tools across kafka core (produce, create topic, alter config), Connect (pause/resume/restart), Schema Registry (`sr_register_schema`, `sr_check_compatibility`, `sr_set_compatibility`), and REST Proxy (produce, consumer lifecycle) |
| `KAFKA_ALLOW_DESTRUCTIVE` | No | `false` | Enable destructive tools across kafka core (delete topic, reset offsets), Connect (restart task, delete connector), and Schema Registry (soft/hard delete subject + version) |
| `SCHEMA_REGISTRY_ENABLED` | No | `false` | Register Schema Registry tools (8 read tools by default; `KAFKA_ALLOW_WRITES`/`KAFKA_ALLOW_DESTRUCTIVE` add the 7 new `sr_*` write/destructive tools) |
| `KSQL_ENABLED` | No | `false` | Enable ksqlDB query tools |
| `CONNECT_ENABLED` | No | `false` | Register Kafka Connect tools (4 read tools by default; gates above add 5 write/destructive tools) |

Setting `KAFKA_ALLOW_DESTRUCTIVE=true` requires `KAFKA_ALLOW_WRITES=true` as well. The config loader enforces this constraint during validation.

Tool count grows with the gating and which Confluent components are enabled. Bare `KAFKA_PROVIDER=msk` registers 15 tools; full Confluent stack (`SCHEMA_REGISTRY_ENABLED + KSQL_ENABLED + CONNECT_ENABLED + RESTPROXY_ENABLED + KAFKA_ALLOW_WRITES + KAFKA_ALLOW_DESTRUCTIVE`) registers 55. See `packages/mcp-server-kafka/tests/tools/full-stack-tools.test.ts` for the asserted-correct formula.

### Tool Timeouts (SIO-710)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `KAFKA_TOOL_TIMEOUT_MS` | No | `30000` | Per-tool admin RPC timeout in ms, mapped to the `@platformatic/kafka` library option `timeout` (the library's own default is 5 000 ms, which trips on first-call MSK warmup). Provider-supplied timeouts still win — for example, the MSK provider's 60 s override is preserved on top of this value. The pre-SIO-710 config option `requestTimeout` was a no-op (the underlying schema is `additionalProperties: false`); it has been renamed to `timeout` to match the library and is now correctly threaded through. |

### Confluent Connect

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CONNECT_ENABLED` | No | `false` | Register the 4 Connect read tools (cluster info, list connectors, get connector status, get task status) |
| `CONNECT_URL` | Conditional | -- | Required when `CONNECT_ENABLED=true`. Connect REST API URL (e.g., `http://internal-confluent-prd-internal-alb-...:8083` for self-hosted). |
| `CONNECT_API_KEY` | No | -- | Basic auth key. Leave empty for self-hosted no-auth Connect deployments. Set for Confluent Cloud. |
| `CONNECT_API_SECRET` | No | -- | Basic auth secret paired with `CONNECT_API_KEY`. |

### Confluent REST Proxy (SIO-682)

REST Proxy v2 integration provides HTTP-fronted produce/consume in addition to the broker-level kafka tools. Useful when AgentCore can reach an HTTP endpoint but not the broker port directly. PVH's REST Proxy lives on a public ALB (separate from the internal ALB used by ksqlDB / Schema Registry / Connect).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RESTPROXY_ENABLED` | No | `false` | Register REST Proxy tools (3 metadata reads always-on; 6 writes additionally gated by `KAFKA_ALLOW_WRITES`) |
| `RESTPROXY_URL` | Conditional | `http://localhost:8082` | Required when `RESTPROXY_ENABLED=true`. REST Proxy v2 base URL. |
| `RESTPROXY_API_KEY` | No | -- | Basic auth key. Leave empty for self-hosted no-auth deployments. Set for Confluent Cloud. |
| `RESTPROXY_API_SECRET` | No | -- | Basic auth secret paired with `RESTPROXY_API_KEY`. |

The 3 metadata reads (`restproxy_list_topics`, `restproxy_get_topic`, `restproxy_get_partitions`) register whenever `RESTPROXY_ENABLED=true`. The 6 writes (`restproxy_produce`, `restproxy_create_consumer`, `restproxy_subscribe`, `restproxy_consume`, `restproxy_commit_offsets`, `restproxy_delete_consumer`) require `KAFKA_ALLOW_WRITES=true` in addition.

### Schema Registry

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SCHEMA_REGISTRY_ENABLED` | No | `false` | Register Schema Registry tools (8 reads always-on; 7 SIO-682 writes/destructives additionally gated below) |
| `SCHEMA_REGISTRY_URL` | Conditional | `http://localhost:8081` | Required when `SCHEMA_REGISTRY_ENABLED=true`. SR base URL. |
| `SCHEMA_REGISTRY_API_KEY` | No | -- | Basic auth key. Leave empty for self-hosted no-auth deployments. |
| `SCHEMA_REGISTRY_API_SECRET` | No | -- | Basic auth secret paired with `SCHEMA_REGISTRY_API_KEY`. |

### ksqlDB

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `KSQL_ENABLED` | No | `false` | Register ksqlDB tools (7 tools) |
| `KSQL_ENDPOINT` | Conditional | `http://localhost:8088` | Required when `KSQL_ENABLED=true`. ksqlDB REST endpoint. |
| `KSQL_API_KEY` | No | -- | Basic auth key. Leave empty for self-hosted no-auth deployments. |
| `KSQL_API_SECRET` | No | -- | Basic auth secret paired with `KSQL_API_KEY`. |

---

## Couchbase Capella MCP Server

Connection parameters for a single Couchbase Capella cluster.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CB_HOSTNAME` | Yes | -- | Couchbase Capella cluster hostname |
| `CB_USERNAME` | Yes | -- | Database user with read access |
| `CB_PASSWORD` | Yes | -- | Database user password |
| `CB_BUCKET` | No | -- | Default bucket name for queries (optional, can be specified per-query) |

The MCP server connects using the Couchbase Node.js SDK. The hostname should be the cluster endpoint provided by the Capella console, typically in the format `cb.xxxxxxxx.cloud.couchbase.com`.

---

## Kong Konnect MCP Server

Authentication and region configuration for the Kong Konnect API gateway management platform.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `KONNECT_ACCESS_TOKEN` | Yes | -- | Personal or system access token from Konnect |
| `KONNECT_REGION` | No | `eu` | Konnect API region: `us`, `eu`, `au`, `me`, or `in` |

The region determines the Konnect API base URL. Ensure the access token has sufficient permissions for the control planes and services you need to query.

| Region Code | API Base URL |
|-------------|-------------|
| `us` | `https://us.api.konghq.com` |
| `eu` | `https://eu.api.konghq.com` |
| `au` | `https://au.api.konghq.com` |
| `me` | `https://me.api.konghq.com` |
| `in` | `https://in.api.konghq.com` |

---

## GitLab MCP Server

Authentication and connection configuration for the GitLab MCP server, which proxies requests to GitLab's native MCP endpoint and provides custom code analysis tools.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GITLAB_INSTANCE_URL` | No | `https://gitlab.com` | GitLab instance base URL (supports self-hosted) |
| `GITLAB_PERSONAL_ACCESS_TOKEN` | Yes | -- | Personal access token with `api` scope |
| `GITLAB_DEFAULT_PROJECT_ID` | No | -- | Default project ID for queries (optional) |
| `GITLAB_TIMEOUT` | No | `30000` | API request timeout in milliseconds |
| `GITLAB_RETRY_ATTEMPTS` | No | `3` | Number of retry attempts for failed requests |
| `GITLAB_RETRY_DELAY` | No | `1000` | Base delay between retry attempts in milliseconds |

The personal access token requires the `api` scope for full MCP tool access. For self-hosted GitLab instances, set `GITLAB_INSTANCE_URL` to your instance URL (e.g., `https://gitlab.company.com`).

---

## Atlassian MCP Server

OAuth 2.0 configuration for the Atlassian MCP server, which proxies Jira and Confluence tools from Atlassian's hosted MCP endpoint and adds incident-project filtering.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ATLASSIAN_MCP_URL` | Yes | `http://localhost:9085` | URL the agent uses to reach the local Atlassian MCP server (matches every other datasource's `*_MCP_URL` convention) |
| `ATLASSIAN_UPSTREAM_MCP_URL` | No | `https://mcp.atlassian.com/v1/mcp` | Upstream Atlassian Cloud Rovo endpoint the local proxy forwards to. Consumed by `mcp-server-atlassian` only. |
| `ATLASSIAN_MCP_PORT` | No | `9085` | Local HTTP port the server listens on |
| `ATLASSIAN_SITE_NAME` | Yes | -- | Atlassian Cloud site identifier (e.g., `your-company`) |
| `ATLASSIAN_OAUTH_CALLBACK_PORT` | No | `9185` | Port for the OAuth 2.0 redirect handler |
| `ATLASSIAN_READ_ONLY` | No | `true` | Disable all write operations (issue create, comment, transition) |
| `ATLASSIAN_INCIDENT_PROJECTS` | No | -- | Comma-separated project keys to allowlist for incident queries |
| `ATLASSIAN_TIMEOUT` | No | `30000` | API request timeout in milliseconds |

The OAuth flow opens a local callback on `ATLASSIAN_OAUTH_CALLBACK_PORT` to receive the auth code, then exchanges it with Atlassian for an access token. `ATLASSIAN_READ_ONLY=true` is the default and is enforced by the incident analyzer's compliance layer.

---

## Agent Configuration

Settings for the LangGraph supervisor agent, including model selection and state persistence.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AGENT_LLM_MODEL` | No | `claude-sonnet-4-6` | Primary model for supervisor, aggregator, and validator nodes |
| `AGENT_LLM_HAIKU_MODEL` | No | `claude-haiku-4-5` | Fast model for classifier and entity extractor nodes |
| `AGENT_LLM_REGION` | No | `eu-west-1` | AWS region for Bedrock model inference |
| `AGENT_CHECKPOINTER_TYPE` | No | `memory` | State persistence backend: `memory` or `sqlite` |
| `GRAPH_TIMEOUT_MS` | No | `720000` | Graph-level abort signal in ms (SIO-697). Overrides the `runtime.timeout` value in `agents/incident-analyzer/agent.yaml` when set. Default `720000` (12 min) gives a 5-source dispatch plus one alignment retry full runway instead of aborting the in-flight retry sub-agent. |
| `SUB_AGENT_TIMEOUT_MS` | No | `360000` | Per-sub-agent `AbortSignal.timeout` in ms (SIO-697). Replaces the previously hardcoded 300 000. Caps any single sub-agent ReAct loop. Tightening this is useful when you want the alignment retry to start sooner; loosening it helps deep-discovery agents that legitimately need more than 6 minutes. |

The agent uses two model tiers. The primary model handles complex reasoning tasks (supervision, aggregation, validation). The fast model handles classification and entity extraction where latency matters more than depth. Both models are accessed through AWS Bedrock.

The `memory` checkpointer stores state in-process (lost on restart). The `sqlite` checkpointer uses `bun:sqlite` for persistent state across restarts.

---

## MCP Server URLs

URLs the agent uses to connect to each MCP server via `MultiServerMCPClient`. These must match the actual running addresses of your MCP servers.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ELASTIC_MCP_URL` | Yes | `http://localhost:9080` | Elasticsearch MCP server URL |
| `KAFKA_MCP_URL` | Yes | `http://localhost:9081` | Kafka MCP server URL |
| `COUCHBASE_MCP_URL` | Yes | `http://localhost:9082` | Couchbase Capella MCP server URL |
| `KONNECT_MCP_URL` | Yes | `http://localhost:9083` | Kong Konnect MCP server URL |
| `GITLAB_MCP_URL` | Yes | `http://localhost:9084` | GitLab MCP server URL |
| `ATLASSIAN_MCP_URL` | Yes | `http://localhost:9085` | URL the agent uses to reach the local Atlassian MCP server (the upstream Rovo endpoint the proxy forwards to is `ATLASSIAN_UPSTREAM_MCP_URL`) |

In Docker Compose, these resolve to service names (e.g., `http://elastic-mcp:9080`). In bare-metal development, they resolve to `localhost` with each server's configured port.

---

## Server

General server configuration for the SvelteKit web frontend.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SERVER_PORT` | No | `5173` | Port for the SvelteKit development server |
| `LOG_LEVEL` | No | `info` | Pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal` |
| `CORS_ORIGINS` | No | `http://localhost:5173` | Comma-separated list of allowed CORS origins |

In production, set `CORS_ORIGINS` to the actual frontend domain. For local development, the default value matches the SvelteKit dev server.

---

## See Also

- [MCP Server Configuration](mcp-server-configuration.md) -- 4-pillar config pattern and per-server deep dives
- [Local Development](../deployment/local-development.md) -- port assignments and startup instructions

---

## Changelog

| Date | Change |
|------|--------|
| 2026-04-04 | Initial environment variables reference created (Phase 3: Configuration + Deployment) |
| 2026-04-09 | Fixed MCP server URL port defaults to match standardized ports (9080-9083) |
| 2026-04-13 | Added GitLab MCP server env vars (SIO-647), added GITLAB_MCP_URL and GITLAB_LANGSMITH_PROJECT |
| 2026-04-23 | Added Atlassian MCP server env vars (ATLASSIAN_SITE_NAME, ATLASSIAN_MCP_URL upstream, ATLASSIAN_MCP_URL_LOCAL, ATLASSIAN_OAUTH_CALLBACK_PORT, ATLASSIAN_READ_ONLY, ATLASSIAN_INCIDENT_PROJECTS, ATLASSIAN_TIMEOUT, ATLASSIAN_MCP_PORT, ATLASSIAN_LANGSMITH_PROJECT) |
| 2026-05-08 | SIO-682: added Confluent Connect (`CONNECT_ENABLED`, `CONNECT_URL`, `CONNECT_API_KEY`, `CONNECT_API_SECRET`), Schema Registry (`SCHEMA_REGISTRY_URL`, `SCHEMA_REGISTRY_API_KEY`, `SCHEMA_REGISTRY_API_SECRET`), ksqlDB (`KSQL_ENDPOINT`, `KSQL_API_KEY`, `KSQL_API_SECRET`), and REST Proxy (`RESTPROXY_ENABLED`, `RESTPROXY_URL`, `RESTPROXY_API_KEY`, `RESTPROXY_API_SECRET`) env vars. Expanded `KAFKA_ALLOW_WRITES` / `KAFKA_ALLOW_DESTRUCTIVE` scope description to cover Connect, SR, and REST Proxy gating. |
| 2026-05-10 | SIO-708 / SIO-710 / SIO-697 post-log-hygiene sync: added Elasticsearch per-call search tuning (`ELASTIC_SEARCH_REQUEST_TIMEOUT_MS`, `ELASTIC_SEARCH_MAX_RETRIES`) with shared-client `requestTimeout` cap raised to 120 000 ms; added Kafka admin-RPC timeout (`KAFKA_TOOL_TIMEOUT_MS`, default 30 000) replacing the previously dead `requestTimeout` knob; added agent graph and sub-agent timeout overrides (`GRAPH_TIMEOUT_MS` default 720 000, `SUB_AGENT_TIMEOUT_MS` default 360 000). |
| 2026-05-16 | SIO-766: collapsed the agent's Atlassian connection URL to `ATLASSIAN_MCP_URL` (was `ATLASSIAN_MCP_URL_LOCAL`) to match every other datasource's convention. The upstream Rovo endpoint the local proxy forwards to is now `ATLASSIAN_UPSTREAM_MCP_URL`. |
