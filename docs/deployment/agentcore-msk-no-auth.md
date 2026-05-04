# AgentCore + MSK Deployment Guide (Unauthenticated Cluster)

> **Targets:** Bun 1.3.9+ | AWS Bedrock AgentCore | MSK Provisioned with `Unauthenticated` enabled
> **Last updated:** 2026-05-04

Deploying the Kafka MCP server to AWS Bedrock AgentCore Runtime against an MSK cluster that runs without authentication (PLAINTEXT, port 9092). **This is the default deployment path.** `MSK_AUTH_MODE` defaults to `none`; the IAM-authenticated path in [`agentcore-msk-setup.md`](agentcore-msk-setup.md) requires `MSK_AUTH_MODE=iam` set explicitly.

This guide differs from the IAM guide in three places:

1. The cluster is created (or already configured) with `--client-authentication '{"Unauthenticated": {"Enabled": true}}'` and is reachable on port 9092.
2. The runtime container talks to brokers in PLAINTEXT -- no SASL token, no TLS. This is the default; `MSK_AUTH_MODE=none` is implicit.
3. The IAM role for the runtime drops `kafka-cluster:*` and `kafka:GetBootstrapBrokers` (no IAM auth means no `sts` VPC endpoint either). Only ECR pull and CloudWatch logs are needed.

The MCP server logs the resolved auth mode at startup (`Creating Kafka provider`), so you can confirm the connection posture from container logs.

Everything else -- the container image, the SigV4 proxy on the agent side, the Gateway registration -- is identical to the IAM guide.

---

## Architecture

```
Local Machine                                  AWS Account (VPC)
+-------------------------------+              +------------------------------------------+
|                               |              |                                          |
|  Web App / Agent              |              |  AgentCore Runtime (microVM, VPC mode)   |
|    |                          |              |    kafka_mcp_server container             |
|    v                          |              |    GET /ping, GET /health, POST /mcp      |
|  mcp-bridge.ts (plain HTTP)   |              |    |                                      |
|    |                          |              |    | PLAINTEXT (no SASL, no TLS)          |
|    v                          |  SigV4       |    v                                      |
|  agentcore-proxy     ---------|------------->|  MSK Provisioned Cluster                 |
|    localhost:3000             |              |    port 9092 (PLAINTEXT, Unauthenticated)|
|                               |              |                                          |
+-------------------------------+              +------------------------------------------+
                                                       |
                                                VPC Endpoints:
                                                  ecr.dkr, ecr.api, s3, logs
                                                  (no sts -- no IAM token signing)
```

The runtime still needs network reachability to MSK brokers. For a private MSK cluster, the AgentCore runtime must run in `networkMode=VPC` with the same subnets and security group(s) as MSK. The `scripts/agentcore/deploy.sh` script switches modes automatically based on `AGENTCORE_SUBNETS` / `AGENTCORE_SECURITY_GROUPS`.

---

## Prerequisites

- AWS CLI v2.28+ with admin credentials for the target account
- Docker Desktop (Apple Silicon builds arm64 natively)
- Bun 1.3+
- `jq`
- Repository cloned with dependencies installed (`bun install`)

---

## Step 0: Set Variables

```bash
export AWS_REGION=eu-west-1
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export ECR_REPO=kafka-mcp-agentcore
export RUNTIME_NAME=kafka-mcp-server
export CLUSTER_NAME=my-msk-cluster
```

---

## Step 1: MSK Cluster (Unauthenticated)

If you do not already have one, create a provisioned MSK cluster with `Unauthenticated` enabled. Provisioned (not Serverless) is recommended -- Serverless cold starts trip tool timeouts.

```bash
export VPC_ID=$(aws ec2 describe-vpcs --filters "Name=isDefault,Values=true" \
  --query 'Vpcs[0].VpcId' --output text --region $AWS_REGION)
export SUBNETS=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" \
  --query 'Subnets[?AvailabilityZone!=`null`] | [:3].SubnetId' --output text --region $AWS_REGION)
export SUBNET_1=$(echo $SUBNETS | awk '{print $1}')
export SUBNET_2=$(echo $SUBNETS | awk '{print $2}')
export SG_ID=$(aws ec2 describe-security-groups \
  --filters "Name=vpc-id,Values=$VPC_ID" "Name=group-name,Values=default" \
  --query 'SecurityGroups[0].GroupId' --output text --region $AWS_REGION)

aws kafka create-cluster \
  --cluster-name $CLUSTER_NAME \
  --kafka-version "3.7.x.kraft" \
  --number-of-broker-nodes 2 \
  --broker-node-group-info '{
    "InstanceType": "kafka.m5.large",
    "ClientSubnets": ["'$SUBNET_1'", "'$SUBNET_2'"],
    "SecurityGroups": ["'$SG_ID'"],
    "StorageInfo": {"EbsStorageInfo": {"VolumeSize": 10}}
  }' \
  --client-authentication '{"Unauthenticated": {"Enabled": true}}' \
  --encryption-info '{"EncryptionInTransit": {"ClientBroker": "PLAINTEXT", "InCluster": true}}' \
  --region $AWS_REGION
```

