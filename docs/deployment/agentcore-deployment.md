# AWS Bedrock AgentCore Deployment

> **Targets:** Bun 1.3.9+ | AWS Bedrock AgentCore | Docker
> **Last updated:** 2026-04-04

Guide for deploying MCP servers to AWS Bedrock AgentCore Runtime. Covers the container contract, parameterized Dockerfile, IAM policies, deployment steps, and local testing. Each MCP server is deployed as an independent AgentCore Runtime behind a shared AgentCore Gateway that the agent discovers tools through.

---

## Overview

AgentCore Runtime hosts MCP servers inside isolated microVMs. Each server runs as a container that exposes three endpoints:

- `GET /ping` -- Liveness probe, returns 200 OK
- `GET /health` -- Readiness probe with detailed status
- `POST /mcp` -- Streamable HTTP for MCP protocol messages

The AgentCore Gateway aggregates multiple Runtime instances behind a single endpoint, allowing the agent to discover all tools across all four MCP servers through one connection.

Each MCP server is deployed independently. The parameterized `Dockerfile.agentcore` at the repository root builds any of the four servers using a build argument.

---

## Architecture

```
+---------------------------------------------------+
| AgentCore Runtime (microVM)                       |
|                                                   |
|   agentcore-entrypoint.ts                         |
|     GET /ping   -> 200 OK                         |
|     GET /health -> 200 OK + status JSON           |
|     POST /mcp   -> Streamable HTTP                |
|       -> new McpServer() per request              |
|       -> tools -> provider (ES/Kafka/CB/Konnect)  |
|                                                   |
|   IAM Role: <server>-mcp-agentcore-role           |
+---------------------------------------------------+
          |
          v
+---------------------------------------------------+
| AgentCore Gateway                                 |
|                                                   |
| Single MCP endpoint for agent tool discovery      |
| Aggregates: elastic + kafka + couchbase + konnect |
+---------------------------------------------------+
          |
          v
+---------------------------------------------------+
| LangGraph Agent                                   |
|                                                   |
| MultiServerMCPClient connects to Gateway          |
| Supervisor fans out to sub-agents per datasource  |
+---------------------------------------------------+
```

Each microVM receives its own IAM role with permissions scoped to the specific data source the MCP server accesses. The gateway handles routing -- the agent does not need to know individual server addresses.

---

## Parameterized Dockerfile

The repository contains a single `Dockerfile.agentcore` at the project root. It builds any of the four MCP servers using the `MCP_SERVER_PACKAGE` build argument.

### Build Argument

| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| `MCP_SERVER_PACKAGE` | No | `mcp-server-kafka` | Package directory name under `packages/` |

### Multi-Stage Build

The Dockerfile uses a two-stage Alpine build to minimize image size:

**Stage 1: deps** -- Installs dependencies.

```
Base: oven/bun:1-alpine
  1. Install dumb-init (PID 1 signal handling)
  2. Copy package.json + bun.lock for shared + target server
  3. Run bun install --frozen-lockfile --production
```

**Stage 2: runtime** -- Copies only what the server needs.

```
Base: oven/bun:1-alpine
  1. Copy dumb-init binary from deps stage
  2. Create non-root user appuser:appgroup (UID/GID 65532)
  3. Copy node_modules from deps stage
  4. Copy shared package source
  5. Copy target server source
  6. Set ENTRYPOINT_PATH env var
  7. Switch to non-root user (USER 65532)
  8. EXPOSE 8000
  9. HEALTHCHECK: wget http://localhost:8000/ping
  10. ENTRYPOINT: dumb-init
  11. CMD: bun run ${ENTRYPOINT_PATH}
```

### Security Measures

| Practice | Implementation |
|----------|---------------|
| Non-root execution | `USER 65532` (appuser, no login shell) |
| PID 1 signal handling | `dumb-init` as entrypoint wraps Bun process |
| Minimal image | Alpine base, production-only dependencies |
| Health monitoring | `HEALTHCHECK` instruction for container orchestrators |
| Frozen lockfile | `--frozen-lockfile` prevents dependency drift |

---

## AgentCore Entrypoint Contract

Each MCP server provides an `agentcore-entrypoint.ts` file that satisfies the AgentCore Runtime contract. This file is separate from the standard `index.ts` used for local development and Docker Compose.

### Endpoints

