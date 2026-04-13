# Docker Reference

> **Targets:** Bun 1.3.9+ | Docker 24.0+ | Alpine Linux
> **Last updated:** 2026-04-04

Reference for all Docker images in the DevOps Incident Analyzer monorepo. Covers the multi-stage build strategy, local development images, the parameterized AgentCore production image, and security practices.

---

## Build Strategy

All Docker images in this project follow a multi-stage build pattern optimized for Bun:

```
Stage 1: deps
  Base: oven/bun:1-alpine
  Purpose: Install production dependencies
  Output: node_modules/, dumb-init binary

Stage 2: runtime
  Base: oven/bun:1-alpine
  Purpose: Minimal runtime with source + deps
  Output: Final image
```

**Why multi-stage:** The deps stage runs `bun install`, which downloads and compiles packages. The runtime stage copies only the resulting `node_modules/` directory, excluding the Bun cache, lockfile resolution artifacts, and development dependencies. This reduces image size by 40-60%.

**Why Alpine:** The `oven/bun:1-alpine` base image is approximately 80MB compared to 200MB+ for Debian-based images. Alpine uses musl libc, which is compatible with Bun's statically-linked binary.

---

## Local Development Images

Docker Compose uses per-service images defined in `docker-compose.yml`. Each service builds from its own context within the monorepo.

| Service | Build Context | Exposed Port | Transport |
|---------|--------------|-------------|-----------|
| `elastic-mcp` | `packages/mcp-server-elastic` | 8080 | SSE |
| `kafka-mcp` | `packages/mcp-server-kafka` | 3000 | HTTP |
| `couchbase-mcp` | `packages/mcp-server-couchbase` | 8082 | HTTP |
| `konnect-mcp` | `packages/mcp-server-konnect` | 8083 | HTTP |
| `agent-web` | `apps/web` | 5173 | -- |

Local development images include all dependencies (not just production) and mount source directories as volumes for hot reload. They are not suitable for production deployment.

---

## AgentCore Production Image

The `Dockerfile.agentcore` at the repository root builds production images for AWS Bedrock AgentCore deployment. It is parameterized -- a single Dockerfile builds any of the five MCP servers.

### Build Commands

```bash
# Elasticsearch MCP
docker build \
  -f Dockerfile.agentcore \
  --build-arg MCP_SERVER_PACKAGE=mcp-server-elastic \
  -t elastic-mcp-agentcore .

# Kafka MCP
docker build \
  -f Dockerfile.agentcore \
  --build-arg MCP_SERVER_PACKAGE=mcp-server-kafka \
  -t kafka-mcp-agentcore .

# Couchbase MCP
docker build \
  -f Dockerfile.agentcore \
  --build-arg MCP_SERVER_PACKAGE=mcp-server-couchbase \
  -t couchbase-mcp-agentcore .

# Konnect MCP
docker build \
  -f Dockerfile.agentcore \
  --build-arg MCP_SERVER_PACKAGE=mcp-server-konnect \
  -t konnect-mcp-agentcore .
```

### Build Argument

| Argument | Default | Description |
|----------|---------|-------------|
| `MCP_SERVER_PACKAGE` | `mcp-server-kafka` | Directory name under `packages/` for the target server |

### What the Image Contains

```
/app/
  node_modules/           Production dependencies only
  packages/
    shared/src/           Shared types, schemas, utilities
    <server>/src/         Target MCP server source
  dumb-init              PID 1 init process
```

The image does not contain:

- Development dependencies
- Other MCP server packages (only the target server and shared are included)
- The web frontend
- The agent package
- Test files
- Build tooling (Biome, TypeScript compiler)

### Runtime Configuration

| Environment Variable | Value | Set By |
|---------------------|-------|--------|
| `ENTRYPOINT_PATH` | `packages/<server>/src/index.ts` | Dockerfile |
| `NODE_ENV` | `production` | Dockerfile |
| `MCP_TRANSPORT` | `agentcore` | AgentCore Runtime |
| `MCP_PORT` | `8000` | AgentCore contract |

Additional environment variables (credentials, provider settings) are injected by AgentCore Runtime from the deployment configuration.

---

## Security Practices

### Non-Root User

All production images create and switch to a non-root user:

```dockerfile
RUN addgroup --system --gid 65532 appgroup && \
    adduser --system --uid 65532 --ingroup appgroup --no-create-home appuser
USER 65532
```

UID/GID 65532 is chosen to avoid conflicts with system users (0-999) and typical application users (1000-65533). The user has no login shell and no home directory.

### dumb-init for Signal Handling

Bun runs as PID 1 inside containers by default. PID 1 has special signal handling behavior in Linux -- it does not receive default signal handlers, which means `SIGTERM` is ignored unless explicitly handled. `dumb-init` wraps the Bun process and forwards signals correctly:

```dockerfile
ENTRYPOINT ["dumb-init", "--"]
CMD ["bun", "run", "${ENTRYPOINT_PATH}"]
```

This ensures graceful shutdown when the container orchestrator sends `SIGTERM` during scaling, updates, or termination.

### Health Checks

The Dockerfile includes a `HEALTHCHECK` instruction for container orchestrators that support it:

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8000/ping || exit 1
```

`wget` is used instead of `curl` because Alpine includes `wget` by default but not `curl`, avoiding an additional package install.

### Production Dependencies Only

The deps stage installs with `--production` flag:

```bash
bun install --frozen-lockfile --production
```

This excludes `devDependencies` from the image, reducing attack surface and image size. The `--frozen-lockfile` flag ensures the installed dependencies exactly match `bun.lock`, preventing supply chain drift.

### Image Scanning

Before pushing to ECR, scan images for known vulnerabilities:

```bash
docker scout cves kafka-mcp-agentcore:latest
```

Or use AWS ECR's built-in scanning:

```bash
aws ecr start-image-scan \
  --repository-name kafka-mcp-agentcore \
  --image-id imageTag=latest
```

---

## See Also

- [AgentCore Deployment](agentcore-deployment.md) -- full deployment pipeline including IAM and Gateway registration
- [Local Development](local-development.md) -- Docker Compose and bare-metal setup

---

## Changelog

| Date | Change |
|------|--------|
| 2026-04-04 | Initial Docker reference created (Phase 3: Configuration + Deployment) |