`ClientBroker: PLAINTEXT` is what makes the brokers expose port 9092 instead of 9094 (TLS) or 9098 (IAM).

For an existing cluster, confirm it has `Unauthenticated.Enabled=true`:

```bash
aws kafka describe-cluster-v2 --cluster-arn $MSK_ARN --region $AWS_REGION \
  --query 'ClusterInfo.ClientAuthentication'
```

Get networking and broker details once the cluster is `ACTIVE`:

```bash
export MSK_ARN=$(aws kafka list-clusters-v2 --cluster-name-filter $CLUSTER_NAME \
  --query 'ClusterInfoList[0].ClusterArn' --output text --region $AWS_REGION)

export MSK_BOOTSTRAP=$(aws kafka get-bootstrap-brokers --cluster-arn $MSK_ARN \
  --query 'BootstrapBrokerString' --output text --region $AWS_REGION)

export MSK_SUBNETS=$(aws kafka describe-cluster --cluster-arn $MSK_ARN \
  --query 'ClusterInfo.BrokerNodeGroupInfo.ClientSubnets' --output text --region $AWS_REGION | tr '\t' ',')

export MSK_SG=$(aws kafka describe-cluster --cluster-arn $MSK_ARN \
  --query 'ClusterInfo.BrokerNodeGroupInfo.SecurityGroups[0]' --output text --region $AWS_REGION)

echo "Bootstrap (plaintext): $MSK_BOOTSTRAP"
echo "Subnets: $MSK_SUBNETS"
echo "Security Group: $MSK_SG"
```

Note: we use `BootstrapBrokerString` (PLAINTEXT, port 9092), not `BootstrapBrokerStringSaslIam`.

---

## Step 2: VPC Endpoints

The runtime needs reachability to AWS services to pull its container image and ship logs. Compared with the IAM guide, **no `sts` endpoint is required** -- there is no IAM token to sign.

```bash
for SVC in ecr.dkr ecr.api logs; do
  aws ec2 create-vpc-endpoint \
    --vpc-id $VPC_ID \
    --service-name com.amazonaws.$AWS_REGION.$SVC \
    --vpc-endpoint-type Interface \
    --subnet-ids $(echo $MSK_SUBNETS | tr ',' ' ') \
    --security-group-ids $MSK_SG \
    --private-dns-enabled \
    --region $AWS_REGION \
    --query 'VpcEndpoint.{Id: VpcEndpointId, State: State}' \
    --output table
done

aws ec2 create-vpc-endpoint \
  --vpc-id $VPC_ID \
  --service-name com.amazonaws.$AWS_REGION.s3 \
  --vpc-endpoint-type Gateway \
  --region $AWS_REGION \
  --query 'VpcEndpoint.{Id: VpcEndpointId, State: State}' \
  --output table
```

The security group must allow self-referencing inbound traffic. The `default` SG does this out of the box.

---

## Step 3: Deploy via `scripts/agentcore/deploy.sh`

The deploy script handles ECR creation/push, IAM role + policies, and runtime creation/update. `MSK_AUTH_MODE` defaults to `none` for both the runtime and the deploy script, so the IAM block scoped to `kafka-cluster:*` is skipped automatically.

```bash
MCP_SERVER=kafka \
KAFKA_PROVIDER=msk \
MSK_CLUSTER_ARN=$MSK_ARN \
MSK_BOOTSTRAP_BROKERS=$MSK_BOOTSTRAP \
AGENTCORE_SUBNETS=$MSK_SUBNETS \
AGENTCORE_SECURITY_GROUPS=$MSK_SG \
AWS_REGION=$AWS_REGION \
./scripts/agentcore/deploy.sh
```

(`MSK_AUTH_MODE=none` is implicit. Set it explicitly only if you want to make the choice obvious in deployment scripts.)

Setting `AGENTCORE_SUBNETS` and `AGENTCORE_SECURITY_GROUPS` switches the runtime to `networkMode=VPC` so it can reach the private MSK brokers.

The script writes deployment details to `.agentcore-deployment.json`:

```bash
jq . .agentcore-deployment.json
```

---

## Step 4: Verify

