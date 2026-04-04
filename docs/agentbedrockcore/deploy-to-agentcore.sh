#!/usr/bin/env bash
# deploy-to-agentcore.sh
#
# Deploys the Kafka MCP server to AWS Bedrock AgentCore Runtime.
#
# Prerequisites:
#   - AWS CLI v2 configured with credentials
#   - Docker or Finch installed
#   - jq installed
#
# Usage:
#   ./deploy-to-agentcore.sh
#
# Environment variables (override defaults):
#   AWS_REGION          - AWS region (default: eu-west-1)
#   RUNTIME_NAME        - AgentCore runtime name (default: kafka-mcp-server)
#   ECR_REPO            - ECR repository name (default: kafka-mcp-agentcore)
#   MSK_CLUSTER_ARN     - Your MSK cluster ARN (required)
#   KAFKA_PROVIDER      - Kafka provider type (default: msk)

set -euo pipefail

# ── Configuration ──
AWS_REGION="${AWS_REGION:-eu-west-1}"
RUNTIME_NAME="${RUNTIME_NAME:-kafka-mcp-server}"
ECR_REPO="${ECR_REPO:-kafka-mcp-agentcore}"
KAFKA_PROVIDER="${KAFKA_PROVIDER:-msk}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_URI="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO}"
IMAGE_TAG="latest"
ROLE_NAME="${RUNTIME_NAME}-agentcore-role"

echo "╔══════════════════════════════════════════════════════╗"
echo "║  Kafka MCP Server → AgentCore Runtime Deployment     ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║  Region:       ${AWS_REGION}"
echo "║  Account:      ${ACCOUNT_ID}"
echo "║  Runtime:      ${RUNTIME_NAME}"
echo "║  ECR Repo:     ${ECR_REPO}"
echo "║  Kafka:        ${KAFKA_PROVIDER}"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ── Step 1: Create ECR repository (if not exists) ──
echo "▸ Step 1/5: Creating ECR repository..."
aws ecr describe-repositories \
  --repository-names "${ECR_REPO}" \
  --region "${AWS_REGION}" 2>/dev/null || \
aws ecr create-repository \
  --repository-name "${ECR_REPO}" \
  --region "${AWS_REGION}" \
  --image-scanning-configuration scanOnPush=true \
  --encryption-configuration encryptionType=AES256
echo "  ✓ ECR repository ready: ${ECR_URI}"

# ── Step 2: Build and push container image ──
echo ""
echo "▸ Step 2/5: Building container image..."
docker build \
  -f Dockerfile.agentcore \
  -t "${ECR_REPO}:${IMAGE_TAG}" \
  .

echo "  Authenticating to ECR..."
aws ecr get-login-password --region "${AWS_REGION}" | \
  docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

echo "  Pushing image..."
docker tag "${ECR_REPO}:${IMAGE_TAG}" "${ECR_URI}:${IMAGE_TAG}"
docker push "${ECR_URI}:${IMAGE_TAG}"
echo "  ✓ Image pushed: ${ECR_URI}:${IMAGE_TAG}"

# ── Step 3: Create IAM execution role ──
echo ""
echo "▸ Step 3/5: Creating IAM role..."

TRUST_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "bedrock-agentcore.amazonaws.com"
      },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": {
          "aws:SourceAccount": "${ACCOUNT_ID}"
        }
      }
    }
  ]
}
EOF
)

# Create role (ignore error if exists)
aws iam create-role \
  --role-name "${ROLE_NAME}" \
  --assume-role-policy-document "${TRUST_POLICY}" \
  --description "AgentCore Runtime role for Kafka MCP server" \
  2>/dev/null || echo "  Role already exists, updating..."

