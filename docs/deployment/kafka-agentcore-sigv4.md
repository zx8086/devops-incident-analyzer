# Kafka MCP to AgentCore: SigV4 Connection Guide

The diagram below assumes IAM-authenticated MSK (port 9098, SASL/OAUTHBEARER + TLS). The SigV4 proxy itself is auth-mode-agnostic -- it signs the AgentCore invoke request, not the Kafka connection. For an unauthenticated MSK cluster (PLAINTEXT, port 9092) replace the in-VPC arrow with `MSK_AUTH_MODE=none` and see [`agentcore-msk-no-auth.md`](agentcore-msk-no-auth.md).

---

## Network Topology

```
Local Machine                              AWS (eu-central-1)
+--------------------------+               +-------------------------------------------+
|                          |               |                                           |
|  Agent App               |               |  Bedrock AgentCore Runtime (microVM, VPC) |
|    |                     |               |    Kafka MCP container :8000              |
|    | HTTP POST           |               |    /ping  /health  /mcp                  |
|    v                     |               |    |                                      |
|  SigV4 Proxy :3000       |   HTTPS/443   |    | SASL OAUTHBEARER (IAM token)        |
|    | signs request       |-------------->|    v                                      |
|    | with AWS creds      |   SigV4       |  MSK Cluster :9098 (TLS + IAM)           |
|                          |               |                                           |
+--------------------------+               +-------------------------------------------+
```

---

## Two Authentication Layers

There are two separate AWS auth steps. They use different credentials and different protocols.

| Layer | From -> To | Protocol | Credentials | Port |
|-------|-----------|----------|-------------|------|
| 1. SigV4 | Local proxy -> AgentCore API | HTTPS + SigV4 header | Your local AWS creds | 443 |
| 2. IAM SASL | Container -> MSK brokers | Kafka SASL/OAUTHBEARER over TLS | Container's IAM role (via STS) | 9098 |

Your local AWS credentials never reach the container. The container authenticates to MSK using its own IAM role assigned by AgentCore.

---

## Request Path

```
Agent App
  | POST http://localhost:3000/mcp (plain HTTP, JSON-RPC)
  v
SigV4 Proxy (localhost:3000)
  | 1. Resolves AWS credentials
  | 2. Signs request body with SigV4 (service: bedrock-agentcore)
  | 3. POST https://bedrock-agentcore.{region}.amazonaws.com
  |         /runtimes/{arn}/invocations?qualifier=DEFAULT
  v
AgentCore API (:443)
  | Verifies SigV4 signature against IAM
  | Routes to microVM
  v
Kafka MCP Container (:8000)
  | Executes Kafka tool (e.g. list_topics)
  | Generates IAM OAUTHBEARER token via STS
  | Connects to MSK brokers
  v
MSK Cluster (:9098, TLS + IAM SASL)
  | Returns data
  v
Response flows back the same path
```

---

## Ports and Protocols

| Endpoint | Address | Protocol | Direction |
|----------|---------|----------|-----------|
| SigV4 Proxy | `localhost:3000` | HTTP | Agent -> Proxy |
| AgentCore API | `bedrock-agentcore.{region}.amazonaws.com:443` | HTTPS + SigV4 | Proxy -> AWS |
| Container (inside microVM) | `0.0.0.0:8000` | HTTP | AgentCore -> Container |
| MSK Brokers | `b-N.cluster.kafka.{region}.amazonaws.com:9098` | Kafka + TLS + IAM SASL | Container -> MSK |
| STS (VPC Endpoint) | `sts.{region}.amazonaws.com:443` | HTTPS | Container -> STS (for IAM tokens) |

---

## SigV4 Signing Summary

Every request from the proxy to AgentCore carries an `Authorization` header:

```
Authorization: AWS4-HMAC-SHA256
  Credential=AKIA.../20260417/eu-central-1/bedrock-agentcore/aws4_request,
  SignedHeaders=content-type;host;x-amz-date,
  Signature=<hex>
```

Key details:
- **Service name:** `bedrock-agentcore` (not `bedrock` or `execute-api`)
- **Payload:** SHA-256 hash of the full request body (tamper protection)
- **Path:** Double URI-encoded (the ARN contains colons)
- **Signing key:** HMAC chain: secret key -> date -> region -> service -> "aws4_request"

---

## Credential Resolution (Proxy Side)

The proxy checks three sources in order:

| Priority | Source | Env Vars |
|----------|--------|----------|
| 1 | AgentCore-specific | `AGENTCORE_AWS_ACCESS_KEY_ID`, `AGENTCORE_AWS_SECRET_ACCESS_KEY`, `AGENTCORE_AWS_SESSION_TOKEN` |
| 2 | Standard AWS | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` |
| 3 | AWS CLI | Runs `aws configure export-credentials` |

Use `AGENTCORE_AWS_*` when the AgentCore account differs from the Bedrock LLM account.

---

## Required VPC Endpoints

AgentCore in VPC mode has no internet. The container needs these endpoints to function:

| Service | Type | Why |
|---------|------|-----|
| `sts` | Interface | IAM token generation for MSK auth |
| `ecr.dkr` | Interface | Pull container image layers |
| `ecr.api` | Interface | ECR authentication |
| `s3` | Gateway | ECR layer storage |
| `logs` | Interface | CloudWatch log delivery |

All interface endpoints must share the same security group as MSK. The SG must allow self-referencing inbound traffic.
