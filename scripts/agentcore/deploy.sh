#!/usr/bin/env bash
# scripts/agentcore/deploy.sh
#
# Deploys an MCP server to AWS Bedrock AgentCore Runtime.
# Parameterized via MCP_SERVER env var to support all 4 servers.
#
# Prerequisites:
#   - AWS CLI v2 configured with credentials
#   - Docker installed
#   - jq installed
#
# Usage:
#   ./scripts/agentcore/deploy.sh                    # Deploys Kafka MCP server
#   MCP_SERVER=elastic ./scripts/agentcore/deploy.sh # Deploys Elastic MCP server
#
# Environment variables (override defaults):
#   MCP_SERVER              - Server name: kafka|elastic|couchbase|konnect (default: kafka)
#   AWS_REGION              - AWS region (default: eu-west-1)
#   RUNTIME_NAME            - AgentCore runtime name (default: <server>-mcp-server)
#   ECR_REPO                - ECR repository name (default: <server>-mcp-agentcore)
#
# Networking (optional, all servers):
#   AGENTCORE_SUBNETS       - Comma-separated subnet IDs. If set, runtime is
#                             created in networkMode=VPC (required to reach
#                             VPC-private resources like a private MSK cluster).
#                             When unset, networkMode=PUBLIC is used.
#   AGENTCORE_SECURITY_GROUPS - Comma-separated security group IDs. Required
#                             when AGENTCORE_SUBNETS is set.
#
# For MCP_SERVER=kafka with KAFKA_PROVIDER=msk, the script auto-discovers
# subnets and the primary security group from MSK_CLUSTER_ARN if neither
# AGENTCORE_SUBNETS nor AGENTCORE_SECURITY_GROUPS is provided. Local
# credentials need 'kafka:DescribeCluster' permission for this.
#
# Kafka-specific:
#   KAFKA_PROVIDER          - Kafka provider type (default: msk)
#   MSK_CLUSTER_ARN         - MSK cluster ARN (used for broker discovery / metadata)
#   MSK_BOOTSTRAP_BROKERS   - Bootstrap brokers (skips runtime-side broker discovery)
#   MSK_AUTH_MODE           - iam (default) | tls | none. When 'none', the IAM
#                             policy block for kafka-cluster:* is skipped because
#                             the cluster does not enforce IAM auth.
#
# Elastic-specific:
#   ELASTICSEARCH_URL       - Elasticsearch cluster URL
#   ELASTICSEARCH_API_KEY   - API key auth (or use USERNAME+PASSWORD)
#   ELASTICSEARCH_USERNAME  - Basic auth username
#   ELASTICSEARCH_PASSWORD  - Basic auth password
#
# Couchbase-specific:
#   CB_HOSTNAME             - Capella cluster hostname
#   CB_USERNAME             - Cluster username
#   CB_PASSWORD             - Cluster password
#   CB_BUCKET               - Target bucket name
#
# Konnect-specific:
#   KONNECT_ACCESS_TOKEN    - Kong Konnect API access token
#   KONNECT_REGION          - Konnect region (us|eu|au|me|in)

set -euo pipefail

# -- Configuration --
MCP_SERVER="${MCP_SERVER:-kafka}"
MCP_SERVER_PACKAGE="mcp-server-${MCP_SERVER}"
AWS_REGION="${AWS_REGION:-eu-west-1}"
RUNTIME_NAME="${RUNTIME_NAME:-${MCP_SERVER}-mcp-server}"
ECR_REPO="${ECR_REPO:-${MCP_SERVER}-mcp-agentcore}"
KAFKA_PROVIDER="${KAFKA_PROVIDER:-msk}"
# Default to 'none' to match the runtime default. Set MSK_AUTH_MODE=iam (or =tls)
# explicitly to opt into authenticated paths.
MSK_AUTH_MODE="${MSK_AUTH_MODE:-none}"
AGENTCORE_SUBNETS="${AGENTCORE_SUBNETS:-}"
AGENTCORE_SECURITY_GROUPS="${AGENTCORE_SECURITY_GROUPS:-}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_URI="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO}"
IMAGE_TAG="latest"
ROLE_NAME="${RUNTIME_NAME}-agentcore-role"

