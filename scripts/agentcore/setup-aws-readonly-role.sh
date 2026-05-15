#!/usr/bin/env bash
# scripts/agentcore/setup-aws-readonly-role.sh
#
# Creates (or updates) the DevOpsAgentReadOnly IAM role in the current
# AWS account with the 11-statement read-only inventory policy attached.
# Idempotent: re-running updates the policy and trust document in place.
#
# Prerequisites:
#   - AWS CLI v2 configured with credentials that can create IAM roles
#     and managed policies in the target account
#   - jq installed
#
# Usage:
#   # Production trust (AgentCore execution role only):
#   ./scripts/agentcore/setup-aws-readonly-role.sh
#
#   # Phase 1 verification trust (AgentCore role + dev principal):
#   TRUST_POLICY_FILE=scripts/agentcore/policies/devops-agent-readonly-trust-policy-phase1.json \
#     ./scripts/agentcore/setup-aws-readonly-role.sh
#
# Environment variables:
#   AWS_REGION         - AWS region for the aws cli calls (default: eu-central-1)
#   ROLE_NAME          - Role name (default: DevOpsAgentReadOnly)
#   POLICY_NAME        - Managed policy name (default: DevOpsAgentReadOnlyPolicy)
#   POLICY_FILE        - Path to the permissions policy document
#                        (default: scripts/agentcore/policies/devops-agent-readonly-policy.json)
#   TRUST_POLICY_FILE  - Path to the trust policy document
#                        (default: scripts/agentcore/policies/devops-agent-readonly-trust-policy.json)

set -euo pipefail

AWS_REGION="${AWS_REGION:-eu-central-1}"
ROLE_NAME="${ROLE_NAME:-DevOpsAgentReadOnly}"
POLICY_NAME="${POLICY_NAME:-DevOpsAgentReadOnlyPolicy}"
POLICY_FILE="${POLICY_FILE:-scripts/agentcore/policies/devops-agent-readonly-policy.json}"
TRUST_POLICY_FILE="${TRUST_POLICY_FILE:-scripts/agentcore/policies/devops-agent-readonly-trust-policy.json}"

# -- Validation --
if [ ! -f "${POLICY_FILE}" ]; then
  echo "Error: permissions policy file not found at ${POLICY_FILE}"
  exit 1
fi
if [ ! -f "${TRUST_POLICY_FILE}" ]; then
  echo "Error: trust policy file not found at ${TRUST_POLICY_FILE}"
  exit 1
fi
if ! jq '.' "${POLICY_FILE}" >/dev/null 2>&1; then
  echo "Error: permissions policy at ${POLICY_FILE} is not valid JSON"
  exit 1
fi
if ! jq '.' "${TRUST_POLICY_FILE}" >/dev/null 2>&1; then
  echo "Error: trust policy at ${TRUST_POLICY_FILE} is not valid JSON"
  exit 1
fi

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${POLICY_NAME}"
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"

echo "================================================================"
echo "  DevOpsAgentReadOnly IAM Setup"
echo "================================================================"
echo "  Account:       ${ACCOUNT_ID}"
echo "  Region:        ${AWS_REGION}"
echo "  Role name:     ${ROLE_NAME}"
echo "  Policy name:   ${POLICY_NAME}"
echo "  Policy file:   ${POLICY_FILE}"
echo "  Trust file:    ${TRUST_POLICY_FILE}"
echo "================================================================"
echo ""

# -- Step 1: Create or update the managed policy --
echo "[1/3] Permissions policy..."
if aws iam get-policy --policy-arn "${POLICY_ARN}" >/dev/null 2>&1; then
  echo "  Policy exists, creating new default version..."
  # Trim old non-default versions to stay under the 5-version IAM limit.
  OLD_VERSIONS=$(aws iam list-policy-versions \
    --policy-arn "${POLICY_ARN}" \
    --query 'Versions[?!IsDefaultVersion].VersionId' \
    --output text)
  for v in ${OLD_VERSIONS}; do
    aws iam delete-policy-version --policy-arn "${POLICY_ARN}" --version-id "${v}" >/dev/null 2>&1 || true
  done
  aws iam create-policy-version \
    --policy-arn "${POLICY_ARN}" \
    --policy-document "file://${POLICY_FILE}" \
    --set-as-default >/dev/null
  echo "  Policy updated: ${POLICY_ARN}"
else
  aws iam create-policy \
    --policy-name "${POLICY_NAME}" \
    --policy-document "file://${POLICY_FILE}" \
    --description "Read-only inventory access for the DevOps Incident Analyzer (see docs/superpowers/specs/2026-05-15-aws-datasource-design.md)" >/dev/null
  echo "  Policy created: ${POLICY_ARN}"
fi

# -- Step 2: Create or update the role --
echo ""
echo "[2/3] Role..."
if aws iam get-role --role-name "${ROLE_NAME}" >/dev/null 2>&1; then
  echo "  Role exists, updating trust policy..."
  aws iam update-assume-role-policy \
    --role-name "${ROLE_NAME}" \
    --policy-document "file://${TRUST_POLICY_FILE}"
  echo "  Trust policy updated"
else
  aws iam create-role \
    --role-name "${ROLE_NAME}" \
    --assume-role-policy-document "file://${TRUST_POLICY_FILE}" \
    --description "Read-only inventory role assumed by the AWS MCP AgentCore container (see docs/superpowers/specs/2026-05-15-aws-datasource-design.md)" >/dev/null
  echo "  Role created: ${ROLE_ARN}"
fi

# -- Step 3: Attach the policy --
echo ""
echo "[3/3] Attaching policy to role..."
aws iam attach-role-policy \
  --role-name "${ROLE_NAME}" \
  --policy-arn "${POLICY_ARN}" 2>/dev/null || true
echo "  Policy attached"

# IAM is eventually consistent; new roles take a moment to be assumable.
echo ""
echo "  Waiting for IAM consistency (10s)..."
sleep 10

echo ""
echo "================================================================"
echo "  Setup complete"
echo "================================================================"
echo ""
echo "  Role ARN:   ${ROLE_ARN}"
echo "  Policy ARN: ${POLICY_ARN}"
echo ""
echo "  Verify with:"
echo "    aws sts assume-role \\"
echo "      --role-arn ${ROLE_ARN} \\"
echo "      --role-session-name verify-readonly \\"
echo "      --external-id aws-mcp-readonly-2026"
echo ""
echo "================================================================"
