# AgentCore + MSK Deployment Guide

Deploying the Kafka MCP server to AWS Bedrock AgentCore Runtime with a provisioned MSK cluster in a private VPC. Covers MSK cluster creation, VPC endpoint setup, container build, IAM, AgentCore runtime, and the local SigV4 proxy.

This guide is account- and region-agnostic. All commands use shell variables set in the first step.

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
|    |                          |              |    | IAM SASL auth (OAUTHBEARER via STS)  |
|    v                          |  SigV4       |    v                                      |
|  agentcore-proxy     ---------|------------->|  MSK Provisioned Cluster                 |
|    localhost:3000             |              |    port 9098 (TLS + IAM)                 |
|                               |              |                                          |
+-------------------------------+              +------------------------------------------+
                                                       |
                                                VPC Endpoints:
                                                  sts, ecr.dkr, ecr.api, s3, logs
```

The agent connects to `http://localhost:3000/mcp` (the proxy). The proxy signs each request with SigV4 and forwards it to the AgentCore invoke endpoint. AgentCore runs the container in VPC mode with direct access to MSK brokers.

---

## Prerequisites

- AWS CLI v2.28+ with admin credentials for the target account
- Docker Desktop (Apple Silicon builds arm64 natively)
- Python 3 with boto3 (`pip3 install --user boto3`)
- Bun 1.3+
- Repository cloned with dependencies installed (`bun install`)

---

## Step 0: Set Variables

All subsequent steps reference these variables. Set them once:

```bash
export AWS_REGION=eu-central-1       # your region
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export ECR_REPO=kafka-mcp-agentcore
export ROLE_NAME=kafka-mcp-agentcore-role
export CLUSTER_NAME=my-msk-cluster   # choose a name
```

---

## Step 1: Create MSK Provisioned Cluster

Skip if you already have an MSK cluster. Use provisioned (not Serverless) -- Serverless has extreme cold-start latency (60-120s) that causes tool timeouts in AgentCore.

```bash
# Get VPC and networking info
export VPC_ID=$(aws ec2 describe-vpcs --filters "Name=isDefault,Values=true" \
  --query 'Vpcs[0].VpcId' --output text --region $AWS_REGION)

# Pick 2+ subnets in different AZs
export SUBNETS=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" \
  --query 'Subnets[?AvailabilityZone!=`null`] | [:3].SubnetId' --output text --region $AWS_REGION)
export SUBNET_1=$(echo $SUBNETS | awk '{print $1}')
export SUBNET_2=$(echo $SUBNETS | awk '{print $2}')

export SG_ID=$(aws ec2 describe-security-groups \
  --filters "Name=vpc-id,Values=$VPC_ID" "Name=group-name,Values=default" \
  --query 'SecurityGroups[0].GroupId' --output text --region $AWS_REGION)

# Create provisioned cluster (2 brokers, m5.large, KRaft, IAM auth)
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
  --client-authentication '{"Sasl": {"Iam": {"Enabled": true}}}' \
  --encryption-info '{"EncryptionInTransit": {"ClientBroker": "TLS", "InCluster": true}}' \
  --region $AWS_REGION
```

Wait for ACTIVE (15-25 minutes):

```bash
export MSK_ARN=$(aws kafka list-clusters-v2 --cluster-name-filter $CLUSTER_NAME \
  --query 'ClusterInfoList[0].ClusterArn' --output text --region $AWS_REGION)

# Poll until ACTIVE
watch -n 30 "aws kafka describe-cluster-v2 --cluster-arn $MSK_ARN \
  --query 'ClusterInfo.State' --output text --region $AWS_REGION"
```

Get networking details:

```bash
export MSK_BOOTSTRAP=$(aws kafka get-bootstrap-brokers --cluster-arn $MSK_ARN \
  --query 'BootstrapBrokerStringSaslIam' --output text --region $AWS_REGION)

# For provisioned clusters, subnets are in BrokerNodeGroupInfo
export MSK_SUBNETS=$(aws kafka describe-cluster --cluster-arn $MSK_ARN \
  --query 'ClusterInfo.BrokerNodeGroupInfo.ClientSubnets' --output text --region $AWS_REGION | tr '\t' ' ')

export MSK_SG=$(aws kafka describe-cluster --cluster-arn $MSK_ARN \
  --query 'ClusterInfo.BrokerNodeGroupInfo.SecurityGroups[0]' --output text --region $AWS_REGION)

echo "Bootstrap: $MSK_BOOTSTRAP"
echo "Subnets: $MSK_SUBNETS"
echo "Security Group: $MSK_SG"
```

---

## Step 2: Create VPC Endpoints

AgentCore in VPC mode has no internet access. The container needs VPC endpoints to reach AWS services.

| Service | Type | Purpose |
|---------|------|---------|
| `sts` | Interface | IAM SASL token generation for MSK auth |
| `ecr.dkr` | Interface | Pull container image layers |
| `ecr.api` | Interface | ECR authentication and manifest API |
| `s3` | Gateway | ECR image layer storage (S3-backed) |
| `logs` | Interface | CloudWatch log delivery |

