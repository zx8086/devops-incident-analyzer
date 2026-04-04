# Deploying Kafka MCP Server to AWS Bedrock AgentCore Runtime

## Overview

This guide covers Phase 1: deploying your existing Kafka MCP server to AgentCore Runtime
and registering it behind AgentCore Gateway. Your server already has HTTP transport with
stateless mode — the changes are minimal.

## What changes

| File | Change | Why |
|------|--------|-----|
| `packages/mcp-server-kafka/src/agentcore-entrypoint.ts` | **New** — AgentCore-specific entrypoint | AgentCore expects `0.0.0.0:8000/mcp` with specific `/ping` and `/invocations` contract |
| `packages/mcp-server-kafka/Dockerfile.agentcore` | **New** — Container image for AgentCore | AgentCore deploys containers to microVMs |
| `packages/mcp-server-kafka/agentcore.json` | **New** — AgentCore Runtime configuration | Declares runtime name, protocol, region |
| `packages/mcp-server-kafka/src/transport/agentcore.ts` | **New** — AgentCore transport adapter | Bridges your existing MCP server to AgentCore's HTTP contract |
| `packages/mcp-server-kafka/src/index.ts` | **Untouched** | Existing entrypoint stays for local/ECS use |
| `packages/mcp-server-kafka/src/config/defaults.ts` | **Untouched** | AgentCore entrypoint overrides via env vars |

## Key insight

AgentCore Runtime for MCP servers expects:
1. Stateless streamable-HTTP on `0.0.0.0:8000/mcp`
2. A `/ping` health endpoint (returns 200)
3. MCP protocol messages proxied through `/invocations`

Your server already supports stateless HTTP mode via `MCP_TRANSPORT=http`.
The AgentCore entrypoint just configures the right port/path and adds the
`/ping` endpoint.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│ AgentCore Runtime (microVM)                         │
│                                                     │
│  ┌─────────────────────────────────────────────┐    │
│  │ agentcore-entrypoint.ts                     │    │
│  │                                             │    │
│  │  GET /ping → 200 OK                        │    │
│  │  POST /mcp → WebStandardStreamableHTTP     │    │
│  │            → McpServer (your 30 tools)      │    │
│  │            → KafkaService                   │    │
│  │            → MskKafkaProvider (IAM auth)    │    │
│  └─────────────────────────────────────────────┘    │
│                                                     │
│  IAM Role: kafka-mcp-agentcore-role                 │
│  - kafka-cluster:Connect/Read/Describe              │
│  - kafka:GetBootstrapBrokers                        │
│  - logs:CreateLogGroup/PutLogEvents                 │
└─────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────┐
│ AgentCore Gateway           │
│                             │
│ Single MCP endpoint for     │
│ agent to discover all tools │
│ across Kafka + Elastic +    │
│ Couchbase MCP servers       │
└─────────────────────────────┘
```

## Deployment steps

### 1. Build container image
### 2. Push to ECR
### 3. Create AgentCore Runtime (MCP protocol)
### 4. Register as Gateway target
### 5. Update agent to use Gateway URL
