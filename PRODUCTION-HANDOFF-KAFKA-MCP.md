# Kafka MCP Server -- AWS Production Deployment Guide

> **Version:** 1.0 | **Date:** 2026-04-08 | **Author:** Simon Owusu
> **Audience:** AWS Implementation / Platform Engineering team
> **Estimated time:** 45-60 minutes (excluding VPC endpoint propagation)

Deploy a pre-built Kafka MCP Server container to AWS Bedrock AgentCore Runtime, connecting it to an existing production MSK cluster using IAM SASL authentication. No source code access required.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Prerequisites](#2-prerequisites)
3. [Step 0: Set Shell Variables](#3-step-0-set-shell-variables)
4. [Step 1: Container Image](#4-step-1-container-image)
5. [Step 2: VPC Endpoints](#5-step-2-vpc-endpoints)
6. [Step 3: IAM Role and Policy](#6-step-3-iam-role-and-policy)
7. [Step 4: Create AgentCore Runtime](#7-step-4-create-agentcore-runtime)
8. [Step 5: Verify End-to-End](#8-step-5-verify-end-to-end)
9. [Step 6: Hand Back to Application Owner](#9-step-6-hand-back-to-application-owner)
10. [Updating the Deployed Server](#10-updating-the-deployed-server)
11. [Troubleshooting](#11-troubleshooting)
12. [Security Considerations](#12-security-considerations)
13. [Appendix A: Quick Reference Card](#13-appendix-a-quick-reference-card)
14. [Appendix B: Environment Variables Reference](#14-appendix-b-environment-variables-reference)

---

## 1. Architecture Overview

```
Developer Machine                           AWS Account (Private VPC)
+-----------------------------------+       +-------------------------------------------+
|                                   |       |                                           |
|  DevOps Incident Analyzer         |       |  AgentCore Runtime (microVM, VPC mode)    |
|  (LangGraph Agent)                |       |    kafka_mcp_server container              |
|    |                              |       |    GET /ping, GET /health, POST /mcp       |
|    v                              |       |    |                                       |
|  SigV4 Signing Proxy              | SigV4 |    | OAUTHBEARER SASL (IAM token via STS)  |
|    localhost:3000            -----|------>|    v                                       |
|                                   |       |  MSK Provisioned Cluster                  |
+-----------------------------------+       |    port 9098 (TLS + IAM)                  |
                                            |                                           |
                                            |  VPC Endpoints:                           |
                                            |    sts, ecr.dkr, ecr.api, s3, logs        |
                                            +-------------------------------------------+
```

### Data Flow

1. The agent application sends plain HTTP JSON-RPC requests to `localhost:3000/mcp`
2. A local SigV4 signing proxy signs each request for the `bedrock-agentcore` service
3. The signed request is forwarded to the AgentCore Runtime invoke endpoint over HTTPS
4. AgentCore runs the Kafka MCP Server container inside a microVM with VPC network access
5. The container authenticates to MSK using OAUTHBEARER SASL (IAM tokens generated via STS)
6. The container queries Kafka topics, consumer groups, and messages, returning results via JSON-RPC

### Key Design Decisions

| Decision | Reason |
|----------|--------|
| **VPC mode** | MSK clusters run in private VPCs. The AgentCore microVM needs ENIs in the same VPC to reach brokers. |
| **Provisioned MSK** (not Serverless) | Serverless MSK has 60-120s cold-start latency on first metadata calls, causing tool timeouts in AgentCore. |
| **SigV4 proxy** | AgentCore requires SigV4-signed requests. The agent application speaks plain HTTP. The proxy bridges the two. |
| **Stateless model** | Each MCP request creates a fresh server instance. No session state between requests. AgentCore may route to different microVM instances. |

---

## 2. Prerequisites

### 2.1 Provided by Application Owner (Simon)

The application owner provides one of:

| Item | Format | Notes |
|------|--------|-------|
| **Container image** pushed to your ECR | ECR URI | Simon pushes directly if he has cross-account ECR write access |
| **Container image tarball** | `.tar.gz` file | If no cross-account access. See [Step 1b](#step-1b-load-from-tarball) for import. |
| **MSK cluster ARN** | ARN string | Your existing production MSK cluster |

### 2.2 AWS Account Requirements

- AWS CLI v2.28+ with admin credentials for the target account
- Docker (only if loading from tarball)
- Python 3 with boto3 (`pip3 install --user boto3`)
- `jq` installed

### 2.3 MSK Cluster Requirements

Your existing MSK cluster must have:

| Requirement | Expected Value | Why |
|-------------|---------------|-----|
| Cluster type | **Provisioned** | Serverless has cold-start timeouts (see [Troubleshooting](#116-msk-serverless-cold-starts)) |
| Client authentication | **IAM SASL enabled** | Container uses OAUTHBEARER mechanism |
| Encryption in transit | **TLS** | Port 9098 (TLS + IAM) |
| Cluster state | **ACTIVE** | Cannot connect to clusters in other states |

Verify your cluster meets these requirements:

```bash
aws kafka describe-cluster-v2 --cluster-arn <YOUR_MSK_CLUSTER_ARN> \
  --query 'ClusterInfo.{
    State: State,
    ClusterType: ClusterType,
    IamAuth: Provisioned.ClientAuthentication.Sasl.Iam.Enabled,
    TLS: Provisioned.EncryptionInfo.EncryptionInTransit.ClientBroker
  }' \
  --output table --region <YOUR_REGION>
```

Expected output: State=ACTIVE, ClusterType=PROVISIONED, IamAuth=True, TLS=TLS.

---

## 3. Step 0: Set Shell Variables

All subsequent steps reference these variables. Set them once per session.

```bash
# -- Your environment --
export AWS_REGION=eu-central-1                      # Your AWS region
export MSK_CLUSTER_ARN="arn:aws:kafka:..."          # Your existing MSK cluster ARN
export ECR_REPO=kafka-mcp-agentcore                 # ECR repository name
export ROLE_NAME=kafka-mcp-agentcore-role            # IAM role name

# -- Derived values --
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

export MSK_BOOTSTRAP=$(aws kafka get-bootstrap-brokers --cluster-arn $MSK_CLUSTER_ARN \
  --query 'BootstrapBrokerStringSaslIam' --output text --region $AWS_REGION)

export MSK_SUBNETS=$(aws kafka describe-cluster --cluster-arn $MSK_CLUSTER_ARN \
  --query 'ClusterInfo.BrokerNodeGroupInfo.ClientSubnets' --output text --region $AWS_REGION \
  | tr '\t' ' ')

export MSK_SG=$(aws kafka describe-cluster --cluster-arn $MSK_CLUSTER_ARN \
  --query 'ClusterInfo.BrokerNodeGroupInfo.SecurityGroups[0]' --output text --region $AWS_REGION)

export VPC_ID=$(aws ec2 describe-subnets \
  --subnet-ids $(echo $MSK_SUBNETS | awk '{print $1}') \
  --query 'Subnets[0].VpcId' --output text --region $AWS_REGION)

export ECR_URI="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO}"

# -- Verify --
echo "Account:    $ACCOUNT_ID"
echo "Region:     $AWS_REGION"
echo "MSK ARN:    $MSK_CLUSTER_ARN"
echo "Bootstrap:  $MSK_BOOTSTRAP"
echo "VPC:        $VPC_ID"
echo "Subnets:    $MSK_SUBNETS"
echo "SG:         $MSK_SG"
echo "ECR URI:    $ECR_URI"
```

**Checkpoint:** All variables must be non-empty. If `MSK_BOOTSTRAP` is empty, IAM SASL authentication is not enabled on your cluster -- enable it before proceeding.

---

## 4. Step 1: Container Image

Choose the scenario that applies:

### Step 1a: Simon Pushed to Your ECR

If the application owner pushed the image directly to your ECR, verify it exists:

```bash
aws ecr describe-images \
  --repository-name $ECR_REPO \
  --region $AWS_REGION \
  --query 'imageDetails[0].{Tags: imageTags, Pushed: imagePushedAt, Size: imageSizeInBytes}' \
  --output table
```

Skip to [Step 2](#5-step-2-vpc-endpoints).

### Step 1b: Load from Tarball

If you received a `.tar.gz` file:

```bash
# Create ECR repository (idempotent)
aws ecr create-repository \
  --repository-name $ECR_REPO \
  --region $AWS_REGION \
  --image-scanning-configuration scanOnPush=true \
  --encryption-configuration encryptionType=AES256 2>/dev/null \
  || echo "Repository already exists"

# Load the tarball
docker load -i kafka-mcp-agentcore.tar.gz

# Tag with your ECR URI (always tag directly to ECR URI to avoid attestation issues)
docker tag kafka-mcp-agentcore:latest "${ECR_URI}:latest"

# Authenticate to ECR
aws ecr get-login-password --region $AWS_REGION | \
  docker login --username AWS --password-stdin \
  ${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com

# Push
docker push "${ECR_URI}:latest"
```

### Verify Architecture

The container must be arm64 (AgentCore runs on Graviton):

```bash
# If you have the image locally:
docker inspect "${ECR_URI}:latest" --format '{{.Architecture}}'
# Expected: arm64

# Or check via ECR:
aws ecr describe-images \
  --repository-name $ECR_REPO \
  --region $AWS_REGION \
  --image-ids imageTag=latest \
  --query 'imageDetails[0].imageManifestMediaType' \
  --output text
```

If architecture is not arm64, contact the application owner to rebuild.

---

## 5. Step 2: VPC Endpoints

AgentCore microVMs in VPC mode have **no internet access**. The container needs VPC endpoints to reach AWS services.

| Service | Type | Purpose |
|---------|------|---------|
| `sts` | Interface | Generate IAM SASL tokens for MSK authentication |
| `ecr.dkr` | Interface | Pull container image layers |
| `ecr.api` | Interface | ECR authentication and manifest API |
| `s3` | Gateway | ECR image layer storage (S3-backed) |
| `logs` | Interface | CloudWatch log delivery |

### Check Existing Endpoints

Some or all may already exist in your VPC:

```bash
aws ec2 describe-vpc-endpoints \
  --filters "Name=vpc-id,Values=$VPC_ID" \
  --query 'VpcEndpoints[*].{Service: ServiceName, State: State, Type: VpcEndpointType}' \
  --output table --region $AWS_REGION
```

### Create Missing Endpoints

Only create endpoints that do not already exist:

```bash
# Interface endpoints (sts, ecr.dkr, ecr.api, logs)
for SVC in sts ecr.dkr ecr.api logs; do
  EXISTING=$(aws ec2 describe-vpc-endpoints \
    --filters "Name=vpc-id,Values=$VPC_ID" \
              "Name=service-name,Values=com.amazonaws.${AWS_REGION}.${SVC}" \
    --query 'VpcEndpoints[0].VpcEndpointId' --output text --region $AWS_REGION)

  if [ "$EXISTING" = "None" ] || [ -z "$EXISTING" ]; then
    echo "Creating $SVC endpoint..."
    aws ec2 create-vpc-endpoint \
      --vpc-id $VPC_ID \
      --service-name com.amazonaws.${AWS_REGION}.${SVC} \
      --vpc-endpoint-type Interface \
      --subnet-ids $MSK_SUBNETS \
      --security-group-ids $MSK_SG \
      --private-dns-enabled \
      --region $AWS_REGION \
      --query 'VpcEndpoint.{Id: VpcEndpointId, State: State}' \
      --output table
  else
    echo "$SVC endpoint already exists: $EXISTING"
  fi
done

# S3 Gateway endpoint (instant, no subnets needed)
EXISTING_S3=$(aws ec2 describe-vpc-endpoints \
  --filters "Name=vpc-id,Values=$VPC_ID" \
            "Name=service-name,Values=com.amazonaws.${AWS_REGION}.s3" \
  --query 'VpcEndpoints[0].VpcEndpointId' --output text --region $AWS_REGION)

if [ "$EXISTING_S3" = "None" ] || [ -z "$EXISTING_S3" ]; then
  echo "Creating S3 Gateway endpoint..."
  aws ec2 create-vpc-endpoint \
    --vpc-id $VPC_ID \
    --service-name com.amazonaws.${AWS_REGION}.s3 \
    --vpc-endpoint-type Gateway \
    --region $AWS_REGION \
    --query 'VpcEndpoint.{Id: VpcEndpointId, State: State}' \
    --output table
else
  echo "S3 Gateway endpoint already exists: $EXISTING_S3"
fi
```

Wait for all Interface endpoints to become `available` (1-2 minutes):

```bash
aws ec2 describe-vpc-endpoints \
  --filters "Name=vpc-id,Values=$VPC_ID" \
  --query 'VpcEndpoints[*].{Service: ServiceName, State: State, Type: VpcEndpointType}' \
  --output table --region $AWS_REGION
```

**Security group note:** The security group used by VPC endpoints must allow inbound traffic from itself (self-referencing rule). The default VPC SG does this automatically. If you are using a custom SG, verify this rule exists:

```bash
aws ec2 describe-security-groups --group-ids $MSK_SG \
  --query 'SecurityGroups[0].IpPermissions[?UserIdGroupPairs[?GroupId==`'$MSK_SG'`]]' \
  --output table --region $AWS_REGION
```

---

## 6. Step 3: IAM Role and Policy

### 6.1 Create the IAM Role

The trust policy allows the AgentCore service to assume this role. The `SourceAccount` condition prevents cross-account confused deputy attacks.

```bash
aws iam create-role \
  --role-name $ROLE_NAME \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": { "Service": "bedrock-agentcore.amazonaws.com" },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": {
          "aws:SourceAccount": "'$ACCOUNT_ID'"
        }
      }
    }]
  }' \
  --description "AgentCore Runtime role for Kafka MCP server" \
  2>/dev/null || echo "Role already exists"
```

### 6.2 Attach Permissions Policy

This policy is scoped to your specific MSK cluster, ECR repository, and CloudWatch log group.

```bash
aws iam put-role-policy \
  --role-name $ROLE_NAME \
  --policy-name kafka-mcp-access \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Sid": "MSKClusterAccess",
        "Effect": "Allow",
        "Action": [
          "kafka-cluster:Connect",
          "kafka-cluster:DescribeCluster",
          "kafka-cluster:DescribeTopic",
          "kafka-cluster:DescribeGroup",
          "kafka-cluster:ReadData",
          "kafka-cluster:DescribeTopicDynamicConfiguration"
        ],
        "Resource": [
          "'$MSK_CLUSTER_ARN'",
          "arn:aws:kafka:'$AWS_REGION':'$ACCOUNT_ID':topic/'$(echo $MSK_CLUSTER_ARN | awk -F: '{print $NF}' | cut -d/ -f2-)'/*",
          "arn:aws:kafka:'$AWS_REGION':'$ACCOUNT_ID':group/'$(echo $MSK_CLUSTER_ARN | awk -F: '{print $NF}' | cut -d/ -f2-)'/*"
        ]
      },
      {
        "Sid": "MSKBrokerDiscovery",
        "Effect": "Allow",
        "Action": [
          "kafka:GetBootstrapBrokers",
          "kafka:DescribeClusterV2"
        ],
        "Resource": "'$MSK_CLUSTER_ARN'"
      },
      {
        "Sid": "ECRPull",
        "Effect": "Allow",
        "Action": [
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage"
        ],
        "Resource": "arn:aws:ecr:'$AWS_REGION':'$ACCOUNT_ID':repository/'$ECR_REPO'"
      },
      {
        "Sid": "ECRAuth",
        "Effect": "Allow",
        "Action": "ecr:GetAuthorizationToken",
        "Resource": "*"
      },
      {
        "Sid": "CloudWatchLogs",
        "Effect": "Allow",
        "Action": [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ],
        "Resource": "arn:aws:logs:'$AWS_REGION':'$ACCOUNT_ID':log-group:/aws/bedrock-agentcore/runtimes/*"
      }
    ]
  }'
```

**Optional -- If write operations are needed**, add these actions to the `MSKClusterAccess` statement:

```json
"kafka-cluster:WriteData",
"kafka-cluster:CreateTopic"
```

### 6.3 Verify

```bash
aws iam get-role --role-name $ROLE_NAME \
  --query 'Role.{Arn: Arn, CreateDate: CreateDate}' --output table
```

Wait 10 seconds for IAM propagation before proceeding:

```bash
echo "Waiting for IAM role propagation..."
sleep 10
```

---

## 7. Step 4: Create AgentCore Runtime

The AWS CLI does not support VPC subnet/security-group parameters for `create-agent-runtime`. Use the boto3 script below.

### 7.1 Create the Runtime

```bash
python3 << 'PYEOF'
import boto3, os

region = os.environ['AWS_REGION']
client = boto3.client('bedrock-agentcore-control', region_name=region)

response = client.create_agent_runtime(
    agentRuntimeName='kafka_mcp_server',
    agentRuntimeArtifact={
        'containerConfiguration': {
            'containerUri': f"{os.environ['ECR_URI']}:latest"
        }
    },
    roleArn=f"arn:aws:iam::{os.environ['ACCOUNT_ID']}:role/{os.environ['ROLE_NAME']}",
    networkConfiguration={
        'networkMode': 'VPC',
        'networkModeConfig': {
            'subnets': os.environ['MSK_SUBNETS'].split(),
            'securityGroups': [os.environ['MSK_SG']]
        }
    },
    protocolConfiguration={'serverProtocol': 'MCP'},
    environmentVariables={
        'KAFKA_PROVIDER': 'msk',
        'MSK_CLUSTER_ARN': os.environ['MSK_CLUSTER_ARN'],
        'MSK_BOOTSTRAP_BROKERS': os.environ['MSK_BOOTSTRAP'],
        'AWS_REGION': region
    }
)
print(f"Runtime ID:  {response['agentRuntimeId']}")
print(f"Runtime ARN: {response['agentRuntimeArn']}")
print(f"Status:      {response['status']}")
PYEOF
```

**Runtime name constraint:** Must match `[a-zA-Z][a-zA-Z0-9_]{0,47}` -- no hyphens allowed. The name `kafka_mcp_server` is used above.

Save the Runtime ID from the output:

```bash
export RUNTIME_ID=kafka_mcp_server-XXXXXXXXXX   # Replace with actual ID from output
```

### 7.2 Wait for ACTIVE

```bash
echo "Waiting for runtime to become ACTIVE..."
for i in $(seq 1 30); do
  STATUS=$(aws bedrock-agentcore-control get-agent-runtime \
    --agent-runtime-id $RUNTIME_ID --region $AWS_REGION \
    --query 'status' --output text 2>/dev/null || echo "CREATING")
  if [ "$STATUS" = "ACTIVE" ]; then
    echo "Runtime is ACTIVE"
    break
  fi
  echo "  Status: $STATUS (attempt $i/30)"
  sleep 10
done
```

### 7.3 Save Runtime ARN

```bash
export RUNTIME_ARN=$(aws bedrock-agentcore-control get-agent-runtime \
  --agent-runtime-id $RUNTIME_ID --region $AWS_REGION \
  --query 'agentRuntimeArn' --output text)

echo "Runtime ARN: $RUNTIME_ARN"
```

---

## 8. Step 5: Verify End-to-End

### Test 1: MCP Initialize

Confirms the container boots and the MCP protocol is functional.

```bash
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
```

**Expected:** Response contains `"serverInfo":{"name":"@devops-agent/mcp-server-kafka","version":"0.1.0"}`

### Test 2: List Kafka Topics

Confirms the container can authenticate to MSK and query Kafka.

```bash
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
```

**Expected:** Response includes a list of Kafka topics from your MSK cluster. Internal topics like `__amazon_msk_canary` and `__consumer_offsets` confirm MSK connectivity.

### Test 3: Get Cluster Info

```bash
echo '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"kafka_get_cluster_info","arguments":{}}}' > /tmp/mcp-cluster.json

aws bedrock-agentcore invoke-agent-runtime \
  --agent-runtime-arn "$RUNTIME_ARN" \
  --qualifier DEFAULT \
  --content-type application/json \
  --accept "application/json, text/event-stream" \
  --payload fileb:///tmp/mcp-cluster.json \
  --region $AWS_REGION \
  /tmp/mcp-cluster-response.bin

cat /tmp/mcp-cluster-response.bin
```

**Note:** The response may include `"awsError": "Request aborted"` for the cluster metadata portion. This is **expected behavior** in VPC mode -- the `DescribeClusterV2` AWS API (`kafka.<region>.amazonaws.com`) is a public endpoint unreachable without internet. All Kafka-protocol data (topics, brokers, consumer groups) is returned normally.

---

## 9. Step 6: Hand Back to Application Owner

Provide these values to the application owner (Simon):

| Item | Variable | Value |
|------|----------|-------|
| Runtime ARN | `RUNTIME_ARN` | *(from Step 4)* |
| Runtime ID | `RUNTIME_ID` | *(from Step 4)* |
| IAM Role ARN | `ROLE_ARN` | `arn:aws:iam::$ACCOUNT_ID:role/$ROLE_NAME` |
| AWS Region | `AWS_REGION` | *(your region)* |

The application owner configures their environment with:

```env
AGENTCORE_RUNTIME_ARN=<RUNTIME_ARN from above>
AGENTCORE_REGION=<AWS_REGION from above>
KAFKA_MCP_URL=http://localhost:3000
```

The SigV4 signing proxy starts automatically when `AGENTCORE_RUNTIME_ARN` is set in the application's environment. No additional action needed from the implementation team.

---

## 10. Updating the Deployed Server

When the application owner provides a new container image:

```bash
# Push new image to ECR (or load from tarball as in Step 1b)
docker push "${ECR_URI}:latest"

# Delete the existing runtime and recreate
# (update-in-place can cause stuck runtimes)
aws bedrock-agentcore-control delete-agent-runtime \
  --agent-runtime-id $RUNTIME_ID --region $AWS_REGION

echo "Waiting for deletion..."
sleep 30

# Re-run Step 4 (Create AgentCore Runtime)
```

**Warning:** Updating a runtime in-place (without delete/recreate) can cause it to become stuck in an intermediate state. The delete-then-recreate approach is more reliable.

---

## 11. Troubleshooting

### 11.1 502 from Runtime Invocation

1. **Check architecture:** Image must be arm64. Verify: `docker inspect <image> --format '{{.Architecture}}'`
2. **Check CloudWatch logs:** `/aws/bedrock-agentcore/runtimes/<runtime-id>-DEFAULT/`
3. **Test locally:** `docker run --rm -p 8888:8000 -e KAFKA_PROVIDER=local <image>` then `curl localhost:8888/ping`
4. **Stuck runtime:** Delete and recreate. Runtimes can get stuck after repeated config changes.

### 11.2 Health Check Timeout (Runtime Stays in CREATING)

The container must respond to `GET /ping` within the health check window. If it times out:

1. Verify all VPC endpoints are in `available` state (re-run the check in Step 2)
2. The STS VPC endpoint is critical -- without it, the container cannot generate IAM SASL tokens during startup
3. Verify the security group allows inbound traffic from itself (self-referencing rule)

### 11.3 SigV4 Signature Mismatch (Proxy Side)

This error occurs on the application owner's machine, not during deployment. If reported:

1. Verify credentials match the account where AgentCore is deployed: `aws sts get-caller-identity`
2. If the LLM account and AgentCore account are different, the application owner should set `AGENTCORE_AWS_ACCESS_KEY_ID` and `AGENTCORE_AWS_SECRET_ACCESS_KEY` separately
3. The SigV4 service name must be `bedrock-agentcore` (handled by the application code)

### 11.4 "metadata failed N times" / Kafka Connection Errors

The container cannot reach MSK brokers:

1. Runtime must be in **VPC mode** with the same subnets and security group as MSK
2. STS VPC endpoint must exist (for IAM SASL token generation)
3. Security group must allow self-referencing inbound traffic on port 9098
4. Verify MSK has IAM SASL authentication enabled

### 11.5 "Request aborted" on kafka_get_cluster_info

**This is expected behavior.** The `DescribeClusterV2` AWS API (`kafka.<region>.amazonaws.com`) is a public endpoint unreachable from VPC mode. The container aborts this call after 10 seconds and returns Kafka-protocol data normally. All other tools are unaffected.

### 11.6 MSK Serverless Cold Starts

MSK Serverless clusters have 60-120 second cold-start latency on the first metadata call. This exceeds AgentCore's tool timeout, causing failures. **Use provisioned MSK clusters only.**

### 11.7 Docker Desktop Attestation Manifest Issues

When loading a tarball and retagging for ECR, Docker Desktop can bake the original tag into the manifest list, causing the push to target the wrong repository. If `docker push` fails or pushes to an unexpected repository after loading a tarball:

```bash
# Clean up and retag
docker rmi ${ECR_URI}:latest 2>/dev/null
docker load -i kafka-mcp-agentcore.tar.gz
docker tag kafka-mcp-agentcore:latest ${ECR_URI}:latest
docker push ${ECR_URI}:latest
```

If this still fails, ask the application owner to rebuild and push the image directly to your ECR (bypassing the tarball workflow).

---

## 12. Security Considerations

| Practice | Implementation |
|----------|---------------|
| **Non-root execution** | Container runs as UID 65532 (appuser), no login shell |
| **PID 1 signal handling** | `dumb-init` wraps the Bun process for graceful SIGTERM/SIGINT shutdown |
| **Minimal image** | Alpine base, production-only dependencies, frozen lockfile |
| **IAM SASL authentication** | No static Kafka credentials. Tokens generated via STS with automatic refresh |
| **Scoped IAM role** | Trust policy with `SourceAccount` condition. Permissions scoped to specific cluster ARN |
| **Network isolation** | VPC mode -- no internet access from container. All AWS service calls go through VPC endpoints |
| **No secrets in env vars** | Only cluster ARN and region are passed. Authentication is via IAM role, not credentials |
| **TLS everywhere** | MSK port 9098 is TLS-only. SigV4 proxy communicates with AgentCore over HTTPS |
| **Container scanning** | ECR repository configured with `scanOnPush=true` for vulnerability detection |

---

## 13. Appendix A: Quick Reference Card

| Component | Value |
|-----------|-------|
| Container image | `<ACCOUNT>.dkr.ecr.<REGION>.amazonaws.com/kafka-mcp-agentcore:latest` |
| Container port | `8000` |
| Container endpoints | `GET /ping` (liveness), `GET /health` (readiness), `POST /mcp` (MCP protocol) |
| AgentCore Runtime name | `kafka_mcp_server` |
| IAM Role | `kafka-mcp-agentcore-role` |
| VPC Endpoints required | `sts`, `ecr.dkr`, `ecr.api`, `s3` (gateway), `logs` |
| MSK auth mechanism | OAUTHBEARER SASL via IAM |
| MSK port | `9098` (TLS + IAM) |
| CloudWatch log group | `/aws/bedrock-agentcore/runtimes/<runtime-id>-DEFAULT/` |
| Runtime name constraint | `[a-zA-Z][a-zA-Z0-9_]{0,47}` (no hyphens) |

---

## 14. Appendix B: Environment Variables Reference

### Container Variables (set by AgentCore at runtime creation)

| Variable | Required | Description |
|----------|----------|-------------|
| `KAFKA_PROVIDER` | Yes | Must be `msk` |
| `MSK_CLUSTER_ARN` | Yes | Full ARN of the MSK cluster |
| `MSK_BOOTSTRAP_BROKERS` | Recommended | Comma-separated broker endpoints (port 9098). Auto-discovered from ARN if omitted, but providing it avoids an API call on startup. |
| `AWS_REGION` | Yes | AWS region of the MSK cluster |
| `MCP_TRANSPORT` | No | Hardcoded to `agentcore` in the Docker image. Do not change. |
| `MCP_PORT` | No | Hardcoded to `8000` in the Docker image. Do not change. |
| `MCP_HOST` | No | Hardcoded to `0.0.0.0` in the Docker image. Do not change. |
| `KAFKA_ALLOW_WRITES` | No | Default `false`. Set to `true` to enable produce/create-topic operations. Requires additional IAM permissions. |
| `KAFKA_ALLOW_DESTRUCTIVE` | No | Default `false`. Set to `true` to enable delete-topic operations. Requires additional IAM permissions. |

### Proxy Variables (set by application owner on their machine)

| Variable | Required | Description |
|----------|----------|-------------|
| `AGENTCORE_RUNTIME_ARN` | Yes | Full ARN of the AgentCore Runtime (triggers proxy mode) |
| `AGENTCORE_REGION` | No | Defaults to `AWS_REGION`. Override if AgentCore is in a different region. |
| `AGENTCORE_PROXY_PORT` | No | Local proxy listen port. Default: `3000` |
| `AGENTCORE_AWS_ACCESS_KEY_ID` | No | Separate credentials for the AgentCore account. Falls back to `AWS_ACCESS_KEY_ID`. |
| `AGENTCORE_AWS_SECRET_ACCESS_KEY` | No | Separate credentials for the AgentCore account. Falls back to `AWS_SECRET_ACCESS_KEY`. |
| `AGENTCORE_AWS_SESSION_TOKEN` | No | Session token for temporary credentials (STS assume-role, SSO). Falls back to `AWS_SESSION_TOKEN`. |
| `KAFKA_MCP_URL` | Yes | Must be `http://localhost:<AGENTCORE_PROXY_PORT>`. The agent uses this to route requests through the proxy. |

---

## Cleanup

If you need to tear down the deployment:

```bash
# Delete AgentCore Runtime
aws bedrock-agentcore-control delete-agent-runtime \
  --agent-runtime-id $RUNTIME_ID --region $AWS_REGION

# Delete IAM policy and role
aws iam delete-role-policy --role-name $ROLE_NAME --policy-name kafka-mcp-access
aws iam delete-role --role-name $ROLE_NAME

# Delete ECR repository (removes all images)
aws ecr delete-repository --repository-name $ECR_REPO --force --region $AWS_REGION

# VPC endpoints -- only delete if you created them for this deployment
# List them first to verify:
aws ec2 describe-vpc-endpoints \
  --filters "Name=vpc-id,Values=$VPC_ID" \
  --query 'VpcEndpoints[*].{Id: VpcEndpointId, Service: ServiceName}' \
  --output table --region $AWS_REGION
```
