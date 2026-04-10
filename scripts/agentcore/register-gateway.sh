#!/usr/bin/env bash
# scripts/agentcore/register-gateway.sh
#
# Registers a deployed MCP server as an AgentCore Gateway target.
# Run this AFTER deploy.sh completes.
#
# Creates a Gateway (if needed) and adds the MCP server as a target,
# giving your LangGraph agent a single MCP endpoint for tool discovery.
#
# Prerequisites:
#   - .agentcore-deployment.json from deploy.sh
#   - AWS CLI v2 with bedrock-agentcore permissions
#
# Usage:
#   ./scripts/agentcore/register-gateway.sh
#
# Environment variables:
#   GATEWAY_NAME    - Gateway name (default: devops-incident-gateway)
#   GATEWAY_ID      - Existing gateway ID (skip creation if set)

set -euo pipefail

# -- Load deployment info --
if [ ! -f .agentcore-deployment.json ]; then
  echo "Error: .agentcore-deployment.json not found. Run deploy.sh first."
  exit 1
fi

RUNTIME_ARN=$(jq -r '.runtimeArn' .agentcore-deployment.json)
RUNTIME_ID=$(jq -r '.runtimeId' .agentcore-deployment.json)
AWS_REGION=$(jq -r '.region' .agentcore-deployment.json)
ACCOUNT_ID=$(jq -r '.accountId' .agentcore-deployment.json)
MCP_SERVER=$(jq -r '.server' .agentcore-deployment.json)

GATEWAY_NAME="${GATEWAY_NAME:-devops-incident-gateway}"
TARGET_NAME="${MCP_SERVER}-mcp"

echo "================================================================"
echo "  Register ${MCP_SERVER^} MCP as AgentCore Gateway Target"
echo "================================================================"
echo "  Runtime ARN: ${RUNTIME_ARN}"
echo "  Gateway:     ${GATEWAY_NAME}"
echo "  Target:      ${TARGET_NAME}"
echo "  Region:      ${AWS_REGION}"
echo "================================================================"
echo ""

# -- Step 1: Create or get Gateway --
if [ -z "${GATEWAY_ID:-}" ]; then
  echo "[1/4] Creating AgentCore Gateway..."

  echo "  Creating Cognito user pool for gateway auth..."
  POOL_ID=$(aws cognito-idp create-user-pool \
    --pool-name "${GATEWAY_NAME}-auth" \
    --region "${AWS_REGION}" \
    --query 'UserPool.Id' \
    --output text 2>/dev/null || echo "")

  if [ -z "${POOL_ID}" ]; then
    echo "  Cognito pool may already exist, searching..."
    POOL_ID=$(aws cognito-idp list-user-pools \
      --max-results 50 \
      --region "${AWS_REGION}" \
      --query "UserPools[?Name=='${GATEWAY_NAME}-auth'].Id" \
      --output text)

    if [ -z "${POOL_ID}" ] || [ "${POOL_ID}" = "None" ]; then
      echo "  Error: Failed to create or find Cognito user pool"
      exit 1
    fi
  fi

  aws cognito-idp create-resource-server \
    --user-pool-id "${POOL_ID}" \
    --identifier "gateway" \
    --name "Gateway Resources" \
    --scopes "ScopeName=tools,ScopeDescription=Access gateway tools" \
    --region "${AWS_REGION}" 2>/dev/null || true

  CLIENT_RESULT=$(aws cognito-idp create-user-pool-client \
    --user-pool-id "${POOL_ID}" \
    --client-name "${GATEWAY_NAME}-client" \
    --generate-secret \
    --allowed-o-auth-flows "client_credentials" \
    --allowed-o-auth-scopes "gateway/tools" \
    --allowed-o-auth-flows-user-pool-client \
    --region "${AWS_REGION}" \
    --output json 2>/dev/null || echo "{}")

  CLIENT_ID=$(echo "${CLIENT_RESULT}" | jq -r '.UserPoolClient.ClientId // empty')
  COGNITO_DOMAIN="https://cognito-idp.${AWS_REGION}.amazonaws.com/${POOL_ID}"

  echo "  Cognito pool: ${POOL_ID}"

  GATEWAY_RESULT=$(aws bedrock-agentcore create-gateway \
    --name "${GATEWAY_NAME}" \
    --protocol-type MCP \
    --authorizer-configuration "{\"type\":\"CustomJWTAuthorizer\",\"discoveryUrl\":\"${COGNITO_DOMAIN}/.well-known/openid-configuration\",\"allowedAudiences\":[\"${CLIENT_ID}\"]}" \
    --region "${AWS_REGION}" \
    --output json 2>/dev/null || echo "{}")

  GATEWAY_ID=$(echo "${GATEWAY_RESULT}" | jq -r '.gatewayId // empty')

  if [ -z "${GATEWAY_ID}" ]; then
    echo "  Gateway may already exist, searching..."
    GATEWAY_ID=$(aws bedrock-agentcore list-gateways \
      --region "${AWS_REGION}" \
      --query "gateways[?name=='${GATEWAY_NAME}'].gatewayId" \
      --output text 2>/dev/null || echo "")

    if [ -z "${GATEWAY_ID}" ] || [ "${GATEWAY_ID}" = "None" ]; then
      echo "  Error: Failed to create or find AgentCore Gateway"
      exit 1
    fi
  fi

  echo "  Gateway ID: ${GATEWAY_ID}"