```bash
for SVC in sts ecr.dkr ecr.api logs; do
  echo "Creating $SVC endpoint..."
  aws ec2 create-vpc-endpoint \
    --vpc-id $VPC_ID \
    --service-name com.amazonaws.$AWS_REGION.$SVC \
    --vpc-endpoint-type Interface \
    --subnet-ids $MSK_SUBNETS \
    --security-group-ids $MSK_SG \
    --private-dns-enabled \
    --region $AWS_REGION \
    --query 'VpcEndpoint.{Id: VpcEndpointId, State: State}' \
    --output table
done

# S3 Gateway (instant, no subnets needed)
aws ec2 create-vpc-endpoint \
  --vpc-id $VPC_ID \
  --service-name com.amazonaws.$AWS_REGION.s3 \
  --vpc-endpoint-type Gateway \
  --region $AWS_REGION \
  --query 'VpcEndpoint.{Id: VpcEndpointId, State: State}' \
  --output table
```

Wait for all Interface endpoints to become `available` (1-2 minutes):

```bash
aws ec2 describe-vpc-endpoints \
  --filters "Name=vpc-id,Values=$VPC_ID" \
  --query 'VpcEndpoints[*].{Service: ServiceName, State: State, Type: VpcEndpointType}' \
  --output table --region $AWS_REGION
```

**Security group note:** The SG must allow inbound traffic from itself (self-referencing rule). This is the default for `default` SGs. AgentCore container ENIs and VPC endpoint ENIs share this SG.

---

## Step 3: Create ECR Repository

```bash
aws ecr create-repository \
  --repository-name $ECR_REPO \
  --region $AWS_REGION 2>/dev/null || echo "Repository already exists"
```

---

## Step 4: Build and Push Container

AgentCore runs on arm64 (Graviton). Build accordingly.

```bash
# Authenticate Docker to ECR
aws ecr get-login-password --region $AWS_REGION | \
  docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com

# Build with full ECR URI as tag (avoids Docker Desktop attestation issues)
docker build -f Dockerfile.agentcore \
  --build-arg MCP_SERVER_PACKAGE=mcp-server-kafka \
  -t $ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO:latest .

# Verify architecture is arm64
docker inspect $ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO:latest \
  --format '{{.Architecture}}'

# Push
docker push $ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO:latest
```

If building on x86_64, add `--platform linux/arm64` to the build command.

---

## Step 5: Create IAM Role

```bash
# Trust policy: AgentCore assumes this role
aws iam create-role \
  --role-name $ROLE_NAME \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "bedrock-agentcore.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }' 2>/dev/null || echo "Role already exists"

# Permissions: MSK cluster access + ECR pull + CloudWatch logs
aws iam put-role-policy \
  --role-name $ROLE_NAME \
  --policy-name msk-access \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": [
          "kafka-cluster:Connect",
          "kafka-cluster:DescribeCluster",
          "kafka-cluster:DescribeTopic",
          "kafka-cluster:DescribeGroup",
          "kafka-cluster:ReadData",
          "kafka-cluster:DescribeTopicDynamicConfiguration"
        ],
        "Resource": "*"
      },
      {
        "Effect": "Allow",
        "Action": ["kafka:GetBootstrapBrokers", "kafka:DescribeClusterV2"],
        "Resource": "*"
      },
      {
        "Effect": "Allow",
        "Action": ["ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage", "ecr:GetAuthorizationToken"],
        "Resource": "*"
      },
      {
        "Effect": "Allow",
        "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
        "Resource": "arn:aws:logs:*:*:log-group:/aws/bedrock-agentcore/*"
      }
    ]
  }'
```

For production, scope `Resource: "*"` to specific ARNs. For write operations, add `kafka-cluster:WriteData` and `kafka-cluster:CreateTopic`.

---

## Step 6: Create AgentCore Runtime

The AWS CLI doesn't support VPC subnet/SG parameters for `create-agent-runtime`. Use boto3:

```bash
python3 << 'PYEOF'
import boto3, os

region = os.environ['AWS_REGION']
client = boto3.client('bedrock-agentcore-control', region_name=region)

response = client.create_agent_runtime(
    agentRuntimeName='kafka_mcp_server',
    agentRuntimeArtifact={
        'containerConfiguration': {
            'containerUri': f"{os.environ['ACCOUNT_ID']}.dkr.ecr.{region}.amazonaws.com/{os.environ['ECR_REPO']}:latest"
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
        'MSK_CLUSTER_ARN': os.environ['MSK_ARN'],
        'MSK_BOOTSTRAP_BROKERS': os.environ['MSK_BOOTSTRAP'],
        'AWS_REGION': region
    }
)
print(f"Runtime ID: {response['agentRuntimeId']}")
print(f"ARN: {response['agentRuntimeArn']}")
print(f"Status: {response['status']}")
PYEOF
```

Save the runtime ID:

```bash
export RUNTIME_ID=kafka_mcp_server-XXXXXXXXXX   # from output above
```

Wait for READY:

