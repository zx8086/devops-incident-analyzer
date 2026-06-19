# Runtime context

Seed file. The agent appends/updates here.

## in-flight

- eu-b2b: Wave 2 ILM acceleration merged (MR !29); !2a synthetics import + tier queued; Wave 3 hot 15→8 GB downsize gated on `.alerts` unmanaged fix; cold-tier heap watch (0156 83%, 0141 74% + 1 old GC).
- eu-b2b: ML node instance-0000000123 degraded (1 GB RAM) — pending Elastic Cloud support.
- eu-cld: orphan ILM policy `otel-transaction-metrics-30d` pending delete (verified safe); dead data stream audit (Apr 17 list partially stale).
- eu-cld: Fleet agent policy migration in flight (Basic Agents ~35%, Citrix ~25%, Warehouse ~14%).
- eu-cld: WebSphere `process.command_line` secret exposure — forward redaction deployed via logs@custom; historical logs still exposed, rotate creds.
- us-cld: Mulesoft v6→v8 reindex cutover in progress (v7 scrapped); 9-step handover plan; v8 indexing on instance-213.
- us-cld: entire mulesoft-aggregations pipeline dormant 67+ days (14 transforms stopped since 2026-03-22, no alert).
- us-cld: Linux metrics filtering deferred (system.diskio/filesystem/network on 6 policies, ~4-6M docs/day).
- us-cld: Enterprise Search stuck data streams (2 shards, 0 docs) pending delete.
- ap-cld: hot tier 450→225 GB plan change in flight via Elastic Cloud console.
- ap-cld: Cisco Trim Package May11 pending.
- gl-testing: repurposed as IaC pre-check sandbox (~$37/mo); single-node — does NOT validate HA/tiered/replica/CCS-CCR.

## recently-shipped

- (none yet)

## known gotchas to re-read before acting

- See `knowledge/reference/conventions.md` — frozen tier capacity, single-node Fleet YELLOW, plan_history > trackers, optimisation turbulence.
- See `RULES.md` — autoscaling Current-before-Max, `.alerts` gate on hot downsize, no apply, no self-merge.