# Attach MSK permissions
MSK_POLICY=$(cat <<EOF
{
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
        "kafka-cluster:DescribeTopicDynamicConfiguration",
        "kafka-cluster:DescribeClusterDynamicConfiguration"
      ],
      "Resource": [
        "arn:aws:kafka:${AWS_REGION}:${ACCOUNT_ID}:cluster/*",
        "arn:aws:kafka:${AWS_REGION}:${ACCOUNT_ID}:topic/*",
        "arn:aws:kafka:${AWS_REGION}:${ACCOUNT_ID}:group/*"
      ]
    },
    {
      "Sid": "MSKBrokerDiscovery",
      "Effect": "Allow",
      "Action": [
        "kafka:GetBootstrapBrokers",
        "kafka:DescribeClusterV2",
        "kafka:ListClusters"
      ],
      "Resource": "arn:aws:kafka:${AWS_REGION}:${ACCOUNT_ID}:cluster/*"
    },
    {
      "Sid": "CloudWatchLogs",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:${AWS_REGION}:${ACCOUNT_ID}:log-group:/aws/bedrock-agentcore/runtimes/*"
    },
    {
      "Sid": "ECRPull",
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
EOF
)

POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${ROLE_NAME}-policy"
aws iam create-policy \
  --policy-name "${ROLE_NAME}-policy" \
  --policy-document "${MSK_POLICY}" \
  2>/dev/null || \
aws iam create-policy-version \
  --policy-arn "${POLICY_ARN}" \
  --policy-document "${MSK_POLICY}" \
  --set-as-default 2>/dev/null || true

aws iam attach-role-policy \
  --role-name "${ROLE_NAME}" \
  --policy-arn "arn:aws:iam::${ACCOUNT_ID}:policy/${ROLE_NAME}-policy" \
  2>/dev/null || true

ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
echo "  ✓ IAM role ready: ${ROLE_ARN}"

# Wait for role propagation
echo "  Waiting for IAM role propagation..."
sleep 10

# ── Step 4: Create AgentCore Runtime ──
echo ""
echo "▸ Step 4/5: Creating AgentCore Runtime..."

# Check if runtime already exists
EXISTING_RUNTIME=$(aws bedrock-agentcore-control list-agent-runtimes \
  --region "${AWS_REGION}" \
  --query "agentRuntimeSummaries[?agentRuntimeName=='${RUNTIME_NAME}'].agentRuntimeId" \
  --output text 2>/dev/null || echo "")

if [ -n "${EXISTING_RUNTIME}" ] && [ "${EXISTING_RUNTIME}" != "None" ]; then
  echo "  Runtime exists (${EXISTING_RUNTIME}), updating..."
  aws bedrock-agentcore-control update-agent-runtime \
    --agent-runtime-id "${EXISTING_RUNTIME}" \
    --agent-runtime-artifact "containerConfiguration={containerUri=${ECR_URI}:${IMAGE_TAG}}" \
    --role-arn "${ROLE_ARN}" \
    --network-configuration "networkMode=PUBLIC" \
    --protocol-configuration "serverProtocol=MCP" \
    --environment-variables "KAFKA_PROVIDER=${KAFKA_PROVIDER},AWS_REGION=${AWS_REGION},MSK_CLUSTER_ARN=${MSK_CLUSTER_ARN:-}" \
    --region "${AWS_REGION}"
  RUNTIME_ID="${EXISTING_RUNTIME}"
else
  RESULT=$(aws bedrock-agentcore-control create-agent-runtime \
    --agent-runtime-name "${RUNTIME_NAME}" \
    --agent-runtime-artifact "containerConfiguration={containerUri=${ECR_URI}:${IMAGE_TAG}}" \
    --role-arn "${ROLE_ARN}" \
    --network-configuration "networkMode=PUBLIC" \
    --protocol-configuration "serverProtocol=MCP" \
    --environment-variables "KAFKA_PROVIDER=${KAFKA_PROVIDER},AWS_REGION=${AWS_REGION},MSK_CLUSTER_ARN=${MSK_CLUSTER_ARN:-}" \
    --region "${AWS_REGION}" \
    --output json)
  RUNTIME_ID=$(echo "${RESULT}" | jq -r '.agentRuntimeId')
fi

echo "  Waiting for runtime to become ACTIVE..."
for i in $(seq 1 30); do
  STATUS=$(aws bedrock-agentcore-control get-agent-runtime \
    --agent-runtime-id "${RUNTIME_ID}" \
    --region "${AWS_REGION}" \
    --query 'status' \
    --output text 2>/dev/null || echo "CREATING")
  if [ "${STATUS}" = "ACTIVE" ]; then
    break
  fi
  echo "    Status: ${STATUS} (attempt ${i}/30)"
  sleep 10
done

RUNTIME_ARN=$(aws bedrock-agentcore-control get-agent-runtime \
  --agent-runtime-id "${RUNTIME_ID}" \
  --region "${AWS_REGION}" \
  --query 'agentRuntimeArn' \
  --output text)

echo "  ✓ AgentCore Runtime ready"
echo "    ID:  ${RUNTIME_ID}"
echo "    ARN: ${RUNTIME_ARN}"

# ── Step 5: Output connection info ──
echo ""
echo "▸ Step 5/5: Connection information"
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  Deployment Complete                                 ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║                                                      ║"
echo "║  Runtime ARN:                                        ║"
echo "║  ${RUNTIME_ARN}"
echo "║                                                      ║"
echo "║  MCP Endpoint:                                       ║"
echo "║  https://bedrock-agentcore.${AWS_REGION}.amazonaws.com/runtimes/<encoded-arn>/invocations"
echo "║                                                      ║"
echo "║  Test with:                                          ║"
echo "║  aws bedrock-agentcore invoke-agent-runtime \\        ║"
echo "║    --agent-runtime-id ${RUNTIME_ID} \\                ║"
echo "║    --region ${AWS_REGION} \\                          ║"
echo "║    --body '{...mcp request...}'                      ║"
echo "║                                                      ║"
echo "║  Next: Register as AgentCore Gateway target          ║"
echo "║  See: register-gateway-target.sh                     ║"
echo "╚══════════════════════════════════════════════════════╝"

# Save deployment info for gateway registration
cat > .agentcore-deployment.json <<EOF
{
  "runtimeId": "${RUNTIME_ID}",
  "runtimeArn": "${RUNTIME_ARN}",
  "region": "${AWS_REGION}",
  "accountId": "${ACCOUNT_ID}",
  "roleArn": "${ROLE_ARN}",
  "ecrUri": "${ECR_URI}:${IMAGE_TAG}",
  "provider": "${KAFKA_PROVIDER}"
}
EOF

echo ""
echo "Deployment info saved to .agentcore-deployment.json"
