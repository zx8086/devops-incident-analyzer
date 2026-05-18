# SIO-701 — Apply KafkaMcpFullCoverage policy to kafka-mcp-agentcore-role-dev

**Status:** ready to apply (policy JSON staged at `/tmp/kafka-mcp-full-policy.json`).
**Cross-account:** the role lives in AWS account `352896877281`. Your usual shell is in `356994971776` and cannot apply this — assume a role with `iam:PutRolePolicy` in the target account, or hand off to whoever owns it.

## Pre-flight

```bash
# From credentials in 352896877281
aws iam list-attached-role-policies --role-name kafka-mcp-agentcore-role-dev
aws iam list-role-policies --role-name kafka-mcp-agentcore-role-dev
```

## Apply

```bash
aws iam put-role-policy \
  --role-name kafka-mcp-agentcore-role-dev \
  --policy-name KafkaMcpFullCoverage \
  --policy-document file:///tmp/kafka-mcp-full-policy.json
```

If `/tmp/kafka-mcp-full-policy.json` is gone (session rotated), regenerate it from the ticket body at https://linear.app/siobytes/issue/SIO-701. The JSON is also pinned in this branch's Linear update for posterity.

## Verify (gap closes)

```bash
# Should return cluster metadata WITHOUT an awsError field.
curl -sN -X POST http://localhost:3000/mcp \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"kafka_get_cluster_info","arguments":{}}}' \
  | sed -n 's/^data: //p' | jq -r '.result.content[0].text' \
  | jq '.awsError // "no awsError -- IAM gap closed"'
```

Expected output **before** fix:
```
"User: arn:aws:sts::352896877281:assumed-role/kafka-mcp-agentcore-role-dev/... is not authorized to perform: kafka:DescribeClusterV2 ..."
```

Expected output **after** fix:
```
"no awsError -- IAM gap closed"
```

## Verify (no regression)

```bash
# kafka_describe_cluster should still report broker count 3 with controller ID present.
curl -sN -X POST http://localhost:3000/mcp \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"kafka_describe_cluster","arguments":{}}}' \
  | sed -n 's/^data: //p' | jq '.result.content[0].text' | jq -r 'fromjson | {brokers, controllerId}'
```

Expect `{"brokers": 3, "controllerId": <int>}` (or shape compatible with what the run produced 2026-05-10 pre-fix — the 7 working data-plane tools confirm the data-plane permissions remain).

## Acceptance

Per the ticket:

- [ ] `KafkaMcpFullCoverage` inline policy attached
- [ ] `kafka_get_cluster_info` returns metadata with no `awsError` field
- [ ] `kafka_describe_cluster` continues to return broker count 3 with controller ID present
- [ ] Write/destructive tools verified in non-production (deferred — separate validation pass)

After acceptance, paste both verification outputs into the SIO-701 Linear ticket comment thread. **Do not set the ticket to Done** without explicit user approval (per CLAUDE.md).

## Out of scope

- KSQL_*, SCHEMA_REGISTRY_*, CONNECT_*, RESTPROXY_* env-var forwarding — that's SIO-680, separate `deploy.sh` re-run.
- Cross-account network reachability to the Confluent Platform internal ALB — SIO-683.
- Multi-cluster support — this policy is scoped to `c72-shared-services-msk`. Adding another cluster requires duplicating the resource-scoped statements with the new cluster ARN.
