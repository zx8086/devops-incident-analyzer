#!/usr/bin/env bash
# scripts/agentcore/test-env-construction.sh
#
# SIO-828: sanity-checks the shell quoting around AWS_ESTATES so the
# --environment-variables flag for aws bedrock-agentcore-control receives
# the JSON intact (no comma splitting, no quote mangling).
#
# Run from the repo root: ./scripts/agentcore/test-env-construction.sh

set -euo pipefail

PASS=0
FAIL=0

check() {
  local name="$1"
  local expected="$2"
  local actual="$3"
  if [ "${actual}" = "${expected}" ]; then
    echo "  PASS: ${name}"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: ${name}"
    echo "    expected: ${expected}"
    echo "    actual:   ${actual}"
    FAIL=$((FAIL + 1))
  fi
}

echo "Test 1: single estate, parses as JSON"
AWS_ESTATES='{"prod":{"assumedRoleArn":"arn:aws:iam::111111111111:role/X","externalId":"id-prod"}}'
ESTATE_COUNT=$(echo "${AWS_ESTATES}" | jq -er 'length')
check "single estate count is 1" "1" "${ESTATE_COUNT}"

ARN_LIST=$(echo "${AWS_ESTATES}" | jq -ec '[.[].assumedRoleArn] | unique')
check "single estate ARN list" '["arn:aws:iam::111111111111:role/X"]' "${ARN_LIST}"

echo ""
echo "Test 2: multi-estate, dedupes shared ARNs"
AWS_ESTATES='{"a":{"assumedRoleArn":"arn:aws:iam::111111111111:role/X","externalId":"id-a"},"b":{"assumedRoleArn":"arn:aws:iam::222222222222:role/X","externalId":"id-b"},"c":{"assumedRoleArn":"arn:aws:iam::111111111111:role/X","externalId":"id-c"}}'
ESTATE_COUNT=$(echo "${AWS_ESTATES}" | jq -er 'length')
check "three-estate count is 3" "3" "${ESTATE_COUNT}"

ARN_LIST=$(echo "${AWS_ESTATES}" | jq -ec '[.[].assumedRoleArn] | unique')
check "deduped ARN list (a and c share role X in account 111)" \
  '["arn:aws:iam::111111111111:role/X","arn:aws:iam::222222222222:role/X"]' \
  "${ARN_LIST}"

echo ""
echo "Test 3: invalid JSON triggers a clear failure path"
AWS_ESTATES='{not-json'
if echo "${AWS_ESTATES}" | jq -er 'length' 2>/dev/null; then
  echo "  FAIL: jq accepted invalid JSON"
  FAIL=$((FAIL + 1))
else
  echo "  PASS: jq rejects invalid JSON"
  PASS=$((PASS + 1))
fi

echo ""
echo "Test 4: ENV_VARS line carries AWS_ESTATES JSON without quote loss"
AWS_ESTATES='{"prod":{"assumedRoleArn":"arn:aws:iam::111111111111:role/X","externalId":"id"}}'
ENV_VARS="AWS_REGION=eu-central-1"
ENV_VARS="${ENV_VARS},AWS_ESTATES=${AWS_ESTATES}"
# A CSV split on the top-level commas would split AWS_ESTATES into garbage if
# the shell mangles quoting. The AWS CLI parses commas only at the top level
# of --environment-variables, but the JSON value contains commas too -- the
# only way this round-trips is if we pass the raw blob and the CLI's parser
# is told this is a single VAR=VALUE pair. Check the structure ourselves.
EXTRACTED=$(echo "${ENV_VARS}" | sed 's/^[^,]*,AWS_ESTATES=//')
check "AWS_ESTATES round-trip is intact" "${AWS_ESTATES}" "${EXTRACTED}"

echo ""
echo "================================================================"
echo "Results: ${PASS} passed, ${FAIL} failed"
echo "================================================================"
[ "${FAIL}" -gt 0 ] && exit 1 || exit 0