```bash
export RUNTIME_ARN=$(jq -r '.runtimeArn' .agentcore-deployment.json)

echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}' > /tmp/mcp-init.json

aws bedrock-agentcore invoke-agent-runtime \
  --agent-runtime-arn "$RUNTIME_ARN" \
  --qualifier DEFAULT \
  --content-type application/json \
  --accept "application/json, text/event-stream" \
  --payload fileb:///tmp/mcp-init.json \
  --region $AWS_REGION \
  /tmp/mcp-response.bin

cat /tmp/mcp-response.bin
# Expected: serverInfo.name = "@devops-agent/mcp-server-kafka"

echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"kafka_list_topics","arguments":{}}}' > /tmp/mcp-topics.json

aws bedrock-agentcore invoke-agent-runtime \
  --agent-runtime-arn "$RUNTIME_ARN" \
  --qualifier DEFAULT \
  --content-type application/json \
  --accept "application/json, text/event-stream" \
  --payload fileb:///tmp/mcp-topics.json \
  --region $AWS_REGION \
  /tmp/mcp-topics-response.bin

cat /tmp/mcp-topics-response.bin
# Expected: a topic list including __amazon_msk_canary on a fresh cluster
```

---

## Step 5: Configure Local Proxy

The agent connects to MCP servers over plain HTTP; AgentCore expects SigV4 signing on the invoke endpoint. The repo has a built-in SigV4 proxy that starts when both `MCP_TRANSPORT=agentcore` and `AGENTCORE_RUNTIME_ARN` are set.

`.env`:

```env
MCP_TRANSPORT=agentcore
AGENTCORE_RUNTIME_ARN=<RUNTIME_ARN from .agentcore-deployment.json>
AGENTCORE_PROXY_PORT=3000
KAFKA_MCP_URL=http://localhost:3000
```

Start the proxy:

```bash
cd packages/mcp-server-kafka && bun run dev
curl -s http://localhost:3000/health
```

The SigV4 proxy is auth-mode-agnostic -- it signs requests to the AgentCore invoke endpoint, not to Kafka. There is no change here compared with the IAM guide.

---

## Troubleshooting

### "metadata failed N times" or connection refused

Most often means the runtime can't reach MSK brokers on port 9092:

1. Confirm the runtime is in `networkMode=VPC` with the same subnets as MSK:
   ```bash
   aws bedrock-agentcore-control get-agent-runtime \
     --agent-runtime-id <id> --region $AWS_REGION --query 'networkConfiguration'
   ```
2. Confirm the security group allows self-referencing inbound on the broker port (9092 for PLAINTEXT).
3. Confirm the cluster actually has `Unauthenticated.Enabled=true` and `ClientBroker: PLAINTEXT`. If the cluster also has TLS or IAM enabled in addition, the `BootstrapBrokerString` you pass must match the auth mode you select.

### Auth handshake errors despite `MSK_AUTH_MODE=none`

The cluster is rejecting the PLAINTEXT connection. Either the cluster does not actually have `Unauthenticated` enabled, or you passed a TLS/IAM bootstrap string. Re-run `aws kafka get-bootstrap-brokers` and use the value of `BootstrapBrokerString` (not `BootstrapBrokerStringTls` or `BootstrapBrokerStringSaslIam`).

### `kafka_get_cluster_info` shows `awsError: Request aborted`

The `DescribeClusterV2` AWS API is a public endpoint unreachable from VPC without internet. This affects only the metadata tool; broker traffic is unaffected.

---

## Cleanup

```bash
RUNTIME_ID=$(jq -r '.runtimeId' .agentcore-deployment.json)

aws bedrock-agentcore-control delete-agent-runtime \
  --agent-runtime-id $RUNTIME_ID --region $AWS_REGION

for vpce in $(aws ec2 describe-vpc-endpoints --filters "Name=vpc-id,Values=$VPC_ID" \
  --query 'VpcEndpoints[*].VpcEndpointId' --output text --region $AWS_REGION); do
  aws ec2 delete-vpc-endpoints --vpc-endpoint-ids $vpce --region $AWS_REGION
done

aws iam delete-role-policy --role-name ${RUNTIME_NAME}-agentcore-role --policy-name ${RUNTIME_NAME}-agentcore-role-policy 2>/dev/null || true
aws iam delete-role --role-name ${RUNTIME_NAME}-agentcore-role
aws ecr delete-repository --repository-name $ECR_REPO --force --region $AWS_REGION
aws kafka delete-cluster --cluster-arn $MSK_ARN --region $AWS_REGION
```

---

## See Also

- [`agentcore-msk-setup.md`](agentcore-msk-setup.md) -- The IAM-authenticated counterpart to this guide.
- [`agentcore-deployment.md`](agentcore-deployment.md) -- General AgentCore deployment overview, container contract, and `deploy.sh` reference.
- [`kafka-agentcore-sigv4.md`](kafka-agentcore-sigv4.md) -- How the local SigV4 proxy works.
- [`../configuration/environment-variables.md`](../configuration/environment-variables.md) -- All env vars including `MSK_AUTH_MODE`.
