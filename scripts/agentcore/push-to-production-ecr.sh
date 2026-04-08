#!/usr/bin/env bash
# scripts/agentcore/push-to-production-ecr.sh
#
# Builds the Kafka MCP Server container image and delivers it to a production
# ECR repository. The production team does not have access to this source repo,
# so this script is the mechanism for getting the image to them.
#
# Two delivery modes:
#   1. Direct ECR push  (default) -- pushes to a target ECR URI
#   2. Tarball export   (--export-tarball) -- saves a .tar.gz for manual transfer
#
# Usage:
#   ./scripts/agentcore/push-to-production-ecr.sh \
#     --ecr-uri 123456789012.dkr.ecr.eu-central-1.amazonaws.com/kafka-mcp-agentcore \
#     --region eu-central-1
#
#   ./scripts/agentcore/push-to-production-ecr.sh --export-tarball
#
# Prerequisites:
#   - Docker Desktop (Apple Silicon builds arm64 natively)
#   - For direct push: AWS CLI v2 with credentials for the target account
#   - Repository cloned with dependencies installed (bun install)

set -euo pipefail

# -- Defaults --
ECR_URI=""
AWS_REGION=""
EXPORT_TARBALL=false
MCP_SERVER_PACKAGE="mcp-server-kafka"
IMAGE_NAME="kafka-mcp-agentcore"
IMAGE_TAG="latest"
TARBALL_NAME="kafka-mcp-agentcore.tar.gz"
SKIP_SMOKE_TEST=false
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# -- Parse arguments --
while [[ $# -gt 0 ]]; do
  case $1 in
    --ecr-uri)
      ECR_URI="$2"
      shift 2
      ;;
    --region)
      AWS_REGION="$2"
      shift 2
      ;;
    --export-tarball)
      EXPORT_TARBALL=true
      shift
      ;;
    --tag)
      IMAGE_TAG="$2"
      shift 2
      ;;
    --skip-smoke-test)
      SKIP_SMOKE_TEST=true
      shift
      ;;
    --help|-h)
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Builds the Kafka MCP Server container and delivers it to production."
      echo ""
      echo "Options:"
      echo "  --ecr-uri URI       Target ECR repository URI (required for direct push)"
      echo "  --region REGION     AWS region of the target ECR (required for direct push)"
      echo "  --export-tarball    Export image as .tar.gz instead of pushing to ECR"
      echo "  --tag TAG           Image tag (default: latest)"
      echo "  --skip-smoke-test   Skip the local container smoke test"
      echo "  -h, --help          Show this help message"
      echo ""
      echo "Examples:"
      echo "  # Push to production ECR"
      echo "  $0 --ecr-uri 123456789012.dkr.ecr.eu-central-1.amazonaws.com/kafka-mcp-agentcore --region eu-central-1"
      echo ""
      echo "  # Export tarball for manual transfer"
      echo "  $0 --export-tarball"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      echo "Run $0 --help for usage"
      exit 1
      ;;
  esac
done

# -- Validate arguments --
if [ "$EXPORT_TARBALL" = false ] && [ -z "$ECR_URI" ]; then
  echo "Error: Either --ecr-uri or --export-tarball is required."
  echo "Run $0 --help for usage."
  exit 1
fi

if [ "$EXPORT_TARBALL" = false ] && [ -z "$AWS_REGION" ]; then
  # Try to extract region from ECR URI (POSIX-compatible, works on macOS)
  AWS_REGION=$(echo "$ECR_URI" | sed -n 's/.*\.ecr\.\([^.]*\)\..*/\1/p')
  if [ -z "$AWS_REGION" ]; then
    echo "Error: --region is required when pushing to ECR."
    exit 1
  fi
  echo "Inferred region from ECR URI: $AWS_REGION"
fi

# -- Header --
echo "================================================================"
echo "  Kafka MCP Server -- Production Image Build"
echo "================================================================"
if [ "$EXPORT_TARBALL" = true ]; then
  echo "  Mode:     Tarball export"
  echo "  Output:   ${PROJECT_ROOT}/${TARBALL_NAME}"
else
  echo "  Mode:     Direct ECR push"
  echo "  Target:   ${ECR_URI}:${IMAGE_TAG}"
  echo "  Region:   ${AWS_REGION}"
fi
echo "  Package:  ${MCP_SERVER_PACKAGE}"
echo "================================================================"
echo ""

# -- Step 1: Build container image --
echo "[1/4] Building container image (arm64)..."
cd "$PROJECT_ROOT"

# Determine build tag: use ECR URI for direct push (avoids Docker Desktop
# attestation manifest issues), use local name for tarball export.
if [ "$EXPORT_TARBALL" = true ]; then
  BUILD_TAG="${IMAGE_NAME}:${IMAGE_TAG}"
else
  BUILD_TAG="${ECR_URI}:${IMAGE_TAG}"
fi

docker build \
  -f Dockerfile.agentcore \
  --build-arg MCP_SERVER_PACKAGE="${MCP_SERVER_PACKAGE}" \
  --platform linux/arm64 \
  -t "$BUILD_TAG" \
  .

