# Environment Variables Reference

> **Targets:** Bun 1.3.9+ | LangGraph | TypeScript 5.x
> **Last updated:** 2026-04-09

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

Each MCP server writes traces to its own LangSmith project. This allows per-server dashboards while the main agent project captures the orchestration layer. Set `LANGSMITH_TRACING=false` to disable all tracing (useful for local development without a LangSmith account).

---

## Elasticsearch MCP Server

The Elasticsearch MCP server supports multi-deployment configuration, allowing a single server instance to query multiple Elasticsearch clusters.

### Multi-Deployment Configuration

Deployments are defined by a comma-separated list of deployment IDs. Each deployment ID becomes a prefix for its connection variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ELASTIC_DEPLOYMENTS` | Yes | -- | Comma-separated deployment IDs (e.g., `production,staging`) |

For each deployment ID (referred to as `{ID}` below), provide one of two authentication methods:

### Per-Deployment Connection Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ELASTIC_{ID}_URL` | Yes | -- | Elasticsearch cluster URL including port |
| `ELASTIC_{ID}_API_KEY` | Conditional | -- | API key authentication (preferred) |
| `ELASTIC_{ID}_USERNAME` | Conditional | -- | Basic auth username (alternative to API key) |
| `ELASTIC_{ID}_PASSWORD` | Conditional | -- | Basic auth password (paired with username) |

Each deployment requires either `ELASTIC_{ID}_API_KEY` or both `ELASTIC_{ID}_USERNAME` and `ELASTIC_{ID}_PASSWORD`. API key authentication is preferred for production deployments.

Example for two deployments:

```bash
ELASTIC_DEPLOYMENTS=production,staging

# Production: API key auth
ELASTIC_PRODUCTION_URL=https://prod-es.example.com:9200
ELASTIC_PRODUCTION_API_KEY=your-api-key-here

# Staging: Basic auth
ELASTIC_STAGING_URL=https://staging-es.example.com:9200
ELASTIC_STAGING_USERNAME=elastic
ELASTIC_STAGING_PASSWORD=your-password-here
```

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
- `msk` -- AWS MSK with IAM authentication (uses `AWS_REGION` and IAM credentials)
- `confluent` -- Confluent Cloud with API key/secret authentication

### Feature Gates

Feature gates control which tool categories are available. All default to `false` for safety.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `KAFKA_ALLOW_WRITES` | No | `false` | Enable topic produce and consumer group management tools |
| `KAFKA_ALLOW_DESTRUCTIVE` | No | `false` | Enable topic deletion and partition reassignment tools |
| `SCHEMA_REGISTRY_ENABLED` | No | `false` | Enable Confluent Schema Registry tools |
| `KSQL_ENABLED` | No | `false` | Enable ksqlDB query tools |

Setting `KAFKA_ALLOW_DESTRUCTIVE=true` requires `KAFKA_ALLOW_WRITES=true` as well. The config loader enforces this constraint during validation.

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

## Agent Configuration

Settings for the LangGraph supervisor agent, including model selection and state persistence.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AGENT_LLM_MODEL` | No | `claude-sonnet-4-6` | Primary model for supervisor, aggregator, and validator nodes |
| `AGENT_LLM_HAIKU_MODEL` | No | `claude-haiku-4-5` | Fast model for classifier and entity extractor nodes |
| `AGENT_LLM_REGION` | No | `eu-west-1` | AWS region for Bedrock model inference |
| `AGENT_CHECKPOINTER_TYPE` | No | `memory` | State persistence backend: `memory` or `sqlite` |

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