# Validate networking inputs early -- VPC requires both subnets and SGs.
if [ -n "${AGENTCORE_SUBNETS}" ] && [ -z "${AGENTCORE_SECURITY_GROUPS}" ]; then
  echo "Error: AGENTCORE_SUBNETS is set but AGENTCORE_SECURITY_GROUPS is not."
  echo "Both are required for networkMode=VPC. Unset AGENTCORE_SUBNETS to use PUBLIC mode."
  exit 1
fi
if [ -z "${AGENTCORE_SUBNETS}" ] && [ -n "${AGENTCORE_SECURITY_GROUPS}" ]; then
  echo "Error: AGENTCORE_SECURITY_GROUPS is set but AGENTCORE_SUBNETS is not."
  exit 1
fi

# For Kafka against MSK, derive VPC networking from the cluster ARN when the
# user hasn't supplied subnets/SGs. MSK clusters are in-VPC by default; the
# runtime needs ENIs in the same subnets+SG to reach the brokers.
if [ "${MCP_SERVER}" = "kafka" ] \
   && [ "${KAFKA_PROVIDER}" = "msk" ] \
   && [ -n "${MSK_CLUSTER_ARN:-}" ] \
   && [ -z "${AGENTCORE_SUBNETS}" ]; then
  echo "Discovering VPC networking from MSK cluster..."
  DISCOVERED_SUBNETS=$(aws kafka describe-cluster \
    --cluster-arn "${MSK_CLUSTER_ARN}" \
    --region "${AWS_REGION}" \
    --query 'ClusterInfo.BrokerNodeGroupInfo.ClientSubnets' \
    --output text 2>/dev/null | tr '\t' ',' || echo "")
  DISCOVERED_SG=$(aws kafka describe-cluster \
    --cluster-arn "${MSK_CLUSTER_ARN}" \
    --region "${AWS_REGION}" \
    --query 'ClusterInfo.BrokerNodeGroupInfo.SecurityGroups[0]' \
    --output text 2>/dev/null || echo "")
  if [ -n "${DISCOVERED_SUBNETS}" ] && [ -n "${DISCOVERED_SG}" ] && [ "${DISCOVERED_SG}" != "None" ]; then
    AGENTCORE_SUBNETS="${DISCOVERED_SUBNETS}"
    AGENTCORE_SECURITY_GROUPS="${DISCOVERED_SG}"
    echo "  Subnets: ${AGENTCORE_SUBNETS}"
    echo "  SG:      ${AGENTCORE_SECURITY_GROUPS}"
  else
    echo "  Could not discover subnets/SG from cluster ARN. Falling back to PUBLIC mode."
    echo "  If brokers are VPC-private, set AGENTCORE_SUBNETS / AGENTCORE_SECURITY_GROUPS"
    echo "  manually or grant 'kafka:DescribeCluster' to your local AWS credentials."
  fi
fi

echo "================================================================"
echo "  ${MCP_SERVER^} MCP Server -> AgentCore Runtime Deployment"
echo "================================================================"
echo "  Region:       ${AWS_REGION}"
echo "  Account:      ${ACCOUNT_ID}"
echo "  Runtime:      ${RUNTIME_NAME}"
echo "  ECR Repo:     ${ECR_REPO}"
echo "  Package:      ${MCP_SERVER_PACKAGE}"
case "${MCP_SERVER}" in
  kafka)    echo "  Kafka:        ${KAFKA_PROVIDER} (auth=${MSK_AUTH_MODE})" ;;
  elastic)  echo "  Elastic:      ${ELASTICSEARCH_URL:-not set}" ;;
  couchbase) echo "  Couchbase:    ${CB_HOSTNAME:-not set}" ;;
  konnect)  echo "  Konnect:      region=${KONNECT_REGION:-us}" ;;
esac
if [ -n "${AGENTCORE_SUBNETS}" ]; then
  echo "  Network:      VPC (subnets=${AGENTCORE_SUBNETS}, sgs=${AGENTCORE_SECURITY_GROUPS})"
else
  echo "  Network:      PUBLIC"
fi
echo "================================================================"
echo ""