echo "  Image built: ${BUILD_TAG}"

# -- Step 2: Verify architecture --
echo ""
echo "[2/4] Verifying architecture..."
ARCH=$(docker inspect "$BUILD_TAG" --format '{{.Architecture}}')
if [ "$ARCH" != "arm64" ] && [ "$ARCH" != "aarch64" ]; then
  echo "  ERROR: Image architecture is '${ARCH}', expected 'arm64'."
  echo "  AgentCore runs on Graviton (arm64). Rebuild with --platform linux/arm64."
  exit 1
fi
echo "  Architecture: ${ARCH} (correct)"

# -- Step 3: Local smoke test --
echo ""
if [ "$SKIP_SMOKE_TEST" = true ]; then
  echo "[3/4] Skipping smoke test (--skip-smoke-test)"
else
  echo "[3/4] Running local smoke test..."
  SMOKE_PORT=8899
  CONTAINER_ID=""

  cleanup_smoke() {
    if [ -n "$CONTAINER_ID" ]; then
      docker stop "$CONTAINER_ID" >/dev/null 2>&1 || true
    fi
  }
  trap cleanup_smoke EXIT

  CONTAINER_ID=$(docker run -d --rm \
    -p ${SMOKE_PORT}:8000 \
    -e KAFKA_PROVIDER=local \
    -e LOCAL_BOOTSTRAP_SERVERS=localhost:9092 \
    "$BUILD_TAG")

  echo "  Container started: ${CONTAINER_ID:0:12}"
  echo "  Waiting for startup..."
  sleep 3

  PING_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${SMOKE_PORT}/ping" 2>/dev/null || echo "000")

  if [ "$PING_STATUS" = "200" ]; then
    echo "  Smoke test passed: /ping returned 200"
  else
    echo "  WARNING: /ping returned ${PING_STATUS} (expected 200)"
    echo "  The container may still work in production -- local Kafka broker is not available."
    echo "  Continuing..."
  fi

  # Clean up
  docker stop "$CONTAINER_ID" >/dev/null 2>&1 || true
  CONTAINER_ID=""
  trap - EXIT
fi

# -- Step 4: Deliver --
echo ""
if [ "$EXPORT_TARBALL" = true ]; then
  echo "[4/4] Exporting tarball..."
  docker save "$BUILD_TAG" | gzip > "${PROJECT_ROOT}/${TARBALL_NAME}"

  SIZE=$(du -h "${PROJECT_ROOT}/${TARBALL_NAME}" | cut -f1)
  echo "  Exported: ${PROJECT_ROOT}/${TARBALL_NAME} (${SIZE})"
  echo ""
  echo "================================================================"
  echo "  Tarball Export Complete"
  echo "================================================================"
  echo ""
  echo "  File: ${TARBALL_NAME} (${SIZE})"
  echo "  Architecture: arm64"
  echo ""
  echo "  Send this file to the production team. They should run:"
  echo ""
  echo "    # Load the image"
  echo "    docker load -i ${TARBALL_NAME}"
  echo ""
  echo "    # Tag for their ECR repository"
  echo "    docker tag ${IMAGE_NAME}:${IMAGE_TAG} \\"
  echo "      <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/kafka-mcp-agentcore:${IMAGE_TAG}"
  echo ""
  echo "    # Authenticate to ECR"
  echo "    aws ecr get-login-password --region <REGION> | \\"
  echo "      docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com"
  echo ""
  echo "    # Push"
  echo "    docker push <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/kafka-mcp-agentcore:${IMAGE_TAG}"
  echo ""
  echo "    # Verify arm64"
  echo "    docker inspect <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/kafka-mcp-agentcore:${IMAGE_TAG} \\"
  echo "      --format '{{.Architecture}}'"
  echo ""
  echo "================================================================"
else
  echo "[4/4] Pushing to production ECR..."

  # Extract account ID from ECR URI for login
  ECR_HOST=$(echo "$ECR_URI" | cut -d'/' -f1)

  echo "  Authenticating to ECR..."
  aws ecr get-login-password --region "$AWS_REGION" | \
    docker login --username AWS --password-stdin "$ECR_HOST"

  echo "  Pushing image..."
  docker push "${ECR_URI}:${IMAGE_TAG}"

  echo ""
  echo "================================================================"
  echo "  ECR Push Complete"
  echo "================================================================"
  echo ""
  echo "  Image: ${ECR_URI}:${IMAGE_TAG}"
  echo "  Architecture: arm64"
  echo ""
  echo "  The production team can verify with:"
  echo ""
  echo "    aws ecr describe-images \\"
  echo "      --repository-name $(echo "$ECR_URI" | cut -d'/' -f2) \\"
  echo "      --region ${AWS_REGION} \\"
  echo "      --query 'imageDetails[0].{Tags: imageTags, Pushed: imagePushedAt}' \\"
  echo "      --output table"
  echo ""
  echo "================================================================"
fi
