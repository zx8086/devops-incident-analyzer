#!/usr/bin/env bash
# scripts/agentcore/test-local.sh
#
# Tests AgentCore-compatible endpoints locally before deployment.
#
# Prerequisites (run in another terminal first):
#   MCP_TRANSPORT=agentcore KAFKA_PROVIDER=local bun run packages/mcp-server-kafka/src/index.ts
#   MCP_TRANSPORT=agentcore ELASTICSEARCH_URL=http://localhost:9200 bun run packages/mcp-server-elastic/src/index.ts
#   MCP_TRANSPORT=agentcore CB_HOSTNAME=localhost bun run packages/mcp-server-couchbase/src/index.ts
#   MCP_TRANSPORT=agentcore KONNECT_ACCESS_TOKEN=test bun run packages/mcp-server-konnect/src/index.ts
#
# Or test via Docker:
#   docker run --rm -p 8000:8000 -e KAFKA_PROVIDER=local kafka-mcp-agentcore
#
# Usage:
#   ./scripts/agentcore/test-local.sh                              # Tests kafka (default)
#   MCP_SERVER=elastic ./scripts/agentcore/test-local.sh           # Tests elastic
#   MCP_SERVER=couchbase ./scripts/agentcore/test-local.sh         # Tests couchbase
#   MCP_SERVER=konnect ./scripts/agentcore/test-local.sh           # Tests konnect
#   BASE_URL=http://localhost:9000 ./scripts/agentcore/test-local.sh

set -euo pipefail

MCP_SERVER="${MCP_SERVER:-kafka}"
BASE_URL="${BASE_URL:-http://localhost:8000}"
EXPECTED_SERVER_NAME="${MCP_SERVER}-mcp-server"
PASS=0
FAIL=0

check() {
  local name="$1"
  local expected="$2"
  local actual="$3"

  if echo "${actual}" | grep -q "${expected}"; then
    echo "  PASS: ${name}"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: ${name}"
    echo "    Expected: ${expected}"
    echo "    Got:      ${actual}"
    FAIL=$((FAIL + 1))
  fi
}

echo "Testing AgentCore endpoints for ${MCP_SERVER} at ${BASE_URL}"
echo "================================================================"
echo ""

# -- Health checks --
echo "Health checks:"

PING=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/ping")
check "GET /ping returns 200" "200" "${PING}"

HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/health")
check "GET /health returns 200" "200" "${HEALTH}"

# -- MCP protocol --
echo ""
echo "MCP protocol:"

MCP_INIT=$(curl -s -X POST "${BASE_URL}/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": { "name": "test-client", "version": "1.0.0" }
    }
  }')
check "POST /mcp initialize returns serverInfo" "serverInfo" "${MCP_INIT}"
check "POST /mcp server identifies as ${EXPECTED_SERVER_NAME}" "${EXPECTED_SERVER_NAME}" "${MCP_INIT}"

# -- Error handling --
echo ""
echo "Error handling:"

MCP_GET=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/mcp")
check "GET /mcp returns 405" "405" "${MCP_GET}"

NOT_FOUND=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/nonexistent")
check "Unknown path returns 404" "404" "${NOT_FOUND}"

# -- Summary --
echo ""
echo "================================================================"
echo "Results: ${PASS} passed, ${FAIL} failed"
echo "================================================================"

if [ "${FAIL}" -gt 0 ]; then
  exit 1
fi
