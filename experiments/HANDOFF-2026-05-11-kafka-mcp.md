# Handoff: 2026-05-11 — Kafka MCP outstanding work

## TL;DR

Four open Kafka-MCP-related items. **One is the blocker; everything else is downstream of it.**

1. **SIO-716 (Urgent, Todo, OTHER TEAM):** AgentCore Kafka MCP runtime points at *dev* Confluent endpoints; c72 is *prod*. Until env vars on `kafka_mcp_server-sCQa486nea` flip from `*.dev` to `*.prd`, every ksql/connect/SR/restproxy tool call against c72 returns nginx 503 from an empty dev upstream pool. **The prd Confluent stack is healthy** (Elastic synthetic `b40a84fc-82ba-412c-bf82-faf828a946fd` reports UP). Fix is a runtime env-var change + redeploy, owned by the platform team.
2. **SIO-717 (High, In Review, ME):** Kafka sub-agent reporting-discipline rules + synthetic-monitor cross-check. Merged in PR #68. End-to-end validation blocked on SIO-716 (cross-check rule only fires when a Confluent hostname is in a tool error, and today's 503 nginx page doesn't include the hostname; once SIO-716 ships and 503s stop entirely, the happy path is dormant by design).
3. **SIO-723 (High, In Review, ME):** Inferred-from-MSK-offsets disclaimer rule for connect-*/ksqlDB consumer groups. Merged in PR #70. End-to-end validation also blocked on SIO-716 for the same reason.
4. **SIO-700 follow-up (no ticket yet, low priority):** the `listOffsets` two-partitionIndex workaround at `kafka-service.ts:67` may be retirable now that `@platformatic/kafka` v2 is on disk. v2 release notes don't mention it explicitly. Worth a 30-minute investigation when convenient.

Net: there is **no Kafka MCP code work** required from this side until SIO-716 ships. The right thing to do is wait, then re-run the c72 prompt and confirm SIO-717 + SIO-723 fire correctly in the happy path.

## Detail per item

### SIO-716 — env-var fix on AgentCore runtime [Urgent, Todo]

**Owner:** platform / shared-services team (not us).

**Change set** (on AgentCore runtime `kafka_mcp_server-sCQa486nea` v3):

| Var | Wrong | Right |
|---|---|---|
| `KSQL_ENDPOINT` | `https://ksql.dev.shared-services.eu.pvh.cloud` | `https://ksql.prd.shared-services.eu.pvh.cloud` |
| `CONNECT_URL` | `https://connect.dev.shared-services.eu.pvh.cloud` | `https://connect.prd.shared-services.eu.pvh.cloud` |
| `SCHEMA_REGISTRY_URL` | `https://schemaregistry.dev.shared-services.eu.pvh.cloud` | `https://schemaregistry.prd.shared-services.eu.pvh.cloud` |
| `RESTPROXY_URL` | `https://restproxy.dev.shared-services.eu.pvh.cloud` | `https://restproxy.prd.shared-services.eu.pvh.cloud` |

Other env vars (`KAFKA_PROVIDER=msk`, `MSK_CLUSTER_ARN`, all `*_ENABLED` flags, `KAFKA_ALLOW_WRITES`, `KAFKA_ALLOW_DESTRUCTIVE`, VPC config) remain unchanged.

**Risk to flag with platform team:** check that the **prd** Confluent stack accepts traffic from the AgentCore VPC (`vpc-0371924050ed73be6`, subnets `subnet-008fdfcbdf99f101f`, `subnet-023195c620d64e604`, `subnet-08db5f7ef30921c36`, SG `sg-0d9c3c6d6e16bc6fa`). If cross-VPC routing differs between dev and prd, this becomes a network ask, not a config flip. The current `c72-shared-services-msk` MSK is in account `352896877281` while the Confluent prd stack lives in `399987695868` — see memory `reference_confluent_prd_ecs_topology.md` for the cross-account gap discovered during this investigation.

**Auth:** if prd Confluent services require API keys (`KSQL_API_KEY/SECRET`, `CONNECT_API_KEY/SECRET`, etc.), set those too. The Kafka MCP supports them but they're not on the runtime today.

**Verification (run after platform redeploys):**
1. Restart the local Kafka MCP SigV4 proxy on `localhost:3000` so it picks up the new runtime version.
2. Through the proxy, POST:
   - `ksql_get_server_info` → expect 200-body JSON with `ksqlServiceId`, real version
   - `connect_get_cluster_info` → expect 200-body JSON with `version`, `kafka_cluster_id`
   - `kafka_list_schemas` → expect non-empty subject list
   - `restproxy_list_topics` → expect 200 body
3. Re-run the c72 Kafka health prompt through the agent UI. Confirm: real ksqlDB/Connect/SR data, no 503s, final confidence ≥ 0.78.

Once those probes pass, SIO-716 can be marked Done; that automatically unblocks SIO-717 and SIO-723 validation below.

### SIO-717 — reporting discipline + synthetic cross-check [High, In Review, code merged]

Code lives on main as of PR #68. Three new correlation rules in `packages/agent/src/correlation/rules.ts` (`ksqldb-unresponsive-task`, `connect-service-unavailable`, `infra-service-degraded-needs-synthetic-cross-check`) plus reporting-discipline rules in `agents/incident-analyzer/agents/kafka-agent/SOUL.md`.

