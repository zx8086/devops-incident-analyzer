#!/usr/bin/env bash
# SIO-780: probe every MCP server's /ready endpoint and report status.
#
# Run with all MCP servers up (`bun run dev` in another shell).
# Each port should return either:
#   - ready=true (component map all "ok")
#   - ready=false (one or more upstream components degraded; operator's call)
# A missing or malformed body counts as FAIL and exits non-zero.
set -euo pipefail
failures=0
for port in 9080 9081 9082 9083 9084 9085 3001; do
	body=$(curl -s --max-time 8 "http://localhost:$port/ready" || echo '{}')
	ready=$(echo "$body" | jq -r '.ready // "MISSING"')
	if [[ "$ready" == "true" ]]; then
		echo "ok    port=$port ready=true"
	elif [[ "$ready" == "false" ]]; then
		errs=$(echo "$body" | jq -c '.errors // {}')
		echo "WARN  port=$port ready=false errors=$errs"
	else
		echo "FAIL  port=$port no ready field"
		failures=$((failures + 1))
	fi
done
exit "$failures"