# -- Step 1: Create ECR repository (if not exists) --
echo "[1/5] Creating ECR repository..."
if ! aws ecr describe-repositories \
  --repository-names "${ECR_REPO}" \
  --region "${AWS_REGION}" >/dev/null 2>&1; then
  aws ecr create-repository \
    --repository-name "${ECR_REPO}" \
    --region "${AWS_REGION}" \
    --image-scanning-configuration scanOnPush=true \
    --encryption-configuration encryptionType=AES256
  echo "  ECR repository created: ${ECR_URI}"
else
  echo "  ECR repository exists: ${ECR_URI}"
fi

# -- Step 2: Build and push container image --
echo ""
echo "[2/5] Building container image..."
docker build \
  -f Dockerfile.agentcore \
  --build-arg MCP_SERVER_PACKAGE="${MCP_SERVER_PACKAGE}" \
  -t "${ECR_REPO}:${IMAGE_TAG}" \
  .

echo "  Authenticating to ECR..."
aws ecr get-login-password --region "${AWS_REGION}" | \
  docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

echo "  Pushing image..."
docker tag "${ECR_REPO}:${IMAGE_TAG}" "${ECR_URI}:${IMAGE_TAG}"
docker push "${ECR_URI}:${IMAGE_TAG}"
echo "  Image pushed: ${ECR_URI}:${IMAGE_TAG}"

# -- Step 3: Create IAM execution role --
echo ""
echo "[3/5] Creating IAM role..."

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

if ! aws iam get-role --role-name "${ROLE_NAME}" >/dev/null 2>&1; then
  aws iam create-role \
    --role-name "${ROLE_NAME}" \
    --assume-role-policy-document "${TRUST_POLICY}" \
    --description "AgentCore Runtime role for ${MCP_SERVER} MCP server"
  echo "  IAM role created: ${ROLE_NAME}"
else
  echo "  IAM role exists: ${ROLE_NAME}"
  aws iam update-assume-role-policy \
    --role-name "${ROLE_NAME}" \
    --policy-document "${TRUST_POLICY}"
fi