**Why it's still In Review, not Done:** the synthetic cross-check rule requires a Confluent hostname inside the tool-error body to fire. The nginx 503 page doesn't include the hostname (just the generic `503 Service Temporarily Unavailable` HTML), so today's c72 traffic doesn't exercise that rule path even though the prompt-side rules (1, 2) are exercised.

**Two ways forward:**
- **Wait on SIO-716**, then re-run c72. With prd endpoints, no 503s happen, the cross-check rule stays dormant by design (happy path), the prompt-side rules continue to apply. Mark Done.
- **Optional belt-and-braces (small follow-up):** propagate the configured upstream hostname into the Kafka MCP error-wrapping format so the cross-check rule has something to match on under future 503 scenarios. Touches 4 files (`packages/mcp-server-kafka/src/services/ksql-service.ts`, `connect-service.ts`, `schema-registry-service.ts`, `restproxy-service.ts`) — change each thrown error to include the hostname in the message string, then update the regex in `extractConfluentHostname()` if needed.

### SIO-723 — inferred-from-MSK-offsets disclaimer [High, In Review, code merged]

Code lives on main as of PR #70. The kafka-agent SOUL.md now requires a disclaimer keyword (`inferred` / `MSK offset state` / `unverifiable while` / `cannot confirm`) when Connect/ksqlDB REST is 5xx-ing and `connect-*` / `_confluent-ksql-default_query_*` group names appear in the report. The `inferred-confluent-groups-need-disclaimer` correlation rule caps confidence at 0.59 when the disclaimer is missing.

**Why still In Review:** SIO-716 hasn't shipped, so the only way to actually exercise this rule today is the misleading-dev-503 path — which is exactly what SIO-716 fixes. Validation needs:
- Pre-SIO-716 (anytime now): trigger the rule by running c72 health, confirm the report either includes the disclaimer (rule passes) OR gets confidence-capped (rule fires correctly).
- Post-SIO-716: confirm the rule is silent on the happy path (Connect REST 200, so trigger predicate returns null).

The first half can be validated **today** without waiting on the other team — re-run the c72 prompt and read the report. If it includes the new disclaimer language, SIO-723 is effectively done.

### SIO-700 follow-up — retire the listOffsets workaround? [no ticket, low priority]

Context: `packages/mcp-server-kafka/src/services/kafka-service.ts:67` works around a `@platformatic/kafka` v1 bug where `listOffsets` threw "Listing offsets failed." when given two partition entries with the same `partitionIndex` (one `EARLIEST` + one `LATEST`). Our workaround issues two single-timestamp calls instead.

`@platformatic/kafka` v2.0.1 (now on main as of SIO-724) doesn't mention this fix in release notes, but the release-note coverage was thin. Worth:
1. Write a small repro script that uses `admin.listOffsets()` with two same-partitionIndex entries against any MSK cluster (no production access needed; local Bun script with the connection to c72).
2. If v2 handles it correctly, simplify `getPartitionOffsetBounds()` to a single call with two partitions in the request, removing the `Promise.all` of two single-call awaits.
3. File a ticket only if the simplification is real — otherwise just leave a comment update on the workaround noting v2 still requires it.

Time: 30 minutes for someone with c72 broker access. Pure simplification; no behaviour change either way.

## Cross-references

- Main investigation handoff: `experiments/HANDOFF-2026-05-11-sio-716-717-718.md` (this file is a sibling for the Kafka-MCP-specific follow-ups)
- SIO-718 (proxy log shape): Done. Both initial (PR #68/#69) and follow-up polish (PR #70) merged.
- SIO-724 (dependency bumps incl. `@platformatic/kafka` v2): Done. PR #71. v2 verified against live c72 MSK via SigV4 proxy on 2026-05-11.
- Memory: `reference_confluent_prd_ecs_topology.md`, `reference_network_ask_agentcore_to_confluent.md`, `feedback_probe_agentcore_via_sigv4_proxy.md`, `reference_kafka_mcp_agentcore_ksql_disabled.md`

## What I'd recommend the next session do

1. **Check if SIO-716 has moved.** If yes → run the verification steps above, then mark SIO-717 + SIO-723 Done (with user approval).
2. **If SIO-716 still Todo:** validate SIO-723's disclaimer path today using the current (still-503) traffic — re-run c72 and confirm the kafka-agent report contains the required disclaimer keywords OR the correlation rule fires and caps confidence. That's enough to mark SIO-723 Done independently of SIO-716; only SIO-717's *synthetic cross-check* is hard-blocked.
3. **Don't touch the SIO-700 retirement** until the higher-priority items are clear. Pure optimization.

## Gotchas

- The Kafka MCP SigV4 proxy on `localhost:3000` is the ground-truth probe surface. Use `curl -X POST http://127.0.0.1:3000/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{...JSON-RPC...}'` rather than reading LangSmith traces. Memory: `feedback_probe_agentcore_via_sigv4_proxy.md`.
- `bun --hot` does NOT re-resolve `node_modules`. After any dependency change, the running Kafka MCP process must be **fully restarted** (Ctrl-C + re-run), not just hot-reloaded. Found the hard way during SIO-724 validation.
- The proxy log line is now single-status-field (`Tool call proxied: <tool> -> <status>`); the old `outer=200 inner=...` vocabulary is gone as of SIO-718 PR #70. If you see anything reference "inner/outer", it predates this work.
