# Issues — gl-cld-reporting

Source: Consolidated_Issue_Register_v21 (live-reconciled 2026-05-31). 5 entries.

- **IR-054** — Hot-only cluster — 99 metrics + 28 logs indices on hot, no expiry
  - Severity: Critical · Status: Closed (verified live)
  - Evidence: cloud_get_deployment plan shows hot_content (3z, 2GB), warm (1z, 4GB, datawarm.d3), frozen (1z, 4GB, datafrozen.i3en) all provisioned and healthy. ILM logs/metrics policies confirmed 4-phase (hot->warm->frozen->delete, 180d retention).
- **IR-101** — Hot-only cluster with no warm/frozen — all 127 active indices on hot; no ILM
  - Severity: Critical · Status: Closed (verified live)
  - Evidence: Deployment plan confirms warm + frozen tiers active (sizes 4096); cold tier size=0 (not provisioned), consistent with the 6-node master threshold rationale. Cluster is 5 nodes (3 hot + 1 warm + 1 frozen), GREEN, 522 active shards, 0 unassigned.
- **IR-123** — Two of three combined data_hot+master nodes at heap ceiling. instance-0000000021 (data_content/data_hot/ingest/master/remote_cluster_client/transform on aws.es.datahot.i3): heap 93%, old-gen 56.3%, 0 GC events. instance-0000000018 (same role set, same instance config): heap 90%, old-gen 78.7%, 1 old-GC event. Tiebreaker instance-0000000020 (master/voting_only on aws.es.master.c5d): heap 77%. Captured during fleet closing audit on 9 May 2026.
  - Severity: P2 · Status: CORRECTED (state differs from doc)
  - Evidence: Heap pressure has materially recovered: nodes_stats jvm.heap_used_percent now instance-0000000014=55%, instance-0000000015=25%, instance-0000000016=44% (vs. doc 93/90/77%). All three hot nodes report jvm.gc.collectors.old.collection_count=0. Old-gen pool used/max ratios are 31%/30%/29% (vs. doc 78.7% peak). Deployment plan still shows 3 zones x 2GB datahot.i3, so the underlying capacity has not been resized - heap recovery appears to be from workload/index hygiene improvements. Issue can move from OPEN to MONITOR.
- **IR-152** — monitoring-indices orphan — 155.9M documents (93% of cluster data), 51.6GB, no ILM
  - Severity: High · Status: Open (verified live)
  - Evidence: list_indices returns single index 'monitoring-indices' with docsCount=155895165 (155.9M), storeSize=52.0gb, health=green, creationDate=2025-12-19. ilm_explain_lifecycle confirms Managed:no, Policy:none, Phase:unknown. State unchanged vs. doc.
- **IR-155** — .ds-logs-enterprise_search.audit-default-2025.03.17-000001 stuck in delete:delete ERROR S
  - Severity: dium OP · Status: Open (verified live)
  - Evidence: index_exists returns true; ilm_explain_lifecycle(onlyErrors=true) returns exactly this index as the sole ILM error - Managed:yes, Policy:logs-enterprise_search.audit-default, Phase:delete:delete ERROR. State unchanged vs. doc - manual DELETE still required.

_Regenerated 2026-06-01 via python-docx + Sev/Status repair pass._