# Build permissions policy based on server type
POLICY_STATEMENTS='[
    {
      "Sid": "CloudWatchLogs",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:'"${AWS_REGION}"':'"${ACCOUNT_ID}"':log-group:/aws/bedrock-agentcore/runtimes/*"
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
    }'

# Add MSK IAM permissions for kafka server only when the cluster enforces IAM auth.
# When MSK_AUTH_MODE=none, kafka-cluster:* actions are unused and would be dead grants.
if [ "${MCP_SERVER}" = "kafka" ] && [ "${MSK_AUTH_MODE}" != "none" ]; then
  POLICY_STATEMENTS="${POLICY_STATEMENTS}"',
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
        "arn:aws:kafka:'"${AWS_REGION}"':'"${ACCOUNT_ID}"':cluster/*",
        "arn:aws:kafka:'"${AWS_REGION}"':'"${ACCOUNT_ID}"':topic/*",
        "arn:aws:kafka:'"${AWS_REGION}"':'"${ACCOUNT_ID}"':group/*"
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
      "Resource": "arn:aws:kafka:'"${AWS_REGION}"':'"${ACCOUNT_ID}"':cluster/*"
    }'
fi

POLICY_DOCUMENT='{"Version":"2012-10-17","Statement":'"${POLICY_STATEMENTS}"']}'

POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${ROLE_NAME}-policy"
if ! aws iam get-policy --policy-arn "${POLICY_ARN}" >/dev/null 2>&1; then
  aws iam create-policy \
    --policy-name "${ROLE_NAME}-policy" \
    --policy-document "${POLICY_DOCUMENT}"
  echo "  Policy created: ${ROLE_NAME}-policy"
else
  aws iam create-policy-version \
    --policy-arn "${POLICY_ARN}" \
    --policy-document "${POLICY_DOCUMENT}" \
    --set-as-default
  echo "  Policy updated: ${ROLE_NAME}-policy"
fi

aws iam attach-role-policy \
  --role-name "${ROLE_NAME}" \
  --policy-arn "${POLICY_ARN}" 2>/dev/null || true

ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
echo "  IAM role ready: ${ROLE_ARN}"

echo "  Waiting for IAM role propagation..."
sleep 10

# -- Step 4: Create AgentCore Runtime --
echo ""
echo "[4/5] Creating AgentCore Runtime..."

# Build environment variables based on server type
ENV_VARS="AWS_REGION=${AWS_REGION}"
case "${MCP_SERVER}" in
  kafka)
    ENV_VARS="${ENV_VARS},KAFKA_PROVIDER=${KAFKA_PROVIDER}"
    ENV_VARS="${ENV_VARS},MSK_AUTH_MODE=${MSK_AUTH_MODE}"
    if [ -n "${MSK_CLUSTER_ARN:-}" ]; then
      ENV_VARS="${ENV_VARS},MSK_CLUSTER_ARN=${MSK_CLUSTER_ARN}"
    fi
    if [ -n "${MSK_BOOTSTRAP_BROKERS:-}" ]; then
      ENV_VARS="${ENV_VARS},MSK_BOOTSTRAP_BROKERS=${MSK_BOOTSTRAP_BROKERS}"
    fi
    if [ -n "${KSQL_ENABLED:-}" ]; then
      ENV_VARS="${ENV_VARS},KSQL_ENABLED=${KSQL_ENABLED}"
    fi
    if [ -n "${KSQL_ENDPOINT:-}" ]; then
      ENV_VARS="${ENV_VARS},KSQL_ENDPOINT=${KSQL_ENDPOINT}"
    fi
    if [ -n "${KSQL_API_KEY:-}" ]; then
      ENV_VARS="${ENV_VARS},KSQL_API_KEY=${KSQL_API_KEY}"
    fi
    if [ -n "${KSQL_API_SECRET:-}" ]; then
      ENV_VARS="${ENV_VARS},KSQL_API_SECRET=${KSQL_API_SECRET}"
    fi
    if [ -n "${SCHEMA_REGISTRY_ENABLED:-}" ]; then
      ENV_VARS="${ENV_VARS},SCHEMA_REGISTRY_ENABLED=${SCHEMA_REGISTRY_ENABLED}"
    fi
    if [ -n "${SCHEMA_REGISTRY_URL:-}" ]; then
      ENV_VARS="${ENV_VARS},SCHEMA_REGISTRY_URL=${SCHEMA_REGISTRY_URL}"
    fi
    if [ -n "${SCHEMA_REGISTRY_API_KEY:-}" ]; then
      ENV_VARS="${ENV_VARS},SCHEMA_REGISTRY_API_KEY=${SCHEMA_REGISTRY_API_KEY}"
    fi
    if [ -n "${SCHEMA_REGISTRY_API_SECRET:-}" ]; then
      ENV_VARS="${ENV_VARS},SCHEMA_REGISTRY_API_SECRET=${SCHEMA_REGISTRY_API_SECRET}"
    fi
    if [ -n "${CONNECT_ENABLED:-}" ]; then
      ENV_VARS="${ENV_VARS},CONNECT_ENABLED=${CONNECT_ENABLED}"
    fi
    if [ -n "${CONNECT_URL:-}" ]; then
      ENV_VARS="${ENV_VARS},CONNECT_URL=${CONNECT_URL}"
    fi
    if [ -n "${CONNECT_API_KEY:-}" ]; then
      ENV_VARS="${ENV_VARS},CONNECT_API_KEY=${CONNECT_API_KEY}"
    fi
    if [ -n "${CONNECT_API_SECRET:-}" ]; then
      ENV_VARS="${ENV_VARS},CONNECT_API_SECRET=${CONNECT_API_SECRET}"
    fi
    ;;
  elastic)
    if [ -n "${ELASTICSEARCH_URL:-}" ]; then
      ENV_VARS="${ENV_VARS},ELASTICSEARCH_URL=${ELASTICSEARCH_URL}"
    fi
    if [ -n "${ELASTICSEARCH_API_KEY:-}" ]; then
      ENV_VARS="${ENV_VARS},ELASTICSEARCH_API_KEY=${ELASTICSEARCH_API_KEY}"
    fi
    if [ -n "${ELASTICSEARCH_USERNAME:-}" ]; then
      ENV_VARS="${ENV_VARS},ELASTICSEARCH_USERNAME=${ELASTICSEARCH_USERNAME}"
    fi
    if [ -n "${ELASTICSEARCH_PASSWORD:-}" ]; then
      ENV_VARS="${ENV_VARS},ELASTICSEARCH_PASSWORD=${ELASTICSEARCH_PASSWORD}"
    fi
    ;;
  couchbase)
    if [ -n "${CB_HOSTNAME:-}" ]; then
      ENV_VARS="${ENV_VARS},CB_HOSTNAME=${CB_HOSTNAME}"
    fi
    if [ -n "${CB_USERNAME:-}" ]; then
      ENV_VARS="${ENV_VARS},CB_USERNAME=${CB_USERNAME}"
    fi
    if [ -n "${CB_PASSWORD:-}" ]; then
      ENV_VARS="${ENV_VARS},CB_PASSWORD=${CB_PASSWORD}"
    fi
    if [ -n "${CB_BUCKET:-}" ]; then
      ENV_VARS="${ENV_VARS},CB_BUCKET=${CB_BUCKET}"
    fi
    ;;
  konnect)
    if [ -n "${KONNECT_ACCESS_TOKEN:-}" ]; then
      ENV_VARS="${ENV_VARS},KONNECT_ACCESS_TOKEN=${KONNECT_ACCESS_TOKEN}"
    fi
    if [ -n "${KONNECT_REGION:-}" ]; then
      ENV_VARS="${ENV_VARS},KONNECT_REGION=${KONNECT_REGION}"
    fi
    ;;
esac

if [ -n "${AGENTCORE_SUBNETS}" ]; then
  # VPC mode: build a JSON network-configuration so the CLI accepts subnet/SG arrays.
  SUBNET_JSON=$(echo "${AGENTCORE_SUBNETS}" | jq -R 'split(",") | map(gsub("^\\s+|\\s+$"; ""))')
  SG_JSON=$(echo "${AGENTCORE_SECURITY_GROUPS}" | jq -R 'split(",") | map(gsub("^\\s+|\\s+$"; ""))')
  NETWORK_CONFIG=$(jq -n \
    --argjson subnets "${SUBNET_JSON}" \
    --argjson sgs "${SG_JSON}" \
    '{networkMode: "VPC", networkModeConfig: {subnets: $subnets, securityGroups: $sgs}}')
else
  NETWORK_CONFIG='{"networkMode":"PUBLIC"}'
fi

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
    --network-configuration "${NETWORK_CONFIG}" \
    --protocol-configuration "serverProtocol=MCP" \
    --environment-variables "${ENV_VARS}" \
    --region "${AWS_REGION}"
  RUNTIME_ID="${EXISTING_RUNTIME}"
else
  RESULT=$(aws bedrock-agentcore-control create-agent-runtime \
    --agent-runtime-name "${RUNTIME_NAME}" \
    --agent-runtime-artifact "containerConfiguration={containerUri=${ECR_URI}:${IMAGE_TAG}}" \
    --role-arn "${ROLE_ARN}" \
    --network-configuration "${NETWORK_CONFIG}" \
    --protocol-configuration "serverProtocol=MCP" \
    --environment-variables "${ENV_VARS}" \
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

echo "  AgentCore Runtime ready"
echo "    ID:  ${RUNTIME_ID}"
echo "    ARN: ${RUNTIME_ARN}"

# -- Step 5: Output connection info --
echo ""
echo "[5/5] Connection information"
echo ""
echo "================================================================"
echo "  Deployment Complete"
echo "================================================================"
echo ""
echo "  Runtime ARN:"
echo "  ${RUNTIME_ARN}"
echo ""
echo "  Test with:"
echo "  aws bedrock-agentcore invoke-agent-runtime \\"
echo "    --agent-runtime-id ${RUNTIME_ID} \\"
echo "    --region ${AWS_REGION} \\"
echo "    --body '{...mcp request...}'"
echo ""
echo "  Next: Register as AgentCore Gateway target"
echo "  Run: ./scripts/agentcore/register-gateway.sh"
echo ""
echo "================================================================"

cat > .agentcore-deployment.json <<EOF
{
  "runtimeId": "${RUNTIME_ID}",
  "runtimeArn": "${RUNTIME_ARN}",
  "region": "${AWS_REGION}",
  "accountId": "${ACCOUNT_ID}",
  "roleArn": "${ROLE_ARN}",
  "ecrUri": "${ECR_URI}:${IMAGE_TAG}",
  "server": "${MCP_SERVER}"
}
EOF

echo "Deployment info saved to .agentcore-deployment.json"
