#!/usr/bin/env bash
# register-gateway-target.sh
#
# Registers the deployed Kafka MCP server as an AgentCore Gateway target.
# Run this AFTER deploy-to-agentcore.sh completes.
#
# This creates a Gateway (if needed) and adds the Kafka MCP server as a
# target, giving your LangGraph agent a single MCP endpoint to discover
# all Kafka tools.
#
# Prerequisites:
#   - .agentcore-deployment.json from deploy-to-agentcore.sh
#   - AWS CLI v2 with bedrock-agentcore permissions
#
# Usage:
#   ./register-gateway-target.sh
#
# Environment variables:
#   GATEWAY_NAME    - Gateway name (default: devops-incident-gateway)
#   GATEWAY_ID      - Existing gateway ID (skip creation if set)

set -euo pipefail

# ── Load deployment info ──
if [ ! -f .agentcore-deployment.json ]; then
  echo "Error: .agentcore-deployment.json not found. Run deploy-to-agentcore.sh first."
  exit 1
fi

RUNTIME_ARN=$(jq -r '.runtimeArn' .agentcore-deployment.json)
RUNTIME_ID=$(jq -r '.runtimeId' .agentcore-deployment.json)
AWS_REGION=$(jq -r '.region' .agentcore-deployment.json)
ACCOUNT_ID=$(jq -r '.accountId' .agentcore-deployment.json)

GATEWAY_NAME="${GATEWAY_NAME:-devops-incident-gateway}"

echo "╔══════════════════════════════════════════════════════╗"
echo "║  Register Kafka MCP as AgentCore Gateway Target      ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║  Runtime ARN: ${RUNTIME_ARN}"
echo "║  Gateway:     ${GATEWAY_NAME}"
echo "║  Region:      ${AWS_REGION}"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ── Step 1: Create or get Gateway ──
if [ -z "${GATEWAY_ID:-}" ]; then
  echo "▸ Step 1: Creating AgentCore Gateway..."

  # Gateway requires an OAuth authorizer.
  # Create a Cognito user pool for gateway auth.
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
  fi

  # Create a resource server for the gateway
  aws cognito-idp create-resource-server \
    --user-pool-id "${POOL_ID}" \
    --identifier "gateway" \
    --name "Gateway Resources" \
    --scopes "ScopeName=tools,ScopeDescription=Access gateway tools" \
    --region "${AWS_REGION}" 2>/dev/null || true

  # Create an app client with client_credentials grant
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

  echo "  ✓ Cognito pool: ${POOL_ID}"

  # Create the gateway
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
  fi

  echo "  ✓ Gateway ID: ${GATEWAY_ID}"
else
  echo "▸ Step 1: Using existing gateway: ${GATEWAY_ID}"
fi

# ── Step 2: Add Kafka MCP server as gateway target ──
echo ""
echo "▸ Step 2: Adding Kafka MCP server as gateway target..."

# The MCP server endpoint within AgentCore Runtime
ENCODED_ARN=$(echo -n "${RUNTIME_ARN}" | jq -sRr '@uri')
MCP_ENDPOINT="https://bedrock-agentcore.${AWS_REGION}.amazonaws.com/runtimes/${ENCODED_ARN}/invocations?qualifier=DEFAULT"

aws bedrock-agentcore create-gateway-target \
  --gateway-id "${GATEWAY_ID}" \
  --name "kafka-mcp" \
  --description "Kafka MCP server — topics, consumers, schemas, ksqlDB" \
  --target-configuration "{\"mcpServerConfiguration\":{\"mcpServerUrl\":\"${MCP_ENDPOINT}\"}}" \
  --region "${AWS_REGION}" \
  2>/dev/null || echo "  Target may already exist, continuing..."

echo "  ✓ Target registered"

# ── Step 3: Synchronize tools ──
echo ""
echo "▸ Step 3: Synchronizing tool catalog..."

aws bedrock-agentcore synchronize-gateway-targets \
  --gateway-id "${GATEWAY_ID}" \
  --target-ids "kafka-mcp" \
  --region "${AWS_REGION}" \
  2>/dev/null || true

echo "  ✓ Tools synchronized (may take a few minutes to index)"

# ── Step 4: Get gateway endpoint ──
echo ""
echo "▸ Step 4: Gateway endpoint"

GATEWAY_ENDPOINT=$(aws bedrock-agentcore get-gateway \
  --gateway-id "${GATEWAY_ID}" \
  --region "${AWS_REGION}" \
  --query 'gatewayUrl' \
  --output text 2>/dev/null || echo "pending...")

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  Gateway Registration Complete                       ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║                                                      ║"
echo "║  Gateway ID:       ${GATEWAY_ID}"
echo "║  Gateway Endpoint: ${GATEWAY_ENDPOINT}"
echo "║                                                      ║"
echo "║  Your agent can now connect to this single endpoint  ║"
echo "║  to discover all Kafka tools via MCP.                ║"
echo "║                                                      ║"
echo "║  To add more MCP servers (Elastic, Couchbase):       ║"
echo "║  Run this script again with a different RUNTIME_ARN  ║"
echo "║  and target name to add them to the same gateway.    ║"
echo "║                                                      ║"
echo "║  Update your agent's .env:                           ║"
echo "║  KAFKA_MCP_URL=${GATEWAY_ENDPOINT}/mcp               ║"
echo "╚══════════════════════════════════════════════════════╝"

# Save gateway info
jq --arg gw "${GATEWAY_ID}" --arg ep "${GATEWAY_ENDPOINT}" \
  '. + {gatewayId: $gw, gatewayEndpoint: $ep}' \
  .agentcore-deployment.json > .agentcore-deployment.json.tmp && \
  mv .agentcore-deployment.json.tmp .agentcore-deployment.json

echo ""
echo "Gateway info saved to .agentcore-deployment.json"