| Method | Path | Response | Purpose |
|--------|------|----------|---------|
| `GET` | `/ping` | `200 OK` (empty body) | Liveness probe -- AgentCore polls this to verify the container is running |
| `GET` | `/health` | `200 OK` with JSON status | Readiness probe -- includes server name, tool count, uptime |
| `POST` | `/mcp` | Streamable HTTP response | MCP protocol messages -- each request gets a fresh `McpServer` instance |

### Stateless Model

The AgentCore entrypoint creates a new `McpServer` instance for every incoming `/mcp` request and disposes it after the response completes. This is different from the persistent server model used in stdio or SSE modes. The stateless model is required because AgentCore may route requests to different microVM instances.

```
Request -> create McpServer -> register tools -> handle message -> dispose
```

No session state is maintained between requests. Tool handlers must be self-contained -- they read from the data source, process the result, and return it within a single request lifecycle.

### Port and Binding

The entrypoint binds to `0.0.0.0:8000`. This is hardcoded in the AgentCore contract and should not be changed. The `EXPOSE 8000` instruction in the Dockerfile documents this.

---

## Deployment Steps

The `scripts/agentcore/deploy.sh` script automates the full deployment pipeline. Each step can also be run manually. The examples below use the Kafka MCP server; substitute the package name for other servers.

### Step 1: Build Container Image

Build the Docker image with the target server specified as a build argument:

```bash
docker build \
  -f Dockerfile.agentcore \
  --build-arg MCP_SERVER_PACKAGE=mcp-server-kafka \
  -t kafka-mcp-agentcore:latest \
  .
```

Build commands for all four servers:

```bash
docker build -f Dockerfile.agentcore --build-arg MCP_SERVER_PACKAGE=mcp-server-elastic -t elastic-mcp-agentcore .
docker build -f Dockerfile.agentcore --build-arg MCP_SERVER_PACKAGE=mcp-server-kafka -t kafka-mcp-agentcore .
docker build -f Dockerfile.agentcore --build-arg MCP_SERVER_PACKAGE=mcp-server-couchbase -t couchbase-mcp-agentcore .
docker build -f Dockerfile.agentcore --build-arg MCP_SERVER_PACKAGE=mcp-server-konnect -t konnect-mcp-agentcore .
```

### Step 2: Push to ECR

Create the ECR repository (if it does not exist) and push the image:

```bash
# Create repository
aws ecr create-repository \
  --repository-name kafka-mcp-agentcore \
  --region eu-west-1

# Authenticate Docker to ECR
aws ecr get-login-password --region eu-west-1 | \
  docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.eu-west-1.amazonaws.com

# Tag and push
docker tag kafka-mcp-agentcore:latest \
  <ACCOUNT_ID>.dkr.ecr.eu-west-1.amazonaws.com/kafka-mcp-agentcore:latest

docker push \
  <ACCOUNT_ID>.dkr.ecr.eu-west-1.amazonaws.com/kafka-mcp-agentcore:latest
```

### Step 3: Create IAM Role and Policies

Each MCP server needs an IAM role that AgentCore Runtime assumes. The role has a trust policy for the AgentCore service and permission policies scoped to the server's data source.

**Trust policy** (common to all servers):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "bedrock-agentcore.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

Create the role:

```bash
aws iam create-role \
  --role-name kafka-mcp-agentcore-role \
  --assume-role-policy-document file://trust-policy.json
```