else
  echo "[1/4] Using existing gateway: ${GATEWAY_ID}"
fi

# -- Step 2: Add MCP server as gateway target --
echo ""
echo "[2/4] Adding ${MCP_SERVER} MCP server as gateway target..."

ENCODED_ARN=$(echo -n "${RUNTIME_ARN}" | jq -sRr '@uri')
MCP_ENDPOINT="https://bedrock-agentcore.${AWS_REGION}.amazonaws.com/runtimes/${ENCODED_ARN}/invocations?qualifier=DEFAULT"

DESCRIPTIONS=(
  ["kafka"]="Kafka MCP server -- topics, consumers, schemas, ksqlDB"
  ["elastic"]="Elasticsearch MCP server -- indices, queries, mappings, monitoring"
  ["couchbase"]="Couchbase MCP server -- queries, buckets, scopes, collections"
  ["konnect"]="Kong Konnect MCP server -- services, routes, plugins, consumers"
)
TARGET_DESC="${DESCRIPTIONS[${MCP_SERVER}]:-${MCP_SERVER} MCP server}"

if ! aws bedrock-agentcore create-gateway-target \
  --gateway-id "${GATEWAY_ID}" \
  --name "${TARGET_NAME}" \
  --description "${TARGET_DESC}" \
  --target-configuration "{\"mcpServerConfiguration\":{\"mcpServerUrl\":\"${MCP_ENDPOINT}\"}}" \
  --region "${AWS_REGION}" 2>/dev/null; then
  echo "  Target may already exist, continuing..."
fi

echo "  Target registered: ${TARGET_NAME}"

# -- Step 3: Synchronize tools --
echo ""
echo "[3/4] Synchronizing tool catalog..."

aws bedrock-agentcore synchronize-gateway-targets \
  --gateway-id "${GATEWAY_ID}" \
  --target-ids "${TARGET_NAME}" \
  --region "${AWS_REGION}" 2>/dev/null || true

echo "  Tools synchronized (may take a few minutes to index)"

# -- Step 4: Get gateway endpoint --
echo ""
echo "[4/4] Gateway endpoint"

GATEWAY_ENDPOINT=$(aws bedrock-agentcore get-gateway \
  --gateway-id "${GATEWAY_ID}" \
  --region "${AWS_REGION}" \
  --query 'gatewayUrl' \
  --output text 2>/dev/null || echo "pending...")

echo ""
echo "================================================================"
echo "  Gateway Registration Complete"
echo "================================================================"
echo ""
echo "  Gateway ID:       ${GATEWAY_ID}"
echo "  Gateway Endpoint: ${GATEWAY_ENDPOINT}"
echo ""
echo "  Your agent can now connect to this single endpoint"
echo "  to discover all ${MCP_SERVER} tools via MCP."
echo ""
echo "  To add more MCP servers to the same gateway:"
echo "  MCP_SERVER=elastic ./scripts/agentcore/deploy.sh"
echo "  GATEWAY_ID=${GATEWAY_ID} ./scripts/agentcore/register-gateway.sh"
echo ""
echo "  Update your agent's .env:"
echo "  ${MCP_SERVER^^}_MCP_URL=${GATEWAY_ENDPOINT}/mcp"
echo ""
echo "================================================================"

jq --arg gw "${GATEWAY_ID}" --arg ep "${GATEWAY_ENDPOINT}" \
  '. + {gatewayId: $gw, gatewayEndpoint: $ep}' \
  .agentcore-deployment.json > .agentcore-deployment.json.tmp && \
  mv .agentcore-deployment.json.tmp .agentcore-deployment.json

echo "Gateway info saved to .agentcore-deployment.json"
