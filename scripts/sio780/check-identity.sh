#!/usr/bin/env bash
# SIO-780: probe every MCP server's /identity endpoint and verify
# role + fingerprint shape.
#
# Run with all MCP servers up (`bun run dev` in another shell).
# Exits 0 when every configured port returns its expected role and a
# 16-hex-char upstreamFingerprint; non-zero with a per-port FAIL line
# otherwise.
set -euo pipefail

declare -A EXPECTED_ROLES=(
    [9080]="elastic-mcp"
    [9081]="kafka-mcp"
    [9082]="couchbase-mcp"
    [9083]="konnect-mcp"
    [9084]="gitlab-mcp"
    [9085]="atlassian-mcp"
    [3001]="aws-proxy"
)

failures=0
for port in 9080 9081 9082 9083 9084 9085 3001; do
    expected="${EXPECTED_ROLES[$port]}"
    body=$(curl -s --max-time 2 "http://localhost:$port/identity" || echo '{}')
    role=$(echo "$body" | jq -r '.role // "MISSING"')
    fp=$(echo "$body" | jq -r '.upstreamFingerprint // "MISSING"')
    if [[ "$role" == "$expected" ]] && [[ "$fp" =~ ^[0-9a-f]{16}$ ]]; then
        echo "ok    port=$port role=$role fingerprint=$fp"
    else
        echo "FAIL  port=$port expected=$expected actual=$role fingerprint=$fp"
        failures=$((failures + 1))
    fi
done

exit "$failures"
