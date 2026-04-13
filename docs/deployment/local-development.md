# Local Development Setup

> **Targets:** Bun 1.3.9+ | Docker 24.0+ | TypeScript 5.x
> **Last updated:** 2026-04-04

Instructions for running the full DevOps Incident Analyzer stack locally. Covers two approaches: Docker Compose (single command, all services) and bare-metal (individual Bun processes). Includes port assignments, health verification, and common startup issues.

---

## Prerequisites

### Required Software

| Software | Minimum Version | Verify Command |
|----------|----------------|----------------|
| Bun | 1.3.9+ | `bun --version` |
| Docker | 24.0+ | `docker --version` |
| Docker Compose | 2.20+ | `docker compose version` |

### Service Credentials

Copy the environment template and fill in credentials for the services you need:

```bash
cp .env.example .env
```

Not all credentials are required for every development task. If you are only working on the Kafka MCP server, you only need Kafka broker access and AWS credentials. See [Environment Variables](../configuration/environment-variables.md) for the full variable reference.

---

## Local Infrastructure

The MCP servers connect to external data sources. Most (Elasticsearch, Couchbase Capella, Kong Konnect) are cloud-hosted and only need credentials in `.env`. Kafka is the exception -- when using `KAFKA_PROVIDER=local`, you need a Kafka broker running on your machine.

### Local Kafka Broker

Start a single-node KRaft Kafka broker (no Zookeeper required):

```bash
docker run -d --name kafka \
  -p 9092:9092 \
  -e KAFKA_NODE_ID=0 \
  -e KAFKA_PROCESS_ROLES=broker,controller \
  -e KAFKA_LISTENERS=PLAINTEXT://:9092,CONTROLLER://:9093 \
  -e KAFKA_ADVERTISED_LISTENERS=PLAINTEXT://localhost:9092 \
  -e KAFKA_CONTROLLER_QUORUM_VOTERS=0@localhost:9093 \
  -e KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER \
  -e KAFKA_LISTENER_SECURITY_PROTOCOL_MAP=CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT \
  -e CLUSTER_ID=MkU3OEVBNTcwNTJENDM2Qk \
  apache/kafka:latest
```

Verify the broker is running:

```bash
docker logs kafka 2>&1 | tail -3
# Should show: Kafka Server started

lsof -i :9092
# Should show a process listening
```

Ensure `.env` is configured for local Kafka (and that `AGENTCORE_RUNTIME_ARN` is **not** set, otherwise the server enters AgentCore proxy mode instead of connecting to local Kafka):

```bash
KAFKA_PROVIDER=local
KAFKA_BROKERS=localhost:9092

# Comment out or remove these for local development:
# AGENTCORE_RUNTIME_ARN=...
# AGENTCORE_PROXY_PORT=...
# AGENTCORE_AWS_ACCESS_KEY_ID=...
# AGENTCORE_AWS_SECRET_ACCESS_KEY=...
```

### Managing the Local Broker

```bash
# Stop
docker stop kafka

# Start again (data persists)
docker start kafka

# Remove completely (loses all topic data)
docker rm -f kafka
```

### Creating Test Topics

Use the Kafka CLI inside the container to create topics for testing:

```bash
docker exec kafka /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:9092 \
  --create --topic test-topic --partitions 3 --replication-factor 1

docker exec kafka /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:9092 --list
```

---

## Option 1: Docker Compose

Docker Compose starts all six services (five MCP servers + web frontend) with a single command. Health checks ensure the web frontend waits for all MCP servers to be ready before starting.

### Starting

```bash
docker compose up
```

Add `-d` to run in detached mode:

```bash
docker compose up -d
```

### Service Ports

| Service | Container Name | Port | Health URL |
|---------|---------------|------|------------|
| Elasticsearch MCP | `elastic-mcp` | 9080 | `http://localhost:9080/health` |
| Kafka MCP | `kafka-mcp` | 9081 | `http://localhost:9081/health` |
| Couchbase MCP | `couchbase-mcp` | 9082 | `http://localhost:9082/health` |
| Konnect MCP | `konnect-mcp` | 9083 | `http://localhost:9083/health` |
| GitLab MCP | `gitlab-mcp` | 9084 | `http://localhost:9084/health` |
| Web Frontend | `agent-web` | 5173 | `http://localhost:5173` |

All MCP servers expose health checks. The `agent-web` service has `depends_on` conditions that wait for all five MCP servers to report healthy before starting. Health checks use:

```bash
bun --eval "fetch('http://localhost:PORT/health').then(r => { if (!r.ok) process.exit(1) })"
```

### Viewing Logs

Follow logs for all services:

```bash
docker compose logs -f
```

Follow logs for a single service:

```bash
docker compose logs -f kafka-mcp
```

### Stopping

Stop all services and remove containers:

```bash
docker compose down
```

Stop and remove volumes (resets all state):

```bash
docker compose down -v
```

---

## Option 2: Bare-Metal

Running each service as an individual Bun process gives you direct access to logs, faster restart cycles, and the ability to run only the services you need.

### Starting MCP Servers

Open a separate terminal for each server. Each command sets the transport mode and port via environment variables:

