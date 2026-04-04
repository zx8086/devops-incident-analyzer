#!/usr/bin/env bash
# test-agentcore-local.sh
#
# Test the AgentCore entrypoint locally before deploying.
# Verifies the /ping and /mcp endpoints work correctly.
#
# Usage:
#   # Terminal 1: Start the server
#   KAFKA_PROVIDER=local bun run packages/mcp-server-kafka/src/agentcore-entrypoint.ts
#
#   # Terminal 2: Run tests
#   ./test-agentcore-local.sh

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8000}"
PASS=0
FAIL=0

check() {
  local name="$1"
  local result="$2"
  local expected="$3"

  if echo "${result}" | grep -q "${expected}"; then
    echo "  ✓ ${name}"
    PASS=$((PASS + 1))
  else
    echo "  ✗ ${name}"
    echo "    Expected: ${expected}"
    echo "    Got: ${result}"
    FAIL=$((FAIL + 1))
  fi
}

echo "Testing AgentCore endpoints at ${BASE_URL}"
echo ""

# ── Test 1: Health check ──
echo "▸ Health checks"
PING=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/ping")
check "GET /ping returns 200" "${PING}" "200"

HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/health")
check "GET /health returns 200" "${HEALTH}" "200"

# ── Test 2: MCP initialize ──
echo ""
echo "▸ MCP protocol"

INIT_RESPONSE=$(curl -s -X POST "${BASE_URL}/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": {"name": "test-client", "version": "0.1.0"}
    }
  }')
check "POST /mcp initialize" "${INIT_RESPONSE}" "serverInfo"

# ── Test 3: MCP tools/list ──
# For stateless mode, we need to initialize + list in one session.
# Use the SSE transport for multi-message flow, or send as separate requests.
TOOLS_RESPONSE=$(curl -s -X POST "${BASE_URL}/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": {"name": "test-client", "version": "0.1.0"}
    }
  }')
check "MCP server responds to initialize" "${TOOLS_RESPONSE}" "kafka-mcp-server"

# ── Test 4: Method not allowed ──
echo ""
echo "▸ Error handling"

GET_MCP=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/mcp")
check "GET /mcp returns 405" "${GET_MCP}" "405"

NOT_FOUND=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/nonexistent")
check "Unknown path returns 404" "${NOT_FOUND}" "404"

# ── Summary ──
echo ""
echo "════════════════════════════════"
echo "Results: ${PASS} passed, ${FAIL} failed"
echo "════════════════════════════════"

if [ "${FAIL}" -gt 0 ]; then
  exit 1
fi