Attach the base policy and any server-specific policies (see [IAM Policies](#iam-policies) below).

### Step 4: Create AgentCore Runtime

Create or update the AgentCore Runtime resource. The `--environment-variables` differ per server:

```bash
aws bedrock-agentcore create-runtime \
  --runtime-name kafka-mcp-runtime \
  --protocol MCP \
  --network-mode PUBLIC \
  --container-image <ACCOUNT_ID>.dkr.ecr.eu-west-1.amazonaws.com/kafka-mcp-agentcore:latest \
  --role-arn arn:aws:iam::<ACCOUNT_ID>:role/kafka-mcp-agentcore-role \
  --environment-variables "KAFKA_PROVIDER=msk,MSK_CLUSTER_ARN=<ARN>,AWS_REGION=eu-west-1" \
  --region eu-west-1
```

Key parameters:

| Parameter | Value | Notes |
|-----------|-------|-------|
| `protocol` | `MCP` | AgentCore handles MCP message routing |
| `networkMode` | `PUBLIC` | Server can reach external data sources (Kafka brokers, Elasticsearch clusters) |

#### Per-Server Environment Variables

| Server | Required Variables | Notes |
|--------|-------------------|-------|
| Kafka | `KAFKA_PROVIDER`, `MSK_CLUSTER_ARN` (for MSK), `AWS_REGION` | `KAFKA_PROVIDER=msk` for AWS MSK clusters |
| Elastic | `ELASTICSEARCH_URL`, `ELASTICSEARCH_API_KEY` or `ELASTICSEARCH_USERNAME` + `ELASTICSEARCH_PASSWORD` | Authenticates directly to ES cluster, no AWS-specific IAM needed |
| Couchbase | `CB_HOSTNAME`, `CB_USERNAME`, `CB_PASSWORD`, `CB_BUCKET` | Authenticates via Capella SDK credentials |
| Konnect | `KONNECT_ACCESS_TOKEN`, `KONNECT_REGION` | Uses Kong Konnect API token, region: `us\|eu\|au\|me\|in` |

### Step 5: Register as Gateway Target

After the Runtime is active, register it as a target on the AgentCore Gateway so the agent can discover its tools:

```bash
aws bedrock-agentcore add-gateway-target \
  --gateway-id <GATEWAY_ID> \
  --runtime-id <RUNTIME_ID>
```

The deploy script saves all deployment details (runtime ID, gateway ID, ECR URI, role ARN) to `.agentcore-deployment.json` in the project root.

---

## IAM Policies

### Base Policy (All Servers)

Every MCP server needs CloudWatch Logs access for container logging and ECR pull access for image deployment:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:eu-west-1:*:*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:GetAuthorizationToken"
      ],
      "Resource": "*"
    }
  ]
}
```

### Kafka-Specific Policy

The Kafka MCP server with MSK provider needs access to MSK cluster operations:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "kafka-cluster:Connect",
        "kafka-cluster:DescribeCluster",
        "kafka-cluster:ReadData",
        "kafka-cluster:DescribeTopic",
        "kafka-cluster:DescribeGroup"
      ],
      "Resource": "arn:aws:kafka:eu-west-1:*:cluster/*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "kafka:GetBootstrapBrokers",
        "kafka:DescribeCluster",
        "kafka:ListClusters"
      ],
      "Resource": "*"
    }
  ]
}
```

If `KAFKA_ALLOW_WRITES=true`, add `kafka-cluster:WriteData` and `kafka-cluster:CreateTopic` to the cluster resource statement.

### Elasticsearch-Specific Policy

The Elasticsearch MCP server does not require AWS-specific IAM policies -- it authenticates directly to Elasticsearch clusters using API keys or basic auth. No additional IAM policy is needed beyond the base policy.

### Couchbase-Specific Policy

The Couchbase MCP server connects directly to Capella clusters using SDK credentials. No additional IAM policy is needed beyond the base policy.

### Konnect-Specific Policy

The Konnect MCP server authenticates using a Konnect access token passed via environment variable. No additional IAM policy is needed beyond the base policy.

---

## Deployment Scripts

The `scripts/agentcore/` directory contains automation scripts for the deployment process:

| Script | Purpose |
|--------|---------|
| `deploy.sh` | Full 5-step deployment pipeline (ECR, build, IAM, Runtime, Gateway) |
| `test-local.sh` | Test AgentCore endpoints against a running server |
| `register-gateway.sh` | Register a deployed Runtime as an AgentCore Gateway target |

### deploy.sh

Usage:

```bash
./scripts/agentcore/deploy.sh                              # Deploys Kafka (default)
MCP_SERVER=elastic ./scripts/agentcore/deploy.sh           # Deploys Elastic
MCP_SERVER=couchbase ./scripts/agentcore/deploy.sh         # Deploys Couchbase
MCP_SERVER=konnect ./scripts/agentcore/deploy.sh           # Deploys Konnect
```

The `MCP_SERVER` env var selects which server to deploy. The script is idempotent -- it creates resources if they do not exist and updates them if they do. On completion, it outputs connection information and saves deployment metadata to `.agentcore-deployment.json`.

### test-local.sh

Usage:

```bash
./scripts/agentcore/test-local.sh                              # Tests kafka (default)
MCP_SERVER=elastic ./scripts/agentcore/test-local.sh           # Tests elastic
MCP_SERVER=couchbase ./scripts/agentcore/test-local.sh         # Tests couchbase
MCP_SERVER=konnect ./scripts/agentcore/test-local.sh           # Tests konnect
```

The script verifies `/ping`, `/health`, and `/mcp` endpoints against a running AgentCore-mode server. It checks that the MCP initialize response contains the expected server name (`<MCP_SERVER>-mcp-server`).

---

## Testing Locally

Before deploying to AgentCore, test the container image locally to verify the entrypoint, health checks, and MCP endpoints work correctly.

### Build and Run (per server)

**Kafka:**
```bash
docker build -f Dockerfile.agentcore --build-arg MCP_SERVER_PACKAGE=mcp-server-kafka -t kafka-mcp-agentcore .
docker run --rm -p 8000:8000 -e KAFKA_PROVIDER=local -e KAFKA_BROKERS=host.docker.internal:9092 kafka-mcp-agentcore
```

**Elastic:**
```bash
docker build -f Dockerfile.agentcore --build-arg MCP_SERVER_PACKAGE=mcp-server-elastic -t elastic-mcp-agentcore .
docker run --rm -p 8000:8000 -e ELASTICSEARCH_URL=http://host.docker.internal:9200 elastic-mcp-agentcore
```

**Couchbase:**
```bash
docker build -f Dockerfile.agentcore --build-arg MCP_SERVER_PACKAGE=mcp-server-couchbase -t couchbase-mcp-agentcore .
docker run --rm -p 8000:8000 -e CB_HOSTNAME=host.docker.internal -e CB_USERNAME=admin -e CB_PASSWORD=password -e CB_BUCKET=default couchbase-mcp-agentcore
```

**Konnect:**
```bash
docker build -f Dockerfile.agentcore --build-arg MCP_SERVER_PACKAGE=mcp-server-konnect -t konnect-mcp-agentcore .
docker run --rm -p 8000:8000 -e KONNECT_ACCESS_TOKEN=your-token -e KONNECT_REGION=us konnect-mcp-agentcore
```

Or test without Docker by running the entrypoint directly:

```bash
KAFKA_PROVIDER=local bun run packages/mcp-server-kafka/src/agentcore-entrypoint.ts
ELASTICSEARCH_URL=http://localhost:9200 bun run packages/mcp-server-elastic/src/agentcore-entrypoint.ts
CB_HOSTNAME=localhost bun run packages/mcp-server-couchbase/src/agentcore-entrypoint.ts
KONNECT_ACCESS_TOKEN=test bun run packages/mcp-server-konnect/src/agentcore-entrypoint.ts
```

### Verify Endpoints

```bash
# Liveness probe
curl -s http://localhost:8000/ping
# Expected: 200 OK

# Health check
curl -s http://localhost:8000/health
# Expected: 200 OK with JSON body

# MCP tool list (example)
curl -s -X POST http://localhost:8000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
# Expected: JSON-RPC response with tool list
```

### Using test-local.sh

The test script verifies all AgentCore endpoints against a running server:

```bash
MCP_SERVER=kafka ./scripts/agentcore/test-local.sh
MCP_SERVER=elastic ./scripts/agentcore/test-local.sh
MCP_SERVER=couchbase ./scripts/agentcore/test-local.sh
MCP_SERVER=konnect ./scripts/agentcore/test-local.sh
```

It checks `/ping`, `/health`, `/mcp` initialize response (verifies server name matches), GET `/mcp` returns 405, and unknown paths return 404. Exit code 0 means all checks passed.

---

## See Also

- [Docker Reference](docker-reference.md) -- Dockerfile patterns and build commands for all images
- [Local Development](local-development.md) -- running services without AgentCore
- [Environment Variables](../configuration/environment-variables.md) -- all configuration variables
- [MCP Server Configuration](../configuration/mcp-server-configuration.md) -- transport modes including AgentCore

---

## Changelog

| Date | Change |
|------|--------|
| 2026-04-07 | Updated to cover all 4 MCP servers with per-server env vars, build examples, and parameterized scripts |
| 2026-04-04 | Initial AgentCore deployment guide created (Phase 3: Configuration + Deployment), migrated from docs/agentbedrockcore/ |
