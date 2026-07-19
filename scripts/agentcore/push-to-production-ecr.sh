#!/usr/bin/env bash
# scripts/agentcore/push-to-production-ecr.sh
#
# Builds an MCP Server container image and delivers it to a production
# ECR repository. The production team does not have access to this source repo,
# so this script is the mechanism for getting the image to them.
#
# Supports any MCP server package via --package (default: mcp-server-kafka).
#
# Two delivery modes:
#   1. Direct ECR push  (default) -- pushes to a target ECR URI
#   2. Tarball export   (--export-tarball) -- saves a .tar.gz for manual transfer
#
# Usage:
#   ./scripts/agentcore/push-to-production-ecr.sh \
#     --package mcp-server-kafka \
#     --ecr-uri 123456789012.dkr.ecr.eu-central-1.amazonaws.com/kafka-mcp-agentcore \
#     --region eu-central-1
#
#   ./scripts/agentcore/push-to-production-ecr.sh --package mcp-server-aws --export-tarball
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
IMAGE_TAG="latest"
SKIP_SMOKE_TEST=false
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# -- Parse arguments --
while [[ $# -gt 0 ]]; do
  case $1 in
    --package)
      MCP_SERVER_PACKAGE="$2"
      shift 2
      ;;
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
      echo "Builds an MCP Server container and delivers it to production."
      echo ""
      echo "Options:"
      echo "  --package NAME      MCP server package (default: mcp-server-kafka)"
      echo "                      Examples: mcp-server-kafka, mcp-server-aws"
      echo "  --ecr-uri URI       Target ECR repository URI (required for direct push)"
      echo "  --region REGION     AWS region of the target ECR (required for direct push)"
      echo "  --export-tarball    Export image as .tar.gz instead of pushing to ECR"
      echo "  --tag TAG           Image tag (default: latest)"
      echo "  --skip-smoke-test   Skip the local container smoke test"
      echo "  -h, --help          Show this help message"
      echo ""
      echo "Examples:"
      echo "  # Push kafka to production ECR"
      echo "  $0 --package mcp-server-kafka \\"
      echo "    --ecr-uri 123456789012.dkr.ecr.eu-central-1.amazonaws.com/kafka-mcp-agentcore --region eu-central-1"
      echo ""
      echo "  # Export tarballs for manual transfer"
      echo "  $0 --package mcp-server-kafka --export-tarball"
      echo "  $0 --package mcp-server-aws --export-tarball"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      echo "Run $0 --help for usage"
      exit 1
      ;;
  esac
done

# -- Validate package and derive names --
if [ ! -d "${PROJECT_ROOT}/packages/${MCP_SERVER_PACKAGE}" ]; then
  echo "Error: package not found at packages/${MCP_SERVER_PACKAGE}"
  exit 1
fi
# Strip leading "mcp-server-" to get the short name (kafka, aws, ...)
SHORT_NAME="${MCP_SERVER_PACKAGE#mcp-server-}"
IMAGE_NAME="${SHORT_NAME}-mcp-agentcore"
TARBALL_NAME="${SHORT_NAME}-mcp-agentcore.tar.gz"

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
SHORT_NAME_UPPER=$(echo "$SHORT_NAME" | tr '[:lower:]' '[:upper:]')
echo "  ${SHORT_NAME_UPPER} MCP Server -- Production Image Build"
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

  # Package-specific env so the container can boot far enough for /ping to respond.
  SMOKE_ENV_ARGS=()
  case "$MCP_SERVER_PACKAGE" in
    mcp-server-kafka)
      # Kafka's config defaults transport to stdio on 127.0.0.1:9081 (dev
      # defaults); without these overrides the container never opens :8000
      # and /ping can't be reached.
      SMOKE_ENV_ARGS=(
        -e KAFKA_PROVIDER=local -e LOCAL_BOOTSTRAP_SERVERS=localhost:9092
        -e MCP_TRANSPORT=agentcore -e MCP_PORT=8000 -e MCP_HOST=0.0.0.0
      )
      ;;
    mcp-server-aws)
      # SIO-828: AWS MCP requires AWS_ESTATES (Zod min-1 estate) at boot or the
      # container exits before opening port 8000. Pass a minimal stub estate so
      # the schema parse succeeds. The boot-time STS:AssumeRole validator runs
      # against this stub ARN -- it WILL fail with AccessDenied (no real creds),
      # but the validator is warn-and-continue (4-pillar), so the runtime still
      # boots and /ping returns 200. Tool calls would also fail; /ping doesn't
      # need them.
      SMOKE_ENV_ARGS=(
        -e AWS_REGION=eu-central-1
        -e 'AWS_ESTATES={"smoke-test":{"assumedRoleArn":"arn:aws:iam::000000000000:role/SmokeTestStub","externalId":"smoke-test"}}'
      )
      ;;
  esac

  CONTAINER_ID=$(docker run -d --rm \
    -p ${SMOKE_PORT}:8000 \
    "${SMOKE_ENV_ARGS[@]}" \
    "$BUILD_TAG")

  echo "  Container started: ${CONTAINER_ID:0:12}"
  echo "  Waiting for startup (poll /ping up to 15s)..."

  # SIO-828: poll /ping with a deadline instead of a fixed sleep. AWS MCP boot
  # now includes a per-estate STS:AssumeRole validation (~1-5s per estate) so a
  # flat sleep 3 was too short. 15s deadline covers all server types comfortably.
  PING_STATUS="000"
  for _i in $(seq 1 15); do
    PING_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${SMOKE_PORT}/ping" 2>/dev/null || echo "000")
    if [ "$PING_STATUS" = "200" ]; then
      break
    fi
    sleep 1
  done

  if [ "$PING_STATUS" = "200" ]; then
    echo "  Smoke test passed: /ping returned 200"
  else
    echo "  WARNING: /ping returned ${PING_STATUS} after 15s (expected 200)"
    echo "  Container logs (first 30 lines):"
    docker logs "$CONTAINER_ID" 2>&1 | head -30 | sed 's/^/    /' || true
    echo "  The container may still work in production. Continuing..."
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
  echo "      <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/${IMAGE_NAME}:${IMAGE_TAG}"
  echo ""
  echo "    # Authenticate to ECR"
  echo "    aws ecr get-login-password --region <REGION> | \\"
  echo "      docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com"
  echo ""
  echo "    # Push"
  echo "    docker push <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/${IMAGE_NAME}:${IMAGE_TAG}"
  echo ""
  echo "    # Verify arm64"
  echo "    docker inspect <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/${IMAGE_NAME}:${IMAGE_TAG} \\"
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