```bash
# Terminal 1: Elasticsearch MCP (port 9080)
MCP_TRANSPORT=sse MCP_PORT=9080 bun packages/mcp-server-elastic/src/index.ts

# Terminal 2: Kafka MCP (port 9081)
MCP_TRANSPORT=http MCP_PORT=9081 bun packages/mcp-server-kafka/src/index.ts

# Terminal 3: Couchbase MCP (port 9082)
MCP_TRANSPORT=http MCP_PORT=9082 bun packages/mcp-server-couchbase/src/index.ts

# Terminal 4: Konnect MCP (port 9083)
MCP_TRANSPORT=http MCP_PORT=9083 bun packages/mcp-server-konnect/src/index.ts

# Terminal 5: GitLab MCP (port 9084)
MCP_TRANSPORT=http MCP_PORT=9084 bun packages/mcp-server-gitlab/src/index.ts
```

Each server logs its transport type, port, and tool count on startup:

```
[mcp-server-kafka] Transport: http | Port: 9081 | Tools: 30
```

### Starting the Web Frontend

In a sixth terminal:

```bash
bun run --filter @devops-agent/web dev
```

The SvelteKit development server starts at `http://localhost:5173` with hot module replacement enabled. Changes to Svelte components and server routes reload automatically.

### Verifying Connectivity

After all services are running, verify the agent can reach each MCP server:

```bash
# Check each MCP server health endpoint
curl -s http://localhost:9080/health
curl -s http://localhost:9081/health
curl -s http://localhost:9082/health
curl -s http://localhost:9083/health
curl -s http://localhost:9084/health
```

Each should return a 200 status with a JSON body containing the server name and tool count.

When running bare-metal, update the MCP server URLs in `.env` to match the bare-metal ports:

```bash
ELASTIC_MCP_URL=http://localhost:9080
KAFKA_MCP_URL=http://localhost:9081
COUCHBASE_MCP_URL=http://localhost:9082
KONNECT_MCP_URL=http://localhost:9083
GITLAB_MCP_URL=http://localhost:9084
```

---

## Port Assignments

Port numbers differ between local bare-metal, Docker Compose, and AgentCore deployments. This table is the canonical reference.

| Service | Bare-Metal | Docker Compose | AgentCore |
|---------|-----------|----------------|-----------|
| Elasticsearch MCP | 9080 | 8080 | 8000 |
| Kafka MCP | 9081 | 3000 | 8000 |
| Couchbase MCP | 9082 | 8082 | 8000 |
| Konnect MCP | 9083 | 8083 | 8000 |
| GitLab MCP | 9084 | 8084 | 8000 |
| Web Frontend | 5173 | 5173 | -- |

In AgentCore, each MCP server runs in its own isolated microVM, so they all use port 8000 without conflict. The AgentCore Gateway handles routing.

---

## Common Startup Issues

### Port Already in Use

If a server fails to start with an address-in-use error, find the process occupying the port:

```bash
lsof -i :9080
```

Kill the process if appropriate:

```bash
kill -9 <PID>
```

Alternatively, choose a different port by changing the `MCP_PORT` value:

```bash
MCP_TRANSPORT=http MCP_PORT=9180 bun packages/mcp-server-elastic/src/index.ts
```

Remember to update the corresponding `ELASTIC_MCP_URL` in `.env` if you change the port.

### MCP Connection Failures

If the web frontend starts but the agent cannot reach MCP servers:

1. Verify MCP servers are running and healthy using the `curl` commands above.
2. Confirm the `*_MCP_URL` variables in `.env` match the actual running addresses.
3. Check that `CORS_ORIGINS` includes `http://localhost:5173`.
4. In Docker Compose, ensure services use container names (e.g., `http://elastic-mcp:8080`), not `localhost`.

### AWS Credential Errors

If the agent fails with Bedrock authentication errors:

1. Verify `AWS_REGION`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY` are set in `.env`.
2. Confirm the IAM user has `bedrock:InvokeModel` permission for the configured region.
3. Check that the model IDs in `AGENT_LLM_MODEL` and `AGENT_LLM_HAIKU_MODEL` are available in your region.

### Config Validation Errors

If a server exits immediately with a Zod validation error:

1. Read the error message -- it lists the exact field and constraint that failed.
2. Check `.env` for typos in variable names (they are case-sensitive).
3. Verify boolean values are `true` or `false` (not `yes`, `no`, `1`, or `0`).
4. For Elasticsearch, ensure every deployment in `ELASTIC_DEPLOYMENTS` has a corresponding `ELASTIC_{ID}_URL`.

---

## See Also

- [Environment Variables](../configuration/environment-variables.md) -- complete variable reference
- [MCP Server Configuration](../configuration/mcp-server-configuration.md) -- per-server config details and transport modes
- [Docker Reference](docker-reference.md) -- Dockerfile patterns and build commands
- [AgentCore Deployment](agentcore-deployment.md) -- deploying to AWS Bedrock AgentCore

---

## Changelog

| Date | Change |
|------|--------|
| 2026-04-04 | Initial local development setup guide created (Phase 3: Configuration + Deployment) |