```bash
aws bedrock-agentcore-control get-agent-runtime \
  --agent-runtime-id $RUNTIME_ID --region $AWS_REGION \
  --query 'status' --output text
```

---

## Step 7: Verify

```bash
# Save the runtime ARN
export RUNTIME_ARN=$(aws bedrock-agentcore-control get-agent-runtime \
  --agent-runtime-id $RUNTIME_ID --region $AWS_REGION \
  --query 'agentRuntimeArn' --output text)

# Test MCP initialize
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

# Test listing topics
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
# Expected: list including __amazon_msk_canary
```

---

## Step 8: Configure Local Proxy

The agent connects to MCP servers via plain HTTP. AgentCore requires SigV4 signing.
A built-in SigV4 proxy starts automatically when `MCP_TRANSPORT=agentcore` and
`AGENTCORE_RUNTIME_ARN` are both set in `.env`.

Add to `.env`:

```env
# Transport mode -- set to "agentcore" to connect via AgentCore Runtime
MCP_TRANSPORT=agentcore

# AgentCore proxy
AGENTCORE_RUNTIME_ARN=<RUNTIME_ARN from Step 6>
AGENTCORE_PROXY_PORT=3000
KAFKA_MCP_URL=http://localhost:3000

# If AgentCore credentials differ from Bedrock LLM credentials:
# AGENTCORE_AWS_ACCESS_KEY_ID=<key for the AgentCore account>
# AGENTCORE_AWS_SECRET_ACCESS_KEY=<secret for the AgentCore account>
```

The proxy resolves credentials in order: `AGENTCORE_AWS_*` -> `AWS_*` -> `aws configure export-credentials`.

Start the server (the SigV4 proxy launches automatically):

```bash
cd packages/mcp-server-kafka && bun run dev
```

Verify:

```bash
curl -s http://localhost:3000/health
# {"status":"ok","target":"agentcore","region":"..."}

curl -s -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}'
```

---

## Updating the Deployed Server

After code changes:

```bash
# Build and push
docker build -f Dockerfile.agentcore \
  --build-arg MCP_SERVER_PACKAGE=mcp-server-kafka \
  -t $ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO:latest .
docker push $ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO:latest

# Delete and recreate runtime (update-in-place can cause stuck runtimes)
aws bedrock-agentcore-control delete-agent-runtime \
  --agent-runtime-id $RUNTIME_ID --region $AWS_REGION
sleep 30
# Re-run Step 6
```

---

## Troubleshooting

### 502 from runtime

1. **Check architecture:** `docker inspect <image> --format '{{.Architecture}}'` -- must be `arm64`
2. **Test locally:** `docker run --rm -p 8888:8000 -e KAFKA_PROVIDER=local <image>` then `curl localhost:8888/ping`
3. **Check CloudWatch:** `/aws/bedrock-agentcore/runtimes/<runtime-id>-DEFAULT/`
4. **Stuck runtime:** Delete and recreate -- runtimes can get stuck after repeated config changes

### Health check timeout

The bootstrap runs telemetry + datasource init before starting the HTTP server. If any step blocks (unreachable OTEL endpoint, etc.), `/ping` isn't available in time. Verify all VPC endpoints are `available`.

### SigV4 signature mismatch (proxy)

1. Verify credentials match the AgentCore account (`aws sts get-caller-identity`)
2. If using separate accounts for LLM and AgentCore, set `AGENTCORE_AWS_*` env vars
3. SigV4 service name must be `bedrock-agentcore`

### "metadata failed N times"

The container can't reach MSK brokers:
1. Runtime must be VPC mode with same subnets/SG as MSK
2. STS VPC endpoint must exist (for IAM token generation)
3. SG must allow self-referencing inbound traffic

### MSK Serverless cold starts

Avoid MSK Serverless for AgentCore. Serverless clusters have 60-120s cold-start latency on first metadata calls, causing tool timeouts. Use provisioned clusters.

### kafka_get_cluster_info shows "awsError: Request aborted"

The `DescribeClusterV2` AWS API (`kafka.<region>.amazonaws.com`) is a public endpoint unreachable from VPC without internet. The MSK provider aborts this call after 10s and returns Kafka-protocol data (topics, brokers) normally. All other tools are unaffected.

---

## Cleanup

```bash
aws bedrock-agentcore-control delete-agent-runtime \
  --agent-runtime-id $RUNTIME_ID --region $AWS_REGION

for vpce in $(aws ec2 describe-vpc-endpoints --filters "Name=vpc-id,Values=$VPC_ID" \
  --query 'VpcEndpoints[*].VpcEndpointId' --output text --region $AWS_REGION); do
  aws ec2 delete-vpc-endpoints --vpc-endpoint-ids $vpce --region $AWS_REGION
done

aws iam delete-role-policy --role-name $ROLE_NAME --policy-name msk-access
aws iam delete-role --role-name $ROLE_NAME
aws ecr delete-repository --repository-name $ECR_REPO --force --region $AWS_REGION
aws kafka delete-cluster --cluster-arn $MSK_ARN --region $AWS_REGION
```
